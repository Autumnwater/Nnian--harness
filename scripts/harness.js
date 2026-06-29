#!/usr/bin/env node
// HEXAI Review Harness V2 — CLI
// Lightweight orchestration for multi-agent weekly task R&D workflow.
// No external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = process.env.HARNESS_ROOT || path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Paths — can be overridden via env vars for testing
// ---------------------------------------------------------------------------
const REVIEW_ROOT = process.env.REVIEW_ROOT || '/Users/admin/project/ai/reviewDoc';
const CODE_REPO = process.env.CODE_REPO || '/Users/admin/project/ai/work/HEXAI';
const REVIEW_PLAYBOOKS = path.join(REVIEW_ROOT, 'ReviewPlaybooks');

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
// Workflow config — load from JSON (P1-4) + W7-A minimal generalization
// ---------------------------------------------------------------------------
// HW7A-P1-002: cacheKey 跨 taskId 隔离；cache miss 时完整重新解析 JSON 并
// 替换 _workflowConfig 引用（不仅比较字符串）。
let _workflowConfig = null;
let _workflowConfigCacheKey = null;

function loadWorkflowConfig(taskId) {
  // HW7A-P1-002: cacheKey = HARNESS_ROOT + taskId，taskId 切换时必然 miss
  const cacheKey = `${HARNESS_ROOT}::${taskId}`;

  // 缓存命中：复用 _workflowConfig 引用
  if (_workflowConfig && _workflowConfigCacheKey === cacheKey && _workflowConfig._loaded) {
    return _workflowConfig;
  }

  // HW7A-P1-002: 缓存失效分支——按 taskId-specific 路径查找，回退到 default
  // HW7A-CR-P2-005: config 文件命名约定
  //   workflows/weekly-canvas-task-{taskId}.json
  //   e.g., weekly-canvas-task-W7-A.json, weekly-canvas-task-W8-A.json
  const taskConfigPath = path.join(HARNESS_ROOT, 'workflows', `weekly-canvas-task-${taskId}.json`);
  const defaultConfigPath = path.join(HARNESS_ROOT, 'workflows', 'weekly-canvas-task.json');
  const usedFallback = !fs.existsSync(taskConfigPath);
  const jsonPath = usedFallback ? defaultConfigPath : taskConfigPath;

  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Workflow config not found for ${taskId}: tried ${taskConfigPath} and ${defaultConfigPath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch (err) {
    throw new Error(`Config read failed for ${taskId} at ${jsonPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // P2-004 修复：JSON 解析失败抛明确错误，不静默 fallback
    throw new Error(`Config JSON parse failed for ${taskId} at ${jsonPath}: ${err.message}`);
  }

  // HW7A-P1-002: 完整替换 _workflowConfig 模块级引用（不依赖任何残留对象）
  _workflowConfig = parsed;
  _workflowConfigCacheKey = cacheKey;

  // HW7A-CR-P1-001: 当 taskId-specific config 不存在且 default config.taskId !== taskId 时
  // 必须 throw 而非仅 warning（避免 W8-A 静默使用 W6-A config 创建错误 status.json）
  if (usedFallback && parsed.taskId !== taskId && taskId) {
    throw new Error(
      `No task-specific config found for ${taskId} (expected: ${taskConfigPath}). ` +
      `Default config is for ${parsed.taskId}. ` +
      `Create workflows/weekly-canvas-task-${taskId}.json first.`
    );
  }

  // HW7A-P1-003: taskTitle 必填 throw（方案 A），避免 W6-A 字面值污染
  if (!_workflowConfig.taskTitle) {
    throw new Error(
      `Config taskTitle is required for ${taskId}. ` +
      `Please add "taskTitle" field to ${jsonPath}.`
    );
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

function getPlanStages() {
  return getWorkflowConfig().planStages || ['implementation-plan', 'plan-fix'];
}

function getCodeStages() {
  return getWorkflowConfig().codeStages || ['code-implementation', 'code-fix', 'delivery'];
}

function getReviewLastStages() {
  return getWorkflowConfig().reviewLastStages || ['done'];
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
  const planStages = getPlanStages();
  const codeStages = getCodeStages();
  const reviewStages = getReviewStages();
  const reviewLastStages = getReviewLastStages();
  if (planStages.includes(stage)) return 'plan';
  if (codeStages.includes(stage)) return 'code';
  if (reviewStages.includes(stage)) return 'review';
  if (reviewLastStages.includes(stage)) return 'reviewlast';
  // Legacy fallback for older workflow configs that only define implementerStages.
  const implementerStages = getImplementerStages();
  if (implementerStages.includes(stage)) return 'code';
  return 'review';
}

function getTargetWindowInstruction(targetWindow) {
  if (targetWindow === 'plan') return '请粘贴到 A/plan 窗口';
  if (targetWindow === 'code') return '请粘贴到 B/code 窗口';
  if (targetWindow === 'review') return '请粘贴到 C/review 窗口';
  if (targetWindow === 'reviewlast') return '请粘贴到 D/reviewlast 窗口';
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

function printRoutePreview(taskId, status) {
  const currentSubtask = status.currentSubtask;
  const currentStage = status.currentStage;
  const config = getStageConfig(currentStage) || {};
  const targetWindow = getTargetWindow(currentStage);
  const nextAction = getTargetWindowInstruction(targetWindow);
  const promptPath = promptFilePath(taskId, currentSubtask, currentStage);

  console.log('➡ NEXT ROUTE PREVIEW');
  console.log(`   Paste to: ${nextAction}`);
  console.log(`   targetWindow: ${targetWindow}`);
  console.log(`   currentSubtask: ${currentSubtask}`);
  console.log(`   currentStage: ${currentStage}`);
  console.log(`   expectedSkill: ${config.requiredSkill || '(none)'}`);
  console.log(`   promptPath: ${promptPath}`);
  console.log();
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
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

// ---------------------------------------------------------------------------
// Status load/save
// ---------------------------------------------------------------------------
function loadStatus(taskId) {
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
  // P2-2: Migration defaults for V2 fields
  if (!status.schemaVersion || status.schemaVersion < 3) {
    status.schemaVersion = 3;
    migrated = true;
  }
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
  if (migrated) {
    saveStatus(taskId, status);
  }
  return status;
}

function saveStatus(taskId, status) {
  status.updatedAt = now();
  // P2-2: Normalize schemaVersion on every write (handles both fresh and migrated status)
  if (!status.schemaVersion || status.schemaVersion < 3) status.schemaVersion = 3;
  if (status.awaitingCommit === undefined) status.awaitingCommit = false;
  if (status.commitRequiredForSubtask === undefined) status.commitRequiredForSubtask = null;
  writeJSON(statusPath(taskId), status);
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
 *   ### W6-A-02-P1-001
 *   Priority: P1
 *   Status: open
 *   Owner: claude-plan-minimax
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
  const inferredSubtaskId = content.match(/\b(W\d+-[A-Z]-\d{2})\b/)?.[1] || '';
  const headingRegex = /^###\s+(?:Finding\s+(\S+)|(W\d+-[A-Z]-\d{2}-P[012]-\d{2,3}))\s*$/gm;
  const headingMatches = [...content.matchAll(headingRegex)];

  for (let i = 0; i < headingMatches.length; i += 1) {
    const m = headingMatches[i];
    const next = headingMatches[i + 1];
    const block = content.slice(m.index, next ? next.index : undefined);

    const f = { id: m[1] || m[2] };
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

  findings.push(...parseFindingStatusTables(content, inferredSubtaskId));

  return findings;
}

function normalizeTableCell(cell) {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/[✅❌⚠️]/g, '')
    .trim();
}

function normalizeFindingStatus(cell) {
  const normalized = normalizeTableCell(cell).toLowerCase();
  const allowed = ['false-positive', 'reopened', 'accepted', 'deferred', 'verified', 'fixed', 'open'];
  return allowed.find(status => normalized.includes(status)) || '';
}

function parseFindingStatusTables(content, inferredSubtaskId = '') {
  const findings = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;

    const headers = line.split('|').slice(1, -1).map(normalizeTableCell);
    if (headers.length < 2) continue;

    const idIdx = headers.findIndex(h => /^(finding|编号|id|finding id)$/i.test(h));
    const statusIdx = headers.findIndex(h => /^(status|状态|最终状态)$/i.test(h));
    if (idIdx === -1 || statusIdx === -1) continue;

    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j].trim();
      if (!row.startsWith('|')) break;
      const cells = row.split('|').slice(1, -1).map(normalizeTableCell);
      if (cells.length < Math.max(idIdx, statusIdx) + 1) continue;
      if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;

      const rawId = cells[idIdx];
      const fullIdMatch = rawId.match(/\b(W\d+-[A-Z]-\d{2}-P[012]-\d{2,3})\b/);
      const shortIdMatch = rawId.match(/\b(P[012]-\d{2,3})\b/);
      const id = fullIdMatch?.[1] || (inferredSubtaskId && shortIdMatch ? `${inferredSubtaskId}-${shortIdMatch[1]}` : '');
      if (!id) continue;

      const priority = id.match(/-(P[012])-/)?.[1] || '';
      const status = normalizeFindingStatus(cells[statusIdx]);
      if (!priority || !status) continue;

      findings.push({ id, priority, status });
    }
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
  const explicit = content.match(/^\s*(?:\*\*)?Decision:\s*(pass|changes-required)(?:\*\*)?\s*$/mi);
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
      const reportDir = path.dirname(stage.primaryReportPath);
      const reportBasename = path.basename(stage.primaryReportPath);

      // Check if primary report has a round suffix (e.g., -2轮)
      const roundSuffixMatch = reportBasename.match(/-[一二三四五六七八九十\d]+轮\.md$/);

      if (roundSuffixMatch) {
        // Primary has round suffix — read historical files first, then primary last
        // This ensures primary's findings win in deduplication
        const baseName = reportBasename.replace(/-[一二三四五六七八九十\d]+轮\.md$/, '');
        if (fs.existsSync(reportDir)) {
          const files = fs.readdirSync(reportDir);
          const matchingFiles = files.filter(f => f.startsWith(baseName) && f !== reportBasename && f.endsWith('.md'));
          const cnMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
          matchingFiles.sort((a, b) => {
            const getRound = (name) => {
              const m = name.match(/-([一二三四五六七八九十\d]+)轮\.md$/);
              if (!m) return 0;
              const num = parseInt(m[1], 10);
              if (!isNaN(num)) return num;
              return cnMap[m[1]] || 0;
            };
            return getRound(a) - getRound(b);
          });
          // Read historical files first (older rounds first)
          for (const f of matchingFiles) {
            const histPath = path.join(reportDir, f);
            try {
              const histContent = fs.readFileSync(histPath, 'utf-8');
              const histFindings = parseFindings(histContent);
              allFindings.push(...histFindings);
            } catch {
              // Skip unreadable files
            }
          }
        }
      }

      // Read primary report LAST so its findings win in deduplication
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
      const cells = trimmed.split('|').filter(c => c.trim()).map(normalizeTableCell);
      if (cells.length >= 2) {
        const headerVal = cells[0].toLowerCase();
        // Skip header row, separator row, and empty cells
        // Separator row: any cell matching Markdown table separator pattern
        // Covers: ---, ---------, :---, ---:, :---: (with any dash count)
        if (headerVal === 'finding' || /^:?-+:?$/.test(cells[0]) || cells[0] === '') continue;
        mapping.push({
          finding: cells[0],
          status: normalizeFindingStatus(cells[1]) || cells[1].toLowerCase(),
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
    // If force (without archive), we just overwrite below
  }

  // P2-001 修复：from 默认值通用化。当未指定 from 时，取 config 的第一个
// 不在 firstRunDefaults.importedCompleted 列表中的 subtask（保留 W6-A 行为：
// W6-A-01 标记为 imported-completed，默认 from 跳过它到 W6-A-02）。
//
// HW7A-CR-P2-003: `_firstRunDefaultsForInit` 仅用于计算 fromSubtask 默认值；
// 与下方 L925+ 的 `firstRunDefaults`（用于 residual risk + console.log）独立。
const _firstRunDefaultsForInit = (getWorkflowConfig().firstRunDefaults) || {};
const _importedCompleted = new Set(_firstRunDefaultsForInit.importedCompleted || []);
const _defaultFromSubtask = (() => {
  for (const s of getSubtasksForTask()) {
    if (!_importedCompleted.has(s.id)) return s.id;
  }
  // HW7A-CR-P2-004: subtasks 为空数组时给出明确错误（而非 TypeError）
  const first = getSubtasksForTask()[0];
  if (!first) {
    throw new Error(`No subtasks defined in workflow config for ${taskId}`);
  }
  return first.id;
})();
const fromSubtask = from || _defaultFromSubtask;
  const startStage = stage || 'implementation-plan';

  // Validate
  const fromIdx = subtasks.findIndex(s => s.id === fromSubtask);
  if (fromIdx === -1) throw new Error(`Unknown subtask: ${fromSubtask}`);
  const allStages = getStages();
  if (!allStages.includes(startStage)) throw new Error(`Unknown stage: ${startStage}`);

  const status = {
    taskId,
    taskTitle: getWorkflowConfig().taskTitle,
    createdAt: now(),
    updatedAt: now(),
    schemaVersion: 3,
    currentSubtask: fromSubtask,
    currentStage: startStage,
    awaitingCommit: false,     // P2-2
    commitRequiredForSubtask: null,  // P2-2
    residualRisks: [],
    acceptances: {},
    subtasks: {},
    history: [],
  };

  const isFirstRun = !from && !stage;
  const firstRunDefaults = (getWorkflowConfig().firstRunDefaults) || {};

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

  if (isFirstRun && firstRunDefaults.importedCompleted) {
    // P2-002 修复：firstRunDefaults.importedCompleted 抽象，W6-A JSON 显式注入 ['W6-A-01']
    for (const sid of firstRunDefaults.importedCompleted) {
      const risk = status.residualRisks.find(r => r.subtask === sid);
      if (risk) {
        risk.risk = `${sid} completed before Harness creation; historical evidence was not re-run by Harness.`;
      }
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
  if (isFirstRun && firstRunDefaults.importedCompleted) {
    for (const sid of firstRunDefaults.importedCompleted) {
      console.log(`   ${sid}: imported-completed (completed before Harness)`);
    }
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
    process.exitCode = 1;
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
  // Capture the stage baseline once, when the production attempt starts.
  // Re-sending/copying a prompt after an agent has already produced the
  // artifact must not turn that delivered artifact into the new baseline.
  if (!stageData.outputBaseline) {
    stageData.outputBaseline = getFileSnapshot(stageData.primaryReportPath);
    stageData.outputBaselineCapturedAt = now();
  }

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
  if (opts.show) {
    console.log(result.prompt);
  } else {
    console.log(`Prompt body hidden by default to keep the H window from executing target-window instructions.`);
    console.log(`Open or paste from: ${promptPath}`);
    if (!opts.copy) {
      console.log(`Tip: use --copy to copy it, or --show to print the full prompt intentionally.`);
    }
  }

  return { ...result, promptPath, copiedToClipboard: copied, targetWindow, nextAction, expectedSkill: config.requiredSkill };
}

// ---------------------------------------------------------------------------
// V2: Step — chain check → advance → next
// ---------------------------------------------------------------------------
function cmdStep(taskId, opts = {}) {
  // P1-1: If already at commit checkpoint, skip check/advance entirely
  const preCheck = loadStatus(taskId);
  if (preCheck.taskStatus === 'completed' || preCheck.currentStage === 'done') {
    console.log('═══════════════════════════════════════════════');
    console.log(`✅ Task ${taskId} is already completed.`);
    console.log('   No further Harness step is required.');
    console.log('═══════════════════════════════════════════════');
    return {
      success: true,
      stoppedAt: 'completed',
      taskStatus: preCheck.taskStatus,
      currentStage: preCheck.currentStage,
    };
  }
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
    process.exitCode = 1;
    return { success: false, stoppedAt: 'check', ...checkResult };
  }
  console.log('✅ CHECK PASSED\n');

  // Step 2: Advance
  console.log('▶ ADVANCE');
  const advanceResult = cmdAdvance(taskId, { checkResult });
  if (!advanceResult.success) {
    console.log('\n⛔ STEP STOPPED at advance.');
    process.exitCode = 1;
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
  printRoutePreview(taskId, loadStatus(taskId));

  // Step 3: Next
  console.log('▶ NEXT');
  const nextResult = cmdNext(taskId, { copy: opts.copy, show: opts.show });
  if (nextResult.error) {
    console.log(`\n⛔ STEP STOPPED at next: ${nextResult.error}`);
    process.exitCode = 1;
    return { success: false, stoppedAt: 'next', ...nextResult };
  }
  console.log('✅ NEXT PROMPT GENERATED');
  console.log(`   Target window: ${nextResult.targetWindow}`);
  console.log(`   Expected skill: ${nextResult.expectedSkill || '(none)'}`);
  console.log(`   Prompt path: ${nextResult.promptPath}`);
  if (opts.copy) {
    console.log(`   Copied to clipboard: ${nextResult.copiedToClipboard}`);
  }
  if (!opts.show) {
    console.log('   Prompt body: hidden (use next/step --show to print intentionally)');
  }

  return { success: true, stoppedAt: null, ...nextResult };
}

// ---------------------------------------------------------------------------
// V2: Current — read-only status overview
// ---------------------------------------------------------------------------
function cmdCurrent(taskId) {
  const status = loadStatus(taskId);
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
function cmdCheck(taskId) {
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;

  if (status.taskStatus === 'completed' || currentStage === 'done') {
    console.log(`✅ CHECK PASSED: Task ${taskId} is already completed.`);
    return {
      pass: true,
      completed: true,
      taskStatus: status.taskStatus,
      currentStage,
    };
  }

  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];

  if (!stageData) {
    console.log('❌ CHECK FAILED: No stage data');
    process.exitCode = 1;
    return { pass: false, reasons: ['No stage data'] };
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
      const legacyFindingHeading = content.match(/(?:^#{4,6}\s+(?!Finding\s+)(?:NEW\s+)?(?:W\d+-[A-Z]-\d{2}-)?P[012](?:#|-)\d+|^#{3}\s+(?!Finding\s+)(?!W\d+-[A-Z]-\d{2}-P[012]-\d{2,3}\b)(?:NEW\s+)?(?:W\d+-[A-Z]-\d{2}-)?P[012](?:#|-)\d+)/m);
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
    const fabricGatePath = currentStage === 'plan-fix-review'
      ? (
          status.subtasks[currentSubtask]?.stages?.['implementation-plan']?.latestAcceptedOutputPath ||
          status.subtasks[currentSubtask]?.stages?.['implementation-plan']?.primaryReportPath ||
          primaryPath
        )
      : primaryPath;

    if (fabricGatePath && fs.existsSync(fabricGatePath)) {
      const content = fs.readFileSync(fabricGatePath, 'utf-8');
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
    saveStatus(taskId, status);
  }

  // Output results
  if (issues.length === 0) {
    if (mirrorPath && primaryPath && fs.existsSync(primaryPath)) {
      ensureDir(path.dirname(mirrorPath));
      fs.copyFileSync(primaryPath, mirrorPath);
      stageData.mirrorSyncedAt = now();
      saveStatus(taskId, status);
    }
    console.log('✅ CHECK PASSED');
    if (warnings.length > 0) {
      console.log(`   Warnings: ${warnings.length}`);
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    return { pass: true, warnings, requiresFixLoop, reviewDecision, openFindingCount };
  } else {
    console.log('❌ CHECK FAILED:');
    issues.forEach(i => console.log(`   ❌ ${i}`));
    if (warnings.length > 0) {
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    process.exitCode = 1;
    return { pass: false, reasons: issues, warnings, requiresFixLoop: false, reviewDecision, openFindingCount };
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
  const status = loadStatus(taskId);

  // V2: Handle --confirm-committed when awaitingCommit
  if (opts.confirmCommitted) {
    // P1-4: Strict preconditions — exit non-zero on any violation
    if (!status.awaitingCommit) {
      console.log('⚠️  Not at commit checkpoint. Use regular "harness advance" first.');
      console.log('   --confirm-committed only works after a delivery passes and awaitingCommit is set.');
      process.exit(1);
    }
    if (!status.commitRequiredForSubtask) {
      console.log('⚠️  commitRequiredForSubtask is missing from status. Cannot confirm commit.');
      process.exit(1);
    }
    if (status.currentSubtask !== status.commitRequiredForSubtask) {
      console.log(`⚠️  Current subtask (${status.currentSubtask}) does not match commitRequiredForSubtask (${status.commitRequiredForSubtask}).`);
      console.log('   You may be at a different subtask. Use "harness current" to check.');
      process.exit(1);
    }
    if (status.currentStage !== 'delivery') {
      console.log(`⚠️  Current stage is "${status.currentStage}", not "delivery".`);
      console.log('   --confirm-committed only applies after a delivery passes.');
      process.exit(1);
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
      saveStatus(taskId, status);
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
    saveStatus(taskId, status);

    console.log(`✅ Commit confirmed. Delivery completed for ${commitSubtask}, advancing to ${nextSubtask.id} / implementation-plan`);
    return { success: true, advanced: true, subtask: nextSubtask.id, stage: 'implementation-plan' };
  }

  // Run check first
  const checkResult = opts.checkResult || cmdCheck(taskId);
  if (!checkResult.pass) {
    console.log('\n❌ Cannot advance: gate check failed. Fix issues before advancing.');
    process.exitCode = 1;
    return { success: false };
  }

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
    saveStatus(taskId, status);

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
    saveStatus(taskId, status);

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
    saveStatus(taskId, status);
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
  ensureDir(path.join(getEffectiveReviewRoot(), week, currentSubtask));
  ensureDir(outputsDir(taskId, currentSubtask));

  addHistory(status, 'stage-advanced', { subtask: currentSubtask, stage: nextStage });
  saveStatus(taskId, status);

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
  const status = loadStatus(taskId);

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
  const status = loadStatus(taskId);
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
  saveStatus(taskId, status);

  console.log(`⚠️  Interrupted ${currentSubtask} / ${currentStage}`);
  console.log(`   Reason: ${reason || 'No reason provided'}`);
  console.log(`   Expected handoff: ${stageData.handoffPath}`);
}

// ---------------------------------------------------------------------------
// Resume current
// ---------------------------------------------------------------------------
function cmdResumeCurrent(taskId, opts = {}) {
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
  if (opts.show) {
    console.log(result.prompt);
  } else {
    console.log(`Prompt body hidden by default to keep the H window from executing target-window instructions.`);
    console.log(`Open or paste from: ${promptPath}`);
  }

  return { ...result, promptPath, targetWindow };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------
function cmdBrief(taskId) {
  const status = loadStatus(taskId);
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
  harness next <taskId> [--copy] [--show]
  harness step <taskId> [--no-copy] [--show]
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
  harness resume-current <taskId> [--show]
  harness brief <taskId>

V2 New Commands:
  step          check → advance → next (chain, stops on first failure)
  current       只读当前状态，显示 targetWindow、expectedSkill、next command

V2 New Options:
  --copy               Copy prompt to clipboard (macOS pbcopy)
  --no-copy            Do not copy prompt when using step (step copies by default)
  --show               Print full prompt body intentionally (hidden by default)
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
`);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------
function main() {
  const { command, positional, opts } = parseArgs(process.argv);
  const taskId = positional[0];

  try {
    // Load workflow config for any command that needs it
    const commandsNeedingConfig = ['init', 'next', 'step', 'current', 'check', 'advance', 'status', 'summary',
      'accept', 'import', 'resume', 'set-current', 'interrupt', 'resume-current', 'brief'];
    if (commandsNeedingConfig.includes(command) && taskId) {
      loadWorkflowConfig(taskId);
    }

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
        cmdNext(taskId, {
          copy: opts.copy === true || opts.copy === 'true',
          show: opts.show === true || opts.show === 'true',
        });
        break;
      }
      case 'step': {
        if (!taskId) throw new Error('taskId required');
        cmdStep(taskId, {
          copy: !(opts['no-copy'] === true || opts['no-copy'] === 'true'),
          show: opts.show === true || opts.show === 'true',
        });
        break;
      }
      case 'current': {
        if (!taskId) throw new Error('taskId required');
        cmdCurrent(taskId);
        break;
      }
      case 'check': {
        if (!taskId) throw new Error('taskId required');
        cmdCheck(taskId);
        break;
      }
      case 'advance': {
        if (!taskId) throw new Error('taskId required');
        cmdAdvance(taskId, { confirmCommitted: opts['confirm-committed'] === true || opts['confirm-committed'] === 'true' });
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
        cmdResumeCurrent(taskId, { show: opts.show === true || opts.show === 'true' });
        break;
      }
      case 'brief': {
        if (!taskId) throw new Error('taskId required');
        cmdBrief(taskId);
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
