import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionStore } from '../scripts/execution-store.js';
import { ExecutionSupervisor } from '../scripts/execution-supervisor.js';
import { FakeWorkerAdapter } from '../scripts/execution-protocol.js';

const baseStatus = () => ({
  schemaVersion: 4,
  stateRevision: 0,
  stageRevision: 2,
  currentSubtask: 'W9-A-01',
  currentStage: 'code-implementation',
  execution: {
    mode: 'worker',
    activeJobId: null,
    activeAttemptId: null,
    activeLeaseToken: null,
    lockEpoch: 0,
    lastJobId: null,
  },
  history: [],
});

class MemoryStatusStore {
  constructor(status = baseStatus()) {
    this.status = structuredClone(status);
    this.saves = 0;
  }
  load() { return structuredClone(this.status); }
  saveCas(expectedRevision, nextStatus) {
    if (this.status.stateRevision !== expectedRevision) throw new Error('state-cas-conflict');
    this.status = structuredClone(nextStatus);
    this.status.stateRevision = expectedRevision + 1;
    this.saves += 1;
    return this.load();
  }
}

const makeHarness = ({ adapter, workflow, status = baseStatus() } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-supervisor-'));
  const store = new ExecutionStore({ harnessRoot: root, taskId: 'W9-A' });
  const statusStore = new MemoryStatusStore(status);
  const effectiveAdapter = adapter || new FakeWorkerAdapter({
    targets: [{ bindingId: 'fake.work', role: 'work' }],
  });
  const supervisor = new ExecutionSupervisor({
    taskId: 'W9-A', store, statusStore, adapter: effectiveAdapter,
    workflow: workflow || {
      evaluate() { return { pass: false, reasons: ['output-not-fresh'] }; },
      derive() { throw new Error('derive should not run'); },
    },
  });
  return { root, store, statusStore, adapter: effectiveAdapter, supervisor };
};

const jobInput = {
  taskId: 'W9-A',
  subtaskId: 'W9-A-01',
  stage: 'code-implementation',
  round: 1,
  expectedStageRevision: 2,
  role: 'work',
  targetBinding: 'fake.work',
  promptPath: '/tmp/prompt.md',
  promptSha256: 'prompt-hash',
  primaryReportPath: '/tmp/report.md',
  outputBaseline: { exists: false, size: 0, mtimeMs: 0, sha256: '' },
};

describe('V3 Phase 2 execution supervisor', () => {
  it('fails closed before prepare when target resolution is missing, duplicate, or role-mismatched', async () => {
    for (const targets of [
      [],
      [{ bindingId: 'fake.work', role: 'work' }, { bindingId: 'fake.work', role: 'work' }],
      [{ bindingId: 'fake.work', role: 'review' }],
    ]) {
      const adapter = new FakeWorkerAdapter({ targets });
      const { supervisor, store, statusStore } = makeHarness({ adapter });
      await assert.rejects(() => supervisor.prepare(jobInput), /target-resolution-failed/);
      assert.equal(store.listOperations().length, 0);
      assert.equal(statusStore.saves, 0);
    }
  });

  it('durably prepares one job, attempt, pending lease, and status commit', async () => {
    const { supervisor, store, statusStore } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);

    assert.equal(store.readOperation(prepared.operationId).phase, 'committed');
    assert.equal(store.readJob(prepared.job.jobId).executionState, 'prepared');
    assert.equal(store.readAttempt(prepared.attempt.attemptId).transportState, 'prepared');
    assert.equal(store.readLease('fake.work').state, 'active');
    assert.equal(statusStore.status.execution.activeAttemptId, prepared.attempt.attemptId);
  });

  it('persists dispatching before the fake adapter reports submitted', async () => {
    const { supervisor, store } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    const result = await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });

    assert.equal(result.status, 'dispatch-submitted');
    const attempt = store.readAttempt(prepared.attempt.attemptId);
    assert.equal(attempt.transportState, 'submitted');
    assert.equal(attempt.dispatchingPersisted, true);
  });

  it('keeps transport-in-flight after timeout until a settle barrier confirms quiescence', async () => {
    let resolveDispatch;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch: () => new Promise(resolve => { resolveDispatch = resolve; }),
        settle: () => ({ settled: false, outcome: 'unknown' }),
      },
    });
    const { supervisor, store } = makeHarness({ adapter });
    const prepared = await supervisor.prepare(jobInput);
    const timedOut = await supervisor.dispatch(prepared.operationId, { timeoutMs: 5 });

    assert.equal(timedOut.status, 'dispatch-uncertain');
    assert.equal(store.readAttempt(prepared.attempt.attemptId).transportState, 'transport-in-flight');
    assert.throws(
      () => supervisor.reconcileNotSent(prepared.attempt.attemptId, {
        confirmTargetQuiescent: true,
        confirmPromptNotVisible: true,
        confirmPromptNotRunning: true,
        reason: 'probe',
        residualRisk: 'late callback possible',
      }),
      /transport-not-quiesced/
    );
    assert.ok(store.readLease('fake.work'));
    resolveDispatch({ status: 'dispatch-submitted', submitted: true });
  });

  it('fences a late dispatch result to its original operation and attempt', async () => {
    let resolveDispatch;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch: () => new Promise(resolve => { resolveDispatch = resolve; }),
        settle: () => ({ settled: false, outcome: 'unknown' }),
      },
    });
    const { supervisor, store } = makeHarness({ adapter });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 5 });
    store.writeAttempt({ ...store.readAttempt(prepared.attempt.attemptId), state: 'abandon-pending-settle' });

    resolveDispatch({ status: 'dispatch-submitted', submitted: true });
    await new Promise(resolve => setTimeout(resolve, 10));

    const attempt = store.readAttempt(prepared.attempt.attemptId);
    assert.equal(attempt.state, 'abandon-pending-settle');
    assert.equal(attempt.lateTransportResult.status, 'dispatch-submitted');
  });

  it('finalizes completion evidence while keeping active refs when output is not ready', async () => {
    const { supervisor, store, statusStore } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const receipt = {
      protocolVersion: 1,
      eventId: 'event-complete',
      jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId,
      leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed',
      sequence: 1,
      occurredAt: new Date().toISOString(),
      source: 'fake-adapter',
      details: {},
    };
    store.publishReceipt(receipt);
    const savesBeforePump = statusStore.saves;
    const result = await supervisor.pumpOnce();

    assert.equal(result.status, 'check-blocked');
    assert.equal(store.listReceipts('processed').length, 1);
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'check-blocked');
    assert.equal(statusStore.saves, savesBeforePump);
    assert.equal(statusStore.status.execution.activeAttemptId, prepared.attempt.attemptId);
  });

  it('uses persisted completion evidence to commit workflow exactly once when output arrives later', async () => {
    let outputReady = false;
    const workflow = {
      evaluate() {
        return outputReady
          ? { pass: true, primarySha256: 'fresh-hash', checkEvidence: { passed: true } }
          : { pass: false, reasons: ['output-not-fresh'] };
      },
      derive(status, evaluation) {
        const next = structuredClone(status);
        next.currentStage = 'code-review';
        next.stageRevision += 1;
        return { nextStatus: next, postCursor: { stage: 'code-review' }, evaluation };
      },
    };
    const { supervisor, store, statusStore } = makeHarness({ workflow });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    store.publishReceipt({
      protocolVersion: 1, eventId: 'event-complete', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });
    await supervisor.pumpOnce();
    const savesAfterFailure = statusStore.saves;
    outputReady = true;

    const committed = await supervisor.pumpOnce();
    const replay = await supervisor.pumpOnce();

    assert.equal(committed.status, 'workflow-completed');
    assert.equal(replay.status, 'idle');
    assert.equal(statusStore.saves, savesAfterFailure + 1);
    assert.equal(statusStore.status.currentStage, 'code-review');
    assert.equal(statusStore.status.execution.activeJobId, null);
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'workflow-completed');
  });
});
