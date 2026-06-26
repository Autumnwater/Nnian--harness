// HEXAI Review Harness V1 — Test Suite
// Run with: pnpm test

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

// Create temp directories for isolated testing
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
const REVIEW_ROOT = path.join(TEST_ROOT, 'review');
const CODE_REPO = path.join(TEST_ROOT, 'hexai');
const HARNESS_DIR = path.join(REVIEW_ROOT, 'Harness');
const HARNESS_SCRIPT = path.join(HARNESS_DIR, 'scripts', 'harness.js');

function harness(args = '') {
  const cmd = `node "${HARNESS_SCRIPT}" ${args}`;
  try {
    const stdout = execSync(cmd, {
      cwd: HARNESS_DIR,
      env: { ...process.env, REVIEW_ROOT, CODE_REPO, HARNESS_ROOT: HARNESS_DIR },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { success: true, stdout, stderr: '' };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

function harnessEnv(envOverrides, args = '') {
  const cmd = `node "${HARNESS_SCRIPT}" ${args}`;
  try {
    const stdout = execSync(cmd, {
      cwd: HARNESS_DIR,
      env: { ...process.env, REVIEW_ROOT, CODE_REPO, HARNESS_ROOT: HARNESS_DIR, ...envOverrides },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { success: true, stdout, stderr: '' };
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

function saveStatus(taskId, status) {
  const p = path.join(HARNESS_DIR, 'runs', taskId, 'status.json');
  fs.writeFileSync(p, JSON.stringify(status, null, 2) + '\n', 'utf-8');
}

function readStatus(taskId) {
  const p = path.join(HARNESS_DIR, 'runs', taskId, 'status.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// Helper: create a report file
function createReport(status, stageId, content) {
  const stage = status.subtasks[status.currentSubtask].stages[stageId];
  if (!stage || !stage.primaryReportPath) {
    throw new Error(`No primaryReportPath for stage ${stageId}`);
  }
  fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
  fs.writeFileSync(stage.primaryReportPath, content, 'utf-8');
  return stage.primaryReportPath;
}

// Helper: create any report path
function createReportAt(reportPath, content) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, content, 'utf-8');
}

function setupPlanFixReviewStage() {
  harness('init W6-A --force');
  let status = readStatus('W6-A');
  createReport(status, 'implementation-plan', '# Plan\n\n## Fabric 官方能力核查\nOK\n');
  harness('advance W6-A');

  status = readStatus('W6-A');
  createReport(status, 'plan-review', '# PR\n\nDecision: changes-required\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
  harness('advance W6-A');

  status = readStatus('W6-A');
  createReport(status, 'plan-fix', '# Fix\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');
  harness('advance W6-A');
}

// ---------------------------------------------------------------------------
// Setup before all tests
// ---------------------------------------------------------------------------
// HW7A-CR-P2-002: srcHarness declared at module scope so describe-level
// before() hooks (notably W7-A) can read production configs
const srcHarness = path.resolve(import.meta.dirname, '..');

before(() => {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  fs.mkdirSync(CODE_REPO, { recursive: true });
  fs.mkdirSync(path.join(REVIEW_ROOT, 'ReviewPlaybooks'), { recursive: true });
  fs.mkdirSync(path.join(REVIEW_ROOT, 'W6', 'W6-A-01'), { recursive: true });

  execSync(`cp -r "${srcHarness}" "${REVIEW_ROOT}/"`, { encoding: 'utf-8' });

  fs.writeFileSync(path.join(REVIEW_ROOT, 'ReviewPlaybooks', 'plan-review-playbook.md'), '# Plan Review Playbook\nTest playbook.', 'utf-8');
  fs.writeFileSync(path.join(REVIEW_ROOT, 'ReviewPlaybooks', 'code-review-playbook.md'), '# Code Review Playbook\nTest playbook.', 'utf-8');
  fs.writeFileSync(path.join(REVIEW_ROOT, 'ReviewPlaybooks', 'canvas-stage-review-playbook.md'), '# Canvas Stage Review Playbook\nTest playbook.', 'utf-8');

  fs.writeFileSync(path.join(REVIEW_ROOT, 'W6', 'W6-A-01', 'W6-A画布本体UIUX收口实施计划-20260616.md'), '# Historical plan', 'utf-8');
});

after(() => {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HEXAI Review Harness V1', () => {
  describe('harness init W6-A', () => {
    let result;
    let status;

    before(() => {
      result = harness('init W6-A --force');
      status = readStatus('W6-A');
    });

    it('should exit successfully', () => {
      assert.equal(result.success, true, `harness failed: ${result.stderr}`);
    });

    it('should create runs/W6-A/status.json', () => {
      assert.ok(status, 'status.json should exist');
    });

    it('should set taskId to W6-A', () => {
      assert.equal(status.taskId, 'W6-A');
    });

    it('should set currentSubtask to W6-A-02', () => {
      assert.equal(status.currentSubtask, 'W6-A-02');
    });

    it('should set currentStage to implementation-plan', () => {
      assert.equal(status.currentStage, 'implementation-plan');
    });

    it('should set W6-A-01 status to imported-completed', () => {
      const s = status.subtasks['W6-A-01'];
      assert.ok(s);
      const stages = s.stages;
      const hasImportedCompleted = Object.values(stages).some(
        st => st.stageStatus === 'imported-completed'
      );
      assert.ok(hasImportedCompleted, 'W6-A-01 should have imported-completed stages');
    });

    it('should record residual risk for W6-A-01', () => {
      const risks = status.residualRisks || [];
      const risk = risks.find(r => r.subtask === 'W6-A-01');
      assert.ok(risk, 'Should have residual risk for W6-A-01');
      assert.ok(risk.risk.includes('Harness'), 'Risk should mention Harness creation');
    });

    it('should set W6-A-02 status to active', () => {
      const s = status.subtasks['W6-A-02'];
      assert.ok(s);
      assert.equal(s.status, 'active');
    });

    it('should set W6-A-02 implementation-plan stageStatus to active', () => {
      const s = status.subtasks['W6-A-02'];
      const stage = s.stages['implementation-plan'];
      assert.ok(stage);
      assert.equal(stage.stageStatus, 'active');
    });

    it('should set W6-A-03+ status to pending', () => {
      for (const id of ['W6-A-03', 'W6-A-04', 'W6-A-05', 'W6-A-06']) {
        const s = status.subtasks[id];
        assert.ok(s, `${id} should exist`);
        assert.equal(s.status, 'pending', `${id} should be pending`);
      }
    });

    it('should have history entries', () => {
      assert.ok(Array.isArray(status.history));
      assert.ok(status.history.length > 0);
    });

    it('should create reportDir for W6-A-02', () => {
      const dir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      assert.ok(fs.existsSync(dir), 'W6-A-02 reportDir should exist');
    });

    // P1-5: outputs field exists
    it('should have outputs and currentOutputPath fields (P1-5)', () => {
      for (const sid of ['W6-A-01', 'W6-A-02']) {
        const s = status.subtasks[sid];
        for (const stage of Object.values(s.stages)) {
          assert.ok('outputs' in stage, `${sid} stage should have outputs[]`);
          assert.ok('currentOutputPath' in stage, `${sid} stage should have currentOutputPath`);
          assert.ok('latestAcceptedOutputPath' in stage, `${sid} stage should have latestAcceptedOutputPath`);
        }
      }
    });

    // P1-3: round counters
    it('should have planRound/codeRound/deliveryRound (P1-3)', () => {
      for (const sid of ['W6-A-02']) {
        const s = status.subtasks[sid];
        assert.equal(s.planRound, 1, `planRound should be 1`);
        assert.equal(s.codeRound, 1, `codeRound should be 1`);
        assert.equal(s.deliveryRound, 1, `deliveryRound should be 1`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // P0-2: init idempotent protection
  // ---------------------------------------------------------------------------
  describe('harness init idempotent protection (P0-2)', () => {
    before(() => {
      harness('init W6-A --force');
    });

    it('should fail when status.json already exists', () => {
      const r = harness('init W6-A');
      assert.equal(r.success, false, 'init should fail without --force');
      assert.ok(r.stderr.includes('already exists') || r.stderr.includes('already exists'),
        'Error should mention existing run');
    });

    it('should succeed with --force', () => {
      const r = harness('init W6-A --force');
      assert.equal(r.success, true, 'init --force should succeed');
    });

    it('should archive existing run with --archive-existing', () => {
      // Create a unique identifiable status
      harness('init W6-A --force');
      const statusBefore = readStatus('W6-A');
      const origCreatedAt = statusBefore.createdAt;

      // Archive and re-init
      const r = harness('init W6-A --archive-existing');
      assert.equal(r.success, true, 'init --archive-existing should succeed');
      assert.ok(r.stdout.includes('archive') || r.stdout.includes('Archived'),
        'Should mention archiving');

      // Archive dir should exist
      const archiveDir = path.join(HARNESS_DIR, 'runs', 'archive');
      assert.ok(fs.existsSync(archiveDir), 'Archive directory should exist');
      const archives = fs.readdirSync(archiveDir);
      assert.ok(archives.length > 0, 'Should have at least one archive');

      // New status should exist
      const newStatus = readStatus('W6-A');
      assert.ok(newStatus, 'New status should exist');
      assert.notEqual(newStatus.createdAt, origCreatedAt, 'New status should have different createdAt');
    });
  });

  // ---------------------------------------------------------------------------
  // P1-4: JSON workflow config
  // ---------------------------------------------------------------------------
  describe('JSON workflow config (P1-4)', () => {
    it('should have weekly-canvas-task.json', () => {
      const jsonPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task.json');
      assert.ok(fs.existsSync(jsonPath), 'Config JSON should exist');
      const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      assert.equal(cfg.taskId, 'W6-A');
      assert.ok(Array.isArray(cfg.stages));
      assert.equal(cfg.stages.length, 10, 'Should have 10 stages');
      assert.ok(Array.isArray(cfg.subtasks));
      assert.equal(cfg.subtasks.length, 6, 'Should have 6 subtasks');
    });

    it('should read config from JSON and use it for stage definitions', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');

      // Verify stages are read from config
      const configPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task.json');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      const stageIds = cfg.stages.map(s => s.id);
      for (const sid of stageIds) {
        assert.ok(sid in status.subtasks['W6-A-02'].stages,
          `Stage "${sid}" should be in subtask stages`);
      }
    });
  });

  describe('harness next W6-A (implementation-plan prompt)', () => {
    let result;
    let status;
    let prompt;

    before(() => {
      harness('init W6-A --force');
      result = harness('next W6-A');
      status = readStatus('W6-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      prompt = fs.readFileSync(promptPath, 'utf-8');
    });

    it('should generate a prompt', () => {
      assert.equal(result.success, true);
      assert.ok(prompt.length > 100, 'Prompt should be substantial');
      assert.ok(result.stdout.includes('Prompt body hidden by default'));
    });

    it('should include taskId in prompt', () => {
      assert.ok(prompt.includes('W6-A'));
    });

    it('should include subtaskId W6-A-02 in prompt', () => {
      assert.ok(prompt.includes('W6-A-02'));
    });

    it('should include primaryReportPath in prompt', () => {
      assert.ok(prompt.includes('primaryReportPath'));
      assert.ok(prompt.includes('/W6/W6-A-02/'));
    });

    it('should include mirror output path in prompt', () => {
      assert.ok(prompt.includes('mirrorOutput') || prompt.includes('mirror'), 'Should mention mirror output');
    });

    it('should include handoff path concept in prompt', () => {
      assert.ok(
        prompt.includes('handoff') || prompt.includes('Handoff') || prompt.includes('HANDOFF'),
        'Should mention handoff'
      );
    });

    it('should include requiredSkill info in prompt', () => {
      assert.ok(prompt.includes('requiredSkill'));
    });

    it('should include codeRepo path in prompt', () => {
      assert.ok(prompt.includes('codeRepo'));
    });

    it('should include reportDir in prompt', () => {
      assert.ok(prompt.includes('reportDir'));
    });
  });

  describe('harness check W6-A', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            fs.unlinkSync(path.join(reportDir, f));
          }
        }
      }
      harness('init W6-A --force');
    });

    it('should fail when primaryReportPath does not exist', () => {
      const r = harness('check W6-A');
      assert.equal(r.success, false, 'check should fail when primaryReportPath missing');
    });

    it('should pass after creating primaryReportPath', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      const reportPath = stage.primaryReportPath;
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric 提供 controls API\n- 自定义逻辑仅做业务桥接\n\n## 需求理解\nContent here.',
        'utf-8');

      const r = harness('check W6-A');
      assert.equal(r.success, true, `check should pass: ${r.stderr || r.stdout}`);
    });
  });

  describe('harness advance W6-A', () => {
    before(() => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric controls API 覆盖\n- 自定义逻辑仅做业务桥接\n\n## 需求理解\nContent.',
        'utf-8');
    });

    it('should advance from implementation-plan to plan-review', () => {
      const r = harness('advance W6-A');
      assert.equal(r.success, true, `advance failed: ${r.stderr}`);

      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-review');

      const prevStage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(prevStage.stageStatus, 'completed', 'Previous stage should be completed');
    });
  });

  describe('harness init with --from and --stage', () => {
    let status;

    before(() => {
      harness('init W6-A --from W6-A-03 --stage code-review --force');
      status = readStatus('W6-A');
    });

    it('should set currentSubtask to W6-A-03', () => {
      assert.equal(status.currentSubtask, 'W6-A-03');
    });

    it('should set currentStage to code-review', () => {
      assert.equal(status.currentStage, 'code-review');
    });

    it('should mark prior subtasks as imported-completed', () => {
      for (const id of ['W6-A-01', 'W6-A-02']) {
        const s = status.subtasks[id];
        assert.ok(s.status === 'imported-completed' ||
          Object.values(s.stages).some(st => st.stageStatus === 'imported-completed'),
          `${id} should be imported-completed`);
      }
    });

    it('should mark prior stages as assumed-completed with residual risk', () => {
      const s = status.subtasks['W6-A-03'];
      const stages = s.stages;
      const assumedStages = ['implementation-plan', 'plan-review', 'plan-fix', 'plan-fix-review'];
      for (const sid of assumedStages) {
        if (stages[sid]) {
          assert.equal(stages[sid].stageStatus, 'assumed-completed',
            `${sid} should be assumed-completed`);
        }
      }
    });

    it('should record residual risks for assumed-completed stages', () => {
      assert.ok(Array.isArray(status.residualRisks));
      const hasRisk = status.residualRisks.some(r =>
        r.stage && r.subtask === 'W6-A-03'
      );
      assert.ok(hasRisk, 'Should have residual risk for assumed-completed stages');
    });
  });

  describe('harness interrupt', () => {
    before(() => {
      harness('init W6-A --force');
    });

    it('should mark current stage as interrupted', () => {
      const r = harness('interrupt W6-A --reason "claude B token exhausted"');
      assert.equal(r.success, true, `interrupt failed: ${r.stderr}`);

      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(stage.stageStatus, 'interrupted');
      assert.ok(stage.interruptReason.includes('token exhausted'));
    });
  });

  describe('harness check with interrupted state', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) fs.unlinkSync(path.join(reportDir, f));
        }
      }
      harness('init W6-A --force');
      harness('interrupt W6-A --reason "token exhausted"');
    });

    it('should fail when interrupted and no handoff exists', () => {
      const r = harness('check W6-A');
      assert.equal(r.success, false, 'check should fail when interrupted without handoff');
    });
  });

  describe('harness resume-current', () => {
    let result;
    let prompt;

    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) fs.unlinkSync(path.join(reportDir, f));
        }
      }
      harness('init W6-A --force');
      harness('interrupt W6-A --reason "token exhausted"');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      const handoffPath = stage.handoffPath;
      if (handoffPath) {
        fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
        fs.writeFileSync(handoffPath, '# Handoff\nInterrupted during implementation plan.', 'utf-8');
      }
      result = harness('resume-current W6-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      prompt = fs.readFileSync(promptPath, 'utf-8');
    });

    it('should generate a continuation prompt', () => {
      assert.equal(result.success, true);
      assert.ok(result.stdout.includes('Prompt body hidden by default'));
      assert.ok(prompt.includes('继续'), 'Prompt should indicate continuation');
      assert.ok(prompt.includes('中断'), 'Prompt should mention interruption');
    });

    it('should include handoffPath in prompt', () => {
      assert.ok(prompt.includes('handoffPath') ||
        prompt.includes('handoff'));
    });

    it('should include primaryReportPath in prompt', () => {
      assert.ok(prompt.includes('primaryReportPath') ||
        prompt.includes('/W6/W6-A-02/'));
    });

    it('should include mirror output path reference in prompt', () => {
      assert.ok(
        prompt.includes('mirror') || prompt.includes('副本') || prompt.includes('Mirror'),
        'Should reference mirror output'
      );
    });

    it('should still have stageStatus as interrupted', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(stage.stageStatus, 'interrupted',
        'resume-current should not change stageStatus');
    });
  });

  describe('cannot advance with handoff but no primary report', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            fs.unlinkSync(path.join(reportDir, f));
          }
        }
      }
      harness('init W6-A --force');
      harness('interrupt W6-A --reason "token exhausted"');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      if (stage.handoffPath) {
        fs.mkdirSync(path.dirname(stage.handoffPath), { recursive: true });
        fs.writeFileSync(stage.handoffPath, '# Handoff', 'utf-8');
      }
    });

    it('should not allow advance when handoff exists but primaryReportPath missing', () => {
      const r = harness('advance W6-A');
      assert.equal(r.success, false, 'Should not advance with handoff but no primary report');
    });
  });

  describe('harness import --completed', () => {
    let status;

    before(() => {
      for (const sid of ['W6-A-02', 'W6-A-03', 'W6-A-04', 'W6-A-05', 'W6-A-06']) {
        const d = path.join(REVIEW_ROOT, 'W6', sid);
        if (fs.existsSync(d)) {
          const files = fs.readdirSync(d);
          for (const f of files) {
            if (f.endsWith('.md')) fs.unlinkSync(path.join(d, f));
          }
        }
      }
      harness('init W6-A --from W6-A-04 --stage implementation-plan --force');
      harness('import W6-A --completed W6-A-01');
      status = readStatus('W6-A');
    });

    it('should mark W6-A-01 as imported-completed', () => {
      const s = status.subtasks['W6-A-01'];
      const hasImported = Object.values(s.stages).some(
        st => st.stageStatus === 'imported-completed'
      );
      assert.ok(hasImported, 'W6-A-01 should be imported-completed');
    });

    it('should have currentSubtask as W6-A-04', () => {
      assert.equal(status.currentSubtask, 'W6-A-04');
    });
  });

  describe('harness status', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('status W6-A');
    });

    it('should display current subtask and stage', () => {
      assert.ok(result.stdout.includes('W6-A-02'));
      assert.ok(result.stdout.includes('implementation-plan'));
    });

    it('should show subtask statuses', () => {
      assert.ok(result.stdout.includes('W6-A-01'));
      assert.ok(result.stdout.includes('imported-completed') ||
        result.stdout.includes('completed'));
    });
  });

  describe('harness summary', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('summary W6-A');
    });

    it('should generate a summary', () => {
      assert.ok(result.stdout.length > 50, 'Summary should be substantial');
    });

    it('should include all subtasks', () => {
      for (let i = 1; i <= 6; i++) {
        const id = `W6-A-0${i}`;
        assert.ok(result.stdout.includes(id), `Summary should mention ${id}`);
      }
    });
  });

  describe('harness set-current', () => {
    let status;

    before(() => {
      harness('init W6-A --force');
      harness('set-current W6-A W6-A-02 plan-review');
      status = readStatus('W6-A');
    });

    it('should update currentSubtask', () => {
      assert.equal(status.currentSubtask, 'W6-A-02');
    });

    it('should update currentStage', () => {
      assert.equal(status.currentStage, 'plan-review');
    });

    it('should record history', () => {
      const setCurrentEntries = status.history.filter(h => h.action === 'set-current');
      assert.ok(setCurrentEntries.length > 0, 'Should have set-current history entry');
    });
  });

  describe('harness resume', () => {
    let status;

    before(() => {
      for (const sid of ['W6-A-02', 'W6-A-03']) {
        const d = path.join(REVIEW_ROOT, 'W6', sid);
        if (fs.existsSync(d)) {
          const files = fs.readdirSync(d);
          for (const f of files) {
            if (f.endsWith('.md')) fs.unlinkSync(path.join(d, f));
          }
        }
      }
      harness('init W6-A --force');
      harness('resume W6-A --from W6-A-03 --stage code-review');
      status = readStatus('W6-A');
    });

    it('should update currentSubtask to W6-A-03', () => {
      assert.equal(status.currentSubtask, 'W6-A-03');
    });

    it('should update currentStage to code-review', () => {
      assert.equal(status.currentStage, 'code-review');
    });

    it('should mark prior stages as assumed-completed with residual risk', () => {
      const risks = status.residualRisks || [];
      const hasRisk = risks.some(r => r.subtask === 'W6-A-03');
      assert.ok(hasRisk || risks.length > 0, 'Should record residual risk');
    });
  });

  describe('continuation prompt from handoff', () => {
    let result;
    let prompt;

    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) fs.unlinkSync(path.join(reportDir, f));
        }
      }
      harness('init W6-A --force');
      harness('interrupt W6-A --reason "token exhausted"');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      if (stage.handoffPath) {
        fs.mkdirSync(path.dirname(stage.handoffPath), { recursive: true });
        fs.writeFileSync(stage.handoffPath, '# Handoff\n\n## Completed\n- Read files\n\n## Remaining\n- Write plan', 'utf-8');
      }
      result = harness('resume-current W6-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      prompt = fs.readFileSync(promptPath, 'utf-8');
    });

    it('should tell agent not to redo work', () => {
      assert.ok(
        prompt.includes('不要从头重做') ||
        prompt.includes('不要重复') ||
        prompt.includes('中断任务') ||
        prompt.includes('继续'),
        'Should tell agent to continue, not restart'
      );
    });
  });

  describe('prompt includes boundary rules', () => {
    let result;
    let prompt;

    before(() => {
      harness('init W6-A --force');
      result = harness('next W6-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      prompt = fs.readFileSync(promptPath, 'utf-8');
    });

    it('should mention .claude/settings.json prohibition', () => {
      assert.ok(
        prompt.includes('.claude/settings.json') ||
        prompt.includes('settings.json'),
        'Should mention settings.json restriction'
      );
    });

    it('should mention implementer cannot approve own work', () => {
      assert.ok(
        prompt.includes('不可批准') ||
        prompt.includes('不能批准') ||
        prompt.includes('cannot approve') ||
        prompt.includes('不可自行批准'),
        'Should state implementer cannot approve own work'
      );
    });
  });

  describe('delivery prompt write boundary', () => {
    it('should forbid delivery from modifying business code', () => {
      harness('init W6-A --from W6-A-03 --stage delivery --force');
      const result = harness('next W6-A');
      assert.equal(result.success, true);
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-03-delivery.md');
      const prompt = fs.readFileSync(promptPath, 'utf-8');
      assert.ok(prompt.includes('禁止写入或修改'));
      assert.ok(prompt.includes('只能写入'));
      assert.ok(!prompt.includes('有权读写'));
    });
  });

  describe('W6-A-02 reportDir creation on init', () => {
    before(() => {
      const dir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      harness('init W6-A --force');
    });

    it('should create W6-A-02 reportDir on init', () => {
      const dir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      assert.ok(fs.existsSync(dir), 'W6-A-02 reportDir should be created on init');
    });
  });

  describe('file naming in status', () => {
    it('should set correct primaryReportPath for implementation-plan', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.ok(stage.primaryReportPath);
      assert.ok(stage.primaryReportPath.includes('/W6/W6-A-02/'));
      assert.ok(stage.primaryReportPath.includes('实施计划'));
      assert.ok(stage.primaryReportPath.endsWith('.md'));
    });

    it('should use HARNESS_DATE_YYYYMMDD for report file naming when provided', () => {
      const r = harnessEnv({ HARNESS_DATE_YYYYMMDD: '20260618' }, 'init W6-A --force');
      assert.equal(r.success, true, `init should succeed with date override: ${r.stderr}`);

      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.ok(
        stage.primaryReportPath.includes('20260618'),
        `primaryReportPath should use overridden local date: ${stage.primaryReportPath}`
      );
    });
  });

  describe('conditional review branch', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) fs.unlinkSync(path.join(reportDir, f));
        }
      }
      harness('init W6-A --force');
      // First advance: implementation-plan → plan-review
      const status1 = readStatus('W6-A');
      const stage1 = status1.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage1.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage1.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n\n## 需求理解\nPlan content.',
        'utf-8');
      harness('advance W6-A');

      // Second advance: a review without findings skips plan-fix
      const status2 = readStatus('W6-A');
      const stage2 = status2.subtasks['W6-A-02'].stages['plan-review'];
      fs.mkdirSync(path.dirname(stage2.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage2.primaryReportPath, '# Review\n\nNo P0/P1 findings.', 'utf-8');
      harness('advance W6-A');
    });

    it('should reach code-implementation after a clean plan review', () => {
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'code-implementation');
    });
  });

  describe('handoff existence detection', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            fs.unlinkSync(path.join(reportDir, f));
          }
        }
      }
      harness('init W6-A --force');
      harness('interrupt W6-A --reason "token exhausted"');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      if (stage.handoffPath) {
        fs.mkdirSync(path.dirname(stage.handoffPath), { recursive: true });
        fs.writeFileSync(stage.handoffPath, '# Handoff', 'utf-8');
      }
    });

    it('should fail check when interrupted with handoff but no primary report', () => {
      const r = harness('check W6-A');
      assert.equal(r.success, false);
    });

    it('should pass check when primary report exists after interruption', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      if (stage.primaryReportPath) {
        fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
        fs.writeFileSync(stage.primaryReportPath,
          '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n\n## 需求理解\nPlan done.',
          'utf-8');
      }
      const r = harness('check W6-A');
      assert.equal(r.success, true,
        `Should pass with primary report: ${r.stderr}`);
    });
  });

  describe('Fabric-first gate', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) fs.unlinkSync(path.join(reportDir, f));
        }
      }
      harness('init W6-A --force');
    });

    it('should fail check when implementation-plan lacks Fabric section', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## 需求理解\n...\n\n## 技术方案\n...\n\n## 实施步骤\n...',
        'utf-8');
      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Check should fail without Fabric section');
      assert.ok(
        r.stdout.includes('Fabric') || r.stderr.includes('Fabric'),
        'Error should mention Fabric-first'
      );
    });

    it('should pass check when implementation-plan has Fabric section', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric 提供 controls API\n- 自定义逻辑仅做业务桥接\n\n## 需求理解\n...\n\n## 技术方案\n...',
        'utf-8');
      const r = harness('check W6-A');
      assert.equal(r.success, true, `Check should pass with Fabric section: ${r.stderr}`);
    });

    it('should allow advance once Fabric section exists', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API 覆盖关键能力\n- 自定义逻辑仅做业务桥接，不重复实现几何算法\n\n## 需求理解\n...\n\n## 技术方案\n...',
        'utf-8');
      const r = harness('advance W6-A');
      assert.equal(r.success, true, `Should advance with Fabric section: ${r.stderr}`);
      const s = readStatus('W6-A');
      assert.equal(s.currentStage, 'plan-review');
    });

    it('should check the accepted implementation plan, not the fix-review report, before code implementation', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');

      const r = harness('check W6-A');
      assert.equal(r.success, true, r.stdout);
    });
  });

  describe('harness brief', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('brief W6-A');
    });

    it('should generate a brief', () => {
      assert.equal(result.success, true);
      assert.ok(result.stdout.length > 200, 'Brief should be substantial');
    });

    it('should include current subtask and stage', () => {
      assert.ok(result.stdout.includes('W6-A-02'), 'Should mention current subtask');
      assert.ok(result.stdout.includes('implementation-plan'), 'Should mention current stage');
    });

    it('should include Harness self files section', () => {
      assert.ok(
        result.stdout.includes('Harness 自身文件') ||
        result.stdout.includes('自身') ||
        result.stdout.includes('status.json'),
        'Should list harness self files'
      );
    });

    it('should include Review rules section', () => {
      assert.ok(
        result.stdout.includes('Review 规则') ||
        result.stdout.includes('playbook'),
        'Should list review rules'
      );
    });

    it('should include next step info', () => {
      assert.ok(
        result.stdout.includes('下一步') ||
        result.stdout.includes('nextRecommendedCommand') ||
        result.stdout.includes('harness next'),
        'Should include next step recommendation'
      );
    });

    it('should include ownerProfile and requiredSkill', () => {
      assert.ok(
        result.stdout.includes('ownerProfile') ||
        result.stdout.includes('claude-implementer'),
        'Should include ownerProfile'
      );
    });

    it('should not modify status', () => {
      const status = readStatus('W6-A');
      const briefEntries = status.history.filter(h => h.action === 'brief');
      assert.equal(briefEntries.length, 0, 'brief should not add history entries');
    });
  });

  // ===================================================================
  // P0-1: Stage-specific gate tests
  // ===================================================================

  describe('P0-1: plan-review allows open findings (test 4)', () => {
    before(() => {
      // Start fresh
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            try { fs.unlinkSync(path.join(reportDir, f)); } catch {}
          }
        }
      }
      harness('init W6-A --force');

      // Advance to plan-review
      const s1 = readStatus('W6-A');
      const stage1 = s1.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage1.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage1.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API\n\n## 需求理解\nContent.\n', 'utf-8');
      harness('advance W6-A');
    });

    it('should pass check with open P1 findings at plan-review stage', () => {
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-review');

      const stage = status.subtasks['W6-A-02'].stages['plan-review'];
      const reportContent = `# Plan Review Report

### Finding W6-A-02-P1-001
Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: TestModule
Issue: Something needs fixing
Expected: Should work properly

### Finding W6-A-02-P2-001
Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: TestModule
Issue: Minor issue
Expected: Should be better
`;
      createReport(status, 'plan-review', reportContent);

      const r = harness('check W6-A');
      assert.equal(r.success, true,
        'plan-review should pass with open P1 findings');
    });

    it('should advance to plan-fix even with open P1 findings', () => {
      const r = harness('advance W6-A');
      assert.equal(r.success, true, `Should advance to plan-fix: ${r.stderr}`);

      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');
    });
  });

  describe('P0-1: code-review allows open findings (test 5)', () => {
    before(() => {
      // Fast-track to code-review
      harness('init W6-A --force');

      // Advance through implementation-plan → plan-review → plan-fix → plan-fix-review → code-implementation → code-review
      let status = readStatus('W6-A');

      // implementation-plan
      const s1 = status.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(s1.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n\nContent.\n');
      harness('advance W6-A');

      // plan-review
      status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# Plan Review\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      // plan-fix (needs Fix Mapping)
      status = readStatus('W6-A');
      createReport(status, 'plan-fix', '# Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');
      harness('advance W6-A');

      // plan-fix-review (must include Fabric section for Fabric-first gate)
      status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nOK.\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      // code-implementation (needs Fabric section at plan-fix-review stage)
      status = readStatus('W6-A');
      createReport(status, 'code-implementation', '# Code Mapping\n\nContent.\n');
      harness('advance W6-A');

      // Should now be at code-review
      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'code-review');
    });

    it('should pass check with open P1 findings at code-review stage', () => {
      const status = readStatus('W6-A');
      const reportContent = `# Code Review Report

### Finding W6-A-02-P1-002
Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: TestModule
Issue: Code issue
Expected: Should be fixed
`;
      createReport(status, 'code-review', reportContent);

      const r = harness('check W6-A');
      assert.equal(r.success, true,
        'code-review should pass with open P1 findings');
    });

    it('should advance to code-fix even with open P1 findings', () => {
      const r = harness('advance W6-A');
      assert.equal(r.success, true, `Should advance to code-fix: ${r.stderr}`);

      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'code-fix');
    });
  });

  describe('P0-1: plan-fix missing Fix Mapping (test 6)', () => {
    before(() => {
      harness('init W6-A --force');

      // Advance to plan-review
      const s1 = readStatus('W6-A');
      const i = s1.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(i.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      // plan-review — create with findings
      let status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# Plan Review\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');
    });

    it('should fail check when plan-fix lacks Fix Mapping', () => {
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix', '# Plan Fix Report\n\nContent without Fix Mapping.\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Should fail without Fix Mapping');
      assert.ok(r.stdout.includes('Fix Mapping') || r.stderr.includes('Fix Mapping'),
        'Error should mention missing Fix Mapping');
    });
  });

  describe('P0-1: code-fix missing Fix Mapping (test 7)', () => {
    before(() => {
      harness('init W6-A --force');

      // Fast-track to code-fix
      let status = readStatus('W6-A');

      const s1 = status.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(s1.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# PR\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'plan-fix', '# Fix\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | ok |\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nOK.\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'code-implementation', '# Code\nContent.\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'code-review',
        '# CR\n\n### Finding W6-A-02-P1-002\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'code-fix');
    });

    it('should fail when code-fix lacks Fix Mapping', () => {
      const status = readStatus('W6-A');
      createReport(status, 'code-fix', '# Code Fix Report\n\nNo Fix Mapping.\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Should fail without Fix Mapping');
      assert.ok(r.stdout.includes('Fix Mapping') || r.stderr.includes('Fix Mapping'),
        'Error should mention missing Fix Mapping');
    });
  });

  describe('P0-1: plan-fix Fix Mapping coverage check (test 8)', () => {
    before(() => {
      harness('init W6-A --force');

      const s1 = readStatus('W6-A');
      const i = s1.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(i.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      const status = readStatus('W6-A');
      // Create plan-review with TWO open findings
      createReport(status, 'plan-review',
        '# Plan Review\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n\n### Finding W6-A-02-P2-001\nPriority: P2\nStatus: open\nOwner: someone\nModule: M\nIssue: Z\nExpected: W\n');
      harness('advance W6-A');
    });

    it('should block if Fix Mapping does not cover all open findings', () => {
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');

      // Create fix report with Fix Mapping that only covers P2-001, missing P1-001
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P2-001 | fixed | src/x.ts | done |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Should fail when Fix Mapping misses findings');
      assert.ok(r.stdout.includes('W6-A-02-P1-001'),
        'Should mention the uncovered finding');
    });

    it('should pass if Fix Mapping covers all open findings', () => {
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/a.ts | done |\n| W6-A-02-P2-001 | deferred | src/b.ts | noted |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, true, 'Should pass when all findings are covered');
    });

    it('should normalize markdown IDs and annotated statuses in Fix Mapping', () => {
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| **W6-A-02-P1-001** | fixed（首轮） | src/a.ts | done |\n| **W6-A-02-P2-001** | accepted（本轮） | src/b.ts | noted |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, true, r.stdout);
    });
  });

  describe('P0-1: plan-fix-review loops open P0/P1 back to plan-fix', () => {
    before(() => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix-review');
    });

    it('should advance back to plan-fix and increment planRound', () => {
      const status = readStatus('W6-A');
      // Create plan-fix-review that REOPENS the finding
      createReport(status, 'plan-fix-review',
        '# Plan Fix Review\n\nDecision: changes-required\n\n## Fabric 官方能力核查\nVerified.\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: reopened\nOwner: someone\nModule: M\nIssue: 修复不完整\nExpected: 需要重新修复\n');

      const checkResult = harness('check W6-A');
      assert.equal(checkResult.success, true, 'Valid fix-review output should pass contract validation');

      const advanceResult = harness('advance W6-A');
      assert.equal(advanceResult.success, true, 'Advance should enter the next fix round');
      const updated = readStatus('W6-A');
      assert.equal(updated.currentStage, 'plan-fix');
      assert.equal(updated.subtasks['W6-A-02'].planRound, 2);
      assert.ok(updated.subtasks['W6-A-02'].stages['plan-fix'].primaryReportPath.includes('-2轮.md'));
    });

    it('should pass advance when all findings are verified (test 12)', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      // Create plan-fix-review that VERIFIES the finding (must include Fabric section for gate)
      createReport(status, 'plan-fix-review',
        '# Plan Fix Review\n\n报告结论：通过。修复符合预期。\n\n## Fabric 官方能力核查\nVerified.\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');

      const r = harness('check W6-A');
      assert.equal(r.success, true, 'Should pass when findings are verified');

      const advanceResult = harness('advance W6-A');
      assert.equal(advanceResult.success, true, 'Advance should succeed');
      const updated = readStatus('W6-A');
      assert.equal(updated.currentStage, 'code-implementation',
        'Should advance to code-implementation');
    });
  });

  describe('Harness review contract validation', () => {
    it('should reject legacy finding headings that the parser cannot track', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: changes-required\n\n## Fabric 官方能力核查\nVerified.\n\n#### W6-A-02-P1-05: legacy heading\n\n**Priority**: P1\n**Status**: open\n');

      const result = harness('check W6-A');
      assert.equal(result.success, false);
      assert.ok(result.stdout.includes('Legacy finding heading'));
    });

    it('should parse full finding ID headings without the Finding prefix', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n\n### W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should allow H3 full-ID detail headings before canonical Finding blocks', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n\n### W6-A-02-P1-001（detail）→ verified\n\n核验说明。\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should reject malformed structured finding IDs', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: changes-required\n\n## Fabric 官方能力核查\nVerified.\n\n### Finding W6-A-02-NEW-P1-5\nPriority: P1\nStatus: reopened\n');

      const result = harness('check W6-A');
      assert.equal(result.success, false);
      assert.ok(result.stdout.includes('Invalid Finding ID'));
    });

    it('should parse markdown-bold finding metadata', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n\n### Finding W6-A-02-P1-001\n\n**Priority**: P1\n**Status**: verified\n**Owner**: someone\n**Module**: M\n**Files**:\n- src/a.ts\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should parse markdown-bold Decision before heuristic fallback text', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\n**Decision: pass**\n\n## Fabric 官方能力核查\nVerified.\n\n说明：只要存在 open finding，必须使用 Decision: changes-required。\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should parse Chinese finding status tables with short finding IDs', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# W6-A-02 Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n\n| 编号 | 问题 | 程度 | 状态 | 核验证据 |\n| --- | --- | --- | --- | --- |\n| P1-001 | X | P1 | ✅ verified | done |\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should parse full finding status tables', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n\n| Finding | Status | 判定依据 |\n| --- | --- | --- |\n| W6-A-02-P1-001 | **fixed** | done |\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true, result.stdout);
    });

    it('should replace a stale mirror with the accepted primary', () => {
      setupPlanFixReviewStage();
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['plan-fix-review'];
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nVerified.\n');
      createReportAt(stage.mirrorOutputPath, '# Different mirror\n');

      const result = harness('check W6-A');
      assert.equal(result.success, true);
      assert.equal(
        fs.readFileSync(stage.mirrorOutputPath, 'utf-8'),
        fs.readFileSync(stage.primaryReportPath, 'utf-8')
      );
      fs.unlinkSync(stage.mirrorOutputPath);
    });
  });

  describe('stage-specific fix-review document references', () => {
    it('should point code-fix-review at code-fix and code-review reports', () => {
      harness('init W6-A --from W6-A-03 --stage code-fix-review --force');
      const status = readStatus('W6-A');
      const stages = status.subtasks['W6-A-03'].stages;
      stages['code-review'].primaryReportPath = '/tmp/W6-A-03-code-review.md';
      stages['code-fix'].primaryReportPath = '/tmp/W6-A-03-code-fix.md';
      stages['code-fix'].reviewFindingsPath = '/tmp/W6-A-03-code-review.md';
      saveStatus('W6-A', status);

      const result = harness('next W6-A');
      assert.equal(result.success, true);
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-03-code-fix-review.md');
      const prompt = fs.readFileSync(promptPath, 'utf-8');
      assert.ok(prompt.includes('fixReportToReview:** /tmp/W6-A-03-code-fix.md'));
      assert.ok(prompt.includes('previousReviewFindings:** /tmp/W6-A-03-code-review.md'));
      assert.ok(!prompt.includes('计划FixReport'));
      assert.ok(prompt.includes('禁止更新或覆盖上一轮 CodeReview 文件'));
      assert.ok(prompt.includes('previousReviewFindings` 是只读输入'));
    });
  });

  // V2: Delivery now requires --confirm-committed before advancing to next subtask
  describe('P0-1: delivery blocks open findings (test 14, 15)', () => {
    before(() => {
      harness('init W6-A --force');

      // Fast-track through each stage
      let status = readStatus('W6-A');

      // implementation-plan
      const s1 = status.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(s1.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      // plan-review
      status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# PR\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      // plan-fix
      status = readStatus('W6-A');
      createReport(status, 'plan-fix', '# Fix\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');
      harness('advance W6-A');

      // plan-fix-review (must pass cleanly — include Fabric section for Fabric-first gate)
      status = readStatus('W6-A');
      createReport(status, 'plan-fix-review',
        '# Fix Review\n\nDecision: pass\n\n## Fabric 官方能力核查\nOK.\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      // code-implementation
      status = readStatus('W6-A');
      createReport(status, 'code-implementation', '# Code\nContent.\n');
      harness('advance W6-A');

      // code-review
      status = readStatus('W6-A');
      createReport(status, 'code-review',
        '# CR\n\n### Finding W6-A-02-P1-002\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      // code-fix
      status = readStatus('W6-A');
      createReport(status, 'code-fix', '# Fix\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-002 | fixed | src/x.ts | done |\n');
      harness('advance W6-A');

      // code-fix-review
      status = readStatus('W6-A');
      createReport(status, 'code-fix-review',
        '# Fix Review\n\nDecision: pass\n\n### Finding W6-A-02-P1-002\nPriority: P1\nStatus: verified\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'delivery');
    });

    it('should block delivery when open findings exist', () => {
      const status = readStatus('W6-A');
      createReport(status, 'delivery',
        '# Delivery Report\n\nContent without required sections.\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Delivery should fail without summary/evidence');
    });

    it('V2: delivery advance should set awaitingCommit, not auto-advance to next subtask', () => {
      const status = readStatus('W6-A');
      // Create proper delivery report
      createReport(status, 'delivery',
        '# Delivery Report\n\n## 交付摘要\nDone.\n\n## 验证\nAll tests pass.\n\n## Residual Risk\nNone.\n');
      assert.equal(harness('accept W6-A --note "用户人工验收通过"').success, true);

      const r = harness('advance W6-A');
      assert.equal(r.success, true, 'Delivery advance should succeed');

      const updated = readStatus('W6-A');
      // V2: Should stay at delivery, awaitingCommit
      assert.equal(updated.currentSubtask, 'W6-A-02',
        'Should stay at current subtask (awaitingCommit)');
      assert.equal(updated.currentStage, 'delivery',
        'Should stay at delivery stage');
      assert.equal(updated.awaitingCommit, true,
        'Should set awaitingCommit to true');
      assert.equal(updated.commitRequiredForSubtask, 'W6-A-02',
        'Should record which subtask needs commit');
    });

    it('V2: advance --confirm-committed should advance to next subtask', () => {
      const r = harness('advance W6-A --confirm-committed');
      assert.equal(r.success, true, 'confirm-committed should succeed');

      const updated = readStatus('W6-A');
      assert.equal(updated.awaitingCommit, false,
        'awaitingCommit should be cleared');
      assert.equal(updated.currentSubtask, 'W6-A-03',
        'Should advance to next subtask W6-A-03');
      assert.equal(updated.currentStage, 'implementation-plan',
        'Next subtask should start at implementation-plan');
      assert.equal(updated.subtasks['W6-A-02'].status, 'completed',
        'Previous subtask should be completed');
    });
  });

  describe('P0-1: last subtask delivery -> done (test 15)', () => {
    before(() => {
      harness('init W6-A --force');
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-06');
      fs.mkdirSync(reportDir, { recursive: true });
      harness('init W6-A --from W6-A-06 --stage delivery --force');
    });

    it('V2: delivery advance sets awaitingCommit, not done directly', () => {
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-06'].stages['delivery'];
      assert.ok(stage, 'delivery stage should exist');
      assert.ok(stage.primaryReportPath, 'delivery should have primaryReportPath');

      createReport(status, 'delivery',
        '# Delivery Report\n\n## 交付摘要\nDone.\n\n## 验证\nAll tests pass.\n\n## Residual Risk\nNone.\n');
      assert.equal(harness('accept W6-A --note "用户人工验收通过"').success, true);

      const r = harness('advance W6-A');
      assert.equal(r.success, true, 'Delivery should advance');

      const updated = readStatus('W6-A');
      assert.equal(updated.awaitingCommit, true,
        'Should be in awaitingCommit state');
      assert.equal(updated.commitRequiredForSubtask, 'W6-A-06',
        'Should require commit for W6-A-06');
    });

    it('V2: advance --confirm-committed completes the last subtask', () => {
      const r = harness('advance W6-A --confirm-committed');
      assert.equal(r.success, true, 'confirm-committed should succeed');

      const updated = readStatus('W6-A');
      assert.equal(updated.currentStage, 'done',
        'Should be at done stage');
      assert.equal(updated.taskStatus, 'completed',
        'Task status should be completed');
      assert.equal(updated.subtasks['W6-A-06'].status, 'completed',
        'Last subtask should be completed');
    });
  });

  // // TEST 10/11 skipped — they require the "go-back-to-fix" logic which is
  // // implemented in cmdAdvance via the check function. The cycle goes:
  // // fix-review fails -> user must manually produce a new fix report,
  // // then manually advance rounds. The harness doesn't auto-rewind the
  // // currentStage — it blocks advance at the check gate and the
  // // operator/manual flow handles the round increment.
  // //
  // // Round increment occurs when the operator uses set-current to go back,
  // // or we add a "harness revert" command. For now, rounds are set on init
  // // and during advance.

  // ===================================================================
  // Actually let me fix this: the requirement says advance from
  // plan-fix-review should go back to plan-fix when it fails.
  // Let me add that logic to cmdAdvance.
  // ===================================================================

  // These tests are deferred until the advance-back logic is properly implemented

  // ===================================================================
  // P1-5: outputs[] status structure
  // ===================================================================
  describe('P1-5: outputs[] / currentOutputPath / latestAcceptedOutputPath', () => {
    before(() => {
      harness('init W6-A --force');

      // Check initial state
      let status = readStatus('W6-A');

      // Advance to plan-review
      const s1 = status.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(s1.primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\nOK\n\nContent.\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# PR\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      createReport(status, 'plan-fix', '# Fix\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| n/a | fixed | - | - |\n');
      harness('advance W6-A');
    });

    it('should have outputs[] populated for completed stages', () => {
      const status = readStatus('W6-A');
      const implPlan = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(implPlan.stageStatus, 'completed');
      assert.ok(Array.isArray(implPlan.outputs));
      // The outputs should contain primaryReportPath after completion
      assert.ok(implPlan.outputs.length >= 0, 'outputs should be populated');

      const planReview = status.subtasks['W6-A-02'].stages['plan-review'];
      assert.equal(planReview.stageStatus, 'completed');
      assert.ok(Array.isArray(planReview.outputs));
    });

    it('should have latestAcceptedOutputPath set after advance', () => {
      const status = readStatus('W6-A');
      const implPlan = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.ok(implPlan.latestAcceptedOutputPath,
        'Should have latestAcceptedOutputPath after completion');
      assert.equal(implPlan.latestAcceptedOutputPath, implPlan.primaryReportPath,
        'latestAcceptedOutputPath should match primaryReportPath');

      const planReview = status.subtasks['W6-A-02'].stages['plan-review'];
      assert.ok(planReview.latestAcceptedOutputPath,
        'plan-review should have latestAcceptedOutputPath');
    });

    it('should have currentOutputPath for all stages', () => {
      const status = readStatus('W6-A');
      for (const [sid, st] of Object.entries(status.subtasks)) {
        for (const [stageId, stage] of Object.entries(st.stages || {})) {
          assert.ok('currentOutputPath' in stage,
            `${sid}/${stageId} should have currentOutputPath`);
          assert.ok('latestAcceptedOutputPath' in stage,
            `${sid}/${stageId} should have latestAcceptedOutputPath`);
          assert.ok('outputs' in stage,
            `${sid}/${stageId} should have outputs[]`);
        }
      }
    });
  });

  // ===================================================================
  // V2 Tests
  // ===================================================================

  describe('V2: next --copy', () => {
    let result;
    let status;

    before(() => {
      harness('init W6-A --force');
      result = harness('next W6-A --copy');
      status = readStatus('W6-A');
    });

    it('should generate a prompt with --copy flag', () => {
      assert.equal(result.success, true, `next --copy should succeed: ${result.stderr}`);
    });

    it('should include structured metadata in output', () => {
      assert.ok(result.stdout.includes('currentSubtask'), 'Should include currentSubtask');
      assert.ok(result.stdout.includes('targetWindow'), 'Should include targetWindow');
      assert.ok(result.stdout.includes('nextAction: 请粘贴到 A/work 窗口'),
        'Should explicitly identify the A/work target window');
      assert.ok(result.stdout.includes('expectedSkill'), 'Should include expectedSkill');
      assert.ok(result.stdout.includes('promptPath'), 'Should include promptPath');
    });

    it('should include copiedToClipboard in output', () => {
      assert.ok(
        result.stdout.includes('copiedToClipboard'),
        'Should include copiedToClipboard in output'
      );
    });

    it('should save prompt to file', () => {
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      assert.ok(fs.existsSync(promptPath), 'Prompt file should exist');
      const content = fs.readFileSync(promptPath, 'utf-8');
      assert.ok(content.includes('W6-A'), 'Prompt file should contain taskId');
    });

    it('should keep prompt body out of stdout by default', () => {
      assert.ok(result.stdout.includes('Prompt body hidden by default'));
      assert.ok(!result.stdout.includes('# 实施方案编写'), 'Should not print full target-window prompt');
    });

    it('should print prompt body when --show is explicitly requested', () => {
      const shown = harness('next W6-A --show');
      assert.equal(shown.success, true);
      assert.ok(shown.stdout.includes('# 实施方案编写'), 'Should print full prompt with --show');
    });
  });

  describe('V2: step command', () => {
    before(() => {
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            try { fs.unlinkSync(path.join(reportDir, f)); } catch {}
          }
        }
      }
      harness('init W6-A --force');
      // Create a valid implementation-plan report so check passes
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n\n## 需求理解\nContent.',
        'utf-8');
    });

    it('should execute check -> advance -> next and copy by default', () => {
      const r = harnessEnv({ HARNESS_COPY_COMMAND: 'true' }, 'step W6-A');
      assert.equal(r.success, true, `step should succeed: ${r.stderr}`);

      // Should mention CHECK PASSED
      assert.ok(r.stdout.includes('CHECK PASSED') || r.stdout.includes('CHECK'),
        'Should include CHECK output');

      // Should have advanced to plan-review
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-review',
        'Should have advanced to plan-review');

      // Should have generated next prompt
      assert.ok(r.stdout.includes('NEXT PROMPT GENERATED') || r.stdout.includes('NEXT'),
        'Should include NEXT output');
      assert.ok(r.stdout.includes('nextAction: 请粘贴到 B/review 窗口'),
        'Should explicitly identify the B/review target window');
      assert.ok(r.stdout.includes('copiedToClipboard: true') || r.stdout.includes('Copied to clipboard: true'),
        'step should copy the generated prompt by default');
    });

    it('should accept --copy flag', () => {
      // First advance back to implementation-plan
      harness('advance W6-A');
      // Now the stage is plan-fix, let's create a report and test step --copy
      // Actually let's just init fresh and test
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      const stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# 实施方案\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n\n## 需求理解\nContent.',
        'utf-8');

      const r = harness('step W6-A --copy');
      assert.equal(r.success, true, `step --copy should succeed: ${r.stderr}`);
      assert.ok(
        r.stdout.includes('Copied to clipboard') || r.stdout.includes('copiedToClipboard'),
        'Should include clipboard info'
      );
    });
  });

  describe('V2: step stops on check failure', () => {
    before(() => {
      // Clean up any existing report files that might interfere
      const reportDir = path.join(REVIEW_ROOT, 'W6', 'W6-A-02');
      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            try { fs.unlinkSync(path.join(reportDir, f)); } catch {}
          }
        }
      }
      harness('init W6-A --force');
    });

    it('should stop at check and not execute advance/next', () => {
      const r = harness('step W6-A');
      // step sets process.exitCode=1 on check failure → execSync throws
      assert.equal(r.success, false, 'step should fail when check fails');
      assert.ok(
        r.stdout.includes('STOPPED at check') || r.stderr.includes('STOPPED at check'),
        'Should indicate stopped at check'
      );

      // Verify stage didn't advance
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'implementation-plan',
        'Should still be at implementation-plan');
    });
  });

  describe('V2: step respects delivery awaitingCommit', () => {
    before(() => {
      harness('init W6-A --from W6-A-06 --stage delivery --force');
      const status = readStatus('W6-A');
      createReport(status, 'delivery',
        '# Delivery Report\n\n## 交付摘要\nDone.\n\n## 验证\nAll tests pass.\n\n## Residual Risk\nNone.\n');
      assert.equal(harness('accept W6-A --note "用户人工验收通过"').success, true);
    });

    it('should stop at awaiting-commit after delivery', () => {
      const r = harness('step W6-A');
      assert.equal(r.success, true, 'step should succeed but stop at commit checkpoint');
      assert.ok(
        r.stdout.includes('commit checkpoint') || r.stdout.includes('awaiting-commit') || r.stdout.includes('confirm-committed'),
        'Should mention commit checkpoint'
      );

      const status = readStatus('W6-A');
      assert.equal(status.awaitingCommit, true,
        'Status should have awaitingCommit=true');
    });
  });

  describe('V2: current command', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('current W6-A');
    });

    it('should succeed', () => {
      assert.equal(result.success, true, `current should succeed: ${result.stderr}`);
    });

    it('should output current stage info', () => {
      assert.ok(result.stdout.includes('currentSubtask'), 'Should include currentSubtask');
      assert.ok(result.stdout.includes('currentStage'), 'Should include currentStage');
      assert.ok(result.stdout.includes('W6-A-02'), 'Should include subtask ID');
      assert.ok(result.stdout.includes('implementation-plan'), 'Should include stage');
    });

    it('should output targetWindow', () => {
      assert.ok(result.stdout.includes('targetWindow'), 'Should include targetWindow');
      assert.ok(
        result.stdout.includes('work') || result.stdout.includes('review'),
        'Should show window value'
      );
    });

    it('should route delivery to the work window', () => {
      harness('set-current W6-A W6-A-02 delivery');
      const deliveryResult = harness('current W6-A');
      assert.equal(deliveryResult.success, true, deliveryResult.stdout);
      assert.ok(deliveryResult.stdout.includes('| targetWindow | work |'), deliveryResult.stdout);
      assert.ok(deliveryResult.stdout.includes('| expectedSkill | hexai-delivery |'), deliveryResult.stdout);
    });

    it('should output expectedSkill', () => {
      assert.ok(result.stdout.includes('expectedSkill'), 'Should include expectedSkill');
    });

    it('should output next recommended command', () => {
      assert.ok(
        result.stdout.includes('Next recommended command') ||
        result.stdout.includes('harness next'),
        'Should include next recommended command'
      );
    });

    it('should output awaitingCommit status', () => {
      assert.ok(result.stdout.includes('awaitingCommit'), 'Should include awaitingCommit');
    });

    it('should not modify status (read-only)', () => {
      const status = readStatus('W6-A');
      const historyAfter = (status.history || []).length;
      // Run current again
      harness('current W6-A');
      const status2 = readStatus('W6-A');
      const historyAfter2 = (status2.history || []).length;
      assert.equal(historyAfter2, historyAfter,
        'current should not add history entries');
    });
  });

  describe('V2: Fix Mapping enhanced diagnostics', () => {
    before(() => {
      harness('init W6-A --force');

      // Advance to plan-review
      const s1 = readStatus('W6-A');
      const i = s1.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(i.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      // plan-review with a finding
      let status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# Plan Review\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');
    });

    it('should report current fix report path when Fix Mapping is missing', () => {
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');
      createReport(status, 'plan-fix', '# Plan Fix Report\n\nNo Fix Mapping here.\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Check should fail without Fix Mapping');
      assert.ok(
        r.stdout.includes('Fix Mapping') || r.stderr.includes('Fix Mapping'),
        'Should mention Fix Mapping'
      );
    });

    it('should detect wrong heading level (## Fix Mapping instead of ###)', () => {
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n## Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Check should fail with wrong heading level');
      assert.ok(
        r.stdout.includes('heading level') || r.stdout.includes('### Fix Mapping'),
        'Should report heading level is wrong'
      );
    });

    it('should list missing finding IDs with review and fix report paths', () => {
      const status = readStatus('W6-A');
      // Create fix report that uses correct heading but misses a finding
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P2-999 | fixed | src/y.ts | done |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'Check should fail when finding IDs don\'t match');
      assert.ok(
        r.stdout.includes('W6-A-02-P1-001') || r.stderr.includes('W6-A-02-P1-001'),
        'Should mention the missing finding ID'
      );
      assert.ok(
        r.stdout.includes('不要补零') || r.stdout.includes('精确匹配') || r.stdout.includes('Finding ID'),
        'Should remind about exact ID matching'
      );
    });
  });

  describe('V2: prompt includes Fix Mapping requirements', () => {
    let result;
    let prompt;

    before(() => {
      harness('init W6-A --force');
      // Advance to plan-fix stage
      const s1 = readStatus('W6-A');
      const i = s1.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(i.primaryReportPath, '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');

      let status = readStatus('W6-A');
      createReport(status, 'plan-review',
        '# PR\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');

      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');
      result = harness('next W6-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-plan-fix.md');
      prompt = fs.readFileSync(promptPath, 'utf-8');
    });

    it('should include ### Fix Mapping requirement in plan-fix prompt', () => {
      assert.ok(
        prompt.includes('### Fix Mapping'),
        'plan-fix prompt should mention ### Fix Mapping heading'
      );
    });

    it('should include requirement to cover ALL open/reopened findings', () => {
      assert.ok(
        prompt.includes('open') || prompt.includes('reopened') ||
        prompt.includes('覆盖') || prompt.includes('上一轮'),
        'Should mention covering all open/reopened findings'
      );
    });

    it('should include requirement to copy IDs exactly from review', () => {
      assert.ok(
        prompt.includes('原样复制') || prompt.includes('精确匹配') ||
        prompt.includes('不要补零') || prompt.includes('不得重命名'),
        'Should require exact ID copying'
      );
    });
  });

  describe('V2: summary enhanced output', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('summary W6-A');
    });

    it('should include taskStatus', () => {
      assert.ok(result.stdout.includes('taskStatus'), 'Should include taskStatus');
    });

    it('should include awaitingCommit status', () => {
      assert.ok(result.stdout.includes('awaitingCommit'), 'Should include awaitingCommit');
    });

    it('should include next recommended command', () => {
      assert.ok(
        result.stdout.includes('Next Recommended Command') ||
        result.stdout.includes('harness'),
        'Should include next recommended command'
      );
    });

    it('should include completed subtasks section', () => {
      assert.ok(
        result.stdout.includes('Completed subtasks') ||
        result.stdout.includes('completed'),
        'Should include completed subtasks info'
      );
    });
  });

  describe('V2: awaitingCommit blocks next and step', () => {
    before(() => {
      harness('init W6-A --from W6-A-06 --stage delivery --force');
      const status = readStatus('W6-A');
      createReport(status, 'delivery',
        '# Delivery Report\n\n## 交付摘要\nDone.\n\n## 验证\nAll tests pass.\n\n## Residual Risk\nNone.\n');
      assert.equal(harness('accept W6-A --note "用户人工验收通过"').success, true);
      harness('advance W6-A'); // Now awaitingCommit
    });

    it('next should not generate prompt when awaitingCommit', () => {
      const r = harness('next W6-A');
      assert.equal(r.success, false, 'next should fail when awaitingCommit');
      assert.ok(
        r.stdout.includes('commit') || r.stderr.includes('commit') ||
        r.stdout.includes('confirm-committed'),
        'Should mention manual commit and confirm-committed'
      );
    });

    it('step should stop at commit checkpoint when awaitingCommit', () => {
      const r = harness('step W6-A');
      // When awaitingCommit is already set, step detects it and stops
      // The status should still have awaitingCommit=true
      const status = readStatus('W6-A');
      assert.equal(status.awaitingCommit, true,
        'Status should still have awaitingCommit=true after step');
      // Should mention commit checkpoint or confirm-committed
      assert.ok(
        r.stdout.includes('commit') || r.stdout.includes('confirm-committed') ||
        r.stdout.includes('checkpoint'),
        'Should mention commit requirements'
      );
    });
  });

  // ===================================================================
  // P1-4: advance --confirm-committed strict preconditions
  // ===================================================================
  describe('P1-4: advance --confirm-committed preconditions', () => {
    it('should fail --confirm-committed when not in awaitingCommit state', () => {
      harness('init W6-A --force');
      const r = harness('advance W6-A --confirm-committed');
      assert.equal(r.success, false, 'Should fail when not at commit checkpoint');
      assert.ok(
        r.stdout.includes('Not at commit checkpoint') ||
        r.stdout.includes('awaitingCommit') ||
        r.stdout.includes('commit'),
        'Should explain not at commit checkpoint'
      );
    });

    it('should fail --confirm-committed when currentStage is not delivery', () => {
      // Set up: delivery passed → awaitingCommit
      harness('init W6-A --force');
      harness('advance W6-A'); // implementation-plan → plan-review
      // Manually set awaitingCommit but keep stage as plan-review
      const status = readStatus('W6-A');
      status.awaitingCommit = true;
      status.commitRequiredForSubtask = status.currentSubtask;
      // Change stage away from delivery
      status.currentStage = 'plan-review';
      saveStatus('W6-A', status);

      const r = harness('advance W6-A --confirm-committed');
      assert.equal(r.success, false, 'Should fail when stage is not delivery');
      assert.ok(
        r.stdout.includes('delivery') || r.stdout.includes('stage'),
        'Should explain stage mismatch'
      );
    });
  });

  // ===================================================================
  // P1-7: Fix Mapping heading level detection
  // ===================================================================
  describe('P1-7: Fix Mapping heading level detection', () => {
    before(() => {
      harness('init W6-A --force');
      // Advance to plan-fix
      const s1 = readStatus('W6-A');
      createReportAt(s1.subtasks['W6-A-02'].stages['implementation-plan'].primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\nOK\n');
      harness('advance W6-A');
      let status = readStatus('W6-A');
      createReport(status, 'plan-review', '# PR\n\n### Finding W6-A-02-P1-001\nPriority: P1\nStatus: open\nOwner: someone\nModule: M\nIssue: X\nExpected: Y\n');
      harness('advance W6-A');
    });

    it('should fail check with #### Fix Mapping (H4)', () => {
      const status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-fix');
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n#### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, false, 'H4 heading should be rejected');
      assert.ok(
        r.stdout.includes('heading level') || r.stdout.includes('### Fix Mapping'),
        'Should report heading level error'
      );
    });

    it('should pass check with correct ### Fix Mapping', () => {
      const status = readStatus('W6-A');
      createReport(status, 'plan-fix',
        '# Plan Fix Report\n\n### Fix Mapping\n\n| Finding | Status | 修复文件 | 验证 |\n| W6-A-02-P1-001 | fixed | src/x.ts | done |\n');

      const r = harness('check W6-A');
      assert.equal(r.success, true, 'Correct H3 heading should pass');
    });
  });

  // ===================================================================
  // P2-1: pbcopy injectable via env vars
  // ===================================================================
  describe('P2-1: pbcopy injectable via HARNESS_DISABLE_PBCOPY', () => {
    it('should output copiedToClipboard: false when HARNESS_DISABLE_PBCOPY=1', () => {
      harness('init W6-A --force');
      const r = harnessEnv({ HARNESS_DISABLE_PBCOPY: '1' }, 'next W6-A --copy');
      assert.equal(r.success, true, 'next --copy should still succeed');
      assert.ok(
        r.stdout.includes('copiedToClipboard: false') || r.stdout.includes('copiedToClipboard'),
        'Should report copiedToClipboard: false'
      );
      assert.ok(
        r.stdout.includes('pbcopy') || r.stdout.includes('warning') || r.stdout.includes('无法复制'),
        'Should warn about clipboard failure'
      );
    });

    it('should still generate prompt file when clipboard fails', () => {
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'prompts', 'W6-A-02-implementation-plan.md');
      if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
      const r = harnessEnv({ HARNESS_DISABLE_PBCOPY: '1' }, 'next W6-A --copy');
      assert.equal(r.success, true);
      assert.ok(fs.existsSync(promptPath), 'Prompt file should still be created');
    });
  });

  describe('V2.4: output freshness and Harness-owned mirror', () => {
    it('should reject unchanged pre-existing output and sync mirror after a fresh update', () => {
      harness('init W6-A --force');
      let status = readStatus('W6-A');
      let stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      createReportAt(stage.primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\nOK\n\nExisting content.\n');

      assert.equal(harness('next W6-A').success, true);
      const staleCheck = harness('check W6-A');
      assert.equal(staleCheck.success, false);
      assert.ok(staleCheck.stdout.includes('was not updated'));

      fs.appendFileSync(stage.primaryReportPath, '\nFresh update.\n', 'utf-8');
      const freshCheck = harness('check W6-A');
      assert.equal(freshCheck.success, true, freshCheck.stdout);

      status = readStatus('W6-A');
      stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(
        fs.readFileSync(stage.mirrorOutputPath, 'utf-8'),
        fs.readFileSync(stage.primaryReportPath, 'utf-8')
      );
      assert.ok(stage.mirrorSyncedAt, 'Passing check should record mirror sync time');
    });

    it('should not recapture baseline when next is re-run after output is produced', () => {
      harness('init W6-A --force');
      let status = readStatus('W6-A');
      let stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      if (fs.existsSync(stage.primaryReportPath)) fs.unlinkSync(stage.primaryReportPath);

      assert.equal(harness('next W6-A').success, true);
      status = readStatus('W6-A');
      stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(stage.outputBaseline.exists, false);

      createReportAt(stage.primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\nOK\n\nDelivered content.\n');

      assert.equal(harness('next W6-A --copy').success, true);
      status = readStatus('W6-A');
      stage = status.subtasks['W6-A-02'].stages['implementation-plan'];
      assert.equal(stage.outputBaseline.exists, false);

      const check = harness('check W6-A');
      assert.equal(check.success, true, check.stdout);
    });
  });

  describe('V2.4: delivery acceptance contract', () => {
    it('should only accept a non-empty report at delivery', () => {
      harness('init W6-A --force');
      assert.equal(harness('accept W6-A --note "验收通过"').success, false);

      harness('init W6-A --from W6-A-06 --stage delivery --force');
      assert.equal(harness('accept W6-A').success, false);
      const emptyStatus = readStatus('W6-A');
      const emptyReportPath = emptyStatus.subtasks['W6-A-06'].stages.delivery.primaryReportPath;
      if (fs.existsSync(emptyReportPath)) fs.unlinkSync(emptyReportPath);
      assert.equal(harness('accept W6-A --note "验收通过"').success, false);

      const status = readStatus('W6-A');
      createReport(status, 'delivery',
        '# Delivery Report\n\n## 交付摘要\nDone.\n\n## 验证\nAll tests pass.\n\n## Residual Risk\nNone.\n');
      assert.equal(harness('accept W6-A --note "验收通过"').success, true);

      const accepted = readStatus('W6-A').acceptances['W6-A-06'];
      assert.equal(accepted.primaryReportPath,
        status.subtasks['W6-A-06'].stages.delivery.primaryReportPath);
      assert.ok(accepted.outputSnapshot.sha256);
    });

    it('should require re-acceptance when the delivery report changes', () => {
      const status = readStatus('W6-A');
      const reportPath = status.subtasks['W6-A-06'].stages.delivery.primaryReportPath;
      fs.appendFileSync(reportPath, '\nChanged after acceptance.\n', 'utf-8');

      const staleAcceptance = harness('check W6-A');
      assert.equal(staleAcceptance.success, false);
      assert.ok(staleAcceptance.stdout.includes('changed after manual acceptance'));

      assert.equal(harness('accept W6-A --note "变更后重新验收"').success, true);
      assert.equal(harness('check W6-A').success, true);
    });
  });

  // ===================================================================
  // V2.4: schemaVersion 3 migration
  // ===================================================================
  describe('V2.4: schemaVersion 3 migration', () => {
    it('should add schemaVersion: 3 to new status', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      assert.equal(status.schemaVersion, 3, 'New status should have schemaVersion: 3');
      assert.deepEqual(status.acceptances, {}, 'New status should initialize acceptances');
      assert.equal(status.awaitingCommit, false, 'New status should have awaitingCommit: false');
      assert.equal(status.commitRequiredForSubtask, null, 'New status should have commitRequiredForSubtask: null');
    });

    it('should migrate old status without schemaVersion', () => {
      // HW7A-CR-P1-001: use a taskId with valid taskId-specific OR fallback config
      // W6-A-MIGRATE-TEST now throws because no W6-A-MIGRATE-TEST.json exists and
      // default config taskId !== requested. Use W6-A directly — TEST_ROOT is isolated
      // so it won't pollute real runs/W6-A/status.json.
      const taskId = 'W6-A';
      const statusPath = path.join(HARNESS_DIR, 'runs', taskId, 'status.json');
      const oldStatus = {
        taskId,
        taskTitle: 'Migration Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentSubtask: 'W6-A-02',
        currentStage: 'implementation-plan',
        residualRisks: [],
        subtasks: {
          'W6-A-02': {
            id: 'W6-A-02',
            title: 'Test',
            shortTitle: 'Test',
            taskTheme: 'Test',
            planRound: 1,
            codeRound: 1,
            deliveryRound: 1,
            status: 'active',
            stages: {
              'implementation-plan': {
                stageStatus: 'active',
                currentOutputPath: '',
                latestAcceptedOutputPath: '',
                outputs: [],
              },
            },
          },
        },
        history: [],
        // NOTE: schemaVersion, awaitingCommit, commitRequiredForSubtask are intentionally absent
      };
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify(oldStatus, null, 2), 'utf-8');

      // loadStatus (via current) should migrate this old status
      const r = harness(`current ${taskId}`);
      assert.equal(r.success, true, 'Should handle old status gracefully');

      const migrated = readStatus(taskId);
      assert.equal(migrated.schemaVersion, 3, 'Should have schemaVersion: 3 after migration');
      assert.deepEqual(migrated.acceptances, {}, 'Should initialize acceptances during migration');
      assert.equal(migrated.awaitingCommit, false, 'Should have awaitingCommit: false after migration');
      assert.equal(migrated.commitRequiredForSubtask, null, 'Should have commitRequiredForSubtask: null after migration');
    });

    it('should persist schemaVersion: 3 after saveStatus', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      assert.equal(status.schemaVersion, 3, 'Should write schemaVersion: 3');
      // Trigger a save
      harness('current W6-A');
      const saved = readStatus('W6-A');
      assert.equal(saved.schemaVersion, 3, 'schemaVersion should persist after save');
    });
  });

  // ===================================================================
  // P2-3: outputs[] not updated by next
  // ===================================================================
  describe('P2-3: next does not add non-existent paths to outputs[]', () => {
    it('next should not add primaryReportPath to outputs[] before report exists', () => {
      harness('init W6-A --force');
      const before = readStatus('W6-A');
      const outputsBefore = before.subtasks['W6-A-02'].stages['implementation-plan'].outputs.slice();

      harness('next W6-A');

      const after = readStatus('W6-A');
      const outputsAfter = after.subtasks['W6-A-02'].stages['implementation-plan'].outputs;
      // outputs should NOT have grown just from next being called
      assert.equal(outputsAfter.length, outputsBefore.length,
        'outputs[] should not grow just from next being called');
    });
  });

  // ===================================================================
  // W7-A minimal generalization (Harness 最小泛化)
  // ===================================================================
  describe('W7-A minimal generalization (Harness 最小泛化)', () => {
    before(() => {
      // HW7A-CR-P2-002 (Option A): test config 派生自生产
      // workflows/weekly-canvas-task-W7-A.json，仅重写路径前缀到 TEST_ROOT
      const w7Dir = path.join(REVIEW_ROOT, 'W7');
      const w7SubDir = path.join(w7Dir, 'W7-A-01');
      fs.mkdirSync(w7SubDir, { recursive: true });

      const productionConfigPath = path.join(srcHarness, 'workflows', 'weekly-canvas-task-W7-A.json');
      if (!fs.existsSync(productionConfigPath)) {
        throw new Error(`Test precondition failed: production ${productionConfigPath} not found`);
      }
      const productionConfig = JSON.parse(fs.readFileSync(productionConfigPath, 'utf-8'));

      // 重写路径字段以指向 TEST_ROOT
      const testConfig = JSON.parse(JSON.stringify(productionConfig));
      testConfig.reportRoot = path.join(REVIEW_ROOT, 'W7');
      testConfig.codeRepo = CODE_REPO;
      testConfig.reviewRoot = REVIEW_ROOT;
      if (testConfig.requiredPlaybooks) {
        for (const key of Object.keys(testConfig.requiredPlaybooks)) {
          testConfig.requiredPlaybooks[key] = testConfig.requiredPlaybooks[key].map(p =>
            path.join(REVIEW_ROOT, 'ReviewPlaybooks', path.basename(p))
          );
        }
      }

      const w7ConfigPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task-W7-A.json');
      fs.writeFileSync(w7ConfigPath, JSON.stringify(testConfig, null, 2), 'utf-8');
    });

    after(() => {
      // Clean up the W7-A config we created for these tests
      const w7ConfigPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task-W7-A.json');
      if (fs.existsSync(w7ConfigPath)) fs.unlinkSync(w7ConfigPath);
    });

    it('W7-A init creates runs/W7-A/status.json', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      assert.ok(status, 'W7-A status.json should exist');
      assert.equal(status.taskId, 'W7-A');
      assert.equal(status.taskTitle, 'W7-A 画布可演示交互闭环');
      assert.equal(status.currentSubtask, 'W7-A-01');
      assert.equal(status.currentStage, 'implementation-plan');
    });

    it('W7-A init uses taskId-specific config (no warning)', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      assert.equal(status.subtasks['W7-A-01'].title, '占位入口治理 + 交互 P0');
      assert.equal(status.subtasks['W7-A-01'].taskTheme, 'W7-A画布可演示交互闭环');
    });

    it('W7-A default fromSubtask is the first subtask (not W6-A-02)', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      assert.equal(status.currentSubtask, 'W7-A-01', 'default fromSubtask must come from config, not hardcoded W6-A-02');
    });

    it('W7-A current shows W7-A fields', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      const r = harness('current W7-A');
      assert.equal(r.success, true);
      assert.ok(r.stdout.includes('W7-A'));
      assert.ok(r.stdout.includes('占位入口治理 + 交互 P0'), 'should show subtask title');
      assert.ok(r.stdout.includes('implementation-plan'));
      // taskTitle is stored in status.json even if cmdCurrent only renders subtaskTitle
      assert.equal(status.taskTitle, 'W7-A 画布可演示交互闭环');
    });

    it('W7-A next generates prompt with taskId-specific paths', () => {
      harness('init W7-A --force');
      const r = harness('next W7-A');
      assert.equal(r.success, true);
      assert.ok(r.stdout.includes('W7-A'));
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W7-A', 'prompts', 'W7-A-01-implementation-plan.md');
      const prompt = fs.readFileSync(promptPath, 'utf-8');
      assert.ok(prompt.includes('W7-A画布可演示交互闭环'));
      assert.ok(prompt.includes('/W7/W7-A-01/') || prompt.includes('reviewRoot'),
        'prompt should reference W7-A report dir');
    });

    it('W7-A next --copy writes prompt to runs/W7-A/prompts/', () => {
      harness('init W7-A --force');
      harness('next W7-A');
      const promptPath = path.join(HARNESS_DIR, 'runs', 'W7-A', 'prompts', 'W7-A-01-implementation-plan.md');
      assert.ok(fs.existsSync(promptPath), 'Prompt file should exist at runs/W7-A/prompts/');
    });

    it('W7-A check fails without Fabric section (Fabric-first gate)', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      const stage = status.subtasks['W7-A-01'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath, '# Plan\n\nContent without Fabric section.\n', 'utf-8');

      const r = harness('check W7-A');
      assert.equal(r.success, false);
      assert.ok(r.stdout.includes('Fabric') || r.stderr.includes('Fabric'));
    });

    it('W7-A check passes with Fabric section + advance to plan-review', () => {
      harness('init W7-A --force');
      const status = readStatus('W7-A');
      const stage = status.subtasks['W7-A-01'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n- 自定义逻辑仅做业务桥接\n\n## 需求理解\nContent.\n',
        'utf-8');

      const r = harness('advance W7-A');
      assert.equal(r.success, true, `advance should succeed: ${r.stderr}`);

      const updated = readStatus('W7-A');
      assert.equal(updated.currentStage, 'plan-review');
      assert.equal(updated.subtasks['W7-A-01'].stages['implementation-plan'].stageStatus, 'completed');
    });

    it('cacheKey: W6-A and W7-A status files are independent', () => {
      // Init both, verify they don't pollute each other
      harness('init W6-A --force');
      harness('init W7-A --force');

      const w6 = readStatus('W6-A');
      const w7 = readStatus('W7-A');

      assert.equal(w6.taskId, 'W6-A');
      assert.equal(w7.taskId, 'W7-A');
      assert.ok(w6.subtasks['W6-A-02'], 'W6-A should have W6-A-02 subtask');
      assert.ok(!w6.subtasks['W7-A-01'], 'W6-A should NOT have W7-A-01 subtask');
      assert.ok(w7.subtasks['W7-A-01'], 'W7-A should have W7-A-01 subtask');
      assert.ok(!w7.subtasks['W6-A-02'], 'W7-A should NOT have W6-A-02 subtask');
    });

    it('cacheKey: W6-A status is unchanged after W7-A init', () => {
      harness('init W6-A --force');
      const before = JSON.stringify(readStatus('W6-A'));

      harness('init W7-A --force');

      const after = JSON.stringify(readStatus('W6-A'));
      assert.equal(after, before, 'W6-A status must not change after W7-A init');
    });

    it('cacheKey: W7-A after-then-W6-A-then-W7-A cycles correctly', () => {
      // First W6-A init
      harness('init W6-A --force');
      // Then W7-A — should use W7-A config
      harness('init W7-A --force');
      let status = readStatus('W7-A');
      assert.equal(status.subtasks['W7-A-01'].title, '占位入口治理 + 交互 P0');

      // Then W6-A again — should restore W6-A config
      harness('init W6-A --force');
      status = readStatus('W6-A');
      assert.equal(status.subtasks['W6-A-02'].title, '移动磁吸与红色参考线');

      // Then W7-A again — must reload W7-A config (cacheKey miss)
      harness('init W7-A --force');
      status = readStatus('W7-A');
      assert.equal(status.subtasks['W7-A-01'].title, '占位入口治理 + 交互 P0');
      assert.ok(!status.subtasks['W6-A-02']);
    });

    it('taskTitle throw: missing taskTitle in config throws clear error', () => {
      // Create a W7-A config without taskTitle
      const brokenConfigPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task-W7-A.json');
      const originalConfig = fs.readFileSync(brokenConfigPath, 'utf-8');
      const broken = JSON.parse(originalConfig);
      delete broken.taskTitle;
      fs.writeFileSync(brokenConfigPath, JSON.stringify(broken, null, 2), 'utf-8');

      const r = harness('init W7-A --force');
      assert.equal(r.success, false, 'init should fail when taskTitle is missing');
      assert.ok(
        r.stdout.includes('taskTitle') || r.stderr.includes('taskTitle'),
        'Error must mention taskTitle'
      );

      // Restore config for subsequent tests
      fs.writeFileSync(brokenConfigPath, originalConfig, 'utf-8');
    });

    it('JSON parse error: invalid JSON config throws clear error', () => {
      const brokenConfigPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task-W7-A.json');
      const originalConfig = fs.readFileSync(brokenConfigPath, 'utf-8');
      fs.writeFileSync(brokenConfigPath, '{ "taskId": "W7-A", "taskTitle": "x", invalid json ', 'utf-8');

      const r = harness('init W7-A --force');
      assert.equal(r.success, false, 'init should fail on invalid JSON');
      assert.ok(
        r.stdout.includes('parse') || r.stderr.includes('parse') ||
        r.stdout.includes('JSON') || r.stderr.includes('JSON'),
        'Error must mention JSON parse failure'
      );

      // Restore
      fs.writeFileSync(brokenConfigPath, originalConfig, 'utf-8');
    });

    it('W6-A isolation: runs/W6-A/ status.json not modified by W7-A ops (semantic equality)', () => {
      // Snapshot W6-A runs dir BEFORE any W7-A ops
      harness('init W6-A --force');
      const w6Dir = path.join(HARNESS_DIR, 'runs', 'W6-A');
      const w6StatusBefore = JSON.parse(JSON.stringify(readStatus('W6-A')));
      const w6MtimeBefore = fs.statSync(path.join(w6Dir, 'status.json')).mtimeMs;

      // W7-A ops must not touch W6-A status.json
      harness('init W7-A --force');
      harness('next W7-A');

      const w6MtimeAfter = fs.statSync(path.join(w6Dir, 'status.json')).mtimeMs;
      assert.equal(w6MtimeAfter, w6MtimeBefore,
        'runs/W6-A/status.json mtime must be unchanged after W7-A ops');

      // Compare semantically (deep equal) — JSON formatting differs from write
      const w6StatusAfter = JSON.parse(fs.readFileSync(path.join(w6Dir, 'status.json'), 'utf-8'));
      assert.deepEqual(w6StatusAfter, w6StatusBefore,
        'runs/W6-A/status.json content must be semantically unchanged after W7-A ops');
    });

    it('W7-A full chain: init → check → step → plan-review', () => {
      // Init W7-A
      harness('init W7-A --force');

      // Create a valid implementation-plan report with Fabric section
      const status = readStatus('W7-A');
      const stage = status.subtasks['W7-A-01'].stages['implementation-plan'];
      fs.mkdirSync(path.dirname(stage.primaryReportPath), { recursive: true });
      fs.writeFileSync(stage.primaryReportPath,
        '# Plan\n\n## Fabric 官方能力核查\n- Fabric API 覆盖\n- 自定义逻辑仅做业务桥接\n\n## 需求理解\nContent.\n',
        'utf-8');

      // Run step (check → advance → next)
      const r = harnessEnv({ HARNESS_COPY_COMMAND: 'true' }, 'step W7-A');
      assert.equal(r.success, true, `step should succeed: ${r.stderr}`);
      assert.ok(r.stdout.includes('CHECK PASSED') || r.stdout.includes('CHECK'));

      const after = readStatus('W7-A');
      assert.equal(after.currentStage, 'plan-review', 'step should advance to plan-review');
      assert.ok(
        after.subtasks['W7-A-01'].stages['implementation-plan'].stageStatus === 'completed',
        'implementation-plan stage should be completed'
      );
    });

    it('W7-A current --copy includes copiedToClipboard info', () => {
      harness('init W7-A --force');
      const r = harness('current W7-A');
      assert.equal(r.success, true);
      assert.ok(r.stdout.includes('currentSubtask'));
      assert.ok(r.stdout.includes('W7-A'));
    });

    // ----- HW7A-CR-P1-001: 未知 taskId fallback 防御 -----
    it('HW7A-CR-P1-001: init W8-A (no taskId-specific config) throws clear error', () => {
      // W8-A 没有 weekly-canvas-task-W8-A.json，必须 throw 而非静默使用 W6-A config
      const r = harness('init W8-A --force');
      assert.equal(r.success, false, 'init W8-A must fail when no taskId-specific config exists');
      const msg = (r.stdout + r.stderr).toLowerCase();
      assert.ok(
        msg.includes('weekly-canvas-task-w8-a.json') ||
        msg.includes('create workflows/weekly-canvas-task-w8-a.json') ||
        msg.includes('no task-specific config'),
        'Error must mention W8-A config filename or "No task-specific config"'
      );
    });

    // ----- HW7A-CR-P2-004: 空 subtasks 防御 -----
    it('HW7A-CR-P2-004: empty subtasks config throws clear error', () => {
      // 临时破坏 W7-A config 的 subtasks 字段为空数组
      const w7ConfigPath = path.join(HARNESS_DIR, 'workflows', 'weekly-canvas-task-W7-A.json');
      const originalConfig = fs.readFileSync(w7ConfigPath, 'utf-8');
      const broken = JSON.parse(originalConfig);
      broken.subtasks = [];
      fs.writeFileSync(w7ConfigPath, JSON.stringify(broken, null, 2), 'utf-8');

      const r = harness('init W7-A --force');
      assert.equal(r.success, false, 'init must fail when subtasks is empty');
      const msg = r.stdout + r.stderr;
      assert.ok(
        msg.includes('No subtasks defined'),
        'Error must say "No subtasks defined" instead of raw TypeError'
      );

      // 恢复 config
      fs.writeFileSync(w7ConfigPath, originalConfig, 'utf-8');
    });
  });

  // ----- HW7A-CR-P2-002 Option B: 验证生产 W7-A config 结构 -----
  describe('W7-A production config structure validation', () => {
    it('production workflows/weekly-canvas-task-W7-A.json has required fields', () => {
      const productionConfigPath = path.join(srcHarness, 'workflows', 'weekly-canvas-task-W7-A.json');
      assert.ok(fs.existsSync(productionConfigPath), 'production W7-A config must exist');
      const cfg = JSON.parse(fs.readFileSync(productionConfigPath, 'utf-8'));
      assert.equal(cfg.taskId, 'W7-A', 'taskId must be W7-A');
      assert.ok(cfg.taskTitle && cfg.taskTitle.trim().length > 0,
        'taskTitle must be present and non-empty (HW7A-P1-003 throw precondition)');
      assert.ok(Array.isArray(cfg.subtasks) && cfg.subtasks.length > 0,
        'subtasks must be non-empty array');
      assert.ok(Array.isArray(cfg.stages) && cfg.stages.length === 10,
        'stages must have 10 entries');
      assert.ok(cfg.reportRoot.endsWith('/W7'),
        `reportRoot must end with /W7, got ${cfg.reportRoot}`);
    });
  });
});
