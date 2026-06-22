#!/usr/bin/env node
// HEXAI Review Harness V2 — CLI
// Lightweight orchestration for multi-agent weekly task R&D workflow.
// No external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATUS_SCHEMA_VERSION,
  FakeWorkerAdapter,
  ManualWorkerAdapter,
  assertAttemptRef,
  assertStageCursor,
  createBinding,
  createExecutionDefaults,
  createMailboxDefaults,
  createEvent,
  createStageCursor,
  migrateExecutionState,
  verifySessionProof,
} from './execution-protocol.js';
import {
  MailboxStore,
  activeCursorHash,
  createMailboxStageCursor,
} from './mailbox-store.js';
import { ExecutionStore } from './execution-store.js';
import { ExecutionSupervisor } from './execution-supervisor.js';
import { deriveAdvanceTransition, evaluateStageCheck } from './workflow-core.js';
import {
  FixtureWarpMacosHelper,
  ProcessWarpMacosHelper,
  WARP_CAPABILITY_NAME,
  WARP_CAPABILITY_TTL_MS,
  WarpMacosAdapter,
  createTargetChallengePayload,
  createTargetChallengeResponse,
  assertRealWarpCapabilityEvidence,
  deriveWarpCapabilities,
  discoverStableTarget,
  targetFingerprintHash,
  validateTargetChallengeResponse,
} from './warp-macos-adapter.js';
import { canonicalHash } from './file-protocol.js';
import {
  acquireExecutionLock,
  finalizeRecoveredExecutionLock,
  releaseExecutionLock,
  updateExecutionLock,
} from './execution-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = process.env.HARNESS_ROOT || path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Paths — can be overridden via env vars for testing
// ---------------------------------------------------------------------------
const REVIEW_ROOT = process.env.REVIEW_ROOT || '/Users/admin/project/ai/review';
const CODE_REPO = process.env.CODE_REPO || '/Users/admin/project/ai/work/HEXAI';
const REVIEW_PLAYBOOKS = path.join(REVIEW_ROOT, 'ReviewPlaybooks');
const BINDING_HEARTBEAT_STALE_MS = 300_000;
const CAPABILITY_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const NEEDS_INPUT_CATEGORIES = new Set([
  'permission-request',
  'agent-question',
  'authentication-required',
  'external-intervention',
]);

// Use env override if set, else fall back to config, then hardcoded default
function getEffectiveReviewRoot() {
  const envVal = process.env.REVIEW_ROOT;
  if (envVal) return envVal;
  try {
    const cfg = getWorkflowConfig();
    if (cfg && cfg.reviewRoot) return cfg.reviewRoot;
  } catch {
    // config not yet loaded
  }
  return REVIEW_ROOT;
}

// ---------------------------------------------------------------------------
// Workflow config — load from JSON (P1-4)
// ---------------------------------------------------------------------------
let _workflowConfig = null;

function loadWorkflowConfig(taskId) {
  if (_workflowConfig && _workflowConfig.taskId === taskId && _workflowConfig._loaded) {
    return _workflowConfig;
  }
  const jsonPath = path.join(HARNESS_ROOT, 'workflows', 'weekly-canvas-task.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Workflow config not found: ${jsonPath}`);
  }
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  _workflowConfig = JSON.parse(raw);
  if (_workflowConfig.taskId !== taskId && taskId) {
    // Allow fallback — config might define a different task as primary
    console.error(`Warning: Config taskId "${_workflowConfig.taskId}" differs from requested "${taskId}". Using config.`);
  }
  _workflowConfig._loaded = true;
  return _workflowConfig;
}

function getWorkflowConfig() {
  if (!_workflowConfig) {
    throw new Error('Workflow config not loaded. Call loadWorkflowConfig(taskId) first.');
  }
  return _workflowConfig;
}

// ---------------------------------------------------------------------------
// Derived from config
// ---------------------------------------------------------------------------
function getStages() {
  return getWorkflowConfig().stages.map(s => s.id);
}

function getStageConfig(stageId) {
  return getWorkflowConfig().stages.find(s => s.id === stageId) || null;
}

function getStageIndex(stage) {
  return getStages().indexOf(stage);
}

function getReviewStages() {
  return getWorkflowConfig().reviewStages || [];
}

function getFixStages() {
  return getWorkflowConfig().fixStages || [];
}

function getFixReviewStages() {
  return getWorkflowConfig().fixReviewStages || [];
}

function getImplementerStages() {
  return getWorkflowConfig().implementerStages || [];
}

function getSubtasksForTask() {
  return getWorkflowConfig().subtasks;
}

// ---------------------------------------------------------------------------
// V2: Clipboard helper (macOS pbcopy, injectable for testing)
// HARNESS_DISABLE_PBCOPY=1  : force failure, output warning
// HARNESS_COPY_COMMAND=<cmd>: override copy command (e.g. "xclip -selection clipboard")
// ---------------------------------------------------------------------------
function copyToClipboard(text) {
  // Allow forcing failure for test environments
  if (process.env.HARNESS_DISABLE_PBCOPY === '1') {
    return false;
  }
  const copyCmd = process.env.HARNESS_COPY_COMMAND || 'pbcopy';
  try {
    execSync(copyCmd, { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// V2: Stage-to-window mapping
// ---------------------------------------------------------------------------
function getTargetWindow(stage) {
  const workStages = ['implementation-plan', 'code-implementation', 'plan-fix', 'code-fix'];
  const reviewStages = ['plan-review', 'plan-fix-review', 'code-review', 'code-fix-review', 'delivery'];
  const harnessStages = ['done'];
  if (workStages.includes(stage)) return 'work';
  if (reviewStages.includes(stage)) return 'review';
  if (harnessStages.includes(stage)) return 'harness';
  // Default: implementer stages → work, review stages → review
  const implementerStages = getImplementerStages();
  if (implementerStages.includes(stage)) return 'work';
  const reviewStagesAll = getReviewStages();
  if (reviewStagesAll.includes(stage)) return 'review';
  return 'review';
}

function getTargetWindowInstruction(targetWindow) {
  if (targetWindow === 'work') return '请粘贴到 A/work 窗口';
  if (targetWindow === 'review') return '请粘贴到 B/review 窗口';
  return '请返回 Harness 窗口继续操作';
}

function getNextRecommendedCommand(taskId, status, stageData = {}) {
  if (status.awaitingCommit) return `pnpm harness advance ${taskId} --confirm-committed`;
  if (status.currentStage === 'done' || status.taskStatus === 'completed') return '(task completed)';
  if (stageData.stageStatus === 'interrupted') return `pnpm harness resume-current ${taskId}`;
  if (stageData.stageStatus === 'completed') return `pnpm harness advance ${taskId}`;
  if (stageData.primaryReportPath && fs.existsSync(stageData.primaryReportPath)) {
    return `pnpm harness step ${taskId}`;
  }
  return `pnpm harness next ${taskId} --copy`;
}

// ---------------------------------------------------------------------------
// V2: Prompt file path
// ---------------------------------------------------------------------------
function promptFilePath(taskId, subtaskId, stage) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'prompts', `${subtaskId}-${stage}.md`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

function getCurrentYyyymmdd() {
  const override = process.env.HARNESS_DATE_YYYYMMDD;
  if (override) {
    if (!/^\d{8}$/.test(override)) {
      throw new Error(`Invalid HARNESS_DATE_YYYYMMDD: ${override}. Expected YYYYMMDD.`);
    }
    return override;
  }

  const timeZone = process.env.HARNESS_TIME_ZONE || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}${byType.month}${byType.day}`;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getFileSnapshot(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, size: 0, mtimeMs: 0, sha256: '' };
  }
  const content = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function hasFreshOutput(stageData) {
  const primaryPath = stageData?.primaryReportPath;
  if (!primaryPath || !fs.existsSync(primaryPath)) return false;
  const baseline = stageData.outputBaseline;
  if (!baseline || baseline.legacy) return true;
  const current = getFileSnapshot(primaryPath);
  return !baseline.exists || current.sha256 !== baseline.sha256;
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

function loadTemplate(templateName) {
  const p = path.join(HARNESS_ROOT, 'templates', `${templateName}.prompt.md`);
  if (!fs.existsSync(p)) {
    throw new Error(`Template not found: ${templateName}`);
  }
  return fs.readFileSync(p, 'utf-8');
}

function getSubtaskIndex(taskId, subtaskId) {
  const subtasks = getSubtasksForTask();
  return subtasks.findIndex(s => s.id === subtaskId);
}

// ---------------------------------------------------------------------------
// Status file paths
// ---------------------------------------------------------------------------
function statusPath(taskId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'status.json');
}

function outputsDir(taskId, subtaskId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'outputs', subtaskId);
}

function handoffsDir(taskId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'handoffs');
}

function archiveDir(taskId) {
  return path.join(HARNESS_ROOT, 'runs', 'archive');
}

function executionLockPath(taskId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'execution.lock');
}

async function withTaskExecutionLock(taskId, command, callback) {
  const lockPath = executionLockPath(taskId);
  const lock = acquireExecutionLock({
    lockPath,
    taskId,
    command,
    staleAfterMs: Number(process.env.HARNESS_LOCK_STALE_MS || 60_000),
  });

  try {
    if (fs.existsSync(statusPath(taskId))) {
      const status = loadStatus(taskId);
      if (lock.recoveries.length > 0) {
        let recoveryStateChanged = false;
        for (const recovery of lock.recoveries) {
          const alreadyRecorded = (status.history || []).some(entry =>
            entry.action === 'stale-lock-recovered' &&
            entry.details?.recoveryId === recovery.recoveryId
          );
          if (alreadyRecorded) continue;
          status.execution.lockEpoch = Number(status.execution.lockEpoch || 0) + 1;
          addHistory(status, 'stale-lock-recovered', {
            recoveryId: recovery.recoveryId,
            reason: 'owner-dead-and-heartbeat-stale',
            previousOwnerId: recovery.previousLock.ownerId || null,
            previousPid: recovery.previousLock.pid || null,
            previousHeartbeatAt: recovery.previousLock.heartbeatAt || null,
            lockEpoch: status.execution.lockEpoch,
          });
          recoveryStateChanged = true;
        }
        if (recoveryStateChanged) saveStatus(taskId, status);
        finalizeRecoveredExecutionLock(lock);
      }
      updateExecutionLock(lock, {
        heartbeatAt: now(),
        lockEpoch: status.execution.lockEpoch,
      });
    }
    return await callback();
  } finally {
    releaseExecutionLock(lock);
  }
}

async function withTaskExecutionLockRetry(taskId, command, callback, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await withTaskExecutionLock(taskId, command, callback);
    } catch (error) {
      if (!error.message.startsWith('task-locked:') || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

// ---------------------------------------------------------------------------
// Status load/save
// ---------------------------------------------------------------------------
function loadStatus(taskId, { persistMigration = true } = {}) {
  const p = statusPath(taskId);
  if (!fs.existsSync(p)) {
    throw new Error(`No run found for ${taskId}. Run "harness init ${taskId}" first.`);
  }
  const status = readJSON(p);
  if (!status) {
    throw new Error(`Corrupt status file for ${taskId}: ${p}`);
  }
  let migrated = false;
  // Migrate old status to new fields (P1-3, P1-5, P2-2)
  for (const [sid, st] of Object.entries(status.subtasks || {})) {
    if (st.planRound === undefined) { st.planRound = 1; migrated = true; }
    if (st.codeRound === undefined) { st.codeRound = 1; migrated = true; }
    if (st.deliveryRound === undefined) { st.deliveryRound = 1; migrated = true; }
    for (const [stageId, stage] of Object.entries(st.stages || {})) {
      if (!stage.outputs) { stage.outputs = []; migrated = true; }
      if (!stage.currentOutputPath) { stage.currentOutputPath = stage.primaryReportPath || ''; migrated = true; }
    }
  }
  if (migrateExecutionState(status)) migrated = true;
  if (status.awaitingCommit === undefined) {
    status.awaitingCommit = false;
    migrated = true;
  }
  if (status.commitRequiredForSubtask === undefined) {
    status.commitRequiredForSubtask = null;
    migrated = true;
  }
  if (!status.residualRisks) { status.residualRisks = []; migrated = true; }
  if (!status.acceptances) { status.acceptances = {}; migrated = true; }
  if (migrated && persistMigration) {
    saveStatus(taskId, status);
  }
  return status;
}

function saveStatus(taskId, status) {
  status.updatedAt = now();
  migrateExecutionState(status);
  status.stateRevision += 1;
  if (status.awaitingCommit === undefined) status.awaitingCommit = false;
  if (status.commitRequiredForSubtask === undefined) status.commitRequiredForSubtask = null;
  writeJSON(statusPath(taskId), status);
}

function bumpStageRevision(status) {
  status.stageRevision = Number(status.stageRevision || 0) + 1;
}

function getCurrentStageCursor(status) {
  return createStageCursor({
    subtaskId: status.currentSubtask,
    stage: status.currentStage,
    round: getRoundForStage(status, status.currentSubtask, status.currentStage),
    stageRevision: status.stageRevision,
    activeAttemptId: status.execution?.activeAttemptId || null,
  });
}

function assertCheckEvidence(status, checkResult) {
  assertStageCursor(checkResult.stageCursor, getCurrentStageCursor(status));
  assertAttemptRef(checkResult.attemptRef, {
    jobId: status.execution?.activeJobId || null,
    attemptId: status.execution?.activeAttemptId || null,
    leaseToken: status.execution?.activeLeaseToken || null,
  });
  const stageData = status.subtasks[status.currentSubtask]?.stages?.[status.currentStage];
  const actual = getFileSnapshot(stageData?.primaryReportPath);
  const expected = checkResult.primarySnapshot;
  if (!expected || expected.sha256 !== actual.sha256 || expected.size !== actual.size) {
    throw new Error('stage-cas-conflict: primary output changed after check');
  }
}

function getCurrentAttemptRef(status) {
  return {
    jobId: status.execution?.activeJobId || null,
    attemptId: status.execution?.activeAttemptId || null,
    leaseToken: status.execution?.activeLeaseToken || null,
  };
}

const MANUAL_PROGRESS_COMMANDS = new Set([
  'init', 'next', 'step', 'check', 'advance', 'accept', 'import', 'resume', 'set-current', 'interrupt', 'resume-current',
]);

const MAILBOX_COMMANDS = new Set([
  'mailbox-bind', 'mailbox-publish', 'mailbox-peek', 'mailbox-claim', 'mailbox-start',
  'mailbox-complete', 'mailbox-failed', 'mailbox-needs-input', 'mailbox-pump',
  'mailbox-close', 'mailbox-reconcile', 'mailbox-takeover',
  'mailbox-worker-peek', 'mailbox-worker-claim', 'mailbox-worker-start',
  'mailbox-worker-complete', 'mailbox-worker-failed', 'mailbox-worker-needs-input',
]);

const LOCKED_MAILBOX_COMMANDS = new Set([
  'mailbox-bind', 'mailbox-publish', 'mailbox-claim', 'mailbox-start',
  'mailbox-complete', 'mailbox-failed', 'mailbox-needs-input', 'mailbox-pump',
  'mailbox-close', 'mailbox-reconcile', 'mailbox-takeover',
  'mailbox-worker-claim', 'mailbox-worker-start', 'mailbox-worker-complete',
  'mailbox-worker-failed', 'mailbox-worker-needs-input',
]);

const LOCKED_WORKER_ARTIFACT_COMMANDS = new Set([
  'worker-attach', 'worker-launch', 'worker-heartbeat', 'worker-detach',
  'worker-hook-probe', 'warp-bind-target', 'pilot-allow',
]);

function assertNoActiveExecution(taskId, command) {
  if (!MANUAL_PROGRESS_COMMANDS.has(command) || !fs.existsSync(statusPath(taskId))) return;
  const status = readJSON(statusPath(taskId));
  if (status?.mailbox?.activeSessionId && command !== 'check') {
    throw new Error(
      `active-mailbox-conflict: ${command} cannot change workflow state while ` +
      `session=${status.mailbox.activeSessionId} attempt=${status.mailbox.activeAttemptId || '(unknown)'} is active`
    );
  }
  // Delivery acceptance is gate evidence for the active attempt, not workflow
  // progression. It is serialized by the task lock and may be recorded while
  // the Supervisor waits for completion.
  if (command === 'accept' && status?.currentStage === 'delivery') return;
  if (status?.execution?.activeJobId || status?.execution?.activeAttemptId) {
    throw new Error(
      `active-job-conflict: ${command} cannot change workflow state while ` +
      `job=${status.execution.activeJobId || '(unknown)'} attempt=${status.execution.activeAttemptId || '(unknown)'} is active`
    );
  }
}

function addHistory(status, action, details = {}) {
  if (!status.history) status.history = [];
  status.history.push({
    timestamp: now(),
    action,
    details,
  });
}

// ---------------------------------------------------------------------------
// File naming — patterns from config (P1-4), rounds (P1-3)
// ---------------------------------------------------------------------------
function toChineseRound(n) {
  const map = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 10) return map[n];
  return String(n);
}

function generateReportPath(taskId, subtask, stage, round) {
  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  const yyyymmdd = getCurrentYyyymmdd();

  const reviewRoot = getEffectiveReviewRoot();
  const reportDir = path.join(reviewRoot, week, subtask.id);

  // Try config-based naming
  const namingCfg = cfg.fileNaming && cfg.fileNaming[stage];
  if (namingCfg) {
    const named = {
      reportDir,
      subtaskId: subtask.id,
      shortTitle: subtask.shortTitle,
      taskTheme: subtask.taskTheme,
      YYYYMMDD: yyyymmdd,
    };
    let p = namingCfg.pattern;
    for (const [k, v] of Object.entries(named)) {
      p = p.replaceAll(`{${k}}`, v);
    }
    // Append round suffix for round > 1
    if (round > 1 && namingCfg.roundSuffix) {
      const suffix = namingCfg.roundSuffix.replace('{n}', String(round));
      p = p.replace(/\.md$/, `${suffix}.md`);
    }
    return p;
  }

  // Fallback: hardcoded naming (backward compat)
  const naming = {
    'implementation-plan': () =>
      path.join(reportDir, `${subtask.taskTheme}实施计划-${yyyymmdd}.md`),

    'plan-review': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}计划Review意见`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'plan-fix': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}计划Fix报告`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'plan-fix-review': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}计划FixReview意见`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'code-implementation': () =>
      path.join(reportDir, `${subtask.id}任务到代码映射-${yyyymmdd}.md`),

    'code-review': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}CodeReview意见`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'code-fix': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}CodeFix报告`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'code-fix-review': () => {
      const base = path.join(reportDir, `${subtask.id}${subtask.shortTitle}CodeFix复审意见`);
      return round > 1 ? `${base}-第${toChineseRound(round)}轮.md` : `${base}.md`;
    },

    'delivery': () =>
      path.join(reportDir, `${subtask.id}交付物报告-${yyyymmdd}.md`),
  };

  const fn = naming[stage];
  if (!fn) return path.join(reportDir, `${subtask.id}-${stage}-output.md`);
  return fn();
}

function generateHandoffPath(taskId, subtask, stage) {
  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  const reportDir = path.join(getEffectiveReviewRoot(), week, subtask.id);
  return path.join(reportDir, `${subtask.id}-${stage}-handoff.md`);
}

function generateMirrorHandoffPath(taskId, subtask, stage) {
  return path.join(handoffsDir(taskId), `${subtask.id}-${stage}-handoff.md`);
}

// Determine round number for a given stage based on roundGroup (P1-3)
function determineRoundForStage(status, subtaskId, stageId) {
  const config = getStageConfig(stageId);
  const roundGroup = config?.roundGroup;
  if (!roundGroup) return 1;

  const subtask = status.subtasks[subtaskId];
  if (!subtask) return 1;

  const roundKey = `${roundGroup}Round`;
  return subtask[roundKey] || 1;
}

// Determine round by scanning existing files (used during init)
function determineRoundFromFiles(taskId, subtask, stage) {
  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  const reportDir = path.join(getEffectiveReviewRoot(), week, subtask.id);
  if (!fs.existsSync(reportDir)) return 1;

  const files = fs.readdirSync(reportDir);
  const prefixes = {
    'plan-review': `${subtask.id}${subtask.shortTitle}计划Review意见`,
    'plan-fix': `${subtask.id}${subtask.shortTitle}计划Fix报告`,
    'plan-fix-review': `${subtask.id}${subtask.shortTitle}计划FixReview意见`,
    'code-review': `${subtask.id}${subtask.shortTitle}CodeReview意见`,
    'code-fix': `${subtask.id}${subtask.shortTitle}CodeFix报告`,
    'code-fix-review': `${subtask.id}${subtask.shortTitle}CodeFix复审意见`,
  };

  const prefix = prefixes[stage];
  if (!prefix) return 1;

  let maxRound = 0;
  for (const f of files) {
    if (f.startsWith(prefix)) {
      if (f === `${prefix}.md`) {
        maxRound = Math.max(maxRound, 1);
      } else {
        const match = f.match(/第([一二三四五六七八九十\d]+)轮\.md$/);
        if (match) {
          const r = parseInt(match[1], 10) || chineseToNumber(match[1]);
          maxRound = Math.max(maxRound, r);
        }
      }
    }
  }
  return maxRound + 1;
}

function chineseToNumber(cn) {
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  return map[cn] || 0;
}

// ---------------------------------------------------------------------------
// Finding parsing (P1-1)
// ---------------------------------------------------------------------------

/**
 * Parse findings from markdown report content.
 * Finding format:
 *   ### Finding W6-A-02-P1-001
 *   Priority: P1
 *   Status: open
 *   Owner: claude-implementer-minimax
 *   Module: InfiniteCanvas
 *   Files:
 *   - src/file1.ts
 *   Issue: ...
 *   Expected: ...
 *   Acceptance: ...
 *
 * Returns array of { id, priority, status, owner, module, files? }
 */
function parseFindings(content) {
  const findings = [];
  const blocks = content.split(/\n(?=### Finding\s+\S+)/);

  for (const block of blocks) {
    const m = block.match(/### Finding\s+(\S+)/);
    if (!m) continue;

    const f = { id: m[1] };
    const lines = block.split('\n');
    let inFiles = false;
    const files = [];

    for (const line of lines) {
      if (line.match(/^\s*\*{0,2}Files\*{0,2}:/i)) { inFiles = true; continue; }
      if (inFiles && line.match(/^\s*-\s/)) {
        files.push(line.replace(/^\s*-\s+/, '').trim());
        continue;
      }
      if (inFiles && !line.match(/^\s*-\s/) && line.includes(':')) {
        inFiles = false;
      }

      const kv = line.match(/^\s*\*{0,2}(\w+)\*{0,2}:\s*(.*)/);
      if (kv) {
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        if (key === 'priority') f.priority = val;
        else if (key === 'status') f.status = val.toLowerCase();
        else if (key === 'owner') f.owner = val;
        else if (key === 'module') f.module = val;
      }
    }

    if (files.length > 0) f.files = files;
    // Default status if not found
    if (!f.status) f.status = 'open';
    findings.push(f);
  }

  return findings;
}

function validateFindingContract(findings, subtaskId) {
  const issues = [];
  const idPattern = new RegExp(`^${subtaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-P[012]-\\d{2,3}$`);
  const allowedStatuses = new Set([
    'open', 'reopened', 'fixed', 'verified', 'accepted', 'deferred', 'false-positive',
  ]);

  for (const finding of findings) {
    if (!idPattern.test(finding.id)) {
      issues.push(`Invalid Finding ID "${finding.id}". Expected ${subtaskId}-P0|P1|P2-NN.`);
    }
    if (!['P0', 'P1', 'P2'].includes(finding.priority)) {
      issues.push(`Finding ${finding.id} is missing a valid Priority: P0/P1/P2.`);
    }
    if (!allowedStatuses.has(finding.status)) {
      issues.push(`Finding ${finding.id} has invalid Status "${finding.status}".`);
    }
  }

  return issues;
}

function detectReviewDecision(content) {
  const explicit = content.match(/^Decision:\s*(pass|changes-required)\s*$/mi);
  if (explicit) return explicit[1].toLowerCase();

  if (/修复.{0,20}后.{0,20}(可|可以)进入|有条件通过|不可进入|阻塞/.test(content)) {
    return 'changes-required';
  }
  if (/可以立即开始实现|可以进入实现|可以进入代码实施|✅\s*通过/.test(content)) {
    return 'pass';
  }
  return '';
}

/**
 * Deduplicate findings by ID, keeping the last occurrence (latest = most recent).
 */
function getLatestFindings(findingsList) {
  const map = new Map();
  for (const f of findingsList) {
    map.set(f.id, f);
  }
  return Array.from(map.values());
}

/**
 * Collect all findings from all review stages for a given subtask.
 * The most recent report's findings for the same ID win.
 */
function getAllFindingsForSubtask(status, subtaskId) {
  const allFindings = [];
  const stages = status.subtasks[subtaskId]?.stages || {};
  const reviewStageIds = getReviewStages();

  for (const stageId of reviewStageIds) {
    const stage = stages[stageId];
    if (stage && stage.primaryReportPath && fs.existsSync(stage.primaryReportPath)) {
      const content = fs.readFileSync(stage.primaryReportPath, 'utf-8');
      const findings = parseFindings(content);
      allFindings.push(...findings);
    }
  }

  return getLatestFindings(allFindings);
}

/**
 * Parse Fix Mapping table from report content (P1-7).
 * Format:
 *   ### Fix Mapping
 *   | Finding | Status | 修复文件 | 验证 |
 *   | --- | --- | --- | --- |
 *   | W6-A-02-P1-001 | fixed | src/file.ts | verified |
 *
 * P1-7: Section must start at a line that is EXACTLY "### Fix Mapping".
 *       Finds the line, then reads table rows until the next heading or end.
 * Returns array of { finding, status, fixFile, verification }
 */
function parseFixMapping(content) {
  const mapping = [];
  // P1-7: Find the heading line — must be exactly "### Fix Mapping" on its own line
  const lines = content.split('\n');
  let headingLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '### Fix Mapping') {
      headingLineIdx = i;
      break;
    }
  }
  if (headingLineIdx === -1) return mapping;

  // P1-7: Scan section lines (after heading) for table rows until next heading
  const sectionLines = lines.slice(headingLineIdx + 1);
  for (const line of sectionLines) {
    const trimmed = line.trim();
    // Stop at next markdown heading (H1-H4)
    if (/^#{1,4}\s/.test(trimmed)) break;
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').filter(c => c.trim()).map(c => c.trim());
      if (cells.length >= 2) {
        const headerVal = cells[0].toLowerCase();
        // Skip header row, separator row, and empty cells
        if (headerVal === 'finding' || headerVal === '---' || cells[0] === '') continue;
        mapping.push({
          finding: cells[0],
          status: cells[1].toLowerCase(),
          fixFile: cells[2] || '',
          verification: cells[3] || '',
        });
      }
    }
  }

  return mapping;
}

/**
 * Find the latest blocking review stage output in the same round group (plan/code).
 * P1-5: For plan-fix prefer plan-fix-review; for code-fix prefer code-fix-review.
 * Used by fix stages to determine which findings need coverage.
 */
function findPreviousReviewStage(status, subtaskId, roundGroup) {
  const stages = status.subtasks[subtaskId]?.stages || {};
  // Check most recent review type first (fix-review before first review)
  const reviewStageIds = roundGroup === 'plan'
    ? ['plan-fix-review', 'plan-review']
    : roundGroup === 'code'
    ? ['code-fix-review', 'code-review']
    : [];

  for (const reviewStageId of reviewStageIds) {
    const stage = stages[reviewStageId];
    if (stage && stage.primaryReportPath && fs.existsSync(stage.primaryReportPath)) {
      return stage;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Get round for a stage from status (P1-3)
// ---------------------------------------------------------------------------
function getRoundForStage(status, subtaskId, stageId) {
  const config = getStageConfig(stageId);
  const roundGroup = config?.roundGroup;
  if (!roundGroup) return 1;

  const subtask = status.subtasks[subtaskId];
  if (!subtask) return 1;

  const roundKey = `${roundGroup}Round`;
  return subtask[roundKey] || 1;
}

// ---------------------------------------------------------------------------
// Template variables
// ---------------------------------------------------------------------------
function buildTemplateVars(taskId, subtaskId, stage, status) {
  const subtasks = getSubtasksForTask();
  const subtask = subtasks.find(s => s.id === subtaskId);
  if (!subtask) throw new Error(`Unknown subtask: ${subtaskId}`);

  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  const reportDir = path.join(getEffectiveReviewRoot(), week, subtaskId);
  const runDir = path.join(HARNESS_ROOT, 'runs', taskId);
  const evidenceDir = path.join(reportDir, 'evidence');

  const stageData = status.subtasks[subtaskId]?.stages?.[stage] || {};
  const round = getRoundForStage(status, subtaskId, stage);
  const primaryReportPath = stageData.primaryReportPath || generateReportPath(taskId, subtask, stage, round);
  const mirrorOutputPath = stageData.mirrorOutputPath ||
    path.join(outputsDir(taskId, subtaskId), path.basename(primaryReportPath));
  const handoffPath = stageData.handoffPath || generateHandoffPath(taskId, subtask, stage);
  const mirrorHandoffPath = stageData.mirrorHandoffPath || generateMirrorHandoffPath(taskId, subtask, stage);

  // Find related documents from previous stages
  const subtaskStages = status.subtasks[subtaskId]?.stages || {};
  const config = getStageConfig(stage) || {};

  function prevStagePath(prevStage) {
    return subtaskStages[prevStage]?.primaryReportPath || '';
  }

  const isCodeFixReview = stage === 'code-fix-review';
  const isPlanFixReview = stage === 'plan-fix-review';
  const fixReportToReview = isCodeFixReview
    ? prevStagePath('code-fix')
    : prevStagePath('plan-fix');
  const previousReviewFindings = isCodeFixReview
    ? (subtaskStages['code-fix']?.reviewFindingsPath || prevStagePath('code-review'))
    : isPlanFixReview
    ? (subtaskStages['plan-fix']?.reviewFindingsPath || prevStagePath('plan-review'))
    : (prevStagePath('plan-review') || prevStagePath('plan-fix-review'));

  return {
    taskId,
    subtaskId,
    subtaskTitle: subtask.title,
    shortTitle: subtask.shortTitle,
    taskTheme: subtask.taskTheme,
    stage,
    stageStatus: stageData.stageStatus || 'active',
    requiredSkill: config.requiredSkill || 'null',
    ownerProfile: config.ownerProfile || '',
    codeRepo: cfg.codeRepo || CODE_REPO,
    reviewRoot: getEffectiveReviewRoot(),
    reportDir,
    runDir,
    evidenceDir,
    primaryReportPath,
    mirrorOutputPath,
    handoffPath,
    mirrorHandoffPath,
    // Cross-stage document references
    implementationPlan: prevStagePath('implementation-plan') || prevStagePath('plan-fix') || '',
    planToReview: prevStagePath('implementation-plan') || prevStagePath('plan-fix') || '',
    fixReportToReview,
    previousReviewFindings,
    codeMappingToReview: prevStagePath('code-implementation') || '',
    codeMapping: prevStagePath('code-implementation') || '',
    reviewFindingsPath: prevStagePath('code-review') || prevStagePath('code-fix-review') || prevStagePath('plan-review') || '',
    allReviewFindings: [
      prevStagePath('plan-review'), prevStagePath('plan-fix-review'),
      prevStagePath('code-review'), prevStagePath('code-fix-review'),
    ].filter(Boolean).join(', '),
    // Additional metadata
    round,
    yyyymmdd: getCurrentYyyymmdd(),
  };
}

function substituteTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, String(value));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Init (P0-2: idempotent protection)
// ---------------------------------------------------------------------------
function cmdInit(taskId, opts = {}) {
  const { from, stage, force, archiveExisting } = opts;
  const subtasks = getSubtasksForTask();

  // Check if run already exists (P0-2)
  const existingStatusPath = statusPath(taskId);
  if (fs.existsSync(existingStatusPath)) {
    if (archiveExisting) {
      // Archive existing run
      const archive = archiveDir(taskId);
      ensureDir(archive);
      const timestamp = now().replace(/[:.]/g, '-');
      const archiveName = `${taskId}-${timestamp}`;
      const archivePath = path.join(archive, archiveName);
      fs.mkdirSync(archivePath, { recursive: true });
      fs.cpSync(path.dirname(existingStatusPath), archivePath, { recursive: true });
      console.log(`📦 Archived existing run to ${archivePath}`);
    } else if (!force) {
      throw new Error(`Run already exists for ${taskId}. Use --force to overwrite or --archive-existing to archive first.`);
    }
    fs.rmSync(path.dirname(existingStatusPath), { recursive: true, force: true });
  }

  const fromSubtask = from || 'W6-A-02';
  const startStage = stage || 'implementation-plan';

  // Validate
  const fromIdx = subtasks.findIndex(s => s.id === fromSubtask);
  if (fromIdx === -1) throw new Error(`Unknown subtask: ${fromSubtask}`);
  const allStages = getStages();
  if (!allStages.includes(startStage)) throw new Error(`Unknown stage: ${startStage}`);

  const status = {
    taskId,
    taskTitle: getWorkflowConfig().taskTitle || `${taskId} 画布本体UIUX收口`,
    createdAt: now(),
    updatedAt: now(),
    schemaVersion: STATUS_SCHEMA_VERSION,
    stateRevision: 0,
    stageRevision: 0,
    execution: createExecutionDefaults(),
    mailbox: createMailboxDefaults(),
    currentSubtask: fromSubtask,
    currentStage: startStage,
    awaitingCommit: false,     // P2-2
    commitRequiredForSubtask: null,  // P2-2
    residualRisks: [],
    acceptances: {},
    subtasks: {},
    history: [],
  };

  const isW6AFirstRun = taskId === 'W6-A' && !from && !stage;

  for (const s of subtasks) {
    const subtaskIdx = subtasks.findIndex(st => st.id === s.id);
    const stages = {};
    const startStageIdx = getStageIndex(startStage);

    // Initialize round counters (P1-3)
    const subtaskState = {
      id: s.id,
      title: s.title,
      shortTitle: s.shortTitle,
      taskTheme: s.taskTheme,
      planRound: 1,
      codeRound: 1,
      deliveryRound: 1,
    };

    for (const stageId of allStages) {
      const stageIdx = getStageIndex(stageId);

      if (subtaskIdx < fromIdx) {
        stages[stageId] = {
          stageStatus: 'imported-completed',
          currentOutputPath: '',
          latestAcceptedOutputPath: '',
          outputs: [],
        };
      } else if (subtaskIdx === fromIdx && stageIdx < startStageIdx) {
        stages[stageId] = {
          stageStatus: 'assumed-completed',
          currentOutputPath: '',
          latestAcceptedOutputPath: '',
          outputs: [],
        };
      } else if (subtaskIdx === fromIdx && stageIdx === startStageIdx) {
        const round = determineRoundFromFiles(taskId, s, stageId) || 1;
        const reportPath = generateReportPath(taskId, s, stageId, round);
        stages[stageId] = {
          stageStatus: 'active',
          currentOutputPath: reportPath,
          latestAcceptedOutputPath: '',
          primaryReportPath: reportPath,
          mirrorOutputPath: path.join(outputsDir(taskId, s.id), path.basename(reportPath)),
          handoffPath: generateHandoffPath(taskId, s, stageId),
          mirrorHandoffPath: generateMirrorHandoffPath(taskId, s, stageId),
          startedAt: now(),
          outputs: [],
        };
      } else {
        stages[stageId] = {
          stageStatus: 'pending',
          currentOutputPath: '',
          latestAcceptedOutputPath: '',
          outputs: [],
        };
      }
    }

    subtaskState.stages = stages;
    subtaskState.status = subtaskIdx < fromIdx ? 'imported-completed'
      : subtaskIdx === fromIdx ? 'active'
      : 'pending';

    status.subtasks[s.id] = subtaskState;
  }

  // Record residual risks
  for (let i = 0; i < fromIdx; i++) {
    const sid = subtasks[i].id;
    status.residualRisks.push({
      subtask: sid,
      stage: 'all',
      risk: `${sid} completed before Harness creation; historical evidence was not re-run by Harness.`,
      recordedAt: now(),
    });
  }

  const startStageIdx = getStageIndex(startStage);
  for (let si = 0; si < startStageIdx; si++) {
    const sid = getStages()[si];
    status.residualRisks.push({
      subtask: fromSubtask,
      stage: sid,
      risk: `${sid} was assumed-completed before Harness resumed from ${startStage}. Residual risk: deliverables may not have been gate-checked by Harness.`,
      recordedAt: now(),
    });
  }

  if (isW6AFirstRun || (from === 'W6-A-02' && !stage)) {
    const riskFor01 = status.residualRisks.find(r => r.subtask === 'W6-A-01');
    if (riskFor01) {
      riskFor01.risk = 'W6-A-01 completed before Harness creation; historical evidence was not re-run by Harness.';
    }
  }

  addHistory(status, 'init', { from: fromSubtask, stage: startStage, opts });

  // Create directories
  const week = taskId.split('-')[0];
  const reportDir = path.join(getEffectiveReviewRoot(), week, fromSubtask);
  ensureDir(reportDir);
  ensureDir(path.join(HARNESS_ROOT, 'runs', taskId));
  ensureDir(outputsDir(taskId, fromSubtask));
  ensureDir(handoffsDir(taskId));

  saveStatus(taskId, status);
  console.log(`✅ Initialized ${taskId} run`);
  console.log(`   currentSubtask: ${fromSubtask}`);
  console.log(`   currentStage: ${startStage}`);
  if (fromSubtask === 'W6-A-02' && !from && !stage) {
    console.log(`   W6-A-01: imported-completed (completed before Harness)`);
  }

  return status;
}

// ---------------------------------------------------------------------------
// Generate prompt (V2: --copy support, prompt file, structured output)
// ---------------------------------------------------------------------------
function cmdNext(taskId, opts = {}) {
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;

  // V2: awaitingCommit guard
  if (status.awaitingCommit) {
    console.log('⏸️  Delivery passed — manual commit checkpoint required before continuing.');
    console.log(`   需要手动 commit 的子任务: ${status.commitRequiredForSubtask}`);
    console.log();
    console.log('   请先手动 commit 业务代码，然后运行:');
    console.log(`   pnpm harness advance ${taskId} --confirm-committed`);
    return { error: 'awaiting-commit', commitRequiredForSubtask: status.commitRequiredForSubtask };
  }

  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];
  if (!stageData) {
    throw new Error(`No stage data for ${currentSubtask} / ${currentStage}`);
  }

  const subtasks = getSubtasksForTask();
  const subtask = subtasks.find(s => s.id === currentSubtask);
  if (!subtask) throw new Error(`Unknown subtask: ${currentSubtask}`);

  const round = getRoundForStage(status, currentSubtask, currentStage);

  if (!stageData.primaryReportPath) {
    stageData.primaryReportPath = generateReportPath(taskId, subtask, currentStage, round);
  }
  if (!stageData.mirrorOutputPath) {
    stageData.mirrorOutputPath = path.join(outputsDir(taskId, currentSubtask), path.basename(stageData.primaryReportPath));
  }
  if (!stageData.handoffPath) {
    stageData.handoffPath = generateHandoffPath(taskId, subtask, currentStage);
  }
  if (!stageData.mirrorHandoffPath) {
    stageData.mirrorHandoffPath = generateMirrorHandoffPath(taskId, subtask, currentStage);
  }

  // Set currentOutputPath (P1-5)
  stageData.currentOutputPath = stageData.primaryReportPath;
  // Every generated prompt starts a new production attempt. Capture the
  // current artifact even when this stage was activated before, otherwise a
  // stale baseline from an earlier attempt can make unchanged output look new.
  stageData.outputBaseline = getFileSnapshot(stageData.primaryReportPath);
  stageData.outputBaselineCapturedAt = now();
  bumpStageRevision(status);

  saveStatus(taskId, status);

  let result;
  if (stageData.stageStatus === 'interrupted') {
    result = generateContinuationPrompt(taskId, status, currentSubtask, currentStage, subtask);
  } else {
    stageData.stageStatus = 'active';
    if (!stageData.startedAt) stageData.startedAt = now();

    // P2-3: Do NOT add to outputs[] here — the report doesn't exist yet.
    // outputs[] and latestAcceptedOutputPath are set only after check/advance pass.
    saveStatus(taskId, status);

    const templateName = getTemplateName(currentStage);
    const vars = buildTemplateVars(taskId, currentSubtask, currentStage, status);
    const template = loadTemplate(templateName);
    const prompt = substituteTemplate(template, vars);
    result = { prompt, stage: currentStage, subtask: currentSubtask, continuation: false };
  }

  // V2: Save prompt to file
  const promptPath = promptFilePath(taskId, currentSubtask, currentStage);
  ensureDir(path.dirname(promptPath));
  fs.writeFileSync(promptPath, result.prompt, 'utf-8');

  // V2: Copy to clipboard if requested
  let copied = false;
  if (opts.copy) {
    copied = copyToClipboard(result.prompt);
  }

  // V2: Structured output
  const config = getStageConfig(currentStage) || {};
  const targetWindow = getTargetWindow(currentStage);
  const nextAction = getTargetWindowInstruction(targetWindow);

  console.log('═══════════════════════════════════════════════');
  console.log(`📋 NEXT PROMPT GENERATED`);
  console.log(`   currentSubtask: ${currentSubtask}`);
  console.log(`   currentStage: ${currentStage}`);
  console.log(`   expectedSkill: ${config.requiredSkill || '(none)'}`);
  console.log(`   targetWindow: ${targetWindow}`);
  console.log(`   nextAction: ${nextAction}`);
  console.log(`   promptPath: ${promptPath}`);
  if (result.continuation) {
    console.log(`   continuation: true`);
  }
  if (opts.copy) {
    if (copied) {
      console.log(`   copiedToClipboard: true`);
    } else {
      console.log(`   copiedToClipboard: false`);
      console.log(`   ⚠️  pbcopy 不可用，无法复制到剪贴板。Prompt 已保存到文件。`);
    }
  }
  console.log('═══════════════════════════════════════════════');
  console.log();
  console.log(result.prompt);

  return { ...result, promptPath, copiedToClipboard: copied, targetWindow, nextAction, expectedSkill: config.requiredSkill };
}

// ---------------------------------------------------------------------------
// V2: Step — chain check → advance → next
// ---------------------------------------------------------------------------
function cmdStep(taskId, opts = {}) {
  // P1-1: If already at commit checkpoint, skip check/advance entirely
  const preCheck = loadStatus(taskId);
  if (preCheck.awaitingCommit) {
    console.log('═══════════════════════════════════════════════');
    console.log('⏸️  Already at commit checkpoint — awaiting manual commit.');
    console.log(`   需要手动 commit 的子任务: ${preCheck.commitRequiredForSubtask}`);
    console.log();
    console.log('   请先手动 commit 业务代码，然后运行:');
    console.log(`   pnpm harness advance ${taskId} --confirm-committed`);
    console.log('═══════════════════════════════════════════════');
    return {
      success: true,
      stoppedAt: 'awaiting-commit',
      awaitingCommit: true,
      commitRequiredForSubtask: preCheck.commitRequiredForSubtask,
      nextCommand: `pnpm harness advance ${taskId} --confirm-committed`,
    };
  }

  // Step 1: Check
  console.log('▶ CHECK');
  const checkResult = cmdCheck(taskId);
  if (!checkResult.pass) {
    console.log('\n⛔ STEP STOPPED at check — fix issues before retrying.');
    return { success: false, stoppedAt: 'check', ...checkResult };
  }
  console.log('✅ CHECK PASSED\n');

  // Step 2: Advance
  console.log('▶ ADVANCE');
  const advanceResult = cmdAdvance(taskId, { checkResult });
  if (!advanceResult.success) {
    console.log('\n⛔ STEP STOPPED at advance.');
    return { success: false, stoppedAt: 'advance', ...advanceResult };
  }

  // If awaitingCommit, stop here — don't proceed to next
  if (advanceResult.awaitingCommit) {
    console.log('⏸️  Delivery passed — manual commit checkpoint required.');
    console.log('   STEP stopped at commit checkpoint.');
    return {
      success: true,
      stoppedAt: 'awaiting-commit',
      awaitingCommit: true,
      commitRequiredForSubtask: advanceResult.subtask,
      nextCommand: `pnpm harness advance ${taskId} --confirm-committed`,
    };
  }

  console.log(`✅ ADVANCED: ${advanceResult.subtask || ''} / ${advanceResult.stage || ''}\n`);

  // Step 3: Next
  console.log('▶ NEXT');
  const nextResult = cmdNext(taskId, { copy: opts.copy });
  if (nextResult.error) {
    console.log(`\n⛔ STEP STOPPED at next: ${nextResult.error}`);
    return { success: false, stoppedAt: 'next', ...nextResult };
  }
  console.log('✅ NEXT PROMPT GENERATED');
  console.log(`   Target window: ${nextResult.targetWindow}`);
  console.log(`   Expected skill: ${nextResult.expectedSkill || '(none)'}`);
  console.log(`   Prompt path: ${nextResult.promptPath}`);
  if (opts.copy) {
    console.log(`   Copied to clipboard: ${nextResult.copiedToClipboard}`);
  }

  return { success: true, stoppedAt: null, ...nextResult };
}

// ---------------------------------------------------------------------------
// V2: Current — read-only status overview
// ---------------------------------------------------------------------------
function cmdCurrent(taskId) {
  const status = loadStatus(taskId, { persistMigration: false });
  const { currentSubtask, currentStage } = status;
  const subtasks = getSubtasksForTask();
  const subtask = subtasks.find(s => s.id === currentSubtask);
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage] || {};
  const config = getStageConfig(currentStage) || {};

  const round = determineRoundForStage(status, currentSubtask, currentStage);
  const targetWindow = getTargetWindow(currentStage);

  // Gather round info
  const st = status.subtasks[currentSubtask];
  const planRound = st?.planRound || 1;
  const codeRound = st?.codeRound || 1;
  const deliveryRound = st?.deliveryRound || 1;

  // Latest prompt path
  const latestPromptPath = promptFilePath(taskId, currentSubtask, currentStage);

  // Latest reports for current subtask
  const subtaskStages = status.subtasks[currentSubtask]?.stages || {};
  const latestReports = [];
  for (const [stageId, sData] of Object.entries(subtaskStages)) {
    if (sData.primaryReportPath && fs.existsSync(sData.primaryReportPath)) {
      latestReports.push({ stage: stageId, path: sData.primaryReportPath, status: sData.stageStatus });
    }
  }

  // Next recommended command
  const nextCmd = getNextRecommendedCommand(taskId, status, stageData);

  console.log('═══════════════════════════════════════════════');
  console.log(`📍 ${taskId} — CURRENT STATE`);
  console.log('═══════════════════════════════════════════════');
  console.log();
  console.log(`| 项目 | 值 |`);
  console.log(`| --- | --- |`);
  console.log(`| taskStatus | ${status.taskStatus || 'in-progress'} |`);
  console.log(`| currentSubtask | ${currentSubtask} |`);
  console.log(`| subtaskTitle | ${subtask?.title || '?'} |`);
  console.log(`| subtaskStatus | ${status.subtasks[currentSubtask]?.status || '?'} |`);
  console.log(`| currentStage | ${currentStage} |`);
  console.log(`| stageStatus | ${stageData.stageStatus || '?'} |`);
  console.log(`| planRound | ${planRound} |`);
  console.log(`| codeRound | ${codeRound} |`);
  console.log(`| deliveryRound | ${deliveryRound} |`);
  console.log(`| currentRound | ${round} |`);
  console.log(`| targetWindow | ${targetWindow} |`);
  console.log(`| expectedSkill | ${config.requiredSkill || '(none)'} |`);
  console.log(`| awaitingCommit | ${status.awaitingCommit ? 'true' : 'false'} |`);
  if (status.awaitingCommit) {
    console.log(`| commitRequiredForSubtask | ${status.commitRequiredForSubtask || currentSubtask} |`);
  }
  console.log();

  if (latestReports.length > 0) {
    console.log('### Latest Reports');
    for (const r of latestReports) {
      console.log(`- [${r.status}] \`${r.path}\``);
    }
    console.log();
  }

  const promptExists = fs.existsSync(latestPromptPath);
  console.log(`**Latest prompt path:** \`${latestPromptPath}\` ${promptExists ? '✅' : '❌ (not yet generated)'}`);
  console.log();
  console.log(`**Next recommended command:**`);
  console.log(`  \`${nextCmd}\``);
  console.log();
  console.log('═══════════════════════════════════════════════');

  return {
    taskStatus: status.taskStatus || 'in-progress',
    currentSubtask,
    currentStage,
    targetWindow,
    expectedSkill: config.requiredSkill,
    planRound,
    codeRound,
    deliveryRound,
    awaitingCommit: status.awaitingCommit || false,
    commitRequiredForSubtask: status.commitRequiredForSubtask || null,
    latestPromptPath,
    latestReports,
    nextRecommendedCommand: nextCmd,
  };
  // P2-2: Persist migration / normalization on read-only commands too
  saveStatus(taskId, status);
}

function getTemplateName(stage) {
  const map = {
    'implementation-plan': '01-implementation-plan',
    'plan-review': '02-plan-review',
    'plan-fix': '03-plan-fix',
    'plan-fix-review': '04-plan-fix-review',
    'code-implementation': '05-code-implementation',
    'code-review': '06-code-review',
    'code-fix': '07-code-fix',
    'code-fix-review': '08-code-fix-review',
    'delivery': '09-delivery',
  };
  return map[stage] || '01-implementation-plan';
}

function generateContinuationPrompt(taskId, status, subtaskId, stage, subtask) {
  const stageData = status.subtasks[subtaskId]?.stages?.[stage];
  const vars = buildTemplateVars(taskId, subtaskId, stage, status);

  const handoffPath = stageData?.handoffPath || vars.handoffPath;
  const handoffExists = fs.existsSync(handoffPath);

  let prompt = '';

  const config = getStageConfig(stage) || {};
  const requiredSkill = config.requiredSkill;
  if (requiredSkill) {
    prompt += `请使用 \`<${requiredSkill}>\` 技能执行本阶段任务。\n\n`;
  }

  prompt += `# 🔄 继续中断任务 — ${subtaskId} ${subtask.title}\n\n`;
  prompt += `## ⚠️ 重要提示\n\n`;
  prompt += `你正在继续一个中断任务，**不要从头重做**。\n\n`;

  if (handoffExists) {
    prompt += `请先读取 handoff：\n`;
    prompt += `\`${handoffPath}\`\n\n`;
  } else {
    prompt += `⚠️ **handoff 文件不存在。** 请先从当前上下文重建 handoff，再继续任务。不能伪造完成状态。\n\n`;
  }

  prompt += `## 任务信息\n\n`;
  prompt += `- **taskId:** ${vars.taskId}\n`;
  prompt += `- **subtaskId:** ${vars.subtaskId}\n`;
  prompt += `- **subtaskTitle:** ${vars.subtaskTitle}\n`;
  prompt += `- **stage:** ${vars.stage}\n`;
  prompt += `- **stageStatus:** interrupted (继续中)\n`;
  prompt += `- **ownerProfile:** ${vars.ownerProfile}\n`;
  prompt += `- **requiredSkill:** ${vars.requiredSkill}\n`;
  if (stageData?.interruptReason) {
    prompt += `- **中断原因:** ${stageData.interruptReason}\n`;
  }
  prompt += `\n`;

  prompt += `## 产物路径\n\n`;
  prompt += `完成后把正式报告写到：\n`;
  prompt += `\`${vars.primaryReportPath}\`\n\n`;
  prompt += `并把机器可读副本写到：\n`;
  prompt += `\`${vars.mirrorOutputPath}\`\n\n`;

  prompt += `## 边界规则\n\n`;
  prompt += `- cwd: \`${CODE_REPO}\`\n`;
  prompt += `- **禁止**读取或修改 \`.claude/settings.json\`、API key、token、cookie\n`;
  prompt += `- 不可批准自己的方案或代码\n`;
  prompt += `- 不可执行 destructive git、commit、push（除非用户明确要求）\n`;

  prompt += `\n## 中断交接\n\n`;
  prompt += `如果再次中断，请写入 handoff：\n`;
  prompt += `- **primary handoff:** \`${vars.handoffPath}\`\n`;
  prompt += `- **mirror handoff:** \`${vars.mirrorHandoffPath}\`\n`;

  // V2: Don't console.log here — caller handles output
  return { prompt, stage, subtask: subtaskId, continuation: true };
}

// ---------------------------------------------------------------------------
// Gate check (P0-1: stage-specific gates)
// ---------------------------------------------------------------------------
function cmdCheck(taskId, opts = {}) {
  const status = opts.status ? structuredClone(opts.status) : loadStatus(taskId);
  if (opts.statusRef) opts.statusRef.current = status;
  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];

  if (!stageData) {
    console.log('❌ CHECK FAILED: No stage data');
    return { pass: false, reasons: ['No stage data'], stageCursor: getCurrentStageCursor(status), attemptRef: getCurrentAttemptRef(status), primarySnapshot: null };
  }

  const issues = [];
  const warnings = [];
  let requiresFixLoop = false;
  let reviewDecision = '';
  let openFindingCount = 0;
  const config = getStageConfig(currentStage) || {};

  // 1. Check primaryReportPath exists and non-empty
  const primaryPath = stageData.primaryReportPath;
  if (!primaryPath) {
    issues.push('primaryReportPath is not set');
  } else if (!fs.existsSync(primaryPath)) {
    issues.push(`primaryReportPath does not exist: ${primaryPath}`);
  } else {
    const content = fs.readFileSync(primaryPath, 'utf-8').trim();
    if (content.length === 0) {
      issues.push(`primaryReportPath is empty: ${primaryPath}`);
    }
    if (!stageData.outputBaseline) {
      warnings.push('Legacy stage has no output baseline; freshness check skipped once.');
    } else if (!hasFreshOutput(stageData)) {
      issues.push(`primaryReportPath was not updated for the current stage: ${primaryPath}`);
    }
  }

  // 2. Mirror is a Harness-managed derived artifact.
  const mirrorPath = stageData.mirrorOutputPath;

  // 3. Stage-specific gate checks
  if (primaryPath && fs.existsSync(primaryPath)) {
    const content = fs.readFileSync(primaryPath, 'utf-8');

    if (getReviewStages().includes(currentStage)) {
      const findings = parseFindings(content);
      const legacyFindingHeading = content.match(/^#{3,6}\s+(?!Finding\s+)(?:NEW\s+)?(?:W\d+-[A-Z]-\d{2}-)?P[012](?:#|-)\d+/m);
      const decision = detectReviewDecision(content);
      reviewDecision = decision;
      openFindingCount = findings.filter(f => f.status === 'open' || f.status === 'reopened').length;

      if (legacyFindingHeading) {
        issues.push(`${currentStage}: Legacy finding heading "${legacyFindingHeading[0]}" is not machine-readable. Use "### Finding ${currentSubtask}-P{0|1|2}-NN".`);
      }
      issues.push(...validateFindingContract(findings, currentSubtask).map(issue => `${currentStage}: ${issue}`));
      if (decision === 'changes-required' && findings.length === 0) {
        issues.push(`${currentStage}: Review requires changes but contains no machine-readable "### Finding ..." blocks.`);
      }
      if (decision === 'pass' && openFindingCount > 0) {
        issues.push(`${currentStage}: Decision is pass but ${openFindingCount} finding(s) remain open/reopened.`);
      }
    }

    if (currentStage === 'plan-review' || currentStage === 'code-review') {
      // Review stages: allow open P0/P1/P2 findings
      // Only check that report exists (already checked above)
      const pCount = (content.match(/### Finding\s+\S+/g) || []).length;
      if (pCount > 0) {
        console.log(`   ℹ️  Found ${pCount} finding(s) in report — allowed at ${currentStage} stage`);
      }
    }

    if (currentStage === 'plan-fix' || currentStage === 'code-fix') {
      // Fix stages: must have ### Fix Mapping (P1-7: line-level regex match)
      // P1-7: Must match a line that is EXACTLY "### Fix Mapping" (no extra chars on line)
      const headingMatch = content.match(/^###\s+Fix\s+Mapping\s*$/m);
      const hasCorrectHeading = !!headingMatch;
      // P1-7: Detect wrong heading level — any other markdown heading level for Fix Mapping
      const wrongHeadingMatch = content.match(/^(#{1,2}|#{4,})\s+Fix\s+Mapping\s*$/m);
      const hasWrongHeading = !!wrongHeadingMatch;

      if (!hasCorrectHeading) {
        if (hasWrongHeading) {
          issues.push(`${currentStage}: Fix Mapping heading level is wrong. Expected "### Fix Mapping", found "${wrongHeadingMatch[0]}".`);
        } else {
          issues.push(`${currentStage}: Missing "### Fix Mapping" section. The heading must be on its own line with exactly three hashes.`);
        }
        issues.push(`   当前阶段: ${currentStage}`);
        issues.push(`   current fix report: ${primaryPath}`);
        issues.push(`   expected heading: ### Fix Mapping (on its own line)`);
      }

      if (hasCorrectHeading) {
        // Check Fix Mapping coverage
        const fixMapping = parseFixMapping(content);

        // P1-5: Find latest blocking review report
        const roundGroup = config.roundGroup; // 'plan' or 'code'
        let latestBlockingReviewStage = null;

        if (roundGroup) {
          latestBlockingReviewStage = findPreviousReviewStage(status, currentSubtask, roundGroup);
        }

        if (latestBlockingReviewStage && latestBlockingReviewStage.primaryReportPath) {
          const reviewContent = fs.readFileSync(latestBlockingReviewStage.primaryReportPath, 'utf-8');
          const findings = parseFindings(reviewContent);

          // Filter open/reopened findings
          const openFindings = findings.filter(f =>
            f.status === 'open' || f.status === 'reopened'
          );

          if (openFindings.length > 0) {
            const mappedIds = fixMapping.map(m => m.finding);
            const unmapped = openFindings.filter(f => !mappedIds.includes(f.id));

            if (unmapped.length > 0) {
              // P1-5: Updated terminology
              issues.push(`${currentStage}: Fix Mapping 未覆盖 latest blocking review 中的以下 open/reopened findings（共 ${unmapped.length} 个）:`);
              issues.push(`   missing finding IDs: ${unmapped.map(f => f.id).join(', ')}`);
              issues.push(`   latest blocking review report: ${latestBlockingReviewStage.primaryReportPath}`);
              issues.push(`   current fix report: ${primaryPath}`);
              issues.push(`   ⚠️  Finding ID 必须精确匹配上一轮 review，不要补零、不要重命名、不要改编号。`);
            }

            // P1-6: Status validity check — all proposed statuses are allowed in FixReport
            // (deferred/false-positive are proposals only; fix-review confirms final)
            for (const m of fixMapping) {
              const statusVal = m.status;
              if (!['fixed', 'accepted', 'deferred', 'false-positive', 'needs-decision'].includes(statusVal)) {
                issues.push(`${currentStage}: Fix Mapping entry "${m.finding}" has invalid status "${statusVal}". Must be one of: fixed, accepted, deferred, false-positive, needs-decision`);
              }
            }

            // Check needs-decision blocks
            const needsDecision = fixMapping.filter(m => m.status === 'needs-decision');
            if (needsDecision.length > 0) {
              issues.push(`${currentStage}: These findings have status "needs-decision": ${needsDecision.map(m => m.finding).join(', ')} — blocks advancement`);
            }

            // P1-6: DO NOT enforce that P0/P1 must be fixed/accepted/deferred here.
            // FixReport is a PROPOSAL. The fix-review stage confirms final status.
            // Only fix-review findings (verified/accepted/deferred/false-positive) are final.
          } else {
            console.log(`   ℹ️  No open/reopened findings from latest blocking review`);
          }
        } else {
          console.log(`   ℹ️  No latest blocking review stage output found — skipping coverage check`);
        }
      }
    }

    if (currentStage === 'plan-fix-review' || currentStage === 'code-fix-review') {
      // Fix-review stages: only verified/accepted/deferred/false-positive pass
      const findings = parseFindings(content);

      // Check for "不通过" (not passed) flag
      const notPassed = content.includes('不通过') || content.includes('不通過') ||
        (content.includes('####') && content.includes('不通过'));

      // Check open/reopened P0/P1
      const openP0P1 = findings.filter(f =>
        (f.priority === 'P0' || f.priority === 'P1') &&
        (f.status === 'open' || f.status === 'reopened')
      );

      // Open/reopened P2 — blocked unless accepted/deferred
      const openP2 = findings.filter(f =>
        f.priority === 'P2' &&
        (f.status === 'open' || f.status === 'reopened')
      );

      if (openP0P1.length > 0 || openP2.length > 0) {
        requiresFixLoop = true;
        const openIds = [...openP0P1, ...openP2].map(f => f.id);
        warnings.push(`${currentStage}: Review requires another fix round for: ${openIds.join(', ')}`);
      }

      if (notPassed && findings.length === 0) {
        issues.push(`${currentStage}: Review report indicates "不通过" but contains no machine-readable findings.`);
      }
    }

    if (currentStage === 'delivery') {
      // Delivery: no open P0/P1/P2
      if (!content.includes('交付摘要') && !content.includes('Delivery Summary') && !content.includes('交付')) {
        issues.push('Delivery report missing delivery summary');
      }
      if (!content.includes('验证') && !content.includes('evidence') && !content.includes('测试') && !content.includes('Test Results')) {
        warnings.push('Delivery report may be missing verification evidence');
      }

      // Check for finding status table or residual risk
      const hasResidual = content.includes('residual risk') || content.includes('Residual Risk') || content.includes('残差') || content.includes('残余风险') || content.includes('残留风险');
      if (!hasResidual) {
        warnings.push('Delivery report may be missing residual risk section');
      }

      const acceptance = status.acceptances?.[currentSubtask];
      if (!acceptance) {
        issues.push(`Delivery blocked: manual acceptance is missing. Run: pnpm harness accept ${taskId} --note "<验收说明>"`);
      } else {
        const acceptedSnapshot = acceptance.outputSnapshot;
        const currentSnapshot = getFileSnapshot(primaryPath);
        if (!acceptedSnapshot || acceptance.primaryReportPath !== primaryPath ||
            acceptedSnapshot.sha256 !== currentSnapshot.sha256) {
          issues.push(`Delivery blocked: report changed after manual acceptance. Re-run: pnpm harness accept ${taskId} --note "<验收说明>"`);
        }
      }

      // Check all findings for the subtask
      const subtaskFindings = getAllFindingsForSubtask(status, currentSubtask);
      const unhandledP0 = subtaskFindings.filter(f => f.priority === 'P0' && (f.status === 'open' || f.status === 'reopened'));
      const unhandledP1 = subtaskFindings.filter(f => f.priority === 'P1' && (f.status === 'open' || f.status === 'reopened'));

      if (unhandledP0.length > 0) {
        issues.push(`Delivery blocked: P0 finding(s) still open/reopened: ${unhandledP0.map(f => f.id).join(', ')}`);
      }
      if (unhandledP1.length > 0) {
        issues.push(`Delivery blocked: P1 finding(s) still open/reopened: ${unhandledP1.map(f => f.id).join(', ')}`);
      }

      // P2: blocked unless accepted/deferred
      const unhandledP2 = subtaskFindings.filter(f => f.priority === 'P2' && (f.status === 'open' || f.status === 'reopened'));
      if (unhandledP2.length > 0) {
        issues.push(`Delivery blocked: P2 finding(s) still open/reopened (must be accepted/deferred): ${unhandledP2.map(f => f.id).join(', ')}`);
      }
    }

    // Check interrupted state
    if (stageData.stageStatus === 'interrupted') {
      const handoffPath = stageData.handoffPath;
      if (!handoffPath || !fs.existsSync(handoffPath)) {
        issues.push('Stage is interrupted and no handoff exists — cannot advance. Use resume-current.');
      } else if (!primaryPath || !fs.existsSync(primaryPath)) {
        issues.push('Handoff exists but primaryReportPath missing — use resume-current to complete, then advance.');
      }
    }
  }

  // Fabric-first gate — required before code-implementation
  const fabricGateStages = ['implementation-plan', 'plan-fix-review'];
  if (fabricGateStages.includes(currentStage)) {
    if (primaryPath && fs.existsSync(primaryPath)) {
      const content = fs.readFileSync(primaryPath, 'utf-8');
      if (!content.includes('Fabric 官方能力核查') && !content.includes('Fabric Official')) {
        issues.push('Fabric-first: 实施方案必须包含 "Fabric 官方能力核查" 章节。缺少该章节不允许进入代码实现。');
      }
    }
  }

  // Store findings count in stage data
  if (primaryPath && fs.existsSync(primaryPath)) {
    const content = fs.readFileSync(primaryPath, 'utf-8');
    const findings = parseFindings(content);
    stageData.openFindings = {
      P0: findings.filter(f => f.priority === 'P0' && (f.status === 'open' || f.status === 'reopened')).length,
      P1: findings.filter(f => f.priority === 'P1' && (f.status === 'open' || f.status === 'reopened')).length,
      P2: findings.filter(f => f.priority === 'P2' && (f.status === 'open' || f.status === 'reopened')).length,
    };
  }

  // Output results
  if (issues.length === 0) {
    if (opts.persist !== false && mirrorPath && primaryPath && fs.existsSync(primaryPath)) {
      ensureDir(path.dirname(mirrorPath));
      fs.copyFileSync(primaryPath, mirrorPath);
      stageData.mirrorSyncedAt = now();
    }
    if (opts.persist !== false) {
      bumpStageRevision(status);
      saveStatus(taskId, status);
    }
    console.log('✅ CHECK PASSED');
    if (warnings.length > 0) {
      console.log(`   Warnings: ${warnings.length}`);
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    return {
      pass: true,
      warnings,
      requiresFixLoop,
      reviewDecision,
      openFindingCount,
      stageCursor: getCurrentStageCursor(status),
      attemptRef: getCurrentAttemptRef(status),
      primarySnapshot: getFileSnapshot(primaryPath),
    };
  } else {
    if (opts.persist !== false && primaryPath && fs.existsSync(primaryPath)) {
      bumpStageRevision(status);
      saveStatus(taskId, status);
    }
    console.log('❌ CHECK FAILED:');
    issues.forEach(i => console.log(`   ❌ ${i}`));
    if (warnings.length > 0) {
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    return {
      pass: false,
      reasons: issues,
      warnings,
      requiresFixLoop: false,
      reviewDecision,
      openFindingCount,
      stageCursor: getCurrentStageCursor(status),
      attemptRef: getCurrentAttemptRef(status),
      primarySnapshot: getFileSnapshot(primaryPath),
    };
  }
}

function getPreviousStage(stage) {
  const allStages = getStages();
  const idx = allStages.indexOf(stage);
  if (idx <= 0) return null;
  return allStages[idx - 1];
}

// ---------------------------------------------------------------------------
// Advance (P0-1, P1-2, P1-3, V2: delivery commit checkpoint)
// ---------------------------------------------------------------------------
function cmdAdvance(taskId, opts = {}) {
  let status = opts.status ? structuredClone(opts.status) : loadStatus(taskId);
  if (opts.statusRef) opts.statusRef.current = status;

  // V2: Handle --confirm-committed when awaitingCommit
  if (opts.confirmCommitted) {
    // P1-4: Strict preconditions — exit non-zero on any violation
    if (!status.awaitingCommit) {
      console.log('⚠️  Not at commit checkpoint. Use regular "harness advance" first.');
      console.log('   --confirm-committed only works after a delivery passes and awaitingCommit is set.');
      return { success: false, error: 'not-awaiting-commit' };
    }
    if (!status.commitRequiredForSubtask) {
      console.log('⚠️  commitRequiredForSubtask is missing from status. Cannot confirm commit.');
      return { success: false, error: 'missing-commit-subtask' };
    }
    if (status.currentSubtask !== status.commitRequiredForSubtask) {
      console.log(`⚠️  Current subtask (${status.currentSubtask}) does not match commitRequiredForSubtask (${status.commitRequiredForSubtask}).`);
      console.log('   You may be at a different subtask. Use "harness current" to check.');
      return { success: false, error: 'commit-subtask-mismatch' };
    }
    if (status.currentStage !== 'delivery') {
      console.log(`⚠️  Current stage is "${status.currentStage}", not "delivery".`);
      console.log('   --confirm-committed only applies after a delivery passes.');
      return { success: false, error: 'commit-stage-mismatch' };
    }

    const commitSubtask = status.commitRequiredForSubtask;
    status.awaitingCommit = false;
    status.commitRequiredForSubtask = null;

    // Mark the subtask as completed
    status.subtasks[commitSubtask].status = 'completed';

    // Record residual risks from this subtask
    if (!status.residualRisks) status.residualRisks = [];
    status.residualRisks.push({
      subtask: commitSubtask,
      stage: 'delivery',
      risk: `${commitSubtask} delivery passed, manually committed by user.`,
      recordedAt: now(),
    });

    addHistory(status, 'confirm-committed', { subtask: commitSubtask });

    // Determine next subtask
    const allSubtasks = getSubtasksForTask();
    const currentIdx = allSubtasks.findIndex(s => s.id === commitSubtask);
    const nextSubtask = allSubtasks[currentIdx + 1];

    if (!nextSubtask) {
      // Last subtask done
      status.currentStage = 'done';
      status.taskStatus = 'completed';
      addHistory(status, 'task-completed', { subtask: commitSubtask });
      bumpStageRevision(status);
      if (opts.persist !== false) saveStatus(taskId, status);
      console.log(`✅ Commit confirmed. All subtasks completed! Task ${taskId} is done.`);
      console.log(`   currentStage: done`);
      console.log(`   nextRecommendedAction: 等待 Codex 总体验收`);
      return { success: true, advanced: true, taskDone: true };
    }

    // Advance to next subtask
    status.currentSubtask = nextSubtask.id;
    status.currentStage = 'implementation-plan';
    status.subtasks[nextSubtask.id].status = 'active';

    if (!status.subtasks[nextSubtask.id].planRound) status.subtasks[nextSubtask.id].planRound = 1;
    if (!status.subtasks[nextSubtask.id].codeRound) status.subtasks[nextSubtask.id].codeRound = 1;
    if (!status.subtasks[nextSubtask.id].deliveryRound) status.subtasks[nextSubtask.id].deliveryRound = 1;

    const round = determineRoundForStage(status, nextSubtask.id, 'implementation-plan');
    const newStage = {
      stageStatus: 'active',
      currentOutputPath: generateReportPath(taskId, nextSubtask, 'implementation-plan', round),
      latestAcceptedOutputPath: '',
      primaryReportPath: generateReportPath(taskId, nextSubtask, 'implementation-plan', round),
      mirrorOutputPath: path.join(outputsDir(taskId, nextSubtask.id), path.basename(generateReportPath(taskId, nextSubtask, 'implementation-plan', round))),
      handoffPath: generateHandoffPath(taskId, nextSubtask, 'implementation-plan'),
      mirrorHandoffPath: generateMirrorHandoffPath(taskId, nextSubtask, 'implementation-plan'),
      startedAt: now(),
      outputs: [],
    };
    status.subtasks[nextSubtask.id].stages['implementation-plan'] = newStage;

    addHistory(status, 'subtask-advanced', { subtask: nextSubtask.id, stage: 'implementation-plan' });
    bumpStageRevision(status);
    if (opts.persist !== false) saveStatus(taskId, status);

    console.log(`✅ Commit confirmed. Delivery completed for ${commitSubtask}, advancing to ${nextSubtask.id} / implementation-plan`);
    return { success: true, advanced: true, subtask: nextSubtask.id, stage: 'implementation-plan' };
  }

  // Run check first
  const checkResult = opts.checkResult || cmdCheck(taskId);
  if (!checkResult.pass) {
    console.log('\n❌ Cannot advance: gate check failed. Fix issues before advancing.');
    return { success: false };
  }
  if (!opts.checkResult) status = loadStatus(taskId);
  if (opts.statusRef) opts.statusRef.current = status;
  assertCheckEvidence(status, checkResult);

  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];
  const config = getStageConfig(currentStage) || {};

  if (checkResult.requiresFixLoop) {
    const loopGroup = currentStage === 'plan-fix-review' ? 'plan' : 'code';
    const fixStage = loopGroup === 'plan' ? 'plan-fix' : 'code-fix';
    const roundKey = `${loopGroup}Round`;
    const subtaskState = status.subtasks[currentSubtask];
    const previousFixStage = subtaskState.stages[fixStage] || {};

    stageData.stageStatus = 'completed-with-findings';
    stageData.completedAt = now();
    stageData.outputs = stageData.outputs || [];
    if (stageData.primaryReportPath && !stageData.outputs.includes(stageData.primaryReportPath)) {
      stageData.outputs.push(stageData.primaryReportPath);
    }

    subtaskState[roundKey] = (subtaskState[roundKey] || 1) + 1;
    const nextRound = subtaskState[roundKey];
    const subtask = getSubtasksForTask().find(item => item.id === currentSubtask);
    const reportPath = generateReportPath(taskId, subtask, fixStage, nextRound);
    subtaskState.stages[fixStage] = {
      stageStatus: 'active',
      currentOutputPath: reportPath,
      latestAcceptedOutputPath: previousFixStage.latestAcceptedOutputPath || '',
      primaryReportPath: reportPath,
      mirrorOutputPath: path.join(outputsDir(taskId, currentSubtask), path.basename(reportPath)),
      handoffPath: generateHandoffPath(taskId, subtask, fixStage),
      mirrorHandoffPath: generateMirrorHandoffPath(taskId, subtask, fixStage),
      startedAt: now(),
      outputs: previousFixStage.outputs || [],
      reviewFindingsPath: stageData.primaryReportPath || '',
    };

    status.currentStage = fixStage;
    addHistory(status, 'fix-review-loop', {
      subtask: currentSubtask,
      fromStage: currentStage,
      toStage: fixStage,
      round: nextRound,
    });
    bumpStageRevision(status);
    if (opts.persist !== false) saveStatus(taskId, status);

    console.log(`🔁 ${currentStage} requires changes; returning to ${fixStage}.`);
    console.log(`   Round: ${nextRound}`);
    return { success: true, advanced: true, looped: true, subtask: currentSubtask, stage: fixStage };
  }

  // V2: Delivery stage → awaitingCommit instead of direct advance to next subtask
  if (currentStage === 'delivery') {
    // Mark delivery stage as completed
    stageData.stageStatus = 'completed';
    stageData.completedAt = now();

    if (stageData.primaryReportPath) {
      stageData.latestAcceptedOutputPath = stageData.primaryReportPath;
      if (!stageData.outputs.includes(stageData.primaryReportPath)) {
        stageData.outputs.push(stageData.primaryReportPath);
      }
    }

    // Set awaitingCommit — do NOT advance to next subtask automatically
    status.awaitingCommit = true;
    status.commitRequiredForSubtask = currentSubtask;

    addHistory(status, 'delivery-passed-awaiting-commit', { subtask: currentSubtask });
    bumpStageRevision(status);
    if (opts.persist !== false) saveStatus(taskId, status);

    console.log('═══════════════════════════════════════════════');
    console.log(`✅ Delivery passed for ${currentSubtask}.`);
    console.log();
    console.log('⏸️  Manual commit checkpoint is required before continuing.');
    console.log('   Harness will not commit automatically.');
    console.log();
    console.log('   请先手动 commit 业务代码，然后运行:');
    console.log(`   pnpm harness advance ${taskId} --confirm-committed`);
    console.log('═══════════════════════════════════════════════');

    return { success: true, advanced: true, awaitingCommit: true, subtask: currentSubtask, stage: 'delivery' };
  }

  // Mark current stage as completed
  stageData.stageStatus = 'completed';
  stageData.completedAt = now();

  // Update latestAcceptedOutputPath (P1-5)
  if (stageData.primaryReportPath) {
    stageData.latestAcceptedOutputPath = stageData.primaryReportPath;
    // Add to outputs list
    if (!stageData.outputs.includes(stageData.primaryReportPath)) {
      stageData.outputs.push(stageData.primaryReportPath);
    }
  }

  addHistory(status, 'stage-completed', { subtask: currentSubtask, stage: currentStage });

  // Determine next stage
  let nextStage = config.nextStage;
  if (currentStage === 'plan-review' && checkResult.openFindingCount === 0) {
    nextStage = 'code-implementation';
  } else if (currentStage === 'code-review' && checkResult.openFindingCount === 0) {
    nextStage = 'delivery';
  }

  if (!nextStage) {
    // Done stage or no next stage
    status.subtasks[currentSubtask].status = 'completed';
    status.currentStage = 'done';
    status.taskStatus = 'completed';
    addHistory(status, 'subtask-completed', { subtask: currentSubtask });
    console.log(`✅ All stages completed for ${currentSubtask}.`);
    console.log(`   Task ${taskId} completed.`);
    bumpStageRevision(status);
    if (opts.persist !== false) saveStatus(taskId, status);
    return { success: true, advanced: true, taskDone: true };
  }

  // Same subtask, next stage
  status.currentStage = nextStage;

  const allSubtasks = getSubtasksForTask();
  const subtask = allSubtasks.find(s => s.id === currentSubtask);

  // Determine round for the new stage (P1-3)
  const nextRound = getRoundForStage(status, currentSubtask, nextStage);
  const previousNextStage = status.subtasks[currentSubtask].stages?.[nextStage] || {};
  const nextStageData = {
    stageStatus: 'active',
    currentOutputPath: generateReportPath(taskId, subtask, nextStage, nextRound),
    latestAcceptedOutputPath: '',
    primaryReportPath: generateReportPath(taskId, subtask, nextStage, nextRound),
    mirrorOutputPath: path.join(outputsDir(taskId, currentSubtask), path.basename(generateReportPath(taskId, subtask, nextStage, nextRound))),
    handoffPath: generateHandoffPath(taskId, subtask, nextStage),
    mirrorHandoffPath: generateMirrorHandoffPath(taskId, subtask, nextStage),
    startedAt: now(),
    outputs: previousNextStage.outputs || [],
  };
  if (nextStage === 'plan-fix' || nextStage === 'code-fix') {
    nextStageData.reviewFindingsPath = stageData.primaryReportPath || '';
  }

  if (!status.subtasks[currentSubtask].stages) {
    status.subtasks[currentSubtask].stages = {};
  }
  status.subtasks[currentSubtask].stages[nextStage] = nextStageData;

  // Ensure reportDir and output dir exist
  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  if (opts.persist !== false) {
    ensureDir(path.join(getEffectiveReviewRoot(), week, currentSubtask));
    ensureDir(outputsDir(taskId, currentSubtask));
  }

  addHistory(status, 'stage-advanced', { subtask: currentSubtask, stage: nextStage });
  bumpStageRevision(status);
  if (opts.persist !== false) saveStatus(taskId, status);

  console.log(`✅ Advanced to ${currentSubtask} / ${nextStage}`);
  if (getStageConfig(nextStage)?.roundGroup) {
    console.log(`   Round: ${nextRound}`);
  }
  return { success: true, advanced: true, subtask: currentSubtask, stage: nextStage };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function cmdStatus(taskId) {
  const status = loadStatus(taskId, { persistMigration: false });

  console.log(`\n📊 ${taskId} Status`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Current: ${status.currentSubtask} / ${status.currentStage}`);
  console.log(`Updated: ${status.updatedAt}`);
  console.log();

  const allSubtasks = getSubtasksForTask();
  console.log('Subtasks:');

  for (const s of allSubtasks) {
    const st = status.subtasks[s.id];
    if (!st) continue;

    const icon = s.id === status.currentSubtask ? '👉' : '  ';
    let stageInfo = '';
    if (s.id === status.currentSubtask) {
      const cs = st.stages[status.currentStage];
      if (cs) {
        stageInfo = ` [${status.currentStage}: ${cs.stageStatus}]`;
      }
    } else {
      stageInfo = ` [${st.status}]`;
    }

    // Show round info for active subtask
    let roundInfo = '';
    if (s.id === status.currentSubtask) {
      const roundParts = [];
      if (st.planRound > 1) roundParts.push(`planRound=${st.planRound}`);
      if (st.codeRound > 1) roundParts.push(`codeRound=${st.codeRound}`);
      if (st.deliveryRound > 1) roundParts.push(`deliveryRound=${st.deliveryRound}`);
      if (roundParts.length > 0) roundInfo = ` (${roundParts.join(', ')})`;
    }

    console.log(`${icon} ${s.id} ${s.title}${stageInfo}${roundInfo}`);
  }

  if (status.residualRisks && status.residualRisks.length > 0) {
    console.log();
    console.log('Residual Risks:');
    for (const r of status.residualRisks) {
      console.log(`  ⚠️  ${r.subtask}${r.stage ? '/' + r.stage : ''}: ${r.risk.slice(0, 80)}...`);
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Summary (V2: enhanced with awaitingCommit, open findings, next command)
// ---------------------------------------------------------------------------
function cmdSummary(taskId) {
  const status = loadStatus(taskId, { persistMigration: false });
  const allSubtasks = getSubtasksForTask();
  const allStages = getStages();

  console.log(`\n# ${taskId} Summary`);
  console.log();

  // Task status overview
  console.log('## 任务状态');
  console.log();
  console.log(`| 项目 | 值 |`);
  console.log(`| --- | --- |`);
  console.log(`| taskStatus | ${status.taskStatus || 'in-progress'} |`);
  console.log(`| currentSubtask | ${status.currentSubtask} |`);
  console.log(`| currentStage | ${status.currentStage} |`);
  console.log(`| awaitingCommit | ${status.awaitingCommit ? 'true' : 'false'} |`);
  if (status.awaitingCommit) {
    console.log(`| commitRequiredForSubtask | ${status.commitRequiredForSubtask} |`);
  }
  console.log();

  // Subtask table
  console.log('## 子任务进度');
  console.log();
  console.log(`| Subtask | Title | Status | Key Stage |`);
  console.log(`| --- | --- | --- | --- |`);

  const completedSubtasks = [];

  for (const s of allSubtasks) {
    const st = status.subtasks[s.id];
    if (!st) continue;

    let keyStage = '';
    for (const stageId of [...allStages].reverse()) {
      const sd = st.stages[stageId];
      if (sd && ['completed', 'active', 'interrupted'].includes(sd.stageStatus)) {
        keyStage = `${stageId} (${sd.stageStatus})`;
        break;
      }
    }
    if (!keyStage) {
      keyStage = st.status || 'unknown';
    }

    if (st.status === 'completed' || st.status === 'imported-completed') {
      completedSubtasks.push(s.id);
    }

    console.log(`| ${s.id} | ${s.title} | ${st.status} | ${keyStage} |`);
  }

  console.log();
  console.log(`**Completed subtasks:** ${completedSubtasks.length > 0 ? completedSubtasks.join(', ') : '(none)'}`);
  console.log();

  // Latest reports for current subtask
  const subtaskStages = status.subtasks[status.currentSubtask]?.stages || {};
  const latestReports = [];
  for (const [stageId, sData] of Object.entries(subtaskStages)) {
    if (sData.primaryReportPath) {
      const exists = fs.existsSync(sData.primaryReportPath);
      latestReports.push({ stage: stageId, path: sData.primaryReportPath, status: sData.stageStatus, exists });
    }
  }

  if (latestReports.length > 0) {
    console.log('## 当前子任务报告');
    console.log();
    for (const r of latestReports) {
      const icon = r.exists ? '✅' : '❌';
      console.log(`- ${icon} [${r.status}] \`${r.path}\``);
    }
    console.log();
  }

  // Open/reopened findings for current subtask
  const allFindings = getAllFindingsForSubtask(status, status.currentSubtask);
  const openFindings = allFindings.filter(f => f.status === 'open' || f.status === 'reopened');
  if (openFindings.length > 0) {
    console.log('## Open/Reopened Findings');
    console.log();
    const byPriority = { P0: [], P1: [], P2: [] };
    for (const f of openFindings) {
      (byPriority[f.priority] || byPriority.P2).push(f);
    }
    for (const p of ['P0', 'P1', 'P2']) {
      if (byPriority[p].length > 0) {
        console.log(`- ${p}: ${byPriority[p].map(f => f.id).join(', ')}`);
      }
    }
    console.log();
  }

  // Residual risks
  if (status.residualRisks && status.residualRisks.length > 0) {
    console.log('## Residual Risks');
    console.log();
    for (const r of status.residualRisks) {
      console.log(`- ${r.subtask}${r.stage ? '/' + r.stage : ''}: ${r.risk}`);
    }
    console.log();
  }

  // Latest prompt path
  const latestPromptPath = promptFilePath(taskId, status.currentSubtask, status.currentStage);
  const promptExists = fs.existsSync(latestPromptPath);
  console.log(`**Latest prompt path:** \`${latestPromptPath}\` ${promptExists ? '✅' : '❌ (not yet generated)'}`);
  console.log();

  // Next recommended command
  const nextCmd = getNextRecommendedCommand(taskId, status, subtaskStages[status.currentStage] || {});

  console.log('## Next Recommended Command');
  console.log();
  console.log(`\`${nextCmd}\``);
  console.log();
}

// ---------------------------------------------------------------------------
// Manual acceptance
// ---------------------------------------------------------------------------
function cmdAccept(taskId, opts = {}) {
  const status = loadStatus(taskId);
  const note = String(opts.note || '').trim();
  if (!note) throw new Error('--note "<acceptance evidence>" is required');
  if (status.currentStage !== 'delivery') {
    throw new Error(`Manual acceptance can only be recorded at delivery; currentStage=${status.currentStage}`);
  }

  const stageData = status.subtasks[status.currentSubtask]?.stages?.delivery;
  const primaryReportPath = stageData?.primaryReportPath;
  const outputSnapshot = getFileSnapshot(primaryReportPath);
  if (!outputSnapshot.exists || outputSnapshot.size === 0) {
    throw new Error(`Manual acceptance requires a non-empty delivery report: ${primaryReportPath || '(missing path)'}`);
  }

  if (!status.acceptances) status.acceptances = {};
  status.acceptances[status.currentSubtask] = {
    acceptedAt: now(),
    note,
    primaryReportPath,
    outputSnapshot,
  };
  addHistory(status, 'manual-acceptance', {
    subtask: status.currentSubtask,
    note,
  });
  if (!status.execution?.activeAttemptId) bumpStageRevision(status);
  saveStatus(taskId, status);
  console.log(`✅ Manual acceptance recorded for ${status.currentSubtask}`);
  console.log(`   note: ${note}`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function cmdImport(taskId, opts = {}) {
  const { completed } = opts;
  if (!completed) throw new Error('--completed <subtaskId> is required for import');

  const status = loadStatus(taskId);
  const allSubtasks = getSubtasksForTask();

  const subtask = allSubtasks.find(s => s.id === completed);
  if (!subtask) throw new Error(`Unknown subtask: ${completed}`);

  const st = status.subtasks[completed];
  if (!st) throw new Error(`Subtask ${completed} not in status`);

  st.status = 'imported-completed';
  const allStages = getStages();
  for (const stageId of allStages) {
    if (st.stages[stageId]) {
      st.stages[stageId].stageStatus = 'imported-completed';
      st.stages[stageId].currentOutputPath = '';
      st.stages[stageId].latestAcceptedOutputPath = '';
      st.stages[stageId].outputs = [];
    } else {
      st.stages[stageId] = { stageStatus: 'imported-completed', currentOutputPath: '', latestAcceptedOutputPath: '', outputs: [] };
    }
  }

  const existingRisk = (status.residualRisks || []).find(r => r.subtask === completed && r.stage === 'all');
  if (!existingRisk) {
    if (!status.residualRisks) status.residualRisks = [];
    status.residualRisks.push({
      subtask: completed,
      stage: 'all',
      risk: `${completed} completed before Harness creation; historical evidence was not re-run by Harness.`,
      recordedAt: now(),
    });
  }

  const completedIdx = allSubtasks.findIndex(s => s.id === completed);
  const nextSubtask = allSubtasks[completedIdx + 1];
  if (nextSubtask && status.currentSubtask === completed) {
    status.currentSubtask = nextSubtask.id;
    status.currentStage = 'implementation-plan';
    const ns = status.subtasks[nextSubtask.id];
    ns.status = 'active';
    if (!ns.planRound) ns.planRound = 1;
    if (!ns.codeRound) ns.codeRound = 1;
    if (!ns.deliveryRound) ns.deliveryRound = 1;

    const round = determineRoundForStage(status, nextSubtask.id, 'implementation-plan');
    ns.stages['implementation-plan'] = {
      stageStatus: 'active',
      currentOutputPath: generateReportPath(taskId, nextSubtask, 'implementation-plan', round),
      latestAcceptedOutputPath: '',
      primaryReportPath: generateReportPath(taskId, nextSubtask, 'implementation-plan', round),
      mirrorOutputPath: path.join(outputsDir(taskId, nextSubtask.id), path.basename(generateReportPath(taskId, nextSubtask, 'implementation-plan', round))),
      handoffPath: generateHandoffPath(taskId, nextSubtask, 'implementation-plan'),
      mirrorHandoffPath: generateMirrorHandoffPath(taskId, nextSubtask, 'implementation-plan'),
      startedAt: now(),
      outputs: [],
    };
  }

  addHistory(status, 'import', { completed });
  bumpStageRevision(status);
  saveStatus(taskId, status);

  console.log(`✅ Imported ${completed} as completed`);
  console.log(`   currentSubtask: ${status.currentSubtask}`);
  console.log(`   currentStage: ${status.currentStage}`);
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------
function cmdResume(taskId, opts = {}) {
  const { from, stage } = opts;
  if (!from || !stage) throw new Error('--from <subtask> and --stage <stage> are required');

  const status = loadStatus(taskId);
  const allSubtasks = getSubtasksForTask();

  const fromIdx = allSubtasks.findIndex(s => s.id === from);
  if (fromIdx === -1) throw new Error(`Unknown subtask: ${from}`);
  const allStages = getStages();
  if (!allStages.includes(stage)) throw new Error(`Unknown stage: ${stage}`);

  const startStageIdx = getStageIndex(stage);

  for (let i = 0; i < fromIdx; i++) {
    const sid = allSubtasks[i].id;
    const st = status.subtasks[sid];
    if (st && st.status === 'pending') {
      st.status = 'imported-completed';
      for (const s of allStages) {
        if (!st.stages[s] || st.stages[s].stageStatus === 'pending') {
          st.stages[s] = { stageStatus: 'imported-completed', currentOutputPath: '', latestAcceptedOutputPath: '', outputs: [] };
        }
      }
    }
  }

  const curSt = status.subtasks[from];
  curSt.status = 'active';
  const newlyAssumedStages = [];
  for (let si = 0; si < startStageIdx; si++) {
    const sid = allStages[si];
    if (!curSt.stages[sid] || curSt.stages[sid].stageStatus === 'pending') {
      curSt.stages[sid] = { stageStatus: 'assumed-completed', currentOutputPath: '', latestAcceptedOutputPath: '', outputs: [] };
      newlyAssumedStages.push(sid);
    } else if (curSt.stages[sid].stageStatus === 'active') {
      curSt.stages[sid].stageStatus = 'assumed-completed';
      newlyAssumedStages.push(sid);
    }
  }

  status.currentSubtask = from;
  status.currentStage = stage;

  // Ensure round counters
  if (!curSt.planRound) curSt.planRound = 1;
  if (!curSt.codeRound) curSt.codeRound = 1;
  if (!curSt.deliveryRound) curSt.deliveryRound = 1;

  const curRound = getRoundForStage(status, from, stage);
  curSt.stages[stage] = {
    stageStatus: 'active',
    currentOutputPath: generateReportPath(taskId, allSubtasks[fromIdx], stage, curRound),
    latestAcceptedOutputPath: '',
    primaryReportPath: generateReportPath(taskId, allSubtasks[fromIdx], stage, curRound),
    mirrorOutputPath: path.join(outputsDir(taskId, from), path.basename(generateReportPath(taskId, allSubtasks[fromIdx], stage, curRound))),
    handoffPath: generateHandoffPath(taskId, allSubtasks[fromIdx], stage),
    mirrorHandoffPath: generateMirrorHandoffPath(taskId, allSubtasks[fromIdx], stage),
    startedAt: now(),
    outputs: [],
  };

  if (!status.residualRisks) status.residualRisks = [];
  for (const sid of newlyAssumedStages) {
    const existing = status.residualRisks.find(r => r.subtask === from && r.stage === sid);
    if (!existing) {
      status.residualRisks.push({
        subtask: from,
        stage: sid,
        risk: `${sid} was assumed-completed (not run through Harness). Residual risk applies.`,
        recordedAt: now(),
      });
    }
  }

  addHistory(status, 'resume', { from, stage });
  bumpStageRevision(status);
  saveStatus(taskId, status);

  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  ensureDir(path.join(getEffectiveReviewRoot(), week, from));

  console.log(`✅ Resumed ${taskId} from ${from} / ${stage}`);
}

// ---------------------------------------------------------------------------
// Set current
// ---------------------------------------------------------------------------
function cmdSetCurrent(taskId, subtaskId, stage) {
  const status = loadStatus(taskId);
  const allStages = getStages();

  if (!allStages.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
  const allSubtasks = getSubtasksForTask();
  if (!allSubtasks.find(s => s.id === subtaskId)) throw new Error(`Unknown subtask: ${subtaskId}`);

  status.currentSubtask = subtaskId;
  status.currentStage = stage;

  addHistory(status, 'set-current', { subtask: subtaskId, stage });
  bumpStageRevision(status);
  saveStatus(taskId, status);

  console.log(`✅ Set current position to ${subtaskId} / ${stage}`);
}

// ---------------------------------------------------------------------------
// Interrupt
// ---------------------------------------------------------------------------
function cmdInterrupt(taskId, opts = {}) {
  const { reason } = opts;
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;

  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];
  if (!stageData) throw new Error(`No stage data for ${currentSubtask} / ${currentStage}`);

  stageData.stageStatus = 'interrupted';
  stageData.interruptReason = reason || 'No reason provided';
  stageData.expectedHandoffPath = stageData.handoffPath;

  if (!stageData.handoffPath) {
    const allSubtasks = getSubtasksForTask();
    const subtask = allSubtasks.find(s => s.id === currentSubtask);
    stageData.handoffPath = generateHandoffPath(taskId, subtask, currentStage);
    stageData.mirrorHandoffPath = generateMirrorHandoffPath(taskId, subtask, currentStage);
  }

  addHistory(status, 'interrupt', { subtask: currentSubtask, stage: currentStage, reason });
  bumpStageRevision(status);
  saveStatus(taskId, status);

  console.log(`⚠️  Interrupted ${currentSubtask} / ${currentStage}`);
  console.log(`   Reason: ${reason || 'No reason provided'}`);
  console.log(`   Expected handoff: ${stageData.handoffPath}`);
}

// ---------------------------------------------------------------------------
// Resume current
// ---------------------------------------------------------------------------
function cmdResumeCurrent(taskId) {
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];

  if (!stageData) throw new Error(`No stage data for ${currentSubtask} / ${currentStage}`);

  if (stageData.stageStatus !== 'interrupted') {
    console.log(`⚠️  Current stage is not interrupted (status: ${stageData.stageStatus}). Use "harness next" instead.`);
    return cmdNext(taskId);
  }

  const allSubtasks = getSubtasksForTask();
  const subtask = allSubtasks.find(s => s.id === currentSubtask);
  const result = generateContinuationPrompt(taskId, status, currentSubtask, currentStage, subtask);

  // V2: Save prompt and output structured info
  const promptPath = promptFilePath(taskId, currentSubtask, currentStage);
  ensureDir(path.dirname(promptPath));
  fs.writeFileSync(promptPath, result.prompt, 'utf-8');

  const config = getStageConfig(currentStage) || {};
  const targetWindow = getTargetWindow(currentStage);

  console.log('═══════════════════════════════════════════════');
  console.log(`🔄 RESUMED PROMPT (continuation)`);
  console.log(`   currentSubtask: ${currentSubtask}`);
  console.log(`   currentStage: ${currentStage}`);
  console.log(`   targetWindow: ${targetWindow}`);
  console.log(`   promptPath: ${promptPath}`);
  console.log('═══════════════════════════════════════════════');
  console.log();
  console.log(result.prompt);

  return { ...result, promptPath, targetWindow };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------
function cmdBrief(taskId) {
  const status = loadStatus(taskId, { persistMigration: false });
  const { currentSubtask, currentStage } = status;
  const allSubtasks = getSubtasksForTask();
  const subtask = allSubtasks.find(s => s.id === currentSubtask);
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage] || {};
  const cfg = getWorkflowConfig();
  const week = taskId.split('-')[0];
  const reportDir = path.join(getEffectiveReviewRoot(), week, currentSubtask);
  const config = getStageConfig(currentStage) || {};

  console.log(`# ${taskId} Session Brief`);
  console.log(`Generated: ${now()}`);
  console.log();

  console.log('## 1. Harness 自身文件');
  console.log();
  const harnessFiles = [
    path.join(HARNESS_ROOT, 'README.md'),
    path.join(HARNESS_ROOT, 'AGENTS.md'),
    path.join(HARNESS_ROOT, 'workflows', 'weekly-canvas-task.json'),
    path.join(HARNESS_ROOT, 'workflows', 'weekly-canvas-task.yaml'),
    statusPath(taskId),
  ];
  for (const f of harnessFiles) {
    const exists = fs.existsSync(f) ? '✅' : '❌';
    console.log(`- ${exists} \`${f}\``);
  }
  const summaryPath = path.join(HARNESS_ROOT, 'runs', taskId, 'summary.md');
  if (fs.existsSync(summaryPath)) {
    console.log(`- ✅ \`${summaryPath}\``);
  }
  console.log();

  console.log('## 2. Review 规则文件');
  console.log();
  const reviewFiles = [
    path.join(getEffectiveReviewRoot(), 'AGENTS.md'),
    path.join(REVIEW_PLAYBOOKS, 'plan-review-playbook.md'),
    path.join(REVIEW_PLAYBOOKS, 'code-review-playbook.md'),
    path.join(REVIEW_PLAYBOOKS, 'canvas-stage-review-playbook.md'),
  ];
  for (const f of reviewFiles) {
    const exists = fs.existsSync(f) ? '✅' : '❌';
    console.log(`- ${exists} \`${f}\``);
  }
  console.log();

  console.log(`## 3. 当前子任务文件 — ${currentSubtask}`);
  console.log();

  if (fs.existsSync(reportDir)) {
    const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort();
    if (files.length === 0) {
      console.log('(暂无文件)');
    } else {
      const categories = {
        '实施计划': f => f.includes('实施计划'),
        'PlanReview': f => f.includes('计划Review意见') || f.includes('计划FixReview意见'),
        'PlanFixReport': f => f.includes('计划-FixReport') || f.includes('计划Fix报告'),
        '任务到代码映射': f => f.includes('任务到代码映射'),
        'CodeReview': f => f.includes('CodeReview意见'),
        'CodeFixReport': f => f.includes('CodeFix报告'),
        'CodeFixReview': f => f.includes('CodeFix复审意见'),
        '交付物报告': f => f.includes('交付物报告'),
        'handoff': f => f.includes('handoff'),
      };

      for (const [cat, predicate] of Object.entries(categories)) {
        const matched = files.filter(predicate);
        if (matched.length > 0) {
          console.log(`### ${cat}`);
          for (const f of matched) {
            const fullPath = path.join(reportDir, f);
            const stat = fs.statSync(fullPath);
            const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
            const mtime = stat.mtime.toISOString().slice(0, 19).replace('T', ' ');
            console.log(`- \`${fullPath}\` (${size}, ${mtime})`);
          }
          console.log();
        }
      }

      const categorized = new Set();
      for (const [cat, predicate] of Object.entries(categories)) {
        files.filter(predicate).forEach(f => categorized.add(f));
      }
      const uncategorized = files.filter(f => !categorized.has(f));
      if (uncategorized.length > 0) {
        console.log('### 其他');
        for (const f of uncategorized) {
          console.log(`- \`${path.join(reportDir, f)}\``);
        }
        console.log();
      }
    }
  } else {
    console.log(`❌ reportDir 不存在: \`${reportDir}\``);
    console.log();
  }

  console.log('## 4. 当前下一步');
  console.log();
  console.log(`| 项目 | 值 |`);
  console.log(`| --- | --- |`);
  console.log(`| currentSubtask | ${currentSubtask} |`);
  console.log(`| subtaskTitle | ${subtask?.title || '?'} |`);
  console.log(`| currentStage | ${currentStage} |`);
  console.log(`| stageStatus | ${stageData.stageStatus || '?'} |`);
  const round = getRoundForStage(status, currentSubtask, currentStage);
  console.log(`| round | ${round} |`);
  console.log(`| ownerProfile | ${config.ownerProfile || '?'} |`);
  console.log(`| requiredSkill | ${config.requiredSkill || 'null'} |`);

  let nextCmd = 'harness next ' + taskId;
  if (stageData.stageStatus === 'interrupted') {
    nextCmd = 'harness resume-current ' + taskId;
  } else if (stageData.stageStatus === 'completed') {
    nextCmd = 'harness advance ' + taskId;
  } else if (stageData.stageStatus === 'active' || stageData.stageStatus === 'assumed-completed') {
    nextCmd = 'harness next ' + taskId;
  }
  console.log(`| nextRecommendedCommand | \`${nextCmd}\` |`);
  console.log();

  if (stageData.primaryReportPath) {
    console.log(`**primaryReportPath:** \`${stageData.primaryReportPath}\``);
  }
  if (stageData.handoffPath) {
    console.log(`**handoffPath:** \`${stageData.handoffPath}\``);
  }
  console.log();

  console.log('---');
  console.log('> brief 只输出文件清单和摘要，不修改状态，不扫描敏感路径。');
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];
  const positional = [];
  const opts = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      opts[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, opts };
}

function printUsage() {
  console.log(`HEXAI Review Harness V2

Usage:
  harness init <taskId> [--from <subtask>] [--stage <stage>]
                      [--force] [--archive-existing]
  harness next <taskId> [--copy]
  harness step <taskId> [--no-copy]
  harness current <taskId>
  harness check <taskId>
  harness advance <taskId> [--confirm-committed]
  harness status <taskId>
  harness summary <taskId>
  harness accept <taskId> --note "<acceptance evidence>"
  harness import <taskId> --completed <subtask>
  harness resume <taskId> --from <subtask> --stage <stage>
  harness set-current <taskId> <subtask> <stage>
  harness interrupt <taskId> --reason "<reason>"
  harness resume-current <taskId>
  harness brief <taskId>

V2 New Commands:
  step          check → advance → next (chain, stops on first failure)
  current       只读当前状态，显示 targetWindow、expectedSkill、next command

V2 New Options:
  --copy               Copy prompt to clipboard (macOS pbcopy)
  --no-copy            Do not copy prompt when using step (step copies by default)
  --confirm-committed  Confirm manual commit after delivery checkpoint

Examples:
  harness init W6-A
  harness init W6-A --from W6-A-03 --stage code-review
  harness init W6-A --force
  harness next W6-A --copy
  harness step W6-A
  harness current W6-A
  harness check W6-A
  harness advance W6-A
  harness advance W6-A --confirm-committed
  harness status W6-A
  harness brief W6-A
  harness accept W6-A --note "人工验收通过"
  harness doctor W6-A [--adapter fake|manual]
  harness run W6-A [--adapter fake|manual]
  harness pump W6-A [--adapter fake|manual]
  harness jobs W6-A [--json]
  harness retry W6-A --job <jobId> [--adapter fake]
  harness cancel W6-A --job <jobId> --attempt <attemptId> --lease-token <token>
  harness reconcile W6-A --attempt <attemptId> --decision sent|not-sent|abandon [evidence]
  harness <manual-command> W6-A --takeover --reason "<reason>"
  harness worker-attach W6-A --role work|review --binding <bindingId> [--cwd <path>] [--dry-run]
  harness worker-launch W6-A --role work|review --binding <bindingId> [--cwd <path>] [--dry-run]
  harness worker-heartbeat W6-A --binding <bindingId>
  harness worker-detach W6-A --binding <bindingId> --reason <text>
  harness worker-hook-probe W6-A --payload <payload.json>
  harness worker-bindings W6-A [--json]
  harness worker-challenge W6-A --binding <bindingId>
  harness worker-challenge W6-A --probe-hook-payload <fixture.json>
  harness worker-receipt W6-A --attempt <attemptId> --kind job.completed --sequence 1 [--binding <bindingId>]
  harness warp-doctor W6-A [--json] [--probe-fixture] [--probe-real]
  harness warp-targets W6-A --role work|review [--json]
  harness warp-bind-target W6-A --role work|review --binding <bindingId> --candidate <candidateId> [--respond-fixture] [--real]
  harness warp-shadow-send W6-A --role work|review --binding <bindingId> [--message <text>]
  harness pilot-doctor W6-A [--json]
  harness pilot-allow W6-A --subtask <subtaskId> --work-stage <stageId> --review-stage <stageId> --roles work,review --reason <text> --expires-at <iso>
`);
}

function createWorkerRuntime(taskId, { adapterName = 'fake', alreadyLocked = false, productionTest = false, scratchTask = false, phase5Pilot = false } = {}) {
  const store = new ExecutionStore({ harnessRoot: HARNESS_ROOT, taskId });
  const targets = [
    { bindingId: 'fake.work', role: 'work' },
    { bindingId: 'fake.review', role: 'review' },
  ];
  let adapter;
  if (adapterName === 'manual') {
    adapter = new ManualWorkerAdapter();
  } else if (adapterName === 'warp-macos') {
    const useFixtureHelper = (productionTest && scratchTask) || process.env.HARNESS_ENABLE_TEST_WARP_HELPER === '1';
    adapter = new WarpMacosAdapter({
      store,
      helper: useFixtureHelper
        ? new FixtureWarpMacosHelper({ candidates: warpTargetCandidates(store), store })
        : new ProcessWarpMacosHelper({ scriptPath: path.join(__dirname, 'warp-macos-helper.js') }),
      productionTest,
      scratchTask,
      phase5Pilot,
    });
  } else {
    adapter = new FakeWorkerAdapter({ targets, transportStore: store });
  }
  const statusStore = {
    load: () => loadStatus(taskId, { persistMigration: false }),
    saveCas(expectedRevision, nextStatus) {
      const current = loadStatus(taskId, { persistMigration: false });
      if (current.stateRevision !== expectedRevision) {
        throw new Error(`state-cas-conflict: expected=${expectedRevision} actual=${current.stateRevision}`);
      }
      const candidate = structuredClone(nextStatus);
      candidate.stateRevision = expectedRevision;
      saveStatus(taskId, candidate);
      return loadStatus(taskId, { persistMigration: false });
    },
  };
  const workflow = {
    evaluate(status, attempt, job) {
      return evaluateStageCheck({
        status, attempt, job,
        evaluate(snapshot) {
          return cmdCheck(taskId, { status: snapshot, persist: false });
        },
      });
    },
    derive(status, evaluation, attempt, job) {
      return deriveAdvanceTransition({
        status, attempt, job, evaluation,
        derive(snapshot, checkResult) {
          const currentStageData = snapshot.subtasks[snapshot.currentSubtask]?.stages?.[snapshot.currentStage];
          if (currentStageData) {
            currentStageData.workerCheckEvidence = {
              attemptId: attempt.attemptId,
              leaseToken: attempt.leaseToken,
              completionEventId: attempt.completionEvidence?.eventId,
              primarySha256: checkResult.primarySnapshot.sha256,
              primarySize: checkResult.primarySnapshot.size,
              passed: true,
            };
          }
          const statusRef = {};
          const result = cmdAdvance(taskId, {
            status: snapshot,
            statusRef,
            persist: false,
            checkResult,
          });
          if (!result.success) throw new Error('workflow-transition-failed');
          return { nextStatus: statusRef.current, postCursor: getCurrentStageCursor(statusRef.current), result };
        },
      });
    },
  };
  const supervisor = new ExecutionSupervisor({
    taskId,
    store,
    statusStore,
    adapter,
    workflow,
    transaction: alreadyLocked ? callback => callback() : callback => withTaskExecutionLockRetry(taskId, 'worker-transaction', callback),
    validatePilotAuthorization: (authorization, context) => validatePilotAuthorization(taskId, authorization, context),
    capturePilotAuthorization: ({ jobInput, status, target }) => {
      if (!jobInput.phase5Pilot) return jobInput.pilotAuthorization || null;
      const allowlist = readPilotAllowlist(taskId);
      const unit = findPilotUnit(allowlist, jobInput.pilotUnitId);
      if (!unit) throw new Error('pilot-unit-not-allowed');
      const hookCapabilities = deriveHookCapabilities(store.readCapability('claude-hook'));
      if (hookCapabilities.completionReceiptCapability !== 'available' ||
          hookCapabilities.needsInputCapability !== 'available') {
        throw new Error('hook-completion-and-needs-input-required');
      }
      const warpCapabilities = deriveWarpCapabilities(store.readCapability(WARP_CAPABILITY_NAME), {
        requireProductionTest: productionTest && scratchTask,
        requirePhase5Pilot: !(productionTest && scratchTask),
      });
      if (productionTest && scratchTask) {
        if (warpCapabilities.phase4RunEnabled !== true) throw new Error('phase5-test-warp-capability-required');
      } else if (warpCapabilities.phase5ProductionCandidate !== true ||
          !warpCapabilities.dispatch ||
          !warpCapabilities.abortableDispatch ||
          !warpCapabilities.settleBarrier) {
        throw new Error('phase5-production-candidate-required');
      }
      if (target.bindingId !== jobInput.targetBinding || target.role !== jobInput.role) {
        throw new Error('pilot-target-binding-conflict');
      }
      if (adapterName === 'warp-macos') {
        adapter.assertCurrentTargetIdentity(target);
      }
      return createPilotAuthorizationSnapshot(taskId, {
        allowlist,
        unit,
        role: jobInput.role,
        status,
        store,
      });
    },
    onPilotEvent: event => applyPilotCounterEvent(taskId, event),
    onWorkflowCommitted: ({ job, attempt, evaluation, postCursor, pilotRoleProgress }) => {
      const authorization = job.pilotAuthorization || attempt.pilotAuthorization || null;
      if (!authorization) return;
      updatePilotRoleCounter(taskId, authorization, authorization.role, progress => {
        progress.roles[authorization.role] = {
          state: 'completed',
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          leaseToken: attempt.leaseToken,
          completedAt: new Date().toISOString(),
          operationId: attempt.operationId,
          completionEventId: attempt.completionEvidence?.eventId || pilotRoleProgress?.completionEventId || null,
          outputHash: evaluation?.primarySnapshot?.sha256 || pilotRoleProgress?.outputHash || '',
          advancedToStage: postCursor?.stage || null,
        };
        if (authorization.role === 'work') {
          progress.workStageRevision = authorization.expectedStageRevision;
        } else if (authorization.role === 'review') {
          progress.reviewStageRevision = authorization.expectedStageRevision;
        }
      });
    },
  });
  return { store, adapter, statusStore, supervisor };
}

function warpTargetCandidates(store) {
  return store.listBindings()
    .filter(binding => binding.targetBinding?.adapter === 'warp-macos')
    .map(binding => ({
      adapter: 'warp-macos',
      bindingId: binding.bindingId,
      role: binding.role,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      sessionNonceHash: binding.sessionNonceHash,
      candidateId: binding.targetBinding.candidateId || binding.targetBinding.challengeId,
      targetFingerprintHash: binding.targetBinding.targetFingerprintHash,
      targetChallengeId: binding.targetBinding.challengeId,
      targetBindingVerifiedAt: binding.targetBinding.verifiedAt,
      capabilityEvidenceId: binding.targetBinding.capabilityEvidenceId,
      adapterIdentity: {
        adapter: 'warp-macos',
        role: binding.role,
        bindingId: binding.bindingId,
        bindingGeneration: binding.bindingGeneration,
        sessionId: binding.sessionId,
        sessionNonceHash: binding.sessionNonceHash,
        targetFingerprintHash: binding.targetBinding.targetFingerprintHash,
        targetChallengeId: binding.targetBinding.challengeId,
        targetBindingVerifiedAt: binding.targetBinding.verifiedAt,
        capabilityEvidenceId: binding.targetBinding.capabilityEvidenceId,
      },
      fingerprint: {
        bindingId: binding.bindingId,
        role: binding.role,
        candidateId: binding.targetBinding.candidateId || binding.targetBinding.challengeId,
      },
    }));
}

function isWarpProductionTestTask(taskId, opts = {}) {
  const enabled = opts['production-test'] === true || opts['production-test'] === 'true';
  return enabled && /^(SCRATCH|TEST)-/.test(taskId);
}

function workerRoleForStage(stage) {
  return getReviewStages().includes(stage) ? 'review' : 'work';
}

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => {
        if (value[key] === undefined) return null;
        return [key, stableValue(value[key])];
      }).filter(([, value]) => value !== undefined)
    );
  }
  return value;
};

const stableHash = value => `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;

function pilotAllowlistPath(taskId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'pilot', 'allowlist.json');
}

function pilotRoleProgressPath(taskId, pilotUnitId) {
  return path.join(HARNESS_ROOT, 'runs', taskId, 'pilot', pilotUnitId, 'roles.json');
}

function readPilotAllowlist(taskId) {
  return readJSON(pilotAllowlistPath(taskId));
}

function hashPilotAllowlist(allowlist) {
  if (!allowlist) return null;
  const { allowlistHash, ...rest } = allowlist;
  return stableHash(rest);
}

function writePilotAllowlist(taskId, allowlist) {
  const candidate = { ...allowlist, allowlistHash: null };
  const withHash = { ...candidate, allowlistHash: hashPilotAllowlist(candidate) };
  writeJSON(pilotAllowlistPath(taskId), withHash);
  return withHash;
}

function readPilotRoleProgress(taskId, pilotUnitId) {
  return readJSON(pilotRoleProgressPath(taskId, pilotUnitId));
}

function writePilotRoleProgress(taskId, pilotUnitId, progress) {
  writeJSON(pilotRoleProgressPath(taskId, pilotUnitId), progress);
  return progress;
}

function classifyPilotStage(stageId) {
  const stageConfig = getStageConfig(stageId);
  if (!stageConfig) throw new Error(`unknown-pilot-stage: ${stageId}`);
  const normalized = String(stageId).toLowerCase();
  const requiredSkill = String(stageConfig.requiredSkill || '').toLowerCase();
  const label = String(stageConfig.label || '').toLowerCase();
  const delivery = normalized === 'delivery' || requiredSkill.includes('delivery') || label.includes('交付');
  const acceptance = normalized.includes('accept') || label.includes('验收');
  const commitCheckpoint = normalized.includes('commit') || label.includes('commit');
  const push = normalized.includes('push');
  const tag = normalized.includes('tag');
  const done = normalized === 'done';
  const irreversible = delivery || acceptance || commitCheckpoint || push || tag || done;
  return {
    stageId,
    source: 'canonical-workflow-metadata',
    delivery,
    acceptance,
    commitCheckpoint,
    push,
    tag,
    done,
    irreversible,
  };
}

function assertPilotStagePair({ workStageId, reviewStageId }) {
  const workClassification = classifyPilotStage(workStageId);
  const reviewClassification = classifyPilotStage(reviewStageId);
  const blocked = [workClassification, reviewClassification].find(item => item.irreversible);
  if (blocked) throw new Error(`pilot-stage-not-allowed: ${blocked.stageId}`);
  if (!getImplementerStages().includes(workStageId)) throw new Error(`pilot-work-stage-not-implementer: ${workStageId}`);
  if (!getReviewStages().includes(reviewStageId)) throw new Error(`pilot-review-stage-not-review: ${reviewStageId}`);
  if (getStageConfig(workStageId)?.nextStage !== reviewStageId) {
    throw new Error('pilot-stage-pair-not-canonical');
  }
  const derivedClassification = {
    source: 'canonical-workflow-metadata',
    workStage: workClassification,
    reviewStage: reviewClassification,
  };
  return {
    ...derivedClassification,
    classificationHash: stableHash(derivedClassification),
  };
}

function findPilotUnit(allowlist, pilotUnitId) {
  return (allowlist?.allowedPilotUnits || []).find(unit => unit.pilotUnitId === pilotUnitId) || null;
}

function assertCurrentAllowlistHash(taskId, allowlist) {
  const actual = hashPilotAllowlist(allowlist);
  if (!allowlist || allowlist.allowlistHash !== actual) {
    throw new Error('pilot-allowlist-hash-drift');
  }
  return actual;
}

function assertPilotAllowlistFresh(allowlist, nowMs = Date.now()) {
  const expiresAtMs = Date.parse(allowlist?.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error('pilot-allowlist-expired');
  }
}

function assertPilotUnitCurrent(taskId, { allowlist, unit, role, status, store = null, persistRoleRecovery = true }) {
  assertCurrentAllowlistHash(taskId, allowlist);
  assertPilotAllowlistFresh(allowlist);
  const classification = assertPilotStagePair(unit);
  if (classification.classificationHash !== unit.derivedClassification?.classificationHash) {
    throw new Error('pilot-classification-drift');
  }
  if (!['work', 'review'].includes(role) || !(unit.roles || []).includes(role)) {
    throw new Error('pilot-role-not-allowed');
  }
  if (status.currentSubtask !== unit.subtaskId) throw new Error('pilot-subtask-cursor-conflict');
  const expectedStage = role === 'work' ? unit.workStageId : unit.reviewStageId;
  if (status.currentStage !== expectedStage) throw new Error('pilot-stage-cursor-conflict');
  if (role === 'review') {
    const progress = store
      ? recoverPilotRoleProgress(taskId, unit, status, store, { persist: persistRoleRecovery })
      : readPilotRoleProgress(taskId, unit.pilotUnitId);
    const work = progress?.roles?.work;
    if (work?.state !== 'completed') throw new Error('pilot-review-work-not-completed');
    if (work.advancedToStage !== unit.reviewStageId) throw new Error('pilot-review-work-evidence-mismatch');
    const workJob = store?.readJob(work.jobId);
    const workAttempt = store?.readAttempt(work.attemptId);
    const marker = (status.history || []).find(entry =>
      entry.action === 'worker-workflow-committed' &&
      entry.details?.operationId === work.operationId &&
      entry.details?.completionEventId === work.completionEventId
    );
    if (!workJob || !workAttempt || !marker ||
        workJob.workflowState !== 'workflow-completed' ||
        workAttempt.workflowState !== 'workflow-completed' ||
        workAttempt.leaseToken !== work.leaseToken ||
        workAttempt.pilotAuthorization?.pilotUnitId !== unit.pilotUnitId ||
        workAttempt.pilotAuthorization?.role !== 'work' ||
        !work.outputHash) {
      throw new Error('pilot-review-work-authority-mismatch');
    }
  }
  const counters = readPilotRoleProgress(taskId, unit.pilotUnitId)?.attemptCounters?.[role];
  for (const [counter, limitField] of [
    ['prepared', 'maxPreparedAttemptsPerRole'],
    ['dispatchStarted', 'maxDispatchAttemptsPerRole'],
    ['submitted', 'maxSubmittedAttemptsPerRole'],
  ]) {
    const observed = Number(counters?.[counter] || 0);
    const limit = Number(unit.attemptBudget?.[limitField]);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`invalid-pilot-attempt-budget: ${limitField}`);
    if (observed >= limit) throw new Error(`pilot-${counter}-attempt-budget-exhausted`);
  }
  return classification;
}

function createPilotAuthorizationSnapshot(taskId, { allowlist, unit, role, status, store = null }) {
  const allowlistHash = assertCurrentAllowlistHash(taskId, allowlist);
  const classification = assertPilotUnitCurrent(taskId, { allowlist, unit, role, status, store });
  const expectedStageId = role === 'work' ? unit.workStageId : unit.reviewStageId;
  return {
    allowlistId: allowlist.allowlistId,
    allowlistHash,
    pilotUnitId: unit.pilotUnitId,
    taskId,
    subtaskId: unit.subtaskId,
    role,
    workStageId: unit.workStageId,
    reviewStageId: unit.reviewStageId,
    expectedStageId,
    expectedStageRevision: status.stageRevision,
    expiresAt: allowlist.expiresAt,
    attemptBudget: unit.attemptBudget,
    derivedClassificationHash: classification.classificationHash,
    reasonHash: stableHash(allowlist.reason || ''),
  };
}

function applyPhase5TestMutationAfterNext(taskId, mutation) {
  if (mutation === 'allowlist-drift') {
    const allowlistPath = pilotAllowlistPath(taskId);
    const allowlist = readJSON(allowlistPath);
    if (!allowlist) throw new Error('test-mutation-allowlist-missing');
    allowlist.allowedPilotUnits[0].testMutation = randomUUID();
    writeJSON(allowlistPath, allowlist);
    return;
  }
  if (mutation === 'allowlist-expired') {
    const allowlist = readPilotAllowlist(taskId);
    if (!allowlist) throw new Error('test-mutation-allowlist-missing');
    writePilotAllowlist(taskId, {
      ...allowlist,
      allowlistHash: null,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    return;
  }
  if (mutation === 'capability-drift') {
    const store = new ExecutionStore({ harnessRoot: HARNESS_ROOT, taskId });
    const capability = store.readCapability(WARP_CAPABILITY_NAME);
    if (!capability) throw new Error('test-mutation-capability-missing');
    store.writeCapability(WARP_CAPABILITY_NAME, {
      ...capability,
      capturedAt: new Date(Date.now() - WARP_CAPABILITY_TTL_MS - 10_000).toISOString(),
    });
    return;
  }
  throw new Error(`unknown-phase5-test-mutation: ${mutation}`);
}

function validatePilotAuthorization(taskId, authorization, { status }) {
  if (!authorization) return true;
  const allowlist = readPilotAllowlist(taskId);
  assertCurrentAllowlistHash(taskId, allowlist);
  if (allowlist.allowlistId !== authorization.allowlistId ||
      allowlist.allowlistHash !== authorization.allowlistHash) {
    throw new Error('pilot-allowlist-hash-drift');
  }
  assertPilotAllowlistFresh(allowlist);
  const unit = findPilotUnit(allowlist, authorization.pilotUnitId);
  if (!unit) throw new Error('pilot-unit-not-allowed');
  const classification = assertPilotStagePair(unit);
  if (classification.classificationHash !== authorization.derivedClassificationHash) {
    throw new Error('pilot-classification-drift');
  }
  if (status.currentSubtask !== authorization.subtaskId ||
      status.currentStage !== authorization.expectedStageId ||
      status.stageRevision !== authorization.expectedStageRevision) {
    throw new Error('pilot-stage-cursor-conflict');
  }
  return true;
}

function updatePilotRoleCounter(taskId, authorization, role, updater) {
  if (!authorization) return null;
  const progressPath = pilotRoleProgressPath(taskId, authorization.pilotUnitId);
  const existing = readJSON(progressPath) || {
    protocolVersion: 1,
    kind: 'phase5.role-progress',
    taskId,
    pilotUnitId: authorization.pilotUnitId,
    subtaskId: authorization.subtaskId,
    workStageId: authorization.workStageId,
    reviewStageId: authorization.reviewStageId,
    roles: {
      work: { state: 'not-started' },
      review: { state: 'not-started' },
    },
    attemptCounters: {
      work: { prepared: 0, dispatchStarted: 0, submitted: 0, safeRetries: 0, notSentRetries: 0 },
      review: { prepared: 0, dispatchStarted: 0, submitted: 0, safeRetries: 0, notSentRetries: 0 },
    },
  };
  const next = structuredClone(existing);
  next.attemptCounters[role] = next.attemptCounters[role] || { prepared: 0, dispatchStarted: 0, submitted: 0, safeRetries: 0, notSentRetries: 0 };
  updater(next);
  writePilotRoleProgress(taskId, authorization.pilotUnitId, next);
  return next;
}

function pilotCounterLimit(authorization, field) {
  const value = Number(authorization?.attemptBudget?.[field]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid-pilot-attempt-budget: ${field}`);
  return value;
}

function applyPilotCounterEvent(taskId, event) {
  const { authorization, type } = event;
  if (!authorization) return null;
  const role = authorization.role;
  const attemptId = event.attempt?.attemptId || 'unknown-attempt';
  const operationId = event.operation?.operationId || event.attempt?.operationId || 'unknown-operation';
  const limits = {
    prepared: pilotCounterLimit(authorization, 'maxPreparedAttemptsPerRole'),
    dispatchStarted: pilotCounterLimit(authorization, 'maxDispatchAttemptsPerRole'),
    submitted: pilotCounterLimit(authorization, 'maxSubmittedAttemptsPerRole'),
    safeRetries: pilotCounterLimit(authorization, 'maxSafeRetryAttemptsPerRole'),
    notSentRetries: pilotCounterLimit(authorization, 'maxNotSentRetryAttemptsPerRole'),
  };
  const check = (...fields) => {
    const progress = readPilotRoleProgress(taskId, authorization.pilotUnitId);
    const counters = progress?.attemptCounters?.[role] || {};
    for (const field of fields) {
      if (Number(counters[field] || 0) >= limits[field]) {
        throw new Error(`pilot-${field}-attempt-budget-exhausted`);
      }
    }
  };
  if (type === 'safe-retry-check') check('safeRetries', 'prepared');
  if (type === 'not-sent-retry-check') check('notSentRetries', 'prepared');
  if (type === 'dispatch-started') check('dispatchStarted', 'submitted');

  const eventKey = `${operationId}:${attemptId}:${type}`;
  return updatePilotRoleCounter(taskId, authorization, role, progress => {
    progress.counterEvents = progress.counterEvents || {};
    if (progress.counterEvents[eventKey]) return;
    const counters = progress.attemptCounters[role];
    if (type === 'prepared') counters.prepared += 1;
    if (type === 'dispatch-started') counters.dispatchStarted += 1;
    if (type === 'submitted' || type === 'reconciled-sent') {
      counters.submitted += 1;
      if (counters.submitted > limits.submitted) {
        progress.budgetViolation = {
          type: 'submitted-attempt-budget-exceeded-by-reconciliation',
          role,
          attemptId,
          observed: counters.submitted,
          limit: limits.submitted,
        };
      }
    }
    if (type === 'safe-retry-prepared') {
      counters.safeRetries += 1;
      counters.prepared += 1;
    }
    if (type === 'not-sent-retry-prepared') {
      counters.notSentRetries += 1;
      counters.prepared += 1;
    }
    if (type === 'prepared' || type === 'safe-retry-prepared' || type === 'not-sent-retry-prepared') {
      progress.roles[role] = {
        ...(progress.roles[role] || {}),
        state: 'prepared',
        jobId: event.job?.jobId || null,
        attemptId,
        leaseToken: event.attempt?.leaseToken || null,
      };
    }
    if (type === 'submitted' || type === 'reconciled-sent') {
      progress.roles[role] = {
        ...(progress.roles[role] || {}),
        state: 'submitted',
        jobId: event.job?.jobId || null,
        attemptId,
        leaseToken: event.attempt?.leaseToken || null,
      };
    }
    progress.counterEvents[eventKey] = { type, attemptId, operationId, recordedAt: new Date().toISOString() };
  });
}

function emptyPilotRoleProgress(taskId, unit) {
  return {
    protocolVersion: 1,
    kind: 'phase5.role-progress',
    taskId,
    pilotUnitId: unit.pilotUnitId,
    subtaskId: unit.subtaskId,
    workStageId: unit.workStageId,
    reviewStageId: unit.reviewStageId,
    roles: { work: { state: 'not-started' }, review: { state: 'not-started' } },
    attemptCounters: {
      work: { prepared: 0, dispatchStarted: 0, submitted: 0, safeRetries: 0, notSentRetries: 0 },
      review: { prepared: 0, dispatchStarted: 0, submitted: 0, safeRetries: 0, notSentRetries: 0 },
    },
    counterEvents: {},
  };
}

function recoverPilotRoleProgress(taskId, unit, status, store, { persist = false } = {}) {
  const existing = readPilotRoleProgress(taskId, unit.pilotUnitId);
  const progress = existing ? structuredClone(existing) : emptyPilotRoleProgress(taskId, unit);
  let changed = !existing;
  const authoritativeCompletions = new Map();
  for (const operation of store.listOperations()) {
    const authorization = operation.pilotAuthorization || operation.payloads?.attempt?.pilotAuthorization || operation.workflowCommit?.attempt?.pilotAuthorization;
    if (authorization?.pilotUnitId !== unit.pilotUnitId) continue;
    const commit = operation.workflowCommit;
    const roleEvidence = commit?.pilotRoleProgress;
    if (!commit || !roleEvidence || !['work', 'review'].includes(roleEvidence.role)) continue;
    const marker = (status.history || []).find(entry =>
      entry.action === 'worker-workflow-committed' &&
      entry.details?.operationId === operation.operationId &&
      entry.details?.completionEventId === commit.completionEventId
    );
    if (!marker || commit.job?.workflowState !== 'workflow-completed' || commit.attempt?.workflowState !== 'workflow-completed') continue;
    authoritativeCompletions.set(roleEvidence.role, {
      state: 'completed',
      jobId: roleEvidence.jobId,
      attemptId: roleEvidence.attemptId,
      leaseToken: roleEvidence.leaseToken,
      operationId: roleEvidence.operationId,
      completionEventId: roleEvidence.completionEventId,
      completedAt: commit.job.workflowCompletedAt || marker.timestamp,
      outputHash: roleEvidence.outputHash,
      advancedToStage: roleEvidence.postCursor?.stage || marker.details?.postCursor?.stage || null,
    });
  }
  for (const role of ['work', 'review']) {
    const authority = authoritativeCompletions.get(role);
    if (authority && JSON.stringify(progress.roles?.[role]) !== JSON.stringify(authority)) {
      progress.roles[role] = authority;
      changed = true;
    } else if (!authority && progress.roles?.[role]?.state === 'completed') {
      progress.roles[role] = {
        ...progress.roles[role],
        state: 'inconsistent-needs-operator',
        reason: 'completion-without-authoritative-history-marker',
      };
      changed = true;
    }
  }
  if (status.currentStage !== unit.workStageId && status.currentStage !== unit.reviewStageId &&
      progress.roles.review.state !== 'completed') {
    progress.roles.review = {
      ...progress.roles.review,
      state: 'inconsistent-needs-operator',
      reason: 'status-beyond-review-without-review-completion',
    };
    changed = true;
  }
  if (persist && changed) writePilotRoleProgress(taskId, unit.pilotUnitId, progress);
  return progress;
}

function bindingDiagnostics(store) {
  const now = Date.now();
  return store.listBindings().map(binding => {
    const heartbeatAt = binding.heartbeatAt || binding.createdAt;
    const heartbeatAgeMs = heartbeatAt ? now - Date.parse(heartbeatAt) : null;
    return {
      bindingId: binding.bindingId,
      role: binding.role,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      sessionNonceHash: binding.sessionNonceHash,
      heartbeatAt,
      heartbeatAgeMs: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
      stale: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs > BINDING_HEARTBEAT_STALE_MS : true,
    };
  });
}

function assertFreshBinding(binding, nowMs = Date.now()) {
  if (!binding) throw new Error('binding-not-found');
  if (['terminal', 'revoked', 'detached'].includes(binding.state)) throw new Error('binding-unavailable');
  const heartbeatAt = binding.heartbeatAt || binding.createdAt;
  const heartbeatMs = Date.parse(heartbeatAt);
  if (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > BINDING_HEARTBEAT_STALE_MS) {
    throw new Error('binding-stale');
  }
  return binding;
}

function deriveHookCapabilities(evidence) {
  const unavailable = reason => ({
    completionReceiptCapability: 'unavailable',
    needsInputCapability: 'unavailable',
    reason,
  });
  if (!evidence) {
    return unavailable('missing-capability-evidence');
  }
  if (evidence.compatible === false || evidence.versionDrift === true) {
    return unavailable(evidence.reason || 'capability-evidence-incompatible');
  }
  const capturedAtMs = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedAtMs) || Date.now() - capturedAtMs > CAPABILITY_EVIDENCE_TTL_MS || capturedAtMs > Date.now() + 60_000) {
    return unavailable('capability-evidence-stale');
  }
  if (!evidence.hookSource || !evidence.hookVersion) {
    return unavailable('missing-hook-source-version');
  }
  if (evidence.completionPhase !== 'claude-completed') {
    return unavailable('missing-completion-phase');
  }
  if (!['hook-payload', 'wrapper-injected'].includes(evidence.attemptRefSource) ||
      !['hook-payload', 'wrapper-injected'].includes(evidence.bindingSessionSource)) {
    return unavailable('missing-injection-proof');
  }
  const fields = new Set(evidence.observedFields || []);
  const completionRequired = ['kind', 'occurredAt'];
  if (evidence.attemptRefSource === 'hook-payload') completionRequired.push('attemptId', 'jobId', 'leaseToken');
  if (evidence.bindingSessionSource === 'hook-payload') completionRequired.push('bindingId', 'sessionId');
  const missingCompletion = completionRequired.filter(field => !fields.has(field));
  if (missingCompletion.length > 0) return unavailable(`missing-fields:${missingCompletion.join(',')}`);
  const needsInputAvailable = evidence.needsInputCategorySource === 'hook-payload' &&
    fields.has('needsInputCategory') &&
    NEEDS_INPUT_CATEGORIES.has(evidence.sampleNeedsInputCategory || 'agent-question');
  return {
    completionReceiptCapability: 'available',
    needsInputCapability: needsInputAvailable ? 'available' : 'unavailable',
    missingCompletionFields: missingCompletion,
    needsInputReason: needsInputAvailable ? null : 'missing-needs-input-category-source',
    source: evidence.source || null,
    hookSource: evidence.hookSource,
    hookVersion: evidence.hookVersion,
    capturedAt: evidence.capturedAt || null,
  };
}

async function cmdWorkerDoctor(taskId, opts = {}) {
  const { store, adapter } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const status = loadStatus(taskId, { persistMigration: false });
  const hookCapabilities = deriveHookCapabilities(store.readCapability('claude-hook'));
  const result = {
    schemaVersion: status.schemaVersion,
    executionMode: status.execution.mode,
    capabilities: await adapter.capabilities(),
    hookCapabilities,
    bindings: bindingDiagnostics(store),
    activeJobId: status.execution.activeJobId,
    activeAttemptId: status.execution.activeAttemptId,
    pendingOperations: store.listOperations().filter(operation => !['rolled-back', 'workflow-completed'].includes(operation.phase)).length,
    pendingReceipts: store.listReceipts('inbox').length,
    phase3Capabilities: hookCapabilities.completionReceiptCapability,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdPilotDoctor(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const status = loadStatus(taskId, { persistMigration: false });
  const allowlist = readPilotAllowlist(taskId);
  let allowlistStatus = 'missing';
  let allowlistReason = null;
  try {
    if (allowlist) {
      assertCurrentAllowlistHash(taskId, allowlist);
      assertPilotAllowlistFresh(allowlist);
      allowlistStatus = 'available';
    }
  } catch (error) {
    allowlistStatus = 'unavailable';
    allowlistReason = error.message;
  }
  const hookCapabilities = deriveHookCapabilities(store.readCapability('claude-hook'));
  const warpCapabilities = deriveWarpCapabilities(store.readCapability(WARP_CAPABILITY_NAME), { requirePhase5Pilot: true });
  const pilotReasons = [];
  let selectedPilotUnit = null;
  let selectedRole = null;
  try {
    if (status.schemaVersion !== STATUS_SCHEMA_VERSION) throw new Error('schema-version-not-current');
    if (status.execution.activeJobId || status.execution.activeAttemptId) throw new Error('active-job-conflict');
    if (!allowlist) throw new Error('pilot-allowlist-missing');
    assertCurrentAllowlistHash(taskId, allowlist);
    assertPilotAllowlistFresh(allowlist);
    selectedPilotUnit = (allowlist.allowedPilotUnits || []).find(unit =>
      unit.subtaskId === status.currentSubtask && [unit.workStageId, unit.reviewStageId].includes(status.currentStage)
    );
    if (!selectedPilotUnit) throw new Error('pilot-unit-not-current');
    selectedRole = status.currentStage === selectedPilotUnit.workStageId ? 'work' : 'review';
    assertPilotUnitCurrent(taskId, {
      allowlist,
      unit: selectedPilotUnit,
      role: selectedRole,
      status,
      store,
      persistRoleRecovery: false,
    });
    if (hookCapabilities.completionReceiptCapability !== 'available' || hookCapabilities.needsInputCapability !== 'available') {
      throw new Error('hook-completion-and-needs-input-required');
    }
    if (warpCapabilities.phase5ProductionCandidate !== true) throw new Error('phase5-production-candidate-required');
    const binding = assertFreshBinding(store.listBindings().find(item => item.role === selectedRole));
    if (!binding.targetBinding?.targetFingerprintHash || !binding.targetBinding?.verifiedAt) throw new Error('warp-target-not-bound');
  } catch (error) {
    pilotReasons.push(error.message);
  }
  const result = {
    taskId,
    schemaVersion: status.schemaVersion,
    activeJobId: status.execution.activeJobId,
    activeAttemptId: status.execution.activeAttemptId,
    currentSubtask: status.currentSubtask,
    currentStage: status.currentStage,
    stageRevision: status.stageRevision,
    allowlistStatus,
    allowlistReason,
    allowlist: allowlist ? {
      allowlistId: allowlist.allowlistId,
      allowlistHash: allowlist.allowlistHash,
      expiresAt: allowlist.expiresAt,
      pilotUnits: (allowlist.allowedPilotUnits || []).map(unit => unit.pilotUnitId),
    } : null,
    hookCapabilities,
    warpCapabilities,
    bindings: bindingDiagnostics(store),
    pilotRun: {
      allowed: pilotReasons.length === 0,
      reasons: pilotReasons,
      pilotUnitId: selectedPilotUnit?.pilotUnitId || null,
      role: selectedRole,
    },
  };
  console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result;
}

function cmdPilotAllow(taskId, opts = {}) {
  const subtaskId = opts.subtask;
  const workStageId = opts['work-stage'];
  const reviewStageId = opts['review-stage'];
  const roles = String(opts.roles || '').split(',').map(role => role.trim()).filter(Boolean);
  const reason = opts.reason;
  const expiresAt = opts['expires-at'];
  if (!subtaskId) throw new Error('--subtask required');
  if (!workStageId) throw new Error('--work-stage required');
  if (!reviewStageId) throw new Error('--review-stage required');
  if (roles.join(',') !== 'work,review') throw new Error('--roles must be work,review');
  if (!reason) throw new Error('--reason required');
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new Error('--expires-at must be ISO timestamp');
  const nowMs = Date.now();
  if (expiresAtMs <= nowMs) throw new Error('pilot-allowlist-expired');
  if (expiresAtMs - nowMs > 24 * 60 * 60 * 1000) throw new Error('pilot-allowlist-expiration-too-long');

  const status = loadStatus(taskId, { persistMigration: false });
  if (status.execution.activeAttemptId || status.execution.activeJobId) throw new Error('active-job-conflict');
  if (!status.subtasks?.[subtaskId]) throw new Error(`unknown-pilot-subtask: ${subtaskId}`);
  const classification = assertPilotStagePair({ workStageId, reviewStageId });
  const pilotUnitId = opts['pilot-unit'] || `${taskId}-${subtaskId}-code-pilot`;
  const unit = {
    pilotUnitId,
    subtaskId,
    workStageId,
    reviewStageId,
    expectedWorkStageRevision: status.currentSubtask === subtaskId && status.currentStage === workStageId ? status.stageRevision : null,
    expectedReviewStageRevision: status.currentSubtask === subtaskId && status.currentStage === reviewStageId ? status.stageRevision : null,
    roles,
    requiresSequentialRoles: true,
    manualFallbackRequired: true,
    attemptBudget: {
      maxPreparedAttemptsPerRole: Number(opts['max-prepared-attempts-per-role'] || 3),
      maxDispatchAttemptsPerRole: Number(opts['max-dispatch-attempts-per-role'] || 2),
      maxSubmittedAttemptsPerRole: Number(opts['max-submitted-attempts-per-role'] || 1),
      maxSafeRetryAttemptsPerRole: Number(opts['max-safe-retry-attempts-per-role'] || 1),
      maxNotSentRetryAttemptsPerRole: Number(opts['max-not-sent-retry-attempts-per-role'] || 1),
    },
    derivedClassification: classification,
  };
  const allowlist = writePilotAllowlist(taskId, {
    protocolVersion: 1,
    kind: 'phase5.pilot-allowlist',
    allowlistId: opts['allowlist-id'] || randomUUID(),
    allowlistHash: null,
    taskId,
    createdAt: now(),
    createdBy: opts.operator || process.env.USER || 'operator',
    allowedPilotUnits: [unit],
    expiresAt: new Date(expiresAtMs).toISOString(),
    reason,
  });
  const nextStatus = loadStatus(taskId, { persistMigration: false });
  addHistory(nextStatus, 'phase5-pilot-allowlist-updated', {
    allowlistId: allowlist.allowlistId,
    allowlistHash: allowlist.allowlistHash,
    pilotUnitId,
    subtaskId,
    workStageId,
    reviewStageId,
  });
  saveStatus(taskId, nextStatus);
  const result = {
    status: 'allowed',
    allowlistId: allowlist.allowlistId,
    allowlistHash: allowlist.allowlistHash,
    pilotUnitId,
    expiresAt: allowlist.expiresAt,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWorkerRun(taskId, opts = {}) {
  const phase5Pilot = opts['phase5-pilot'] === true || opts['phase5-pilot'] === 'true';
  const productionTest = opts['production-test'] === true || opts['production-test'] === 'true';
  const productionTestTask = isWarpProductionTestTask(taskId, opts);
  if (opts.adapter === 'warp-macos' && !isWarpProductionTestTask(taskId, opts) && !phase5Pilot) {
    const result = { success: false, status: 'warp-macos-production-disabled' };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const runtime = createWorkerRuntime(taskId, {
    adapterName: opts.adapter,
    productionTest,
    scratchTask: productionTestTask,
    phase5Pilot,
  });
  const capabilities = await runtime.adapter.capabilities();
  if (!capabilities.dispatch || !capabilities.abortableDispatch || !capabilities.settleBarrier) {
    const result = { success: false, status: capabilities.mode === 'manual' ? 'manual-required' : 'capability-unavailable' };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (opts.adapter === 'warp-macos') {
    if (phase5Pilot) {
      if (capabilities.phase5ProductionCandidate !== true) {
        const result = { success: false, status: 'capability-unavailable', reason: 'phase5-production-candidate-required', capabilities };
        console.log(JSON.stringify(result, null, 2));
        return result;
      }
      for (const flag of ['confirm-real-target', 'confirm-manual-fallback', 'confirm-no-auto-approval']) {
        if (!(opts[flag] === true || opts[flag] === 'true')) {
          const result = { success: false, status: 'phase5-confirmation-required', flag };
          console.log(JSON.stringify(result, null, 2));
          return result;
        }
      }
    }
    const hookCapabilities = deriveHookCapabilities(runtime.store.readCapability('claude-hook'));
    if (hookCapabilities.completionReceiptCapability !== 'available' ||
        hookCapabilities.needsInputCapability !== 'available') {
      const result = {
        success: false,
        status: 'capability-unavailable',
        reason: 'hook-completion-and-needs-input-required',
        hookCapabilities,
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
  }
  let phase5Preflight = null;
  if (phase5Pilot) {
    const status = loadStatus(taskId, { persistMigration: false });
    const allowlist = readPilotAllowlist(taskId);
    const pilotUnitId = opts['pilot-unit'];
    if (!pilotUnitId) throw new Error('--pilot-unit required');
    const role = opts.role;
    const unit = findPilotUnit(allowlist, pilotUnitId);
    if (!unit) throw new Error('pilot-unit-not-allowed');
    assertPilotUnitCurrent(taskId, { allowlist, unit, role, status, store: runtime.store });
    phase5Preflight = { allowlist, unit, role };
  }
  const nextResult = await withTaskExecutionLock(taskId, 'worker-next', () => cmdNext(taskId, { copy: false }));
  if (nextResult.error) return { success: false, error: nextResult.error };
  if (phase5Pilot && process.env.HARNESS_ENABLE_TEST_FAULTS === '1' && process.env.HARNESS_PHASE5_TEST_MUTATE_AFTER_NEXT) {
    applyPhase5TestMutationAfterNext(taskId, process.env.HARNESS_PHASE5_TEST_MUTATE_AFTER_NEXT);
  }
  const status = loadStatus(taskId);
  const stageData = status.subtasks[status.currentSubtask].stages[status.currentStage];
  const role = phase5Pilot ? opts.role : workerRoleForStage(status.currentStage);
  const promptSnapshot = getFileSnapshot(nextResult.promptPath);
  const { supervisor } = runtime;
  const prepared = await supervisor.prepare({
    taskId,
    subtaskId: status.currentSubtask,
    stage: status.currentStage,
    round: getRoundForStage(status, status.currentSubtask, status.currentStage),
    expectedStageRevision: status.stageRevision,
    role,
    targetBinding: opts.adapter === 'warp-macos'
      ? `wrapper.${role}`
      : `${opts.adapter === 'manual' ? 'manual' : 'fake'}.${role}`,
    promptPath: nextResult.promptPath,
    promptSha256: promptSnapshot.sha256,
    primaryReportPath: stageData.primaryReportPath,
    outputBaseline: stageData.outputBaseline,
    ...(phase5Pilot ? {
      phase5Pilot: true,
      pilotUnitId: phase5Preflight.unit.pilotUnitId,
    } : {}),
  });
  const dispatched = await supervisor.dispatch(prepared.operationId, {
    timeoutMs: Number(opts['dispatch-timeout-ms'] || 30_000),
  });
  if (dispatched.status !== 'dispatch-submitted') {
    const result = { success: false, prepared, dispatched };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const runTimeoutMs = Number(opts['run-timeout-ms'] || 300_000);
  const pollMs = Number(opts['poll-ms'] || 100);
  if (!Number.isInteger(runTimeoutMs) || runTimeoutMs <= 0) throw new Error('--run-timeout-ms must be a positive integer');
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error('--poll-ms must be a positive integer');
  const deadline = Date.now() + runTimeoutMs;
  let pumped = { status: 'dispatch-submitted' };
  const terminal = new Set(['workflow-completed', 'failed', 'cancelled', 'abandoned', 'idle']);
  const stops = new Set(['check-blocked', 'sequence-gap', 'dispatch-uncertain', 'needs-input']);
  while (Date.now() < deadline) {
    pumped = await supervisor.pumpOnce();
    if (terminal.has(pumped.status) || stops.has(pumped.status)) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  if (Date.now() >= deadline && !terminal.has(pumped.status) && !stops.has(pumped.status)) {
    pumped = { status: 'run-timeout' };
  }
  const success = terminal.has(pumped.status);
  const result = {
    success,
    operationId: prepared.operationId,
    jobId: prepared.job.jobId,
    attemptId: prepared.attempt.attemptId,
    dispatched,
    final: pumped,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWorkerPump(taskId, opts = {}) {
  const { supervisor } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const result = await supervisor.pumpOnce();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerJobs(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const status = loadStatus(taskId, { persistMigration: false });
  const result = {
    activeJob: status.execution.activeJobId ? store.readJob(status.execution.activeJobId) : null,
    activeAttempt: status.execution.activeAttemptId ? store.readAttempt(status.execution.activeAttemptId) : null,
    operations: store.listOperations(),
    bindings: bindingDiagnostics(store),
    hookCapabilities: deriveHookCapabilities(store.readCapability('claude-hook')),
  };
  console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerAttach(taskId, opts = {}) {
  const role = opts.role;
  if (!['work', 'review'].includes(role)) throw new Error('--role must be work or review');
  const bindingId = opts.binding || `wrapper.${role}`;
  const dryRun = opts['dry-run'] === true || opts['dry-run'] === 'true';
  const replace = opts.replace === true || opts.replace === 'true';
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const existing = store.readBinding(bindingId);
  const generation = existing ? existing.bindingGeneration + 1 : 1;
  const { binding, rawNonce } = createBinding({
    taskId,
    bindingId,
    role,
    bindingGeneration: generation,
    metadata: { cwd: opts.cwd || CODE_REPO },
  });
  const result = { ...binding, wouldWrite: !dryRun };
  if (dryRun) {
    console.log(JSON.stringify({ ...result, wouldWrite: false }, null, 2));
    return { ...result, wouldWrite: false };
  }
  if (existing && !replace) throw new Error('binding-already-exists');
  const status = loadStatus(taskId, { persistMigration: false });
  if (status.execution.activeAttemptId) {
    const activeAttempt = store.readAttempt(status.execution.activeAttemptId);
    const activeJob = activeAttempt ? store.readJob(activeAttempt.jobId) : null;
    if (!activeJob || activeJob.role === role || activeAttempt.bindingId === bindingId) {
      throw new Error('active-attempt-binding-replacement-conflict');
    }
  }
  store.writeBinding({ ...binding, heartbeatAt: binding.createdAt });
  store.writeBindingSecret(binding.bindingId, rawNonce);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerHeartbeat(taskId, opts = {}) {
  const bindingId = opts.binding;
  if (!bindingId) throw new Error('--binding required');
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const binding = store.readBinding(bindingId);
  if (!binding) throw new Error('binding-not-found');
  if (['terminal', 'revoked', 'detached'].includes(binding.state)) throw new Error('binding-unavailable');
  const heartbeatAt = new Date().toISOString();
  const next = { ...binding, heartbeatAt, state: binding.state || 'live' };
  store.writeBinding(next);
  const result = {
    status: 'heartbeat-recorded',
    bindingId,
    role: next.role,
    bindingGeneration: next.bindingGeneration,
    sessionId: next.sessionId,
    heartbeatAt,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerDetach(taskId, opts = {}) {
  const bindingId = opts.binding;
  if (!bindingId) throw new Error('--binding required');
  const reason = opts.reason;
  if (!reason) throw new Error('--reason required');
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const binding = store.readBinding(bindingId);
  if (!binding) throw new Error('binding-not-found');
  const detachedAt = new Date().toISOString();
  const next = { ...binding, state: 'detached', detachedAt, detachReason: reason };
  store.writeBinding(next);
  const result = {
    status: 'detached',
    bindingId,
    role: next.role,
    bindingGeneration: next.bindingGeneration,
    sessionId: next.sessionId,
    detachedAt,
    reason,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerHookProbe(taskId, opts = {}) {
  const payloadPath = opts.payload;
  if (!payloadPath) throw new Error('--payload required');
  const resolved = path.resolve(String(payloadPath));
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const observedFields = Object.keys(payload).sort();
  const payloadHash = stableHash(payload);
  const capturedAt = new Date().toISOString();
  const diagnostic = {
    protocolVersion: 1,
    kind: 'claude-hook.fixture-diagnostic',
    fixture: true,
    source: resolved,
    capturedAt,
    payloadHash,
    observedFields,
    realCapabilityWritten: false,
    pilotEligible: false,
    reason: 'fixture-hook-payload-cannot-authorize-real-pilot',
  };
  const diagnosticsDir = path.join(HARNESS_ROOT, 'runs', taskId, 'diagnostics', 'hook-fixtures');
  const diagnosticId = `${Date.now()}-${createHash('sha256').update(payloadHash).digest('hex').slice(0, 12)}`;
  const diagnosticPath = path.join(diagnosticsDir, `${diagnosticId}.json`);
  writeJSON(diagnosticPath, diagnostic);
  const result = {
    status: 'fixture-diagnostic-recorded',
    diagnosticPath,
    payloadHash,
    realCapabilityWritten: false,
    pilotEligible: false,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerBindings(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: opts.adapter || 'fake' });
  const result = {
    bindings: bindingDiagnostics(store),
    hookCapabilities: deriveHookCapabilities(store.readCapability('claude-hook')),
  };
  console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerChallenge(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  if (opts['probe-hook-payload']) {
    const fixturePath = path.resolve(String(opts['probe-hook-payload']));
    const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const evidence = {
      source: fixturePath,
      capturedAt: payload.capturedAt || new Date().toISOString(),
      observedFields: payload.observedFields || Object.keys(payload),
      compatible: payload.versionDrift === true ? false : true,
      versionDrift: payload.versionDrift === true,
      hookSource: payload.hookSource || payload.source || null,
      hookVersion: payload.hookVersion || payload.version || null,
      completionPhase: payload.completionPhase || payload.hookPhase || null,
      attemptRefSource: payload.attemptRefSource || null,
      bindingSessionSource: payload.bindingSessionSource || null,
      needsInputCategorySource: payload.needsInputCategorySource || null,
      sampleNeedsInputCategory: payload.needsInputCategory || null,
    };
    store.writeCapability('claude-hook', evidence);
    const result = deriveHookCapabilities(evidence);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const bindingId = opts.binding;
  if (!bindingId) throw new Error('--binding required');
  const binding = assertFreshBinding(store.readBinding(bindingId));
  const challengeId = opts['challenge-id'] || randomUUID();
  const challengeRecordId = `binding-challenge-${challengeId}`;
  const existing = store.readCapability(challengeRecordId);
  if (opts.proof) {
    if (!existing) throw new Error('challenge-not-found');
    if (existing.verifiedAt) throw new Error('challenge-already-used');
    const existingPayload = existing.payload || {};
    if (existingPayload.bindingId !== binding.bindingId ||
        existingPayload.bindingGeneration !== binding.bindingGeneration ||
        existingPayload.sessionId !== binding.sessionId ||
        existingPayload.sessionNonceHash !== binding.sessionNonceHash) {
      throw new Error('challenge-binding-mismatch');
    }
    const rawNonce = store.readBindingSecret(bindingId);
    if (!rawNonce) throw new Error('session-secret-unavailable');
    const proofPayload = { ...existing.payload, proof: opts.proof };
    if (!verifySessionProof(rawNonce, proofPayload)) throw new Error('challenge-proof-invalid');
    const verified = { ...existing, status: 'verified', verifiedAt: new Date().toISOString() };
    store.writeCapability(challengeRecordId, verified);
    const result = {
      status: 'verified',
      challengeId,
      bindingId,
      role: binding.role,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      verifiedAt: verified.verifiedAt,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (existing) throw new Error('challenge-already-issued');
  const payload = {
    protocolVersion: 1,
    kind: 'binding.challenge',
    challengeId,
    bindingId,
    role: binding.role,
    bindingGeneration: binding.bindingGeneration,
    sessionId: binding.sessionId,
    sessionNonceHash: binding.sessionNonceHash,
    issuedAt: new Date().toISOString(),
  };
  const result = {
    status: 'issued',
    challengeId,
    bindingId,
    payload,
    proofRequired: true,
  };
  store.writeCapability(challengeRecordId, { ...result, type: 'binding-challenge' });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function cmdWorkerReceipt(taskId, opts = {}) {
  const attemptId = opts.attempt;
  const kind = opts.kind;
  const sequence = Number(opts.sequence);
  if (!attemptId) throw new Error('--attempt required');
  if (!kind) throw new Error('--kind required');
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error('--sequence must be a positive integer');
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const attempt = store.readAttempt(attemptId);
  if (!attempt) throw new Error('attempt-not-found');
  let binding = null;
  let rawNonce = null;
  const bindingId = opts.binding || attempt.bindingIdentity?.bindingId || null;
  if (bindingId) {
    binding = store.readBinding(bindingId);
    if (!binding) throw new Error('binding-not-found');
    rawNonce = store.readBindingSecret(bindingId);
    if (!rawNonce) throw new Error('binding-secret-unavailable');
  }
  const category = opts.category || opts['needs-input-category'];
  if (kind === 'job.needs-input') {
    if (!NEEDS_INPUT_CATEGORIES.has(category)) throw new Error('needs-input-invalid-category');
  }
  const receipt = createEvent({
    kind,
    source: opts.source || (binding ? 'wrapper-hook' : 'fake-adapter'),
    attempt,
    sequence,
    eventId: opts['event-id'],
    occurredAt: opts['occurred-at'],
    details: {
      ...(category ? { category } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
    binding,
    rawNonce,
  });
  const published = store.publishReceipt(receipt);
  const result = {
    status: published.status,
    eventId: receipt.eventId,
    attemptId: receipt.attemptId,
    receiptPath: store.receiptPath('inbox', receipt.attemptId, receipt.eventId),
    payloadHash: published.payloadHash,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWarpDoctor(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  if (opts['probe-fixture'] === true || opts['probe-fixture'] === 'true') {
    const evidence = {
      protocolVersion: 1,
      kind: 'warp-macos.capability',
      capturedAt: new Date().toISOString(),
      fixture: true,
      warp: { detected: true, bundleId: 'fixture.warp', version: 'fixture' },
      accessibility: { permission: 'granted', helper: 'fixture-helper', helperVersion: 1 },
      targetDiscovery: { available: true, stableFingerprintFields: ['bindingId', 'role', 'candidateId'], requiresTwoScanStability: true },
      inputSubmission: { available: true, method: 'fixture-submit', usesClipboard: false, settleBarrier: 'fixture-submit-result' },
      targetIdentity: { available: true, requiresWrapperBinding: true, requiresChallenge: true },
      diagnosticEligible: true,
      phase4RunEnabled: opts['enable-production-test'] === true || opts['enable-production-test'] === 'true',
      phase5ProductionCandidate: opts['enable-phase5-candidate'] === true || opts['enable-phase5-candidate'] === 'true',
      reasons: [],
    };
    store.writeCapability(WARP_CAPABILITY_NAME, evidence);
  }
  if (opts['probe-real'] === true || opts['probe-real'] === 'true') {
    const helper = new ProcessWarpMacosHelper({ scriptPath: path.join(__dirname, 'warp-macos-helper.js') });
    const evidence = await helper.probeCapability();
    assertRealWarpCapabilityEvidence(evidence);
    if (evidence.inputSubmission?.usesClipboard !== false) throw new Error('warp-probe-real-clipboard-forbidden');
    store.writeCapability(WARP_CAPABILITY_NAME, evidence);
  }
  const evidence = store.readCapability(WARP_CAPABILITY_NAME);
  const result = {
    adapter: 'warp-macos',
    evidence: evidence || null,
    capabilities: deriveWarpCapabilities(evidence, { requireProductionTest: false }),
    hookCapabilities: deriveHookCapabilities(store.readCapability('claude-hook')),
  };
  console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result;
}

function cmdWarpTargets(taskId, opts = {}) {
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const role = opts.role;
  if (role && !['work', 'review'].includes(role)) throw new Error('--role must be work or review');
  const targets = warpTargetCandidates(store)
    .filter(target => !role || target.role === role)
    .map(target => ({
      adapter: target.adapter,
      role: target.role,
      bindingId: target.bindingId,
      candidateId: target.candidateId,
      targetFingerprintHash: target.targetFingerprintHash,
      targetChallengeId: target.targetChallengeId,
      targetBindingVerifiedAt: target.targetBindingVerifiedAt,
      capabilityEvidenceId: target.capabilityEvidenceId,
    }));
  const result = { adapter: 'warp-macos', targets };
  console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result;
}

function warpFixtureCandidate(binding, candidateId, opts = {}) {
  const role = binding.role;
  if (opts['title-only'] === true || opts['title-only'] === 'true') {
    return {
      adapter: 'warp-macos',
      bindingId: binding.bindingId,
      role,
      candidateId,
      fingerprint: { windowTitle: opts['window-title'] || 'Warp', tabTitle: opts['tab-title'] || role },
    };
  }
  if (opts['frontmost-only'] === true || opts['frontmost-only'] === 'true') {
    return {
      adapter: 'warp-macos',
      bindingId: binding.bindingId,
      role,
      candidateId,
      fingerprint: { frontmost: true, windowTitle: opts['window-title'] || 'Warp' },
    };
  }
  return {
    adapter: 'warp-macos',
    bindingId: binding.bindingId,
    role,
    candidateId,
    fingerprint: {
      adapter: 'warp-macos',
      bindingId: binding.bindingId,
      role,
      candidateId,
      bundleId: 'dev.warp.Warp-Stable',
      windowId: opts['window-id'] || `fixture-window-${candidateId}`,
      tabId: opts['tab-id'] || `fixture-tab-${role}`,
    },
  };
}

function warpFixtureDiscoveryPlan(binding, candidateId, opts = {}) {
  if (opts['fixture-targets']) {
    const fixturePath = path.resolve(String(opts['fixture-targets']));
    const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    if (Array.isArray(payload)) return { candidates: payload };
    if (payload && Array.isArray(payload.first) && Array.isArray(payload.second)) {
      return { scanSequences: [payload.first, payload.second] };
    }
    throw new Error('invalid-fixture-targets');
  }
  const candidate = warpFixtureCandidate(binding, candidateId, opts);
  if (opts['fixture-zero'] === true || opts['fixture-zero'] === 'true') return { candidates: [] };
  if (opts['fixture-duplicate'] === true || opts['fixture-duplicate'] === 'true') {
    return {
      candidates: [
        candidate,
        { ...candidate, fingerprint: { ...candidate.fingerprint, windowId: `${candidate.fingerprint?.windowId || 'window'}-duplicate` } },
      ],
    };
  }
  if (opts['fixture-changed'] === true || opts['fixture-changed'] === 'true') {
    return {
      scanSequences: [
        [candidate],
        [{ ...candidate, fingerprint: { ...candidate.fingerprint, windowId: `${candidate.fingerprint?.windowId || 'window'}-changed` } }],
      ],
    };
  }
  return { candidates: [candidate] };
}

async function cmdWarpBindTarget(taskId, opts = {}) {
  const role = opts.role;
  const bindingId = opts.binding;
  const candidateId = opts.candidate;
  const real = opts.real === true || opts.real === 'true';
  if (!['work', 'review'].includes(role)) throw new Error('--role must be work or review');
  if (!bindingId) throw new Error('--binding required');
  if (!candidateId) throw new Error('--candidate required');
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const binding = assertFreshBinding(store.readBinding(bindingId));
  if (binding.role !== role) throw new Error('target-binding-role-mismatch');
  const status = loadStatus(taskId, { persistMigration: false });
  if (status.execution.activeAttemptId) {
    const activeAttempt = store.readAttempt(status.execution.activeAttemptId);
    const activeJob = activeAttempt ? store.readJob(activeAttempt.jobId) : null;
    if (!activeJob ||
        activeJob.role === role ||
        activeAttempt.bindingId === bindingId ||
        activeAttempt.adapterIdentity?.bindingId === bindingId) {
      throw new Error('active-attempt-target-binding-conflict');
    }
  }
  const capability = store.readCapability(WARP_CAPABILITY_NAME);
  const capabilities = deriveWarpCapabilities(capability, { requireProductionTest: false });
  if (real) {
    if (!capability || capability.fixture === true || !capabilities.phase5ProductionCandidate) {
      throw new Error('warp-bind-target-real-capability-unavailable');
    }
    throw new Error('warp-bind-target-real-target-local-response-channel-unavailable');
  }
  if (!capabilities.diagnosticEligible) throw new Error('warp-macos-capability-unavailable');
  const discoveryPlan = warpFixtureDiscoveryPlan(binding, candidateId, opts);
  const helper = new FixtureWarpMacosHelper(discoveryPlan);
  const target = await discoverStableTarget(helper, { role, candidateId });
  const fingerprintHash = target.targetFingerprintHash;
  const challengeId = opts['challenge-id'] || randomUUID();
  let challenge = store.readTargetChallenge(challengeId);
  if (!challenge) {
    const payload = createTargetChallengePayload({
      taskId,
      role,
      binding,
      candidateId,
      targetFingerprintHash: fingerprintHash,
      capabilityEvidenceId: opts['capability-evidence-id'] || `${WARP_CAPABILITY_NAME}:${capability.capturedAt}`,
      challengeId,
      });
    challenge = { status: 'issued', payload, issuedAt: payload.issuedAt };
    store.writeTargetChallenge(challenge);
    if (!(opts['respond-fixture'] === true || opts['respond-fixture'] === 'true')) {
      const result = { status: 'issued', challengeId, payload };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
  }
  if (challenge.payload.targetFingerprintHash !== fingerprintHash) throw new Error('target-challenge-target-mismatch');
  if (challenge.status === 'verified') throw new Error('target-challenge-replay');
  const rawNonce = store.readBindingSecret(bindingId);
  const response = createTargetChallengeResponse({ payload: challenge.payload, rawNonce });
  store.publishTargetChallengeResponse(response);
  const targetBinding = validateTargetChallengeResponse({
    challenge,
    response,
    binding,
    rawNonce,
  });
  const nextBinding = {
    ...binding,
    targetBinding: {
      ...targetBinding,
      candidateId,
    },
  };
  store.writeBinding(nextBinding);
  store.writeTargetChallenge({ ...challenge, status: 'verified', verifiedAt: targetBinding.verifiedAt });
  store.finalizeTargetChallengeResponse(challengeId, response.eventId, 'processed');
  const result = { status: 'verified', bindingId, role, targetBinding: nextBinding.targetBinding };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWarpShadowSend(taskId, opts = {}) {
  const role = opts.role;
  const bindingId = opts.binding;
  if (!['work', 'review'].includes(role)) throw new Error('--role must be work or review');
  if (!bindingId) throw new Error('--binding required');
  const message = opts.message || 'HEXAI Harness Phase 4 shadow probe. Do not modify files, run commands, approve tools, commit, push, or change workflow state.';
  const { store } = createWorkerRuntime(taskId, { adapterName: 'fake' });
  const target = warpTargetCandidates(store).find(item => item.role === role && item.bindingId === bindingId);
  if (!target) throw new Error('warp-target-not-bound');
  const operationId = opts['operation-id'] || randomUUID();
  const helper = new FixtureWarpMacosHelper({
    candidates: [target],
    submitResult: opts['side-effect-state'] ? {
      protocolVersion: 1,
      kind: 'warp-macos.submit-result',
      operationId,
      targetFingerprintHash: target.targetFingerprintHash,
      transportEvidenceId: randomUUID(),
      sideEffectState: opts['side-effect-state'],
      settled: true,
      usedClipboard: opts['used-clipboard'] === true || opts['used-clipboard'] === 'true',
      evidencePath: 'fixture://warp-shadow-send',
      submittedAt: opts['side-effect-state'] === 'submitted' ? new Date().toISOString() : null,
    } : null,
  });
  const adapter = new WarpMacosAdapter({ store, helper, productionTest: true, scratchTask: true });
  const result = await adapter.dispatch(
    {
      jobId: `shadow:${operationId}`,
      promptText: message,
      attempt: {
        jobId: `shadow:${operationId}`,
        attemptId: `shadow-attempt:${operationId}`,
        leaseToken: `shadow-lease:${operationId}`,
        lockEpoch: 0,
      },
      pilotAuthorization: {
        allowlistId: 'warp-shadow-send',
        allowlistHash: 'sha256:warp-shadow-send',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    target,
    { operationId }
  );
  const output = { status: result.status, sideEffectState: result.sideEffectState || null, submitted: result.submitted === true };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function cmdWorkerRetry(taskId, opts = {}) {
  if (!opts.job) throw new Error('--job required');
  const { supervisor } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const prepared = await supervisor.retry(opts.job);
  const dispatched = await supervisor.dispatch(prepared.operationId, {
    timeoutMs: Number(opts['dispatch-timeout-ms'] || 30_000),
  });
  const result = { ...prepared, dispatched, success: dispatched.status === 'dispatch-submitted' };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWorkerCancel(taskId, opts = {}) {
  for (const field of ['job', 'attempt', 'lease-token']) {
    if (!opts[field]) throw new Error(`--${field} required`);
  }
  const { supervisor } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const result = await supervisor.cancel({
    jobId: opts.job,
    attemptId: opts.attempt,
    leaseToken: opts['lease-token'],
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWorkerReconcile(taskId, opts = {}) {
  if (!opts.attempt) throw new Error('--attempt required');
  if (!opts.decision) throw new Error('--decision required');
  const { supervisor } = createWorkerRuntime(taskId, { adapterName: opts.adapter });
  const result = await supervisor.reconcile(opts.attempt, opts.decision, {
    confirmTargetQuiescent: opts['confirm-target-quiescent'] === true || opts['confirm-target-quiescent'] === 'true',
    confirmPromptNotVisible: opts['confirm-prompt-not-visible'] === true || opts['confirm-prompt-not-visible'] === 'true',
    confirmPromptNotRunning: opts['confirm-prompt-not-running'] === true || opts['confirm-prompt-not-running'] === 'true',
    reason: opts.reason,
    residualRisk: opts['residual-risk'],
    operator: opts.operator || process.env.USER || 'cli',
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdWorkerTakeover(taskId, reason) {
  const { supervisor } = createWorkerRuntime(taskId, { alreadyLocked: true });
  return supervisor.takeover(reason);
}

// ---------------------------------------------------------------------------
// File Mailbox Phase C — operator-assisted CLI skeleton
// ---------------------------------------------------------------------------
function createMailboxStore(taskId) {
  return new MailboxStore({
    harnessRoot: HARNESS_ROOT,
    reviewRoot: getEffectiveReviewRoot(),
    taskId,
  });
}

function sha256FilePrefixed(filePath) {
  const snapshot = getFileSnapshot(filePath);
  if (!snapshot.exists) throw new Error(`file-not-found: ${filePath}`);
  return `sha256:${snapshot.sha256}`;
}

function sha256TextPrefixed(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`;
}

function mailboxRoleForStage(stage) {
  const target = getTargetWindow(stage);
  if (target === 'work' || target === 'review') return target;
  throw new Error(`mailbox-stage-not-eligible: ${stage}`);
}

function mailboxExpectedSkill(stage) {
  const requiredSkill = getStageConfig(stage)?.requiredSkill;
  if (requiredSkill?.startsWith('hexai-')) return `nNian-${requiredSkill.slice('hexai-'.length)}`;
  return requiredSkill || `nNian-${stage}`;
}

function emitMailboxResult(result) {
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function prepareMailboxPromptArtifact(taskId) {
  const status = loadStatus(taskId);
  if (status.awaitingCommit) throw new Error('awaiting-commit');
  if (status.execution?.activeJobId || status.execution?.activeAttemptId) {
    throw new Error('active-job-conflict: mailbox-publish cannot start while execution is active');
  }
  if (status.mailbox?.activeSessionId) {
    throw new Error(`active-mailbox-conflict: mailbox-publish cannot start while session=${status.mailbox.activeSessionId} is active`);
  }

  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];
  if (!stageData) throw new Error(`No stage data for ${currentSubtask} / ${currentStage}`);

  const subtask = getSubtasksForTask().find(s => s.id === currentSubtask);
  if (!subtask) throw new Error(`Unknown subtask: ${currentSubtask}`);

  const round = getRoundForStage(status, currentSubtask, currentStage);
  if (!stageData.primaryReportPath) {
    stageData.primaryReportPath = generateReportPath(taskId, subtask, currentStage, round);
  }
  if (!stageData.mirrorOutputPath) {
    stageData.mirrorOutputPath = path.join(outputsDir(taskId, currentSubtask), path.basename(stageData.primaryReportPath));
  }
  if (!stageData.handoffPath) {
    stageData.handoffPath = generateHandoffPath(taskId, subtask, currentStage);
  }
  if (!stageData.mirrorHandoffPath) {
    stageData.mirrorHandoffPath = generateMirrorHandoffPath(taskId, subtask, currentStage);
  }

  stageData.currentOutputPath = stageData.primaryReportPath;
  stageData.outputBaseline = getFileSnapshot(stageData.primaryReportPath);
  stageData.outputBaselineCapturedAt = now();
  const wasInterrupted = stageData.stageStatus === 'interrupted';
  stageData.stageStatus = 'active';
  if (!stageData.startedAt) stageData.startedAt = now();
  bumpStageRevision(status);

  const result = wasInterrupted
    ? generateContinuationPrompt(taskId, status, currentSubtask, currentStage, subtask)
    : {
        prompt: substituteTemplate(loadTemplate(getTemplateName(currentStage)), buildTemplateVars(taskId, currentSubtask, currentStage, status)),
        stage: currentStage,
        subtask: currentSubtask,
        continuation: false,
      };

  const promptPath = promptFilePath(taskId, currentSubtask, currentStage);

  return {
    status,
    currentSubtask,
    currentStage,
    round,
    promptPath,
    primaryReportPath: stageData.primaryReportPath,
    outputBaseline: stageData.outputBaseline,
    prompt: result.prompt,
  };
}

function assertMailboxStatusActive(status, ledger) {
  if (status.mailbox?.activeSessionId !== ledger.sessionId ||
      status.mailbox?.activeAttemptId !== ledger.attemptId ||
      status.mailbox?.activeCursorHash !== ledger.activeCursorHash) {
    throw new Error('active-mailbox-cursor-mismatch');
  }
}

function readActiveMailboxContext(taskId, sessionId = null) {
  const status = loadStatus(taskId);
  const activeSessionId = sessionId || status.mailbox?.activeSessionId;
  if (!activeSessionId) throw new Error('mailbox-no-active-session');
  const store = createMailboxStore(taskId);
  const { ledger, marker } = store.assertPublishCommitted(activeSessionId);
  assertMailboxStatusActive(status, ledger);
  const session = store.readSession(activeSessionId);
  if (!session) throw new Error(`mailbox-session-not-found: ${activeSessionId}`);
  const envelope = store.readEnvelope(activeSessionId);
  if (!envelope) throw new Error(`mailbox-envelope-not-found: ${activeSessionId}`);
  return { status, store, ledger, marker, session, envelope };
}

function readMailboxCloseContext(taskId, sessionId) {
  const status = loadStatus(taskId);
  const store = createMailboxStore(taskId);
  const session = store.readSession(sessionId);
  if (!session) throw new Error(`mailbox-session-not-found: ${sessionId}`);
  const envelope = store.readEnvelope(sessionId);
  if (!envelope) throw new Error(`mailbox-envelope-not-found: ${sessionId}`);
  const closeLedger = store.readCloseLedger(sessionId);
  const activeSessionId = status.mailbox?.activeSessionId || null;
  let publish = null;
  if (activeSessionId === sessionId) {
    publish = store.assertPublishCommitted(sessionId);
    assertMailboxStatusActive(status, publish.ledger);
  } else if (activeSessionId) {
    throw new Error(`active-mailbox-other-session: ${activeSessionId}`);
  } else if (session.state !== 'closed' || !closeLedger) {
    throw new Error('mailbox-close-status-not-active');
  }
  return { status, store, session, envelope, closeLedger, publish };
}

function updateMailboxSession(store, session, updates) {
  const next = { ...session, ...updates, updatedAt: now() };
  store.writeSession(next);
  return next;
}

function appendMailboxEvent(store, event) {
  return store.appendEvent({
    protocolVersion: 1,
    eventId: randomUUID(),
    occurredAt: now(),
    ...event,
  });
}

function workerIdentityHashFromOpts(opts = {}) {
  if (opts['worker-identity-hash']) return opts['worker-identity-hash'];
  if (opts['worker-identity']) return sha256TextPrefixed(opts['worker-identity']);
  return null;
}

function mailboxSourceForMode(mode) {
  return mode === 'worker' ? 'claude-code-worker' : 'claude-code-operator';
}

function assertMailboxClaimOwnerForMode(session, binding, mode, action) {
  if (mode === 'worker') {
    if (session.claimSource !== 'claude-code-worker') {
      throw new Error(`mailbox-worker-claim-owner-mismatch: ${action}: source`);
    }
    if (session.claimBindingId !== binding.bindingId) {
      throw new Error(`mailbox-worker-claim-owner-mismatch: ${action}: binding`);
    }
    if (session.claimBindingGeneration !== binding.bindingGeneration) {
      throw new Error(`mailbox-worker-claim-owner-mismatch: ${action}: generation`);
    }
    if (session.claimWorkerIdentityHash !== binding.workerIdentityHash) {
      throw new Error(`mailbox-worker-claim-owner-mismatch: ${action}: worker-identity`);
    }
    return;
  }
  if (session.claimSource === 'claude-code-worker') {
    throw new Error(`mailbox-worker-session-requires-takeover: ${action}`);
  }
}

function frozenWorkerClaimBinding(session, envelope) {
  if (session.claimSource !== 'claude-code-worker') return null;
  if (!session.claimBindingId || !session.claimBindingGeneration || !session.claimWorkerIdentityHash) {
    throw new Error('mailbox-worker-claim-owner-incomplete');
  }
  return {
    bindingId: session.claimBindingId,
    bindingGeneration: session.claimBindingGeneration,
    workerIdentityHash: session.claimWorkerIdentityHash,
    role: envelope.role,
  };
}

function assertWorkerCompleteArtifacts(store, ledger, session, envelope) {
  if (session.promptPath !== envelope.prompt.path) throw new Error('mailbox-worker-prompt-path-mismatch');
  if (session.promptSha256 !== envelope.prompt.sha256) throw new Error('mailbox-worker-prompt-hash-mismatch');
  if (ledger.promptHash !== envelope.prompt.sha256) throw new Error('mailbox-worker-ledger-prompt-hash-mismatch');
  store.validatePromptForLedger(ledger, session.promptPath, session.promptSha256, 'worker-complete');
  if (session.primaryReportPath !== envelope.expectedOutput.primaryReportPath) {
    throw new Error('mailbox-worker-output-path-mismatch');
  }
}

function cmdMailboxBind(taskId, opts = {}) {
  const role = opts.role;
  const bindingId = opts.binding;
  if (!['work', 'review'].includes(role)) throw new Error('mailbox-bind requires --role work|review');
  if (!bindingId) throw new Error('mailbox-bind requires --binding <id>');
  const store = createMailboxStore(taskId);
  const { binding } = store.createBinding({
    bindingId,
    role,
    replace: opts.replace === true || opts.replace === 'true',
    workerIdentityHash: workerIdentityHashFromOpts(opts),
    metadata: { operator: opts.operator || process.env.USER || 'cli' },
  });
  appendMailboxEvent(store, {
    kind: opts.replace ? 'mailbox.binding-replaced' : 'mailbox.binding-created',
    taskId,
    bindingId,
    role,
    bindingGeneration: binding.bindingGeneration,
  });
  return emitMailboxResult({
    ok: true,
    code: opts.replace ? 'mailbox-binding-replaced' : 'mailbox-binding-created',
    bindingId,
    role,
    bindingGeneration: binding.bindingGeneration,
    workerIdentityHash: binding.workerIdentityHash || null,
    noncePath: store.bindingSecretPath(bindingId),
  });
}

function cmdMailboxPublish(taskId) {
  const artifact = prepareMailboxPromptArtifact(taskId);
  const store = createMailboxStore(taskId);
  const sessionId = randomUUID();
  const attemptId = randomUUID();
  const stageCursor = {
    subtaskId: artifact.currentSubtask,
    stage: artifact.currentStage,
    round: artifact.round,
    stageRevision: artifact.status.stageRevision,
  };
  let ledger = store.createPublishIntent({
    sessionId,
    attemptId,
    stageCursor,
    statusRevisionBefore: artifact.status.stateRevision,
  });
  ensureDir(path.dirname(artifact.promptPath));
  fs.writeFileSync(artifact.promptPath, artifact.prompt, 'utf-8');
  saveStatus(taskId, artifact.status);
  const promptHash = sha256FilePrefixed(artifact.promptPath);
  ledger = store.markPromptWritten(sessionId, promptHash);
  const role = mailboxRoleForStage(artifact.currentStage);
  const session = {
    protocolVersion: 1,
    kind: 'hexai.mailbox.session',
    taskId,
    sessionId,
    attemptId,
    state: 'published',
    stageCursor: ledger.stageCursor,
    activeCursorHash: ledger.activeCursorHash,
    bindingId: null,
    promptPath: artifact.promptPath,
    promptSha256: promptHash,
    primaryReportPath: artifact.primaryReportPath,
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
    lastEventId: null,
  };
  ledger = store.markSessionWritten(sessionId, session);
  const envelope = {
    protocolVersion: 1,
    kind: 'hexai.mailbox.task',
    taskId,
    sessionId,
    attemptId,
    createdAt: now(),
    role,
    expectedSkill: mailboxExpectedSkill(artifact.currentStage),
    stageCursor: ledger.stageCursor,
    activeCursorHash: ledger.activeCursorHash,
    prompt: {
      path: artifact.promptPath,
      sha256: promptHash,
    },
    expectedOutput: {
      primaryReportPath: artifact.primaryReportPath,
      baseline: artifact.outputBaseline,
    },
    constraints: {
      noAutoApprove: true,
      noAutoDelivery: true,
      noCommit: true,
      noPush: true,
      noClipboard: true,
      noWarp: true,
    },
  };
  ledger = store.markEnvelopePublished(sessionId, envelope, artifact.primaryReportPath);
  artifact.status.mailbox = {
    mode: 'manual',
    activeSessionId: sessionId,
    activeAttemptId: attemptId,
    activeCursorHash: activeCursorHash(createMailboxStageCursor(ledger.stageCursor)),
    lastSessionId: sessionId,
  };
  addHistory(artifact.status, 'mailbox-publish', {
    sessionId,
    attemptId,
    activeCursorHash: artifact.status.mailbox.activeCursorHash,
    promptPath: artifact.promptPath,
    primaryReportPath: artifact.primaryReportPath,
  });
  saveStatus(taskId, artifact.status);
  store.markStatusActive(sessionId, { statusRevisionAfter: artifact.status.stateRevision });
  const committed = store.commitPublish(sessionId);
  appendMailboxEvent(store, {
    kind: 'mailbox.publish-committed',
    taskId,
    sessionId,
    attemptId,
    activeCursorHash: ledger.activeCursorHash,
  });
  return emitMailboxResult({
    ok: true,
    code: 'mailbox-published',
    sessionId,
    attemptId,
    activeCursorHash: ledger.activeCursorHash,
    promptPath: artifact.promptPath,
    primaryReportPath: artifact.primaryReportPath,
    committedAt: committed.committedAt,
  });
}

function cmdMailboxPeek(taskId) {
  const status = loadStatus(taskId, { persistMigration: false });
  if (!status.mailbox?.activeSessionId) {
    return emitMailboxResult({ ok: true, code: 'mailbox-empty', tasks: [] });
  }
  const { ledger, session, envelope } = readActiveMailboxContext(taskId);
  return emitMailboxResult({
    ok: true,
    code: 'mailbox-active',
    tasks: [{
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      activeCursorHash: ledger.activeCursorHash,
      state: session.state,
      role: envelope.role,
      promptPath: envelope.prompt.path,
      primaryReportPath: envelope.expectedOutput.primaryReportPath,
      claimable: session.state === 'published',
    }],
  });
}

function cmdMailboxWorkerPeek(taskId, opts = {}) {
  if (!opts.binding) throw new Error('mailbox-worker-peek requires --binding <id>');
  if (!['work', 'review'].includes(opts.role)) throw new Error('mailbox-worker-peek requires --role work|review');
  const store = createMailboxStore(taskId);
  const binding = store.readBinding(opts.binding);
  if (!binding || binding.state !== 'live') throw new Error(`binding-not-live: ${opts.binding}`);
  if (binding.role !== opts.role) throw new Error(`binding-role-mismatch: expected ${opts.role}, got ${binding.role}`);
  return cmdMailboxPeek(taskId);
}

function assertMailboxBindingForSession(store, bindingId, envelope) {
  const binding = store.readBinding(bindingId);
  if (!binding || binding.state !== 'live') throw new Error(`binding-not-live: ${bindingId}`);
  if (binding.role !== envelope.role) throw new Error(`binding-role-mismatch: expected ${envelope.role}, got ${binding.role}`);
  return binding;
}

function publishMailboxReceipt(store, kind, session, envelope, bindingId, details = {}, outputSnapshot = null, source = 'claude-code-operator') {
  return store.publishReceipt({
    kind,
    bindingId,
    role: envelope.role,
    sessionId: session.sessionId,
    attemptId: session.attemptId,
    stageCursor: session.stageCursor,
    activeCursorHash: session.activeCursorHash,
    details,
    outputSnapshot,
    source,
  });
}

function cmdMailboxClaim(taskId, opts = {}, mode = 'operator') {
  if (!opts.session) throw new Error('mailbox-claim requires --session <id>');
  if (!opts.binding) throw new Error('mailbox-claim requires --binding <id>');
  if (mode !== 'worker' && !opts.reason) throw new Error('mailbox-claim requires --reason <text>');
  const { store, session, envelope } = readActiveMailboxContext(taskId, opts.session);
  if (session.state !== 'published') throw new Error(`mailbox-session-not-claimable: ${session.state}`);
  const binding = assertMailboxBindingForSession(store, opts.binding, envelope);
  const source = mailboxSourceForMode(mode);
  if (mode === 'worker') store.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source });
  const updated = updateMailboxSession(store, session, {
    state: 'claimed',
    bindingId: opts.binding,
    claimBindingId: opts.binding,
    claimBindingGeneration: binding.bindingGeneration,
    claimWorkerIdentityHash: binding.workerIdentityHash || null,
    claimSource: source,
    claimedAt: now(),
  });
  if (mode === 'worker') store.appendClaimedRoleEvidence({ session: updated, binding, source });
  const receipt = publishMailboxReceipt(store, 'session.claimed', updated, envelope, opts.binding, { reason: opts.reason || 'worker claim' }, null, source);
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: mode === 'worker' ? 'worker-claim' : 'claim', taskId, sessionId: session.sessionId, attemptId: session.attemptId, reason: opts.reason || 'worker claim' });
  return emitMailboxResult({ ok: true, code: mode === 'worker' ? 'mailbox-worker-claimed' : 'mailbox-claimed', sessionId: session.sessionId, attemptId: session.attemptId, activeCursorHash: session.activeCursorHash, receiptEventId: receipt.receipt.eventId });
}

function cmdMailboxStart(taskId, opts = {}, mode = 'operator') {
  if (!opts.session) throw new Error('mailbox-start requires --session <id>');
  if (!opts.binding) throw new Error('mailbox-start requires --binding <id>');
  const { store, session, envelope } = readActiveMailboxContext(taskId, opts.session);
  if (session.state !== 'claimed') throw new Error(`mailbox-session-not-claimed: ${session.state}`);
  if (session.bindingId !== opts.binding) throw new Error('mailbox-binding-mismatch');
  const binding = assertMailboxBindingForSession(store, opts.binding, envelope);
  if (session.claimBindingGeneration && session.claimBindingGeneration !== binding.bindingGeneration) throw new Error('mailbox-binding-generation-mismatch');
  assertMailboxClaimOwnerForMode(session, binding, mode, 'start');
  const source = mailboxSourceForMode(mode);
  const updated = updateMailboxSession(store, session, { state: 'running' });
  const receipt = publishMailboxReceipt(store, 'session.running', updated, envelope, opts.binding, {}, null, source);
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: mode === 'worker' ? 'worker-start' : 'start', taskId, sessionId: session.sessionId, attemptId: session.attemptId });
  return emitMailboxResult({ ok: true, code: mode === 'worker' ? 'mailbox-worker-running' : 'mailbox-running', sessionId: session.sessionId, attemptId: session.attemptId, activeCursorHash: session.activeCursorHash, receiptEventId: receipt.receipt.eventId });
}

function cmdMailboxComplete(taskId, opts = {}, mode = 'operator') {
  if (!opts.session) throw new Error('mailbox-complete requires --session <id>');
  if (!opts.binding) throw new Error('mailbox-complete requires --binding <id>');
  if (!opts.summary) throw new Error('mailbox-complete requires --summary <text>');
  const { store, ledger, session, envelope } = readActiveMailboxContext(taskId, opts.session);
  if (!['claimed', 'running'].includes(session.state)) throw new Error(`mailbox-session-not-completable: ${session.state}`);
  if (session.bindingId !== opts.binding) throw new Error('mailbox-binding-mismatch');
  const binding = assertMailboxBindingForSession(store, opts.binding, envelope);
  if (session.claimBindingGeneration && session.claimBindingGeneration !== binding.bindingGeneration) throw new Error('mailbox-binding-generation-mismatch');
  assertMailboxClaimOwnerForMode(session, binding, mode, 'complete');
  const source = mailboxSourceForMode(mode);
  if (mode === 'worker') store.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source });
  if (mode === 'worker') assertWorkerCompleteArtifacts(store, ledger, session, envelope);
  const outputSnapshot = getFileSnapshot(session.primaryReportPath);
  if (!outputSnapshot.exists) throw new Error(`mailbox-output-missing: ${session.primaryReportPath}`);
  const receipt = publishMailboxReceipt(store, 'session.completed', session, envelope, opts.binding, { summary: opts.summary }, outputSnapshot, source);
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: mode === 'worker' ? 'worker-complete' : 'complete', taskId, sessionId: session.sessionId, attemptId: session.attemptId, reason: opts.summary, primarySnapshot: outputSnapshot });
  return emitMailboxResult({ ok: true, code: mode === 'worker' ? 'mailbox-worker-completed-receipt-published' : 'mailbox-completed-receipt-published', sessionId: session.sessionId, attemptId: session.attemptId, activeCursorHash: session.activeCursorHash, receiptEventId: receipt.receipt.eventId });
}

function cmdMailboxTerminalReceipt(taskId, opts = {}, kind, action, mode = 'operator') {
  if (!opts.session) throw new Error(`mailbox-${action} requires --session <id>`);
  if (!opts.binding) throw new Error(`mailbox-${action} requires --binding <id>`);
  if (!opts.reason) throw new Error(`mailbox-${action} requires --reason <text>`);
  const { store, session, envelope } = readActiveMailboxContext(taskId, opts.session);
  if (!['claimed', 'running'].includes(session.state)) throw new Error(`mailbox-session-not-${action}: ${session.state}`);
  if (session.bindingId !== opts.binding) throw new Error('mailbox-binding-mismatch');
  const binding = assertMailboxBindingForSession(store, opts.binding, envelope);
  if (session.claimBindingGeneration && session.claimBindingGeneration !== binding.bindingGeneration) throw new Error('mailbox-binding-generation-mismatch');
  assertMailboxClaimOwnerForMode(session, binding, mode, action);
  const source = mailboxSourceForMode(mode);
  if (mode === 'worker') store.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source });
  const receipt = publishMailboxReceipt(store, kind, session, envelope, opts.binding, { reason: opts.reason }, null, source);
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: mode === 'worker' ? `worker-${action}` : action, taskId, sessionId: session.sessionId, attemptId: session.attemptId, reason: opts.reason });
  return emitMailboxResult({ ok: true, code: mode === 'worker' ? `mailbox-worker-${action}-receipt-published` : `mailbox-${action}-receipt-published`, sessionId: session.sessionId, attemptId: session.attemptId, activeCursorHash: session.activeCursorHash, receiptEventId: receipt.receipt.eventId });
}

function moveMailboxReceipt(store, filePath, bucket, receipt) {
  const destination = store.receiptPath(bucket, receipt.attemptId, receipt.eventId);
  store.ensureMailboxFileTarget(destination);
  if (fs.existsSync(destination)) {
    fs.rmSync(filePath, { force: true });
    return destination;
  }
  fs.renameSync(filePath, destination);
  return destination;
}

function cmdMailboxPump(taskId, opts = {}) {
  const { store, session } = readActiveMailboxContext(taskId, opts.session);
  const receipts = store.listReceipts('inbox').filter(item =>
    item.receipt?.sessionId === session.sessionId && item.receipt?.attemptId === session.attemptId
  ).sort((a, b) => (a.receipt?.sequence || 0) - (b.receipt?.sequence || 0));
  const consumedSequences = new Set(
    ['processed', 'rejected']
      .flatMap(bucket => store.listReceipts(bucket))
      .filter(item => item.receipt?.sessionId === session.sessionId && item.receipt?.attemptId === session.attemptId)
      .map(item => item.receipt.sequence)
  );
  let expectedSequence = 1;
  while (consumedSequences.has(expectedSequence)) expectedSequence += 1;
  let next = session;
  const processed = [];
  for (const { filePath, receipt, error } of receipts) {
    if (error || !receipt) continue;
    if (receipt.sequence < expectedSequence) {
      moveMailboxReceipt(store, filePath, 'processed', receipt);
      continue;
    }
    if (receipt.sequence > expectedSequence) {
      appendMailboxEvent(store, {
        kind: 'mailbox.receipt-sequence-gap',
        taskId,
        sessionId: session.sessionId,
        attemptId: session.attemptId,
        expectedSequence,
        foundSequence: receipt.sequence,
        receiptEventId: receipt.eventId,
      });
      break;
    }
    if (!store.verifyBindingProof(receipt.binding?.bindingId, receipt)) {
      appendMailboxEvent(store, { kind: 'mailbox.receipt-rejected', taskId, sessionId: session.sessionId, attemptId: session.attemptId, receiptEventId: receipt.eventId, reason: 'invalid-proof' });
      moveMailboxReceipt(store, filePath, 'rejected', receipt);
      consumedSequences.add(receipt.sequence);
      expectedSequence += 1;
      while (consumedSequences.has(expectedSequence)) expectedSequence += 1;
      continue;
    }
    let state = next.state;
    if (receipt.kind === 'session.completed') {
      const output = getFileSnapshot(next.primaryReportPath);
      state = output.exists ? 'output-detected' : 'receipt-seen';
    } else if (receipt.kind === 'session.failed') {
      state = 'failed';
    } else if (receipt.kind === 'session.needs-input') {
      state = 'needs-input';
    } else if (receipt.kind === 'session.running') {
      state = 'running';
    } else if (receipt.kind === 'session.claimed') {
      state = 'claimed';
    }
    next = updateMailboxSession(store, next, { state, lastEventId: receipt.eventId });
    if (['session.completed', 'session.failed', 'session.needs-input'].includes(receipt.kind)) {
      store.appendReceiptAcceptedRoleEvidence(receipt);
    }
    moveMailboxReceipt(store, filePath, 'processed', receipt);
    consumedSequences.add(receipt.sequence);
    expectedSequence += 1;
    while (consumedSequences.has(expectedSequence)) expectedSequence += 1;
    processed.push({ eventId: receipt.eventId, kind: receipt.kind, state });
  }
  appendMailboxEvent(store, { kind: 'mailbox.pump', taskId, sessionId: session.sessionId, attemptId: session.attemptId, processed });
  return emitMailboxResult({ ok: true, code: 'mailbox-pumped', sessionId: session.sessionId, attemptId: session.attemptId, activeCursorHash: session.activeCursorHash, processed });
}

function cmdMailboxClose(taskId, opts = {}) {
  if (!opts.session) throw new Error('mailbox-close requires --session <id>');
  if (!opts.reason) throw new Error('mailbox-close requires --reason <text>');
  const context = readMailboxCloseContext(taskId, opts.session);
  const { status, store, session, envelope } = context;
  let current = session;
  let closeLedger = context.closeLedger;
  const statusActiveForSession = status.mailbox?.activeSessionId === current.sessionId;

  if (!statusActiveForSession && current.state === 'closed' && closeLedger) {
    const recovery = store.recoverCloseAfterStatusCleared(current.sessionId, { statusActiveSessionId: null, reason: opts.reason });
    appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: 'close-recovery', taskId, sessionId: current.sessionId, attemptId: current.attemptId, reason: opts.reason });
    return emitMailboxResult({ ok: true, code: 'mailbox-close-recovered', sessionId: current.sessionId, attemptId: current.attemptId, activeCursorHash: current.activeCursorHash, closePhase: recovery.ledger.phase });
  }

  const afterCheck = opts['after-check'] === true || opts['after-check'] === 'true';
  const closeBinding = frozenWorkerClaimBinding(current, envelope);
  if (closeBinding) {
    store.assertNoOppositeRoleGateSatisfied({
      session: current,
      binding: closeBinding,
      stageRole: closeBinding.role,
      source: 'claude-code-worker',
    });
  }
  if (afterCheck && ['receipt-seen', 'output-detected'].includes(current.state)) {
    const checkResult = cmdCheck(taskId, { persist: false });
    if (!checkResult.pass) {
      return emitMailboxResult({ ok: false, error: 'mailbox-close-check-failed', code: 'mailbox-close-check-failed', sessionId: current.sessionId, attemptId: current.attemptId, reasons: checkResult.reasons || [] });
    }
    if (closeBinding) {
      store.appendGateSatisfiedRoleEvidence({
        session: current,
        binding: closeBinding,
        source: 'claude-code-worker',
        checkResultHash: canonicalHash(checkResult),
        primarySnapshotHash: checkResult.primarySnapshot ? canonicalHash(checkResult.primarySnapshot) : null,
      });
    }
    appendMailboxEvent(store, { kind: 'mailbox.check-passed', taskId, sessionId: current.sessionId, attemptId: current.attemptId, activeCursorHash: current.activeCursorHash, primarySnapshot: checkResult.primarySnapshot });
    current = updateMailboxSession(store, current, { state: 'check-passed' });
  }
  const terminalSafe = ['check-passed', 'abandoned', 'rejected', 'taken-over'];
  if (current.state !== 'closed' && !terminalSafe.includes(current.state)) {
    throw new Error(`mailbox-close-not-terminal-safe: ${current.state}`);
  }
  if (closeBinding && current.state === 'check-passed') {
    store.appendGateSatisfiedRoleEvidence({
      session: current,
      binding: closeBinding,
      source: 'claude-code-worker',
    });
  }
  if (!closeLedger) {
    closeLedger = store.createCloseIntent({
      sessionId: current.sessionId,
      attemptId: current.attemptId,
      activeCursorHash: current.activeCursorHash,
      terminalPreconditionState: current.state,
      statusWasActive: true,
    });
  }
  if (closeLedger.phase === 'close-intent') closeLedger = store.advanceCloseLedger(current.sessionId, 'close-event-written');
  if (current.state !== 'closed') {
    current = updateMailboxSession(store, current, { state: 'closed', closedAt: now(), closeReason: opts.reason });
  }
  if (['close-intent', 'close-event-written'].includes(closeLedger.phase)) {
    closeLedger = store.advanceCloseLedger(current.sessionId, 'session-closed');
  }
  if (status.mailbox?.activeSessionId === current.sessionId) {
    status.mailbox = {
      mode: 'manual',
      activeSessionId: null,
      activeAttemptId: null,
      activeCursorHash: null,
      lastSessionId: current.sessionId,
    };
    addHistory(status, 'mailbox-close', { sessionId: current.sessionId, attemptId: current.attemptId, reason: opts.reason });
    saveStatus(taskId, status);
  }
  const recovery = store.recoverCloseAfterStatusCleared(current.sessionId, { statusActiveSessionId: status.mailbox?.activeSessionId || null, reason: opts.reason });
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: 'close', taskId, sessionId: current.sessionId, attemptId: current.attemptId, reason: opts.reason });
  return emitMailboxResult({ ok: true, code: 'mailbox-closed', sessionId: current.sessionId, attemptId: current.attemptId, activeCursorHash: current.activeCursorHash, closePhase: recovery.ledger.phase });
}

function cmdMailboxTakeover(taskId, opts = {}) {
  if (!opts.session) throw new Error('mailbox-takeover requires --session <id>');
  if (!opts.reason) throw new Error('mailbox-takeover requires --reason <text>');
  const { store, session } = readActiveMailboxContext(taskId, opts.session);
  const updated = updateMailboxSession(store, session, { state: 'taken-over' });
  appendMailboxEvent(store, { kind: 'mailbox.operator-action', action: 'takeover', taskId, sessionId: session.sessionId, attemptId: session.attemptId, reason: opts.reason });
  return emitMailboxResult({ ok: true, code: 'mailbox-taken-over', sessionId: updated.sessionId, attemptId: updated.attemptId, activeCursorHash: updated.activeCursorHash });
}

function cmdMailboxReconcile(taskId, opts = {}) {
  if (!opts.session) throw new Error('mailbox-reconcile requires --session <id>');
  if (!opts.outcome) throw new Error('mailbox-reconcile requires --outcome <value>');
  if (!opts.reason) throw new Error('mailbox-reconcile requires --reason <text>');
  const status = loadStatus(taskId);
  const store = createMailboxStore(taskId);
  const sessionBefore = store.readSession(opts.session);
  const ledger = store.readPublishLedger(opts.session);
  const statusBefore = structuredClone(status.mailbox || {});
  let sessionAfter = sessionBefore;
  let marker = null;

  const clearActiveIfMatches = () => {
    if (status.mailbox?.activeSessionId === opts.session) {
      status.mailbox = {
        mode: 'manual',
        activeSessionId: null,
        activeAttemptId: null,
        activeCursorHash: null,
        lastSessionId: opts.session,
      };
      addHistory(status, 'mailbox-reconcile', { sessionId: opts.session, outcome: opts.outcome, reason: opts.reason });
      saveStatus(taskId, status);
    }
  };

  const currentMailboxCursor = () => ({
    subtaskId: status.currentSubtask,
    stage: status.currentStage,
    round: getRoundForStage(status, status.currentSubtask, status.currentStage),
    stageRevision: status.stageRevision,
  });

  const mailboxCursorMatchesCurrent = stageCursor => {
    const current = currentMailboxCursor();
    return stageCursor?.subtaskId === current.subtaskId
      && stageCursor?.stage === current.stage
      && stageCursor?.round === current.round
      && stageCursor?.stageRevision === current.stageRevision;
  };

  const rejectActiveStatusRecovery = (reason, extra = {}) => {
    appendMailboxEvent(store, {
      kind: 'mailbox.operator-action',
      action: 'reconcile-rejected',
      taskId,
      sessionId: opts.session,
      outcome: opts.outcome,
      reason: opts.reason,
      rejectionReason: reason,
      statusBefore,
      sessionBefore,
      ledger,
      ...extra,
    });
    throw new Error(reason);
  };

  const assertCanWriteActiveMailboxStatus = () => {
    const activeSessionId = status.mailbox?.activeSessionId || null;
    if (activeSessionId && activeSessionId !== opts.session) {
      rejectActiveStatusRecovery(`mailbox-reconcile-active-other-session: ${activeSessionId}`, { activeSessionId });
    }
    if (!mailboxCursorMatchesCurrent(ledger?.stageCursor)) {
      rejectActiveStatusRecovery(`mailbox-reconcile-stale-cursor: ${opts.session}`, {
        expectedCursor: currentMailboxCursor(),
        ledgerCursor: ledger?.stageCursor || null,
      });
    }
  };

  switch (opts.outcome) {
    case 'commit-marker': {
      if (!ledger) throw new Error(`publish-ledger-not-found: ${opts.session}`);
      assertMailboxStatusActive(status, ledger);
      marker = store.commitPublish(opts.session);
      break;
    }
    case 'activate': {
      if (!ledger) throw new Error(`publish-ledger-not-found: ${opts.session}`);
      if (!['envelope-published', 'status-active', 'committed'].includes(ledger.phase)) {
        throw new Error(`mailbox-reconcile-activate-invalid-phase: ${ledger.phase}`);
      }
      assertCanWriteActiveMailboxStatus();
      status.mailbox = {
        mode: 'manual',
        activeSessionId: ledger.sessionId,
        activeAttemptId: ledger.attemptId,
        activeCursorHash: ledger.activeCursorHash,
        lastSessionId: ledger.sessionId,
      };
      addHistory(status, 'mailbox-reconcile', { sessionId: opts.session, outcome: opts.outcome, reason: opts.reason });
      saveStatus(taskId, status);
      if (ledger.phase === 'envelope-published') {
        store.markStatusActive(opts.session, { statusRevisionAfter: status.stateRevision });
      }
      marker = store.commitPublish(opts.session);
      break;
    }
    case 'repair-status': {
      if (!ledger) throw new Error(`publish-ledger-not-found: ${opts.session}`);
      store.assertPublishCommitted(opts.session);
      assertCanWriteActiveMailboxStatus();
      status.mailbox = {
        mode: 'manual',
        activeSessionId: ledger.sessionId,
        activeAttemptId: ledger.attemptId,
        activeCursorHash: ledger.activeCursorHash,
        lastSessionId: ledger.sessionId,
      };
      addHistory(status, 'mailbox-reconcile', { sessionId: opts.session, outcome: opts.outcome, reason: opts.reason });
      saveStatus(taskId, status);
      break;
    }
    case 'output-detected': {
      if (!sessionBefore) throw new Error(`mailbox-session-not-found: ${opts.session}`);
      const output = getFileSnapshot(sessionBefore.primaryReportPath);
      if (!output.exists) throw new Error(`mailbox-output-missing: ${sessionBefore.primaryReportPath}`);
      sessionAfter = updateMailboxSession(store, sessionBefore, { state: 'output-detected' });
      break;
    }
    case 'reject':
    case 'rejected': {
      if (sessionBefore) sessionAfter = updateMailboxSession(store, sessionBefore, { state: 'rejected' });
      clearActiveIfMatches();
      break;
    }
    case 'abandon':
    case 'abandoned':
    case 'clear-stale': {
      if (sessionBefore) sessionAfter = updateMailboxSession(store, sessionBefore, { state: 'abandoned' });
      clearActiveIfMatches();
      break;
    }
    default:
      throw new Error(`unsupported-mailbox-reconcile-outcome: ${opts.outcome}`);
  }

  appendMailboxEvent(store, {
    kind: 'mailbox.operator-action',
    action: 'reconcile',
    taskId,
    sessionId: opts.session,
    outcome: opts.outcome,
    reason: opts.reason,
    statusBefore,
    statusAfter: status.mailbox || {},
    sessionBefore,
    sessionAfter,
    marker,
  });
  return emitMailboxResult({ ok: true, code: 'mailbox-reconciled', sessionId: opts.session, outcome: opts.outcome });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------
async function main() {
  const { command, positional, opts } = parseArgs(process.argv);
  const taskId = positional[0];

  try {
    // Load workflow config for any command that needs it
    const commandsNeedingConfig = ['init', 'next', 'step', 'current', 'check', 'advance', 'status', 'summary',
      'accept', 'import', 'resume', 'set-current', 'interrupt', 'resume-current', 'brief',
      'doctor', 'run', 'pump', 'jobs', 'retry', 'cancel', 'reconcile',
      'worker-attach', 'worker-launch', 'worker-heartbeat', 'worker-detach',
      'worker-hook-probe', 'worker-bindings', 'worker-challenge', 'worker-receipt',
      'warp-doctor', 'warp-targets', 'warp-bind-target', 'warp-shadow-send',
      'pilot-doctor', 'pilot-allow',
      'mailbox-bind', 'mailbox-publish', 'mailbox-peek', 'mailbox-claim', 'mailbox-start',
      'mailbox-complete', 'mailbox-failed', 'mailbox-needs-input', 'mailbox-pump',
      'mailbox-close', 'mailbox-reconcile', 'mailbox-takeover',
      'mailbox-worker-peek', 'mailbox-worker-claim', 'mailbox-worker-start',
      'mailbox-worker-complete', 'mailbox-worker-failed', 'mailbox-worker-needs-input'];
    if (commandsNeedingConfig.includes(command) && taskId) {
      loadWorkflowConfig(taskId);
    }

    let commandResult;
    const dispatch = async () => {
      if (opts.takeover === true || opts.takeover === 'true') {
        if (!MANUAL_PROGRESS_COMMANDS.has(command)) throw new Error('--takeover only applies to manual progress commands');
        await cmdWorkerTakeover(taskId, opts.reason);
      }
      assertNoActiveExecution(taskId, command);
      switch (command) {
      case 'init': {
        if (!taskId) throw new Error('taskId required');
        cmdInit(taskId, {
          from: opts.from,
          stage: opts.stage,
          force: opts.force === true || opts.force === 'true',
          archiveExisting: opts['archive-existing'] === true || opts['archive-existing'] === 'true',
        });
        break;
      }
      case 'next': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdNext(taskId, { copy: opts.copy === true || opts.copy === 'true' });
        break;
      }
      case 'step': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdStep(taskId, { copy: !(opts['no-copy'] === true || opts['no-copy'] === 'true') });
        break;
      }
      case 'current': {
        if (!taskId) throw new Error('taskId required');
        cmdCurrent(taskId);
        break;
      }
      case 'check': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdCheck(taskId);
        break;
      }
      case 'advance': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdAdvance(taskId, { confirmCommitted: opts['confirm-committed'] === true || opts['confirm-committed'] === 'true' });
        break;
      }
      case 'status': {
        if (!taskId) throw new Error('taskId required');
        cmdStatus(taskId);
        break;
      }
      case 'summary': {
        if (!taskId) throw new Error('taskId required');
        cmdSummary(taskId);
        break;
      }
      case 'accept': {
        if (!taskId) throw new Error('taskId required');
        cmdAccept(taskId, { note: opts.note });
        break;
      }
      case 'import': {
        if (!taskId) throw new Error('taskId required');
        cmdImport(taskId, { completed: opts.completed });
        break;
      }
      case 'resume': {
        if (!taskId) throw new Error('taskId required');
        cmdResume(taskId, { from: opts.from, stage: opts.stage });
        break;
      }
      case 'set-current': {
        const [cmdTaskId, subtaskId, stage] = positional;
        if (!cmdTaskId || !subtaskId || !stage) throw new Error('taskId, subtaskId, and stage required');
        cmdSetCurrent(cmdTaskId, subtaskId, stage);
        break;
      }
      case 'interrupt': {
        if (!taskId) throw new Error('taskId required');
        cmdInterrupt(taskId, { reason: opts.reason });
        break;
      }
      case 'resume-current': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdResumeCurrent(taskId);
        break;
      }
      case 'brief': {
        if (!taskId) throw new Error('taskId required');
        cmdBrief(taskId);
        break;
      }
      case 'doctor': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerDoctor(taskId, { adapter: opts.adapter || 'fake' });
        break;
      }
      case 'run': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerRun(taskId, { ...opts, adapter: opts.adapter || 'fake' });
        break;
      }
      case 'pump': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerPump(taskId, { adapter: opts.adapter || 'fake' });
        break;
      }
      case 'jobs': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerJobs(taskId, { ...opts, adapter: opts.adapter || 'fake' });
        break;
      }
      case 'retry': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerRetry(taskId, { ...opts, adapter: opts.adapter || 'fake' });
        break;
      }
      case 'cancel': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerCancel(taskId, { ...opts, adapter: opts.adapter || 'fake' });
        break;
      }
      case 'reconcile': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWorkerReconcile(taskId, { ...opts, adapter: opts.adapter || 'fake' });
        break;
      }
      case 'worker-attach': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerAttach(taskId, opts);
        break;
      }
      case 'worker-launch': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerAttach(taskId, opts);
        break;
      }
      case 'worker-heartbeat': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerHeartbeat(taskId, opts);
        break;
      }
      case 'worker-detach': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerDetach(taskId, opts);
        break;
      }
      case 'worker-hook-probe': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerHookProbe(taskId, opts);
        break;
      }
      case 'worker-bindings': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerBindings(taskId, opts);
        break;
      }
      case 'worker-challenge': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerChallenge(taskId, opts);
        break;
      }
      case 'worker-receipt': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWorkerReceipt(taskId, opts);
        break;
      }
      case 'warp-doctor': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWarpDoctor(taskId, opts);
        break;
      }
      case 'warp-targets': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdWarpTargets(taskId, opts);
        break;
      }
      case 'warp-bind-target': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWarpBindTarget(taskId, opts);
        break;
      }
      case 'warp-shadow-send': {
        if (!taskId) throw new Error('taskId required');
        commandResult = await cmdWarpShadowSend(taskId, opts);
        break;
      }
      case 'pilot-doctor': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdPilotDoctor(taskId, opts);
        break;
      }
      case 'pilot-allow': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdPilotAllow(taskId, opts);
        break;
      }
      case 'mailbox-bind': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxBind(taskId, opts);
        break;
      }
      case 'mailbox-publish': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxPublish(taskId, opts);
        break;
      }
      case 'mailbox-peek': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxPeek(taskId, opts);
        break;
      }
      case 'mailbox-worker-peek': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxWorkerPeek(taskId, opts);
        break;
      }
      case 'mailbox-claim': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxClaim(taskId, opts);
        break;
      }
      case 'mailbox-worker-claim': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxClaim(taskId, opts, 'worker');
        break;
      }
      case 'mailbox-start': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxStart(taskId, opts);
        break;
      }
      case 'mailbox-worker-start': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxStart(taskId, opts, 'worker');
        break;
      }
      case 'mailbox-complete': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxComplete(taskId, opts);
        break;
      }
      case 'mailbox-worker-complete': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxComplete(taskId, opts, 'worker');
        break;
      }
      case 'mailbox-failed': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxTerminalReceipt(taskId, opts, 'session.failed', 'failed');
        break;
      }
      case 'mailbox-worker-failed': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxTerminalReceipt(taskId, opts, 'session.failed', 'failed', 'worker');
        break;
      }
      case 'mailbox-needs-input': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxTerminalReceipt(taskId, opts, 'session.needs-input', 'needs-input');
        break;
      }
      case 'mailbox-worker-needs-input': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxTerminalReceipt(taskId, opts, 'session.needs-input', 'needs-input', 'worker');
        break;
      }
      case 'mailbox-pump': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxPump(taskId, opts);
        break;
      }
      case 'mailbox-close': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxClose(taskId, opts);
        break;
      }
      case 'mailbox-reconcile': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxReconcile(taskId, opts);
        break;
      }
      case 'mailbox-takeover': {
        if (!taskId) throw new Error('taskId required');
        commandResult = cmdMailboxTakeover(taskId, opts);
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
      }
    };

    if (taskId && MANUAL_PROGRESS_COMMANDS.has(command)) {
      await withTaskExecutionLockRetry(taskId, command, dispatch);
    } else if (taskId && LOCKED_MAILBOX_COMMANDS.has(command)) {
      await withTaskExecutionLockRetry(taskId, command, dispatch);
    } else if (taskId && LOCKED_WORKER_ARTIFACT_COMMANDS.has(command) &&
        !(opts['dry-run'] === true || opts['dry-run'] === 'true')) {
      await withTaskExecutionLockRetry(taskId, command, dispatch);
    } else {
      await dispatch();
    }
    if (commandResult?.success === false || commandResult?.pass === false || commandResult?.error) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exitCode = 1;
});
