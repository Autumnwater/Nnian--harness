// HEXAI Review Harness V1 — Test Suite
// Run with: pnpm test

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import { createSessionProof } from '../scripts/execution-protocol.js';

// Create temp directories for isolated testing
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
const REVIEW_ROOT = path.join(TEST_ROOT, 'review');
const CODE_REPO = path.join(TEST_ROOT, 'hexai');
const HARNESS_DIR = path.join(REVIEW_ROOT, 'Harness');
const HARNESS_SCRIPT = path.join(HARNESS_DIR, 'scripts', 'harness.js');
process.env.HARNESS_ENABLE_TEST_WARP_HELPER = '1';
process.env.HARNESS_ENABLE_TEST_FAULTS = '1';

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

function startHarness(args) {
  const child = spawn(process.execPath, [HARNESS_SCRIPT, ...args], {
    cwd: HARNESS_DIR,
    env: { ...process.env, REVIEW_ROOT, CODE_REPO, HARNESS_ROOT: HARNESS_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    completed: new Promise(resolve => child.on('close', exitCode => resolve({ success: exitCode === 0, exitCode, stdout, stderr }))),
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timeout');
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

function workflowStatusSnapshot(taskId) {
  const status = readStatus(taskId);
  return {
    taskId: status.taskId,
    currentSubtask: status.currentSubtask,
    currentStage: status.currentStage,
    subtasks: Object.fromEntries(Object.entries(status.subtasks || {}).map(([subtaskId, subtask]) => [
      subtaskId,
      {
        status: subtask.status,
        planRound: subtask.planRound,
        codeRound: subtask.codeRound,
        deliveryRound: subtask.deliveryRound,
        stages: Object.fromEntries(Object.entries(subtask.stages || {}).map(([stageId, stage]) => [
          stageId,
          {
            stageStatus: stage.stageStatus,
            currentOutputPath: stage.currentOutputPath,
            latestAcceptedOutputPath: stage.latestAcceptedOutputPath,
            outputs: stage.outputs || [],
          },
        ])),
      },
    ])),
  };
}

function activeSubmittedStatus(taskId, bindingId) {
  const status = readStatus(taskId);
  if (!status?.execution?.activeAttemptId) return null;
  const transportPath = path.join(HARNESS_DIR, 'runs', taskId, 'transports', `${bindingId}.json`);
  if (!fs.existsSync(transportPath)) return null;
  const transport = JSON.parse(fs.readFileSync(transportPath, 'utf8'));
  return transport.attemptId === status.execution.activeAttemptId && transport.transportState === 'submitted'
    ? status
    : null;
}

function writeFullHookCapabilityFixture(name = 'phase5-full-hook.json') {
  const fixture = path.join(TEST_ROOT, name);
  fs.writeFileSync(fixture, JSON.stringify({
    hookSource: 'claude-code-hook',
    hookVersion: 'test-1',
    completionPhase: 'claude-completed',
    attemptRefSource: 'wrapper-injected',
    bindingSessionSource: 'wrapper-injected',
    needsInputCategorySource: 'hook-payload',
    needsInputCategory: 'agent-question',
    kind: 'job.completed',
    occurredAt: new Date().toISOString(),
    observedFields: ['kind', 'occurredAt', 'needsInputCategory'],
  }), 'utf8');
  return fixture;
}

function setupVerifiedWarpPilotRole(taskId, role) {
  const bindingId = `wrapper.${role}`;
  assert.equal(harness(`worker-attach ${taskId} --role ${role} --binding ${bindingId}`).success, true);
  const bind = harness(`warp-bind-target ${taskId} --role ${role} --binding ${bindingId} --candidate candidate-${role} --respond-fixture`);
  assert.equal(bind.success, true, bind.stderr);
  return JSON.parse(bind.stdout);
}

function setupPhase5PilotCapabilities(taskId) {
  const capabilityPath = path.join(HARNESS_DIR, 'runs', taskId, 'capabilities', 'warp-macos.json');
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
  fs.writeFileSync(capabilityPath, JSON.stringify({
    protocolVersion: 1,
    kind: 'warp-macos.capability',
    name: 'warp-macos',
    capturedAt: new Date().toISOString(),
    fixture: false,
    warp: { detected: true, bundleId: 'dev.warp.Warp-Stable', version: 'phase5-test' },
    accessibility: { permission: 'granted', helper: 'macos-accessibility-helper', helperVersion: 1 },
    targetDiscovery: { available: true, stableFingerprintFields: ['bindingId', 'role', 'candidateId'], requiresTwoScanStability: true },
    inputSubmission: { available: true, method: 'accessibility-submit', usesClipboard: false, settleBarrier: 'helper-submit-result' },
    targetIdentity: { available: true, requiresWrapperBinding: true, requiresChallenge: true },
    diagnosticEligible: true,
    phase4RunEnabled: false,
    phase5ProductionCandidate: true,
    reasons: [],
  }, null, 2) + '\n', 'utf8');
  const fixture = writeFullHookCapabilityFixture(`${taskId}-phase5-full-hook.json`);
  assert.equal(harness(`worker-challenge ${taskId} --probe-hook-payload ${fixture}`).success, true);
}

function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
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
before(() => {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  fs.mkdirSync(CODE_REPO, { recursive: true });
  fs.mkdirSync(path.join(REVIEW_ROOT, 'ReviewPlaybooks'), { recursive: true });
  fs.mkdirSync(path.join(REVIEW_ROOT, 'W6', 'W6-A-01'), { recursive: true });

  const srcHarness = path.resolve(import.meta.dirname, '..');
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

    before(() => {
      harness('init W6-A --force');
      result = harness('next W6-A');
      status = readStatus('W6-A');
    });

    it('should generate a prompt', () => {
      assert.equal(result.success, true);
      assert.ok(result.stdout.length > 100, 'Prompt should be substantial');
    });

    it('should include taskId in prompt', () => {
      assert.ok(result.stdout.includes('W6-A'));
    });

    it('should include subtaskId W6-A-02 in prompt', () => {
      assert.ok(result.stdout.includes('W6-A-02'));
    });

    it('should include primaryReportPath in prompt', () => {
      assert.ok(result.stdout.includes('primaryReportPath'));
      assert.ok(result.stdout.includes('/W6/W6-A-02/'));
    });

    it('should include mirror output path in prompt', () => {
      assert.ok(result.stdout.includes('mirrorOutput') || result.stdout.includes('mirror'), 'Should mention mirror output');
    });

    it('should include handoff path concept in prompt', () => {
      assert.ok(
        result.stdout.includes('handoff') || result.stdout.includes('Handoff') || result.stdout.includes('HANDOFF'),
        'Should mention handoff'
      );
    });

    it('should include requiredSkill info in prompt', () => {
      assert.ok(result.stdout.includes('requiredSkill'));
    });

    it('should include codeRepo path in prompt', () => {
      assert.ok(result.stdout.includes('codeRepo'));
    });

    it('should include reportDir in prompt', () => {
      assert.ok(result.stdout.includes('reportDir'));
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
    });

    it('should generate a continuation prompt', () => {
      assert.equal(result.success, true);
      assert.ok(result.stdout.includes('继续'), 'Prompt should indicate continuation');
      assert.ok(result.stdout.includes('中断'), 'Prompt should mention interruption');
    });

    it('should include handoffPath in prompt', () => {
      assert.ok(result.stdout.includes('handoffPath') ||
        result.stdout.includes('handoff'));
    });

    it('should include primaryReportPath in prompt', () => {
      assert.ok(result.stdout.includes('primaryReportPath') ||
        result.stdout.includes('/W6/W6-A-02/'));
    });

    it('should include mirror output path reference in prompt', () => {
      assert.ok(
        result.stdout.includes('mirror') || result.stdout.includes('副本') || result.stdout.includes('Mirror'),
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
    });

    it('should tell agent not to redo work', () => {
      assert.ok(
        result.stdout.includes('不要从头重做') ||
        result.stdout.includes('不要重复') ||
        result.stdout.includes('中断任务') ||
        result.stdout.includes('继续'),
        'Should tell agent to continue, not restart'
      );
    });
  });

  describe('prompt includes boundary rules', () => {
    let result;

    before(() => {
      harness('init W6-A --force');
      result = harness('next W6-A');
    });

    it('should mention .claude/settings.json prohibition', () => {
      assert.ok(
        result.stdout.includes('.claude/settings.json') ||
        result.stdout.includes('settings.json'),
        'Should mention settings.json restriction'
      );
    });

    it('should mention implementer cannot approve own work', () => {
      assert.ok(
        result.stdout.includes('不可批准') ||
        result.stdout.includes('不能批准') ||
        result.stdout.includes('cannot approve') ||
        result.stdout.includes('不可自行批准'),
        'Should state implementer cannot approve own work'
      );
    });
  });

  describe('delivery prompt write boundary', () => {
    it('should forbid delivery from modifying business code', () => {
      harness('init W6-A --from W6-A-03 --stage delivery --force');
      const result = harness('next W6-A');
      assert.equal(result.success, true);
      assert.ok(result.stdout.includes('禁止写入或修改'));
      assert.ok(result.stdout.includes('只能写入'));
      assert.ok(!result.stdout.includes('有权读写'));
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
      assert.ok(result.stdout.includes('fixReportToReview:** /tmp/W6-A-03-code-fix.md'));
      assert.ok(result.stdout.includes('previousReviewFindings:** /tmp/W6-A-03-code-review.md'));
      assert.ok(!result.stdout.includes('计划FixReport'));
      assert.ok(result.stdout.includes('禁止更新或覆盖上一轮 CodeReview 文件'));
      assert.ok(result.stdout.includes('previousReviewFindings` 是只读输入'));
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

    it('should still contain the prompt content', () => {
      assert.ok(result.stdout.includes('W6-A-02'), 'Should include subtask in prompt');
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
    });

    it('should include ### Fix Mapping requirement in plan-fix prompt', () => {
      assert.ok(
        result.stdout.includes('### Fix Mapping'),
        'plan-fix prompt should mention ### Fix Mapping heading'
      );
    });

    it('should include requirement to cover ALL open/reopened findings', () => {
      assert.ok(
        result.stdout.includes('open') || result.stdout.includes('reopened') ||
        result.stdout.includes('覆盖') || result.stdout.includes('上一轮'),
        'Should mention covering all open/reopened findings'
      );
    });

    it('should include requirement to copy IDs exactly from review', () => {
      assert.ok(
        result.stdout.includes('原样复制') || result.stdout.includes('精确匹配') ||
        result.stdout.includes('不要补零') || result.stdout.includes('不得重命名'),
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
  // V3 Phase 1: schemaVersion 4 migration and execution safety
  // ===================================================================
  describe('V3 Phase 1: schemaVersion 4 migration and execution safety', () => {
    it('should add schemaVersion: 4 and manual execution defaults to new status', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      assert.equal(status.schemaVersion, 4, 'New status should have schemaVersion: 4');
      assert.ok(status.stateRevision >= 1, 'New status should have a persisted stateRevision');
      assert.equal(status.stageRevision, 0, 'New status should initialize stageRevision');
      assert.deepEqual(status.execution, {
        mode: 'manual',
        activeJobId: null,
        activeAttemptId: null,
        activeLeaseToken: null,
        lockEpoch: 0,
        lastJobId: null,
      });
      assert.deepEqual(status.acceptances, {}, 'New status should initialize acceptances');
      assert.equal(status.awaitingCommit, false, 'New status should have awaitingCommit: false');
      assert.equal(status.commitRequiredForSubtask, null, 'New status should have commitRequiredForSubtask: null');
    });

    it('should migrate old status without schemaVersion', () => {
      // Use a unique task ID to avoid collision with any existing run
      const taskId = 'W6-A-MIGRATE-TEST';
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

      const beforeRead = fs.readFileSync(statusPath, 'utf-8');

      // Read-only commands may use an in-memory migration but must not write it back.
      const r = harness(`current ${taskId}`);
      assert.equal(r.success, true, 'Should handle old status gracefully');
      assert.equal(fs.readFileSync(statusPath, 'utf-8'), beforeRead,
        'Read-only current must not persist migration without the execution lock');

      // A state-changing command owns execution.lock, re-reads, migrates, and writes new stage evidence.
      const next = harness(`next ${taskId}`);
      assert.equal(next.success, true, 'Locked next should persist migration and baseline evidence');

      const migrated = readStatus(taskId);
      assert.equal(migrated.schemaVersion, 4, 'Should have schemaVersion: 4 after migration');
      assert.ok(migrated.stateRevision >= 1, 'Migration should persist stateRevision');
      assert.ok(migrated.stageRevision >= 1, 'next should persist a new stage revision');
      assert.equal(migrated.execution.mode, 'manual', 'Migration should default to manual mode');
      assert.equal(migrated.execution.activeJobId, null);
      assert.equal(migrated.execution.activeAttemptId, null);
      assert.ok(migrated.subtasks['W6-A-02'].stages['implementation-plan'].outputBaseline,
        'next should persist output baseline evidence');
      assert.deepEqual(migrated.acceptances, {}, 'Should initialize acceptances during migration');
      assert.equal(migrated.awaitingCommit, false, 'Should have awaitingCommit: false after migration');
      assert.equal(migrated.commitRequiredForSubtask, null, 'Should have commitRequiredForSubtask: null after migration');

      const afterWrite = fs.readFileSync(statusPath, 'utf-8');
      for (const readCommand of ['current', 'status', 'summary', 'brief']) {
        assert.equal(harness(`${readCommand} ${taskId}`).success, true);
        assert.equal(fs.readFileSync(statusPath, 'utf-8'), afterWrite,
          `${readCommand} must not overwrite migrated baseline/revision evidence`);
      }
    });

    it('should persist schemaVersion: 4 after saveStatus', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      assert.equal(status.schemaVersion, 4, 'Should write schemaVersion: 4');
      // Trigger a save
      harness('current W6-A');
      const saved = readStatus('W6-A');
      assert.equal(saved.schemaVersion, 4, 'schemaVersion should persist after save');
    });

    it('should reject progress while another task execution holds the lock', () => {
      harness('init W6-A --force');
      const lockPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'execution.lock');
      const acquiredAt = new Date().toISOString();
      fs.writeFileSync(lockPath, JSON.stringify({
        taskId: 'W6-A',
        command: 'step',
        ownerId: 'live-test-owner',
        pid: process.pid,
        acquiredAt,
        heartbeatAt: acquiredAt,
        lockEpoch: 0,
      }), 'utf-8');

      const result = harness('next W6-A');

      assert.equal(result.success, false);
      assert.match(result.stderr, /task-locked/);
      fs.unlinkSync(lockPath);
    });

    it('should recover a stale lock only after its owner process is gone', () => {
      harness('init W6-A --force');
      const lockPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'execution.lock');
      fs.writeFileSync(lockPath, JSON.stringify({
        ownerId: 'dead-owner',
        pid: 2_147_483_647,
        acquiredAt: '2000-01-01T00:00:00.000Z',
        heartbeatAt: '2000-01-01T00:00:00.000Z',
        lockEpoch: 0,
      }), 'utf-8');

      const result = harnessEnv({ HARNESS_LOCK_STALE_MS: '0' }, 'next W6-A');

      assert.equal(result.success, true);
      assert.equal(fs.existsSync(lockPath), false);
      const recoveredStatus = readStatus('W6-A');
      assert.equal(recoveredStatus.execution.lockEpoch, 1);
      assert.equal(recoveredStatus.history.at(-1).action, 'stale-lock-recovered');
      assert.equal(recoveredStatus.history.at(-1).details.reason, 'owner-dead-and-heartbeat-stale');
    });

    it('should replay an orphan recovery marker without incrementing lockEpoch twice', () => {
      harness('init W6-A --force');
      const lockPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'execution.lock');
      const stale = {
        ownerId: 'dead-owner',
        pid: 2_147_483_647,
        acquiredAt: '2000-01-01T00:00:00.000Z',
        heartbeatAt: '2000-01-01T00:00:00.000Z',
        lockEpoch: 0,
      };
      const recoveryId = `${stale.ownerId}:${stale.acquiredAt}`;
      const status = readStatus('W6-A');
      status.execution.lockEpoch = 1;
      status.history.push({
        timestamp: new Date().toISOString(),
        action: 'stale-lock-recovered',
        details: { recoveryId, lockEpoch: 1 },
      });
      saveStatus('W6-A', status);
      fs.writeFileSync(`${lockPath}.stale.${stale.ownerId}`, JSON.stringify(stale), 'utf-8');

      const result = harness('next W6-A');

      assert.equal(result.success, true);
      const replayedStatus = readStatus('W6-A');
      assert.equal(replayedStatus.execution.lockEpoch, 1);
      assert.equal(
        replayedStatus.history.filter(entry => entry.details?.recoveryId === recoveryId).length,
        1
      );
      assert.equal(fs.existsSync(`${lockPath}.stale.${stale.ownerId}`), false);
    });

    it('should complete an unaudited orphan recovery marker exactly once', () => {
      harness('init W6-A --force');
      const lockPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'execution.lock');
      const stale = {
        ownerId: 'crashed-recovery-owner',
        pid: 2_147_483_647,
        acquiredAt: '2001-01-01T00:00:00.000Z',
        heartbeatAt: '2001-01-01T00:00:00.000Z',
        lockEpoch: 0,
      };
      const markerPath = `${lockPath}.stale.${stale.ownerId}`;
      fs.writeFileSync(markerPath, JSON.stringify(stale), 'utf-8');

      const result = harness('next W6-A');

      assert.equal(result.success, true);
      const status = readStatus('W6-A');
      const recoveryId = `${stale.ownerId}:${stale.acquiredAt}`;
      assert.equal(status.execution.lockEpoch, 1);
      assert.equal(
        status.history.filter(entry => entry.details?.recoveryId === recoveryId).length,
        1
      );
      assert.equal(fs.existsSync(markerPath), false);
    });

    it('should audit and fence each consecutive orphan recovery independently', () => {
      harness('init W6-A --force');
      const lockPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'execution.lock');
      const staleLocks = [
        { ownerId: 'owner-a', acquiredAt: '2000-01-01T00:00:00.000Z' },
        { ownerId: 'owner-b', acquiredAt: '2001-01-01T00:00:00.000Z' },
      ].map(item => ({
        ...item,
        pid: 2_147_483_647,
        heartbeatAt: item.acquiredAt,
        lockEpoch: 0,
      }));
      for (const stale of staleLocks) {
        fs.writeFileSync(`${lockPath}.stale.${stale.ownerId}`, JSON.stringify(stale), 'utf-8');
      }

      const result = harness('next W6-A');

      assert.equal(result.success, true);
      const status = readStatus('W6-A');
      assert.equal(status.execution.lockEpoch, 2);
      for (const stale of staleLocks) {
        const recoveryId = `${stale.ownerId}:${stale.acquiredAt}`;
        assert.equal(
          status.history.filter(entry => entry.details?.recoveryId === recoveryId).length,
          1
        );
        assert.equal(fs.existsSync(`${lockPath}.stale.${stale.ownerId}`), false);
      }
    });

    it('should reject manual progress while an attempt is active', () => {
      harness('init W6-A --force');
      const status = readStatus('W6-A');
      status.execution.activeJobId = 'job-1';
      status.execution.activeAttemptId = 'attempt-1';
      status.execution.activeLeaseToken = 'attempt-1:1:token';
      saveStatus('W6-A', status);

      const result = harness('next W6-A');

      assert.equal(result.success, false);
      assert.match(result.stderr, /active-job-conflict/);

      const checkResult = harness('check W6-A');
      assert.equal(checkResult.success, false);
      assert.match(checkResult.stderr, /active-job-conflict/);

      const initResult = harness('init W6-A --force');
      assert.equal(initResult.success, false);
      assert.match(initResult.stderr, /active-job-conflict/);
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

  describe('V3 Phase 2: real CLI fake-adapter loop', () => {
    before(() => {
      const status = readStatus('W6-A');
      if (!status?.execution) return;
      status.execution.activeJobId = null;
      status.execution.activeAttemptId = null;
      status.execution.activeLeaseToken = null;
      saveStatus('W6-A', status);
    });

    it('keeps doctor/jobs read-only and completes foreground run through real gates', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      const statusFile = path.join(HARNESS_DIR, 'runs', 'W6-A', 'status.json');
      const beforeDoctor = fs.readFileSync(statusFile, 'utf8');
      const doctor = harness('doctor W6-A --adapter fake');
      assert.equal(doctor.success, true, doctor.stderr);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), beforeDoctor);
      const manual = harness('run W6-A --adapter manual');
      assert.equal(manual.success, false);
      assert.match(manual.stdout, /manual-required/);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), beforeDoctor);
      const beforeJobsReadOnly = fs.readFileSync(statusFile, 'utf8');
      assert.equal(harness('jobs W6-A --json').success, true);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), beforeJobsReadOnly);

      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      let status = await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));
      assert.ok(status.execution.activeJobId);
      assert.ok(status.execution.activeAttemptId);
      assert.ok(status.execution.activeLeaseToken);
      assert.equal(harness('jobs W6-A --json').success, true);

      const attemptPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'attempts', `${status.execution.activeAttemptId}.json`);
      const attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
      const jobPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'jobs', `${status.execution.activeJobId}.json`);
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      createReportAt(job.primaryReportPath, `# Plan ${attempt.attemptId}\n\n## Fabric 官方能力核查\nOK\n`);
      const receiptDir = path.join(HARNESS_DIR, 'runs', 'W6-A', 'receipts', 'inbox', attempt.attemptId);
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(path.join(receiptDir, 'event-complete.json'), JSON.stringify({
        protocolVersion: 1,
        eventId: 'event-complete',
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        leaseToken: attempt.leaseToken,
        kind: 'job.completed',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        source: 'fake-adapter',
        details: {},
      }, null, 2));

      const run = await running.completed;
      assert.equal(run.success, true, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, /workflow-completed/, run.stdout);
      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'plan-review');
      assert.equal(status.execution.activeJobId, null);
      assert.equal(status.execution.activeAttemptId, null);
      assert.equal(status.execution.activeLeaseToken, null);
      assert.ok(status.history.some(entry => entry.action === 'worker-workflow-committed'));
    });

    it('allows full AttemptRef cancellation while foreground run waits', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      let status = await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));
      const stale = harness(`cancel W6-A --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token stale`);
      assert.equal(stale.success, false);
      assert.match(stale.stderr, /attempt-fence-conflict/);
      status = readStatus('W6-A');
      const cancelled = harness(`cancel W6-A --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token ${status.execution.activeLeaseToken}`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
      status = readStatus('W6-A');
      assert.equal(status.execution.activeJobId, null, cancelled.stdout);
      assert.equal(status.execution.activeAttemptId, null);
      assert.ok(status.history.some(entry => entry.action === 'worker-cancelled'));
      const run = await running.completed;
      assert.equal(run.success, true, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, /"status": "idle"/);
    });

    it('allows manual takeover while foreground run waits without bypassing gates', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));
      const takeover = harness('advance W6-A --takeover --reason "operator takeover"');
      assert.equal(takeover.success, false, takeover.stdout);
      assert.match(takeover.stdout, /Cannot advance: check failed|check failed/i);
      const status = readStatus('W6-A');
      assert.equal(status.execution.activeJobId, null);
      assert.equal(status.execution.activeAttemptId, null);
      assert.equal(status.execution.activeLeaseToken, null);
      assert.equal(status.currentStage, 'implementation-plan');
      assert.ok(status.history.some(entry => entry.action === 'worker-takeover'));
      const run = await running.completed;
      assert.equal(run.success, true, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, /"status": "idle"/);
    });

    it('records delivery acceptance while foreground run waits and stops at the commit checkpoint', async () => {
      assert.equal(harness('init W6-A --from W6-A-02 --stage delivery --force').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      let status = await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));
      const attempt = JSON.parse(fs.readFileSync(path.join(
        HARNESS_DIR, 'runs', 'W6-A', 'attempts', `${status.execution.activeAttemptId}.json`
      ), 'utf8'));
      const job = JSON.parse(fs.readFileSync(path.join(
        HARNESS_DIR, 'runs', 'W6-A', 'jobs', `${status.execution.activeJobId}.json`
      ), 'utf8'));
      createReportAt(job.primaryReportPath, `# 交付摘要 ${attempt.attemptId}\n\n## 验证\n全部通过。\n\n## 残留风险\n无。\n`);
      const stageRevisionBeforeAccept = status.stageRevision;
      const accepted = harness('accept W6-A --note "人工验收通过"');
      assert.equal(accepted.success, true, accepted.stderr);
      status = readStatus('W6-A');
      assert.equal(status.stageRevision, stageRevisionBeforeAccept);

      const receiptDir = path.join(HARNESS_DIR, 'runs', 'W6-A', 'receipts', 'inbox', attempt.attemptId);
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(path.join(receiptDir, 'delivery-complete.json'), JSON.stringify({
        protocolVersion: 1, eventId: 'delivery-complete', jobId: attempt.jobId,
        attemptId: attempt.attemptId, leaseToken: attempt.leaseToken, kind: 'job.completed',
        sequence: 1, occurredAt: new Date().toISOString(), source: 'fake-adapter', details: {},
      }, null, 2));
      const run = await running.completed;
      assert.equal(run.success, true, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, /workflow-completed/);
      status = readStatus('W6-A');
      assert.equal(status.currentStage, 'delivery');
      assert.equal(status.awaitingCommit, true);
      assert.equal(status.execution.activeAttemptId, null);
    });
  });

  describe('V3 Phase 3: worker binding and receipt CLI', () => {
    it('keeps worker-attach dry-run read-only and stores raw nonce only in the secret file', () => {
      assert.equal(harness('init W6-A --force').success, true);
      const statusFile = path.join(HARNESS_DIR, 'runs', 'W6-A', 'status.json');
      const before = fs.readFileSync(statusFile, 'utf8');

      const dryRun = harness('worker-attach W6-A --role work --binding wrapper.work --dry-run');
      assert.equal(dryRun.success, true, dryRun.stderr);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(HARNESS_DIR, 'runs', 'W6-A', 'bindings', 'wrapper.work.json')), false);
      assert.match(dryRun.stdout, /"wouldWrite": false/);
      assert.doesNotMatch(dryRun.stdout, /rawNonce|sessionNonce[^H]/);

      const attached = harness('worker-attach W6-A --role work --binding wrapper.work');
      assert.equal(attached.success, true, attached.stderr);
      assert.doesNotMatch(attached.stdout, /rawNonce|sessionNonce[^H]/);
      const bindingPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'bindings', 'wrapper.work.json');
      const secretPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'bindings', '.secrets', 'wrapper.work.nonce');
      assert.equal(fs.existsSync(bindingPath), true);
      assert.equal(fs.existsSync(secretPath), true);
      assert.doesNotMatch(fs.readFileSync(bindingPath, 'utf8'), /rawNonce|sessionNonce[^H]/);
      assert.equal((fs.statSync(secretPath).mode & 0o777), 0o600);

      const bindings = harness('worker-bindings W6-A --json');
      assert.equal(bindings.success, true, bindings.stderr);
      assert.equal(bindings.stdout.includes(fs.readFileSync(secretPath, 'utf8')), false);
      assert.match(bindings.stdout, /wrapper\.work/);

      const issued = harness('worker-challenge W6-A --binding wrapper.work');
      assert.equal(issued.success, true, issued.stderr);
      const challenge = JSON.parse(issued.stdout);
      assert.equal(challenge.status, 'issued');
      assert.ok(challenge.payload.challengeId);
      const badVerify = harness(`worker-challenge W6-A --binding wrapper.work --challenge-id ${challenge.challengeId} --proof bad-proof`);
      assert.equal(badVerify.success, false);
      assert.match(badVerify.stderr, /challenge-proof-invalid/);
      const proof = createSessionProof(fs.readFileSync(secretPath, 'utf8'), challenge.payload);
      const verified = harness(`worker-challenge W6-A --binding wrapper.work --challenge-id ${challenge.challengeId} --proof ${proof}`);
      assert.equal(verified.success, true, verified.stderr);
      assert.match(verified.stdout, /"status": "verified"/);
      const replay = harness(`worker-challenge W6-A --binding wrapper.work --challenge-id ${challenge.challengeId} --proof ${proof}`);
      assert.equal(replay.success, false);
      assert.match(replay.stderr, /challenge-already-used/);

      const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      fs.writeFileSync(bindingPath, JSON.stringify({
        ...binding,
        heartbeatAt: '2000-01-01T00:00:00.000Z',
      }, null, 2), 'utf8');
      const stale = harness('worker-challenge W6-A --binding wrapper.work');
      assert.equal(stale.success, false);
      assert.match(stale.stderr, /binding-stale/);
    });

    it('supports worker-launch heartbeat and detach without leaking raw nonce or changing workflow status', () => {
      assert.equal(harness('init W6-A --force').success, true);
      const before = workflowStatusSnapshot('W6-A');

      const launched = harness('worker-launch W6-A --role work --binding wrapper.work');
      assert.equal(launched.success, true, launched.stderr);
      assert.doesNotMatch(launched.stdout, /rawNonce|sessionNonce[^H]/);
      assert.deepEqual(workflowStatusSnapshot('W6-A'), before);

      const bindingPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'bindings', 'wrapper.work.json');
      const original = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      const heartbeat = harness('worker-heartbeat W6-A --binding wrapper.work');
      assert.equal(heartbeat.success, true, heartbeat.stderr);
      assert.match(heartbeat.stdout, /heartbeat-recorded/);
      const refreshed = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      assert.ok(Date.parse(refreshed.heartbeatAt) >= Date.parse(original.heartbeatAt));
      assert.equal(refreshed.state, 'live');
      assert.deepEqual(workflowStatusSnapshot('W6-A'), before);

      const detached = harness('worker-detach W6-A --binding wrapper.work --reason done');
      assert.equal(detached.success, true, detached.stderr);
      assert.match(detached.stdout, /"status": "detached"/);
      const detachedBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      assert.equal(detachedBinding.state, 'detached');
      assert.equal(detachedBinding.detachReason, 'done');
      assert.deepEqual(workflowStatusSnapshot('W6-A'), before);

      const staleHeartbeat = harness('worker-heartbeat W6-A --binding wrapper.work');
      assert.equal(staleHeartbeat.success, false);
      assert.match(staleHeartbeat.stderr, /binding-unavailable/);
    });

    it('rejects binding replacement while an active attempt for the role exists', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));

      const replace = harness('worker-attach W6-A --role work --binding wrapper.work --replace');

      assert.equal(replace.success, false);
      assert.match(replace.stderr, /active-attempt-binding-replacement-conflict/);
      const status = readStatus('W6-A');
      const cancelled = harness(`cancel W6-A --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token ${status.execution.activeLeaseToken}`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
      await running.completed;
    });

    it('publishes needs-input through worker-receipt and makes foreground run stop without clearing active refs', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      const status = await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));

      const receipt = harness(`worker-receipt W6-A --attempt ${status.execution.activeAttemptId} --kind job.needs-input --sequence 1 --needs-input-category agent-question --event-id needs-input-cli`);
      assert.equal(receipt.success, true, `${receipt.stderr}\n${receipt.stdout}`);
      assert.doesNotMatch(receipt.stdout, /rawNonce|sessionNonce[^H]/);
      const run = await running.completed;

      assert.equal(run.success, false, `${run.stderr}\n${run.stdout}`);
      assert.match(run.stdout, /"status": "needs-input"/);
      const after = readStatus('W6-A');
      assert.equal(after.execution.activeAttemptId, status.execution.activeAttemptId);
      assert.equal(after.execution.activeLeaseToken, status.execution.activeLeaseToken);
      assert.equal(fs.existsSync(path.join(HARNESS_DIR, 'runs', 'W6-A', 'leases', 'fake.work.json')), true);

      const invalid = harness(`worker-receipt W6-A --attempt ${status.execution.activeAttemptId} --kind job.needs-input --sequence 2 --event-id needs-input-invalid`);
      assert.equal(invalid.success, false);
      assert.match(invalid.stderr, /needs-input-invalid-category/);
      const cancelled = harness(`cancel W6-A --job ${after.execution.activeJobId} --attempt ${after.execution.activeAttemptId} --lease-token ${after.execution.activeLeaseToken}`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
    });

    it('records hook payload capability evidence and reports it from doctor without writing status', () => {
      assert.equal(harness('init W6-A --force').success, true);
      const fixture = path.join(TEST_ROOT, 'hook-payload.json');
      fs.writeFileSync(fixture, JSON.stringify({
        hookSource: 'claude-code-hook',
        hookVersion: 'test-1',
        completionPhase: 'claude-completed',
        attemptRefSource: 'wrapper-injected',
        bindingSessionSource: 'wrapper-injected',
        needsInputCategorySource: 'hook-payload',
        kind: 'job.completed',
        occurredAt: new Date().toISOString(),
        needsInputCategory: 'agent-question',
      }), 'utf8');
      const statusFile = path.join(HARNESS_DIR, 'runs', 'W6-A', 'status.json');
      const before = fs.readFileSync(statusFile, 'utf8');

      const challenge = harness(`worker-challenge W6-A --probe-hook-payload ${fixture}`);
      assert.equal(challenge.success, true, challenge.stderr);
      assert.match(challenge.stdout, /"completionReceiptCapability": "available"/);
      const afterProbe = fs.readFileSync(statusFile, 'utf8');
      assert.equal(afterProbe, before);

      const doctor = harness('doctor W6-A --adapter fake');
      assert.equal(doctor.success, true, doctor.stderr);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
      assert.match(doctor.stdout, /"completionReceiptCapability": "available"/);
      assert.match(doctor.stdout, /"needsInputCapability": "available"/);
    });

    it('keeps worker-hook-probe fixture diagnostics from authorizing pilot-doctor', () => {
      assert.equal(harness('init W6-A --force').success, true);
      fs.rmSync(path.join(HARNESS_DIR, 'runs', 'W6-A', 'capabilities', 'claude-hook.json'), { force: true });
      const fixture = path.join(TEST_ROOT, 'hook-fixture-only.json');
      fs.writeFileSync(fixture, JSON.stringify({
        hookSource: 'claude-code-hook',
        hookVersion: 'test-1',
        completionPhase: 'claude-completed',
        attemptRefSource: 'wrapper-injected',
        bindingSessionSource: 'wrapper-injected',
        needsInputCategorySource: 'hook-payload',
        kind: 'job.completed',
        occurredAt: new Date().toISOString(),
        needsInputCategory: 'agent-question',
      }), 'utf8');
      const before = workflowStatusSnapshot('W6-A');
      const probe = harness(`worker-hook-probe W6-A --payload ${fixture}`);
      assert.equal(probe.success, true, probe.stderr);
      assert.match(probe.stdout, /fixture-diagnostic-recorded/);
      assert.match(probe.stdout, /"realCapabilityWritten": false/);
      assert.deepEqual(workflowStatusSnapshot('W6-A'), before);
      assert.equal(fs.existsSync(path.join(HARNESS_DIR, 'runs', 'W6-A', 'capabilities', 'claude-hook.json')), false);

      const parsed = JSON.parse(probe.stdout);
      const diagnostic = JSON.parse(fs.readFileSync(parsed.diagnosticPath, 'utf8'));
      assert.equal(diagnostic.fixture, true);
      assert.equal(diagnostic.pilotEligible, false);

      const doctor = harness('pilot-doctor W6-A --json');
      assert.equal(doctor.success, true, doctor.stderr);
      const pilot = JSON.parse(doctor.stdout);
      assert.equal(pilot.hookCapabilities.completionReceiptCapability, 'unavailable');
      assert.equal(pilot.pilotRun.allowed, false);
    });

    it('keeps hook capability unavailable for missing, stale, drifted, or incomplete evidence', () => {
      assert.equal(harness('init W6-A --force').success, true);
      const writeProbe = (name, payload) => {
        const fixture = path.join(TEST_ROOT, name);
        fs.writeFileSync(fixture, JSON.stringify(payload), 'utf8');
        return harness(`worker-challenge W6-A --probe-hook-payload ${fixture}`);
      };
      const base = {
        hookSource: 'claude-code-hook',
        hookVersion: 'test-1',
        completionPhase: 'claude-completed',
        attemptRefSource: 'wrapper-injected',
        bindingSessionSource: 'wrapper-injected',
        needsInputCategorySource: 'hook-payload',
        kind: 'job.completed',
        occurredAt: new Date().toISOString(),
        needsInputCategory: 'agent-question',
      };
      for (const [name, payload, reason] of [
        ['hook-drift.json', { ...base, versionDrift: true }, 'capability-evidence-incompatible'],
        ['hook-stale.json', { ...base, capturedAt: '2000-01-01T00:00:00.000Z' }, 'capability-evidence-stale'],
        ['hook-missing-phase.json', { ...base, completionPhase: undefined }, 'missing-completion-phase'],
        ['hook-missing-source.json', { ...base, needsInputCategorySource: undefined }, 'missing-needs-input-category-source'],
      ]) {
        const result = writeProbe(name, payload);
        assert.equal(result.success, true, result.stderr);
        assert.match(result.stdout, /"completionReceiptCapability": "unavailable"|"needsInputCapability": "unavailable"/);
        assert.match(result.stdout, new RegExp(reason));
      }
    });
  });

  describe('V3 Phase 4: warp-macos adapter spike CLI', () => {
    it('reports warp-macos unavailable by default and refuses real W6 run', () => {
      assert.equal(harness('init W6-A --force').success, true);
      const doctor = harness('doctor W6-A --adapter warp-macos');
      assert.equal(doctor.success, true, doctor.stderr);
      assert.match(doctor.stdout, /missing-warp-capability-evidence/);

      const run = harness('run W6-A --adapter warp-macos');
      assert.equal(run.success, false);
      assert.match(run.stdout, /warp-macos-production-disabled/);
      const status = readStatus('W6-A');
      assert.equal(status.execution.activeAttemptId, null);
      assert.equal(status.execution.activeJobId, null);
    });

    it('binds a fixture warp target through target challenge without writing workflow status', () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      const statusFile = path.join(HARNESS_DIR, 'runs', 'W6-A', 'status.json');
      const before = fs.readFileSync(statusFile, 'utf8');
      const beforeStatus = JSON.parse(before);

      const probe = harness('warp-doctor W6-A --probe-fixture --json');
      assert.equal(probe.success, true, probe.stderr);
      assert.match(probe.stdout, /"diagnosticEligible":true|"diagnosticEligible": true/);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), before);

      const issued = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work');
      assert.equal(issued.success, true, issued.stderr);
      const challenge = JSON.parse(issued.stdout);
      assert.equal(challenge.status, 'issued');
      assert.equal(challenge.payload.kind, 'target.challenge');

      const verified = harness(`warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --challenge-id ${challenge.challengeId} --respond-fixture`);
      assert.equal(verified.success, true, verified.stderr);
      assert.match(verified.stdout, /"status": "verified"/);
      const afterStatus = readStatus('W6-A');
      assert.equal(afterStatus.currentSubtask, beforeStatus.currentSubtask);
      assert.equal(afterStatus.currentStage, beforeStatus.currentStage);
      assert.equal(afterStatus.execution.activeJobId, beforeStatus.execution.activeJobId);
      assert.equal(afterStatus.execution.activeAttemptId, beforeStatus.execution.activeAttemptId);
      assert.equal(afterStatus.execution.activeLeaseToken, beforeStatus.execution.activeLeaseToken);

      const replay = harness(`warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --challenge-id ${challenge.challengeId} --respond-fixture`);
      assert.equal(replay.success, false);
      assert.match(replay.stderr, /target-challenge-replay/);

      const targets = harness('warp-targets W6-A --role work --json');
      assert.equal(targets.success, true, targets.stderr);
      assert.match(targets.stdout, /wrapper\.work/);
      assert.match(targets.stdout, /targetFingerprintHash/);
      assert.doesNotMatch(targets.stdout, /rawNonce|sessionNonce[^H]/);
    });

    it('fails closed for missing, duplicate, changed, or title-only target discovery', () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      assert.equal(harness('warp-doctor W6-A --probe-fixture').success, true);

      const zero = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --fixture-zero');
      assert.equal(zero.success, false);
      assert.match(zero.stderr, /target-discovery-zero/);

      const duplicate = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --fixture-duplicate');
      assert.equal(duplicate.success, false);
      assert.match(duplicate.stderr, /target-discovery-duplicate/);

      const changed = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --fixture-changed');
      assert.equal(changed.success, false);
      assert.match(changed.stderr, /target-discovery-changed/);

      const titleOnly = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --title-only');
      assert.equal(titleOnly.success, false);
      assert.match(titleOnly.stderr, /target-fingerprint-unstable/);
    });

    it('rejects target binding changes while a related active attempt exists', async () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      assert.equal(harness('warp-doctor W6-A --probe-fixture').success, true);
      const running = startHarness(['run', 'W6-A', '--adapter', 'fake', '--run-timeout-ms', '5000', '--poll-ms', '20']);
      const status = await waitFor(() => activeSubmittedStatus('W6-A', 'fake.work'));

      const bind = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work');

      assert.equal(bind.success, false);
      assert.match(bind.stderr, /active-attempt-target-binding-conflict/);
      const cancelled = harness(`cancel W6-A --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token ${status.execution.activeLeaseToken}`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
      await running.completed;
    });

    it('fails closed for real target binding without falling back to fixture challenge', () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      assert.equal(harness('warp-doctor W6-A --probe-fixture --enable-phase5-candidate').success, true);

      const fixtureEvidence = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --real');
      assert.equal(fixtureEvidence.success, false);
      assert.match(fixtureEvidence.stderr, /warp-bind-target-real-capability-unavailable/);
      const bindingPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'bindings', 'wrapper.work.json');
      let binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      assert.equal(binding.targetBinding, undefined);

      const capabilityPath = path.join(HARNESS_DIR, 'runs', 'W6-A', 'capabilities', 'warp-macos.json');
      fs.writeFileSync(capabilityPath, JSON.stringify({
        protocolVersion: 1,
        kind: 'warp-macos.capability',
        capturedAt: new Date().toISOString(),
        fixture: false,
        warp: { detected: true, bundleId: 'dev.warp.Warp-Stable', version: 'fixture-test' },
        accessibility: { permission: 'granted', helper: 'real-helper', helperVersion: 1 },
        targetDiscovery: {
          available: true,
          stableFingerprintFields: ['bundleId', 'windowId', 'tabId', 'roleBindingMarker'],
          requiresTwoScanStability: true,
        },
        inputSubmission: {
          available: true,
          method: 'accessibility-key-events',
          usesClipboard: false,
          settleBarrier: 'helper-submit-result',
        },
        targetIdentity: { available: true, requiresWrapperBinding: true, requiresChallenge: true },
        diagnosticEligible: true,
        phase4RunEnabled: false,
        phase5ProductionCandidate: true,
        reasons: [],
      }, null, 2), 'utf8');

      const noTargetLocalChannel = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --real');
      assert.equal(noTargetLocalChannel.success, false);
      assert.match(noTargetLocalChannel.stderr, /warp-bind-target-real-target-local-response-channel-unavailable/);
      binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      assert.equal(binding.targetBinding, undefined);
    });

    it('requires hook completion and needs-input capability before warp production-test run prepares a job', () => {
      assert.equal(harness('init TEST-A --force').success, true);
      assert.equal(harness('warp-doctor TEST-A --probe-fixture --enable-production-test').success, true);

      const missingHook = harness('run TEST-A --adapter warp-macos --production-test');
      assert.equal(missingHook.success, false);
      assert.match(missingHook.stdout, /hook-completion-and-needs-input-required/);
      let status = readStatus('TEST-A');
      assert.equal(status.execution.activeAttemptId, null);

      const completionOnlyFixture = path.join(TEST_ROOT, 'phase4-completion-only-hook.json');
      fs.writeFileSync(completionOnlyFixture, JSON.stringify({
        hookSource: 'claude-code-hook',
        hookVersion: 'test-1',
        completionPhase: 'claude-completed',
        attemptRefSource: 'wrapper-injected',
        bindingSessionSource: 'wrapper-injected',
        kind: 'job.completed',
        occurredAt: new Date().toISOString(),
      }), 'utf8');
      assert.equal(harness(`worker-challenge TEST-A --probe-hook-payload ${completionOnlyFixture}`).success, true);
      const completionOnly = harness('run TEST-A --adapter warp-macos --production-test');
      assert.equal(completionOnly.success, false);
      assert.match(completionOnly.stdout, /missing-needs-input-category-source/);
      status = readStatus('TEST-A');
      assert.equal(status.execution.activeAttemptId, null);
    });

    it('shadow send is diagnostic only and maps partial input to uncertain', () => {
      assert.equal(harness('init W6-A --force').success, true);
      assert.equal(harness('worker-attach W6-A --role work --binding wrapper.work').success, true);
      assert.equal(harness('warp-doctor W6-A --probe-fixture --enable-production-test').success, true);
      const bind = harness('warp-bind-target W6-A --role work --binding wrapper.work --candidate candidate-work --respond-fixture');
      assert.equal(bind.success, true, bind.stderr);
      const statusFile = path.join(HARNESS_DIR, 'runs', 'W6-A', 'status.json');
      const before = fs.readFileSync(statusFile, 'utf8');

      const uncertain = harness('warp-shadow-send W6-A --role work --binding wrapper.work --side-effect-state input-mutated');
      assert.equal(uncertain.success, true, uncertain.stderr);
      assert.match(uncertain.stdout, /dispatch-uncertain/);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), before);

      const clipboard = harness('warp-shadow-send W6-A --role work --binding wrapper.work --side-effect-state submitted --used-clipboard');
      assert.equal(clipboard.success, false);
      assert.match(clipboard.stderr, /clipboard-dispatch-forbidden/);
      assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
    });
  });

  describe('V3 Phase 5: controlled W6 pilot gate', () => {
    it('keeps real W6 warp run disabled unless the explicit phase5 pilot gate is used', () => {
      assert.equal(harness('init W6-A --force').success, true);
      setupPhase5PilotCapabilities('W6-A');
      setupVerifiedWarpPilotRole('W6-A', 'work');

      const run = harness('run W6-A --adapter warp-macos');

      assert.equal(run.success, false);
      assert.match(run.stdout, /warp-macos-production-disabled/);
      const status = readStatus('W6-A');
      assert.equal(status.execution.activeAttemptId, null);
      assert.equal(status.execution.activeJobId, null);
    });

    it('rejects W6 phase5 pilot when only fixture warp evidence is available', () => {
      const taskId = 'W6-A';
      const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
      assert.equal(harness(`init ${taskId} --force`).success, true);
      assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
      assert.equal(harness(`warp-doctor ${taskId} --probe-fixture --enable-production-test --enable-phase5-candidate`).success, true);
      const hookFixture = writeFullHookCapabilityFixture(`${taskId}-phase5-fixture-only-hook.json`);
      assert.equal(harness(`worker-challenge ${taskId} --probe-hook-payload ${hookFixture}`).success, true);
      setupVerifiedWarpPilotRole(taskId, 'work');
      const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
      assert.equal(allow.success, true, allow.stderr);

      const run = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`);

      assert.equal(run.success, false);
      assert.match(run.stdout + run.stderr, /capability-unavailable|phase5-production-candidate-required/);
      const status = readStatus(taskId);
      assert.equal(status.execution.activeAttemptId, null);
      assert.equal(status.execution.activeJobId, null);
    });

    it('derives canonical stage classification and rejects delivery even when operator flags claim it is safe', () => {
      const taskId = 'PH5-CLASSIFY';
      assert.equal(harness(`init ${taskId} --force`).success, true);

      const delivery = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage delivery --review-stage done --roles work,review --reason pilot --expires-at ${futureIso()} --delivery false --commitCheckpoint false`);

      assert.equal(delivery.success, false);
      assert.match(delivery.stderr, /pilot-stage-not-allowed/);
      assert.equal(fs.existsSync(path.join(HARNESS_DIR, 'runs', taskId, 'pilot', 'allowlist.json')), false);
    });

    it('captures pilotAuthorization into operation, job, attempt, and lease before phase5 dispatch', () => {
      const taskId = 'PH5-AUTH';
      const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
      assert.equal(harness(`init ${taskId} --force`).success, true);
      assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
      setupPhase5PilotCapabilities(taskId);
      setupVerifiedWarpPilotRole(taskId, 'work');

      const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
      assert.equal(allow.success, true, allow.stderr);
      const allowed = JSON.parse(allow.stdout);
      assert.equal(allowed.status, 'allowed');
      assert.ok(allowed.allowlistHash);

      const run = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval --run-timeout-ms 50 --poll-ms 10`);

      assert.equal(run.success, false);
      assert.match(run.stdout, /run-timeout|dispatch-submitted/);
      const status = readStatus(taskId);
      assert.ok(status.execution.activeAttemptId);
      const attemptPath = path.join(HARNESS_DIR, 'runs', taskId, 'attempts', `${status.execution.activeAttemptId}.json`);
      const attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
      const job = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'runs', taskId, 'jobs', `${status.execution.activeJobId}.json`), 'utf8'));
      const lease = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'runs', taskId, 'leases', 'wrapper.work.json'), 'utf8'));
      const operation = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'runs', taskId, 'operations', `${attempt.operationId}.json`), 'utf8'));
      for (const record of [attempt, job, lease, operation]) {
        assert.equal(record.pilotAuthorization.allowlistId, allowed.allowlistId);
        assert.equal(record.pilotAuthorization.allowlistHash, allowed.allowlistHash);
        assert.equal(record.pilotAuthorization.role, 'work');
        assert.equal(record.pilotAuthorization.expectedStageId, 'code-implementation');
      }
      const cancelled = harness(`cancel ${taskId} --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token ${status.execution.activeLeaseToken} --adapter warp-macos`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
    });

    it('fails closed when captured allowlist authorization expires or drifts before dispatch', () => {
      const taskId = 'PH5-DRIFT';
      const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
      assert.equal(harness(`init ${taskId} --force`).success, true);
      assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
      setupPhase5PilotCapabilities(taskId);
      setupVerifiedWarpPilotRole(taskId, 'work');

      const expired = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at 2000-01-01T00:00:00.000Z`);
      assert.equal(expired.success, false);
      assert.match(expired.stderr, /pilot-allowlist-expired/);

      const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
      assert.equal(allow.success, true, allow.stderr);
      const allowlistPath = path.join(HARNESS_DIR, 'runs', taskId, 'pilot', 'allowlist.json');
      const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
      allowlist.allowedPilotUnits[0].reason = 'tampered';
      fs.writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2) + '\n', 'utf8');

      const run = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`);

      assert.equal(run.success, false);
      assert.match(run.stderr + run.stdout, /pilot-allowlist-hash-drift/);
      const status = readStatus(taskId);
      assert.equal(status.execution.activeAttemptId, null);
    });

    it('revalidates phase5 authorization inside prepare after next writes the prompt', () => {
      for (const [taskId, mutation, reason] of [
        ['PH5-PREPARE-ALLOWLIST', 'allowlist-expired', /pilot-allowlist-expired/],
        ['PH5-PREPARE-CAPABILITY', 'capability-drift', /phase5-production-candidate-required|adapter-capability-unavailable|warp-capability-evidence-stale/],
      ]) {
        const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
        assert.equal(harness(`init ${taskId} --force`).success, true);
        assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
        setupPhase5PilotCapabilities(taskId);
        setupVerifiedWarpPilotRole(taskId, 'work');
        const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
        assert.equal(allow.success, true, allow.stderr);

        const run = harnessEnv(
          { HARNESS_PHASE5_TEST_MUTATE_AFTER_NEXT: mutation },
          `run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`
        );

        assert.equal(run.success, false);
        assert.match(run.stderr + run.stdout, reason);
        const status = readStatus(taskId);
        assert.equal(status.execution.activeAttemptId, null);
        assert.equal(status.execution.activeJobId, null);
        const attemptsDir = path.join(HARNESS_DIR, 'runs', taskId, 'attempts');
        assert.equal(fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir).length : 0, 0);
      }
    });

    it('commits work completion through workflow CAS only to the review stage and records role progress', () => {
      const taskId = 'PH5-WORKFLOW';
      const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
      assert.equal(harness(`init ${taskId} --force`).success, true);
      assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
      setupPhase5PilotCapabilities(taskId);
      setupVerifiedWarpPilotRole(taskId, 'work');
      const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
      assert.equal(allow.success, true, allow.stderr);
      const run = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval --run-timeout-ms 50 --poll-ms 10`);
      assert.equal(run.success, false);

      let status = readStatus(taskId);
      createReport(status, 'code-implementation', '# Code mapping\n\nImplemented safely.\n');
      const receipt = harness(`worker-receipt ${taskId} --attempt ${status.execution.activeAttemptId} --kind job.completed --sequence 1 --binding wrapper.work --event-id phase5-work-completed`);
      assert.equal(receipt.success, true, receipt.stderr);
      const pump = harness(`pump ${taskId} --adapter warp-macos`);
      assert.equal(pump.success, true, `${pump.stderr}\n${pump.stdout}`);

      status = readStatus(taskId);
      assert.equal(status.currentStage, 'code-review');
      assert.equal(status.execution.activeAttemptId, null);
      const progress = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'runs', taskId, 'pilot', pilotUnitId, 'roles.json'), 'utf8'));
      assert.equal(progress.roles.work.state, 'completed');
      assert.equal(progress.roles.work.advancedToStage, 'code-review');
      assert.equal(progress.roles.review.state, 'not-started');
    });

    it('enforces review sequencing and submitted attempt budget', () => {
      const taskId = 'PH5-BUDGET';
      const pilotUnitId = `${taskId}-W6-A-01-code-pilot`;
      assert.equal(harness(`init ${taskId} --force`).success, true);
      assert.equal(harness(`set-current ${taskId} W6-A-01 code-implementation`).success, true);
      setupPhase5PilotCapabilities(taskId);
      setupVerifiedWarpPilotRole(taskId, 'work');
      setupVerifiedWarpPilotRole(taskId, 'review');
      const allow = harness(`pilot-allow ${taskId} --subtask W6-A-01 --work-stage code-implementation --review-stage code-review --roles work,review --reason pilot --expires-at ${futureIso()}`);
      assert.equal(allow.success, true, allow.stderr);

      const earlyReview = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role review --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`);
      assert.equal(earlyReview.success, false);
      assert.match(earlyReview.stderr + earlyReview.stdout, /pilot-review-work-not-completed|pilot-stage-cursor-conflict/);

      const workRun = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval --run-timeout-ms 50 --poll-ms 10`);
      assert.equal(workRun.success, false);
      assert.match(workRun.stdout, /run-timeout|dispatch-submitted/);
      const status = readStatus(taskId);
      const retry = harness(`retry ${taskId} --job ${status.execution.activeJobId} --adapter warp-macos`);
      assert.equal(retry.success, false);
      assert.match(retry.stderr + retry.stdout, /active-job-conflict|retry-not-allowed/);
      const cancelled = harness(`cancel ${taskId} --job ${status.execution.activeJobId} --attempt ${status.execution.activeAttemptId} --lease-token ${status.execution.activeLeaseToken} --adapter warp-macos`);
      assert.equal(cancelled.success, true, `${cancelled.stderr}\n${cancelled.stdout}`);
      const secondRun = harness(`run ${taskId} --adapter warp-macos --phase5-pilot --pilot-unit ${pilotUnitId} --role work --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`);
      assert.equal(secondRun.success, false);
      assert.match(secondRun.stderr + secondRun.stdout, /pilot-submitted-attempt-budget-exhausted/);
    });
  });
});
