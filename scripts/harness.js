#!/usr/bin/env node
// HEXAI Review Harness V1 — CLI
// Lightweight orchestration for multi-agent weekly task R&D workflow.
// No external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = process.env.HARNESS_ROOT || path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Paths — can be overridden via env vars for testing
// ---------------------------------------------------------------------------
const REVIEW_ROOT = process.env.REVIEW_ROOT || '/Users/admin/project/ai/review';
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
// Helpers
// ---------------------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
  // Migrate old status to new fields (P1-3, P1-5)
  for (const [sid, st] of Object.entries(status.subtasks || {})) {
    if (st.planRound === undefined) st.planRound = 1;
    if (st.codeRound === undefined) st.codeRound = 1;
    if (st.deliveryRound === undefined) st.deliveryRound = 1;
    for (const [stageId, stage] of Object.entries(st.stages || {})) {
      if (!stage.outputs) stage.outputs = [];
      if (!stage.currentOutputPath) stage.currentOutputPath = stage.primaryReportPath || '';
    }
  }
  if (!status.residualRisks) status.residualRisks = [];
  return status;
}

function saveStatus(taskId, status) {
  status.updatedAt = now();
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
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');

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
      if (line.match(/^\s*Files:/i)) { inFiles = true; continue; }
      if (inFiles && line.match(/^\s*-\s/)) {
        files.push(line.replace(/^\s*-\s+/, '').trim());
        continue;
      }
      if (inFiles && !line.match(/^\s*-\s/) && line.includes(':')) {
        inFiles = false;
      }

      const kv = line.match(/^(\w+):\s*(.*)/);
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
 * Parse Fix Mapping table from report content (P1-1).
 * Format:
 *   ### Fix Mapping
 *   | Finding | Status | 修复文件 | 验证 |
 *   | --- | --- | --- | --- |
 *   | W6-A-02-P1-001 | fixed | src/file.ts | verified |
 *
 * Returns array of { finding, status, fixFile, verification }
 */
function parseFixMapping(content) {
  const mapping = [];
  const sectionMatch = content.match(/### Fix Mapping[\s\S]*?(?=\n###|\n##|$)/);
  if (!sectionMatch) return mapping;

  const lines = sectionMatch[0].split('\n');
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').filter(c => c.trim()).map(c => c.trim());
      if (cells.length >= 2) {
        // Skip header and separator rows
        const headerVal = cells[0].toLowerCase();
        if (headerVal === 'finding' || headerVal === '---' || cells[0] === '') continue;
        inTable = true;
        mapping.push({
          finding: cells[0],
          status: cells[1].toLowerCase(),
          fixFile: cells[2] || '',
          verification: cells[3] || '',
        });
      }
    } else if (inTable && trimmed === '') {
      break;
    } else if (inTable && !trimmed.startsWith('|')) {
      break;
    }
  }

  return mapping;
}

/**
 * Find the most recent review stage output in the same round group (plan/code).
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
    fixReportToReview: prevStagePath('plan-fix') || '',
    previousReviewFindings: prevStagePath('plan-review') || prevStagePath('plan-fix-review') || '',
    codeMappingToReview: prevStagePath('code-implementation') || '',
    codeMapping: prevStagePath('code-implementation') || '',
    reviewFindingsPath: prevStagePath('code-review') || prevStagePath('code-fix-review') || prevStagePath('plan-review') || '',
    allReviewFindings: [
      prevStagePath('plan-review'), prevStagePath('plan-fix-review'),
      prevStagePath('code-review'), prevStagePath('code-fix-review'),
    ].filter(Boolean).join(', '),
    // Additional metadata
    round,
    yyyymmdd: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
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
    currentSubtask: fromSubtask,
    currentStage: startStage,
    residualRisks: [],
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
// Generate prompt
// ---------------------------------------------------------------------------
function cmdNext(taskId) {
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;

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

  saveStatus(taskId, status);

  if (stageData.stageStatus === 'interrupted') {
    return generateContinuationPrompt(taskId, status, currentSubtask, currentStage, subtask);
  }

  stageData.stageStatus = 'active';
  if (!stageData.startedAt) stageData.startedAt = now();

  // Add to outputs[] (P1-5)
  if (stageData.primaryReportPath && !stageData.outputs.includes(stageData.primaryReportPath)) {
    stageData.outputs.push(stageData.primaryReportPath);
  }

  saveStatus(taskId, status);

  const templateName = getTemplateName(currentStage);
  const vars = buildTemplateVars(taskId, currentSubtask, currentStage, status);
  const template = loadTemplate(templateName);
  const prompt = substituteTemplate(template, vars);

  console.log(prompt);
  return { prompt, stage: currentStage, subtask: currentSubtask };
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

  console.log(prompt);
  return { prompt, stage, subtask: subtaskId, continuation: true };
}

// ---------------------------------------------------------------------------
// Gate check (P0-1: stage-specific gates)
// ---------------------------------------------------------------------------
function cmdCheck(taskId) {
  const status = loadStatus(taskId);
  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];

  if (!stageData) {
    console.log('❌ CHECK FAILED: No stage data');
    process.exitCode = 1;
    return { pass: false, reasons: ['No stage data'] };
  }

  const issues = [];
  const warnings = [];
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
  }

  // 2. Check mirrorOutputPath
  const mirrorPath = stageData.mirrorOutputPath;
  if (mirrorPath && !fs.existsSync(mirrorPath)) {
    warnings.push(`mirrorOutputPath does not exist: ${mirrorPath}`);
  }

  // 3. Stage-specific gate checks
  if (primaryPath && fs.existsSync(primaryPath)) {
    const content = fs.readFileSync(primaryPath, 'utf-8');

    if (currentStage === 'plan-review' || currentStage === 'code-review') {
      // Review stages: allow open P0/P1/P2 findings
      // Only check that report exists (already checked above)
      const pCount = (content.match(/### Finding\s+\S+/g) || []).length;
      if (pCount > 0) {
        console.log(`   ℹ️  Found ${pCount} finding(s) in report — allowed at ${currentStage} stage`);
      }
    }

    if (currentStage === 'plan-fix' || currentStage === 'code-fix') {
      // Fix stages: must have ### Fix Mapping (P1-1)
      if (!content.includes('### Fix Mapping')) {
        issues.push(`${currentStage}: Missing "### Fix Mapping" section in report`);
      } else {
        // Check Fix Mapping coverage
        const fixMapping = parseFixMapping(content);

        // Determine round group to find previous review
        const roundGroup = config.roundGroup; // 'plan' or 'code'
        let previousReviewStage = null;

        if (roundGroup) {
          previousReviewStage = findPreviousReviewStage(status, currentSubtask, roundGroup);
        }

        if (previousReviewStage && previousReviewStage.primaryReportPath) {
          const reviewContent = fs.readFileSync(previousReviewStage.primaryReportPath, 'utf-8');
          const findings = parseFindings(reviewContent);

          // Filter open/reopened findings
          const openFindings = findings.filter(f =>
            f.status === 'open' || f.status === 'reopened'
          );

          if (openFindings.length > 0) {
            const mappedIds = fixMapping.map(m => m.finding);
            const unmapped = openFindings.filter(f => !mappedIds.includes(f.id));

            if (unmapped.length > 0) {
              issues.push(`${currentStage}: Fix Mapping does not cover these open findings from previous review: ${unmapped.map(f => f.id).join(', ')}`);
            }

            // Check each mapped finding has a valid status
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

            // Check P0/P1 must be fixed or explicitly accepted/deferred
            for (const m of fixMapping) {
              const findingObj = openFindings.find(f => f.id === m.finding);
              if (findingObj && (findingObj.priority === 'P0' || findingObj.priority === 'P1')) {
                if (!['fixed', 'accepted', 'deferred', 'false-positive'].includes(m.status)) {
                  issues.push(`${currentStage}: P${findingObj.priority} finding "${m.finding}" must be fixed/accepted/deferred/false-positive (current: ${m.status})`);
                }
              }
            }
          } else {
            console.log(`   ℹ️  No open/reopened findings from previous review`);
          }
        } else {
          console.log(`   ℹ️  No previous review stage output found — skipping coverage check`);
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

      if (openP0P1.length > 0) {
        issues.push(`${currentStage}: Blocked by ${openP0P1.length} open/reopened P0/P1 finding(s): ${openP0P1.map(f => f.id).join(', ')}`);
      }

      if (openP2.length > 0) {
        issues.push(`${currentStage}: Blocked by ${openP2.length} open/reopened P2 finding(s). Must be accepted/deferred: ${openP2.map(f => f.id).join(', ')}`);
      }

      if (notPassed && issues.length === 0) {
        issues.push(`${currentStage}: Review report indicates "不通过" (not passed)`);
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
      const hasResidual = content.includes('residual risk') || content.includes('Residual Risk') || content.includes('残差') || content.includes('残余风险');
      if (!hasResidual) {
        warnings.push('Delivery report may be missing residual risk section');
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
    saveStatus(taskId, status);
  }

  // Output results
  if (issues.length === 0) {
    console.log('✅ CHECK PASSED');
    if (warnings.length > 0) {
      console.log(`   Warnings: ${warnings.length}`);
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    return { pass: true, warnings };
  } else {
    console.log('❌ CHECK FAILED:');
    issues.forEach(i => console.log(`   ❌ ${i}`));
    if (warnings.length > 0) {
      warnings.forEach(w => console.log(`   ⚠️  ${w}`));
    }
    process.exitCode = 1;
    return { pass: false, reasons: issues, warnings };
  }
}

function getPreviousStage(stage) {
  const allStages = getStages();
  const idx = allStages.indexOf(stage);
  if (idx <= 0) return null;
  return allStages[idx - 1];
}

// ---------------------------------------------------------------------------
// Advance (P0-1, P1-2, P1-3: stage-specific gates, subtask progression, rounds)
// ---------------------------------------------------------------------------
function cmdAdvance(taskId) {
  const status = loadStatus(taskId);

  // Run check first
  const checkResult = cmdCheck(taskId);
  if (!checkResult.pass) {
    console.log('\n❌ Cannot advance: gate check failed. Fix issues before advancing.');
    process.exitCode = 1;
    return { success: false };
  }

  const { currentSubtask, currentStage } = status;
  const stageData = status.subtasks[currentSubtask]?.stages?.[currentStage];
  const config = getStageConfig(currentStage) || {};

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
  const nextStage = config.nextStage;

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

  // Check if we need to advance to a new subtask (from delivery -> done)
  if (currentStage === 'delivery') {
    // Save current subtask status
    status.subtasks[currentSubtask].status = 'completed';

    const allSubtasks = getSubtasksForTask();
    const currentIdx = allSubtasks.findIndex(s => s.id === currentSubtask);
    const nextSubtask = allSubtasks[currentIdx + 1];

    if (!nextSubtask) {
      // Last subtask done
      status.currentStage = 'done';
      status.taskStatus = 'completed';
      addHistory(status, 'task-completed', { subtask: currentSubtask });
      saveStatus(taskId, status);
      console.log(`✅ All subtasks completed! Task ${taskId} is done.`);
      console.log(`   currentStage: done`);
      console.log(`   nextRecommendedAction: 等待 Codex 总体验收`);
      return { success: true, advanced: true, taskDone: true };
    }

    // Advance to next subtask's implementation-plan
    status.currentSubtask = nextSubtask.id;
    status.currentStage = 'implementation-plan';
    status.subtasks[nextSubtask.id].status = 'active';

    // Initialize round counters for the new subtask if not set
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

    console.log(`✅ Delivery completed for ${currentSubtask}, advancing to ${nextSubtask.id} / implementation-plan`);
    return { success: true, advanced: true };
  }

  // Same subtask, next stage
  status.currentStage = nextStage;

  const allSubtasks = getSubtasksForTask();
  const subtask = allSubtasks.find(s => s.id === currentSubtask);

  // Determine round for the new stage (P1-3)
  const nextRound = getRoundForStage(status, currentSubtask, nextStage);
  const nextStageData = {
    stageStatus: 'active',
    currentOutputPath: generateReportPath(taskId, subtask, nextStage, nextRound),
    latestAcceptedOutputPath: '',
    primaryReportPath: generateReportPath(taskId, subtask, nextStage, nextRound),
    mirrorOutputPath: path.join(outputsDir(taskId, currentSubtask), path.basename(generateReportPath(taskId, subtask, nextStage, nextRound))),
    handoffPath: generateHandoffPath(taskId, subtask, nextStage),
    mirrorHandoffPath: generateMirrorHandoffPath(taskId, subtask, nextStage),
    startedAt: now(),
    outputs: [],
  };

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
  return { success: true, advanced: true };
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
// Summary
// ---------------------------------------------------------------------------
function cmdSummary(taskId) {
  const status = loadStatus(taskId);
  const allSubtasks = getSubtasksForTask();
  const allStages = getStages();

  console.log(`\n# ${taskId} Summary`);
  console.log();
  console.log(`| Subtask | Title | Status | Key Stage |`);
  console.log(`| --- | --- | --- | --- |`);

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

    console.log(`| ${s.id} | ${s.title} | ${st.status} | ${keyStage} |`);
  }

  console.log();
  console.log(`**Current Position:** ${status.currentSubtask} / ${status.currentStage}`);
  if (status.taskStatus) {
    console.log(`**Task Status:** ${status.taskStatus}`);
  }

  if (status.residualRisks && status.residualRisks.length > 0) {
    console.log();
    console.log('### Residual Risks');
    for (const r of status.residualRisks) {
      console.log(`- ${r.subtask}${r.stage ? '/' + r.stage : ''}: ${r.risk}`);
    }
  }

  console.log();
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
  for (let si = 0; si < startStageIdx; si++) {
    const sid = allStages[si];
    if (!curSt.stages[sid] || curSt.stages[sid].stageStatus === 'pending') {
      curSt.stages[sid] = { stageStatus: 'assumed-completed', currentOutputPath: '', latestAcceptedOutputPath: '', outputs: [] };
    } else if (curSt.stages[sid].stageStatus === 'active') {
      curSt.stages[sid].stageStatus = 'assumed-completed';
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
  for (let si = 0; si < startStageIdx; si++) {
    const sid = allStages[si];
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
  return generateContinuationPrompt(taskId, status, currentSubtask, currentStage, subtask);
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
  console.log(`HEXAI Review Harness V1

Usage:
  harness init <taskId> [--from <subtask>] [--stage <stage>]
                      [--force] [--archive-existing]
  harness next <taskId>
  harness check <taskId>
  harness advance <taskId>
  harness status <taskId>
  harness summary <taskId>
  harness import <taskId> --completed <subtask>
  harness resume <taskId> --from <subtask> --stage <stage>
  harness set-current <taskId> <subtask> <stage>
  harness interrupt <taskId> --reason "<reason>"
  harness resume-current <taskId>
  harness brief <taskId>

Options:
  --force              Overwrite existing run (used with init)
  --archive-existing   Archive existing run before init
  --from <subtask>     Starting subtask (default: W6-A-02)
  --stage <stage>      Starting stage (default: implementation-plan)
  -  --completed <subtask>  Mark a subtask as imported-completed

Examples:
  harness init W6-A
  harness init W6-A --from W6-A-03 --stage code-review
  harness init W6-A --force
  harness init W6-A --archive-existing
  harness next W6-A
  harness check W6-A
  harness advance W6-A
  harness status W6-A
  harness brief W6-A
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
    const commandsNeedingConfig = ['init', 'next', 'check', 'advance', 'status', 'summary',
      'import', 'resume', 'set-current', 'interrupt', 'resume-current', 'brief'];
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
        cmdNext(taskId);
        break;
      }
      case 'check': {
        if (!taskId) throw new Error('taskId required');
        cmdCheck(taskId);
        break;
      }
      case 'advance': {
        if (!taskId) throw new Error('taskId required');
        cmdAdvance(taskId);
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
        cmdResumeCurrent(taskId);
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
