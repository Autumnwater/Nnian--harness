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

const makeSupervisor = ({ store, statusStore, adapter, workflow, faultInjector }) => new ExecutionSupervisor({
  taskId: 'W9-A', store, statusStore, adapter, faultInjector,
  workflow: workflow || {
    evaluate() { return { pass: false, reasons: ['output-not-fresh'] }; },
    derive() { throw new Error('derive should not run'); },
  },
});

const makeAsyncMutex = () => {
  let tail = Promise.resolve();
  return async callback => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };
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

  it('recovers every dispatch prepare crash boundary by rollback or roll-forward', async () => {
    for (const crashPoint of [
      'after-operation-intent',
      'after-job-write',
      'after-attempt-write',
      'after-lease-write',
      'after-status-commit',
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-'));
      const store = new ExecutionStore({ harnessRoot: root, taskId: 'W9-A' });
      const statusStore = new MemoryStatusStore();
      const adapter = new FakeWorkerAdapter({ targets: [{ bindingId: 'fake.work', role: 'work' }] });
      let crashed = false;
      const supervisor = makeSupervisor({
        store, statusStore, adapter,
        faultInjector(point) {
          if (!crashed && point === crashPoint) {
            crashed = true;
            throw new Error(`crash:${point}`);
          }
        },
      });
      await assert.rejects(() => supervisor.prepare(jobInput), new RegExp(`crash:${crashPoint}`));

      const restarted = makeSupervisor({ store, statusStore, adapter });
      const recovery = restarted.recoverOperations();
      const operation = store.listOperations()[0];
      if (crashPoint === 'after-status-commit') {
        assert.equal(recovery.rolledForward, 1);
        assert.equal(operation.phase, 'committed');
        assert.ok(store.readJob(operation.attemptRef.jobId));
        assert.ok(store.readAttempt(operation.attemptRef.attemptId));
        assert.equal(store.readLease(operation.bindingId).state, 'active');
        assert.equal(statusStore.status.execution.activeAttemptId, operation.attemptRef.attemptId);
      } else {
        assert.equal(recovery.rolledBack, 1);
        assert.equal(operation.phase, 'rolled-back');
        assert.equal(store.readLease(operation.bindingId), null);
        assert.equal(statusStore.status.execution.activeAttemptId, null);
      }
    }
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

  it('classifies only proven pre-side-effect dispatch failures as retryable', async () => {
    const safeError = message => Object.assign(new Error(message), { safeBeforeSideEffect: true });
    for (const dispatch of [
      () => { throw safeError('sync-preflight'); },
      () => Promise.reject(safeError('async-preflight')),
      () => ({ status: 'dispatch-rejected', safeBeforeSideEffect: true, outcome: 'failed-before-side-effect' }),
    ]) {
      const adapter = new FakeWorkerAdapter({ targets: [{ bindingId: 'fake.work', role: 'work' }] });
      adapter.dispatch = dispatch;
      const { supervisor, store, statusStore } = makeHarness({ adapter });
      const prepared = await supervisor.prepare(jobInput);
      const result = await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
      assert.equal(result.status, 'failed-before-dispatch');
      const failed = store.readAttempt(prepared.attempt.attemptId);
      assert.equal(failed.state, 'failed-before-dispatch');
      assert.equal(failed.dispatchingPersisted, false);
      assert.equal(failed.transportState, 'quiesced');
      assert.equal(statusStore.status.execution.activeAttemptId, null);
      assert.equal((await supervisor.retry(prepared.job.jobId)).status, 'retry-prepared');
    }

    let calls = 0;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch() {
          calls += 1;
          return calls === 1
            ? { status: 'dispatch-rejected', safeBeforeSideEffect: true, outcome: 'failed-before-side-effect' }
            : { status: 'dispatch-submitted', submitted: true };
        },
      },
    });
    const harness = makeHarness({ adapter });
    const first = await harness.supervisor.prepare(jobInput);
    assert.equal((await harness.supervisor.dispatch(first.operationId, { timeoutMs: 100 })).status, 'failed-before-dispatch');
    const retried = await harness.supervisor.retry(first.job.jobId);
    assert.equal((await harness.supervisor.dispatch(retried.operationId, { timeoutMs: 100 })).status, 'dispatch-submitted');

    const ambiguousAdapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: { dispatch: () => Promise.reject(new Error('unknown-side-effect')) },
    });
    const ambiguous = makeHarness({ adapter: ambiguousAdapter });
    const prepared = await ambiguous.supervisor.prepare(jobInput);
    assert.equal((await ambiguous.supervisor.dispatch(prepared.operationId, { timeoutMs: 100 })).status, 'dispatch-uncertain');
    assert.equal(ambiguous.store.readAttempt(prepared.attempt.attemptId).state, 'dispatch-uncertain');
    await assert.rejects(() => ambiguous.supervisor.retry(prepared.job.jobId), /active-job-conflict/);
  });

  it('allows only one concurrent caller to claim and invoke adapter dispatch', async () => {
    let dispatchCalls = 0;
    let resolveDispatch;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch() {
          dispatchCalls += 1;
          return new Promise(resolve => { resolveDispatch = resolve; });
        },
      },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dispatch-lock-'));
    const store = new ExecutionStore({ harnessRoot: root, taskId: 'W9-A' });
    const statusStore = new MemoryStatusStore();
    const transaction = makeAsyncMutex();
    const supervisor = new ExecutionSupervisor({
      taskId: 'W9-A', store, statusStore, adapter, transaction,
      workflow: { evaluate: () => ({ pass: false }), derive: () => null },
    });
    const prepared = await supervisor.prepare(jobInput);

    const first = supervisor.dispatch(prepared.operationId, { timeoutMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await supervisor.dispatch(prepared.operationId, { timeoutMs: 1000 });
    assert.equal(second.status, 'already-dispatching');
    assert.equal(dispatchCalls, 1);
    resolveDispatch({ status: 'dispatch-submitted', submitted: true });
    assert.equal((await first).status, 'dispatch-submitted');
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

  it('resumes the settle barrier from pump after a supervisor restart', async () => {
    let settleReady = false;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch: () => new Promise(() => {}),
        settle: () => settleReady
          ? ({ settled: true, outcome: 'aborted-before-side-effect' })
          : ({ settled: false, outcome: 'unknown' }),
      },
    });
    const { supervisor, store, statusStore } = makeHarness({ adapter });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 5 });
    const restarted = makeSupervisor({ store, statusStore, adapter });

    assert.equal((await restarted.pumpOnce()).status, 'transport-in-flight');
    settleReady = true;
    await restarted.pumpOnce();

    const attempt = store.readAttempt(prepared.attempt.attemptId);
    assert.equal(attempt.transportState, 'quiesced');
    assert.equal(attempt.transportOutcome, 'aborted-before-side-effect');
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

  it('replays a receipt after crashing between attempt and job evidence writes', async () => {
    const { store, statusStore, adapter } = makeHarness();
    let crash = false;
    const supervisor = makeSupervisor({
      store, statusStore, adapter,
      faultInjector(point) {
        if (crash && point === 'after-receipt-attempt-write') {
          crash = false;
          throw new Error('receipt-write-crash');
        }
      },
    });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const receipt = {
      protocolVersion: 1, eventId: 'event-complete', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    };
    store.publishReceipt(receipt);
    crash = true;
    await assert.rejects(() => supervisor.pumpOnce(), /receipt-write-crash/);

    const restarted = makeSupervisor({ store, statusStore, adapter });
    const result = await restarted.pumpOnce();

    assert.equal(result.status, 'check-blocked');
    assert.equal(store.readAttempt(prepared.attempt.attemptId).lastSequence, 1);
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'check-blocked');
    assert.equal(store.listReceipts('processed').length, 1);
  });

  it('rejects an invalid receipt without blocking the next valid event', async () => {
    const { supervisor, store } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const common = {
      jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId,
      leaseToken: prepared.attempt.leaseToken,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      source: 'fake',
      details: {},
    };
    store.publishReceipt({ ...common, protocolVersion: 99, eventId: 'a-invalid', kind: 'job.completed' });
    store.publishReceipt({ ...common, protocolVersion: 1, eventId: 'b-valid', kind: 'job.completed' });

    const result = await supervisor.pumpOnce();

    assert.equal(result.status, 'check-blocked');
    assert.equal(store.listReceipts('rejected').length, 1);
    assert.equal(store.listReceipts('processed').length, 1);
    assert.equal(store.readReceiptApplication(prepared.attempt.attemptId, 'a-invalid').reason, 'invalid-protocol-version');
  });

  it('keeps a sequence gap pending and rejects duplicate and stale sequences', async () => {
    const { supervisor, store } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const makeReceipt = (eventId, sequence, kind = 'job.running') => ({
      protocolVersion: 1, eventId, jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind, sequence, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });
    store.publishReceipt(makeReceipt('gap-2', 2));
    assert.equal((await supervisor.pumpOnce()).status, 'sequence-gap');
    assert.equal(store.listReceipts('inbox').length, 1);

    store.publishReceipt(makeReceipt('first-1', 1));
    await supervisor.pumpOnce();
    assert.equal(store.listReceipts('processed').length, 2);
    store.publishReceipt(makeReceipt('duplicate-2', 2));
    store.publishReceipt(makeReceipt('stale-1', 1));
    await supervisor.pumpOnce();

    const reasons = store.listReceipts('rejected')
      .map(item => store.readReceiptApplication(item.receipt.attemptId, item.receipt.eventId).reason)
      .sort();
    assert.deepEqual(reasons, ['duplicate-sequence', 'stale-sequence']);
  });

  it('rejects a receipt whose occurredAt exceeds the allowed clock skew', async () => {
    const { supervisor, store } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    store.publishReceipt({
      protocolVersion: 1, eventId: 'future', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed', sequence: 1,
      occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(), source: 'fake', details: {},
    });

    await supervisor.pumpOnce();

    assert.equal(store.listReceipts('rejected').length, 1);
    assert.equal(store.readReceiptApplication(prepared.attempt.attemptId, 'future').reason, 'occurred-at-in-future');
  });

  it('terminalizes a failed receipt and releases the matching active lease', async () => {
    const { supervisor, store, statusStore } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    store.publishReceipt({
      protocolVersion: 1, eventId: 'worker-failed', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.failed', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });

    const result = await supervisor.pumpOnce();

    assert.equal(result.status, 'failed');
    assert.equal(statusStore.status.execution.activeAttemptId, null);
    assert.equal(store.readAttempt(prepared.attempt.attemptId).state, 'failed');
    assert.equal(store.readLease('fake.work'), null);
    assert.equal(store.listReceipts('processed').length, 1);
  });

  it('rejects wrong-lease and stale-epoch receipts without advancing workflow', async () => {
    const { supervisor, store, statusStore } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    store.publishReceipt({
      protocolVersion: 1, eventId: 'wrong-lease', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: 'wrong', kind: 'job.completed',
      sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });
    await supervisor.pumpOnce();
    assert.equal(store.readReceiptApplication(prepared.attempt.attemptId, 'wrong-lease').reason, 'attempt-ref-mismatch');
    assert.equal(statusStore.status.currentStage, 'code-implementation');

    statusStore.status.execution.lockEpoch += 1;
    store.publishReceipt({
      protocolVersion: 1, eventId: 'old-epoch', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken, kind: 'job.completed',
      sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });
    await supervisor.pumpOnce();
    assert.equal(store.readReceiptApplication(prepared.attempt.attemptId, 'old-epoch').reason, 'fenced-lock-epoch');
    assert.equal(statusStore.status.currentStage, 'code-implementation');
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'pending');
  });

  it('archives malformed JSON and an eventId payload collision without stopping the pump', async () => {
    const { supervisor, store } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const receipt = {
      protocolVersion: 1, eventId: 'same-event', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.running', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    };
    store.publishReceipt(receipt);
    await supervisor.pumpOnce();
    store.publishReceipt({ ...receipt, kind: 'job.completed', sequence: 2 });
    const malformedPath = store.receiptPath('inbox', prepared.attempt.attemptId, 'malformed');
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
    fs.writeFileSync(malformedPath, '{bad-json');

    await supervisor.pumpOnce();

    assert.equal(store.listReceipts('inbox').length, 0);
    assert.equal(store.listReceipts('rejected').length, 2);
    const applications = fs.readdirSync(path.join(store.paths.applications, prepared.attempt.attemptId));
    assert.ok(applications.some(name => name.startsWith('same-event.collision-')));
    assert.equal(store.readReceiptApplication(prepared.attempt.attemptId, 'malformed').reason, 'malformed-json');
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

  it('cancels with a full AttemptRef and fences stale cancellation', async () => {
    const { supervisor, store, statusStore } = makeHarness();
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    const ref = {
      jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId,
      leaseToken: prepared.attempt.leaseToken,
    };

    await assert.rejects(
      () => supervisor.cancel({ ...ref, leaseToken: 'stale-token' }),
      /attempt-fence-conflict/
    );
    const cancelled = await supervisor.cancel(ref);

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(store.readAttempt(ref.attemptId).state, 'cancelled');
    assert.equal(statusStore.status.execution.activeAttemptId, null);
    assert.equal(store.readLease('fake.work'), null);
    assert.equal((await supervisor.cancel(ref)).status, 'already-terminal');
  });

  it('requires uncertain adjudication evidence and only retries a quiesced not-sent attempt', async () => {
    let resolveDispatch;
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
      dispatchController: {
        dispatch: () => new Promise(resolve => { resolveDispatch = resolve; }),
        settle: () => ({ settled: false, outcome: 'unknown' }),
      },
    });
    const { supervisor, store, statusStore } = makeHarness({ adapter });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 5 });

    await assert.rejects(() => supervisor.takeover('manual work'), /reconcile-required/);
    await assert.rejects(
      () => supervisor.reconcile(prepared.attempt.attemptId, 'not-sent', { reason: 'checked', residualRisk: 'low' }),
      /transport-not-quiesced/
    );
    const uncertain = store.readAttempt(prepared.attempt.attemptId);
    store.writeAttempt({ ...uncertain, transportState: 'quiesced', transportOutcome: 'aborted-before-side-effect' });
    const reconciled = await supervisor.reconcile(prepared.attempt.attemptId, 'not-sent', {
      confirmTargetQuiescent: true,
      confirmPromptNotVisible: true,
      confirmPromptNotRunning: true,
      reason: 'target inspected',
      residualRisk: 'accessibility state may lag',
      operator: 'test',
    });
    assert.equal(reconciled.status, 'reconciled-not-sent');
    assert.equal(statusStore.status.execution.activeAttemptId, null);

    const retried = await supervisor.retry(prepared.job.jobId);
    assert.notEqual(retried.attempt.attemptId, prepared.attempt.attemptId);
    assert.equal(statusStore.status.execution.activeAttemptId, retried.attempt.attemptId);
    assert.deepEqual(store.readJob(prepared.job.jobId).attemptIds, [prepared.attempt.attemptId, retried.attempt.attemptId]);
    store.publishReceipt({
      protocolVersion: 1, eventId: 'late-old-completion', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });
    await supervisor.pumpOnce();
    assert.equal(
      store.readReceiptApplication(prepared.attempt.attemptId, 'late-old-completion').reason,
      'superseded-attempt'
    );
    assert.equal(statusStore.status.execution.activeAttemptId, retried.attempt.attemptId);
    resolveDispatch({ status: 'dispatch-error' });
  });

  it('recovers terminal records after a crash immediately following workflow status CAS', async () => {
    let crash = true;
    const workflow = {
      evaluate: () => ({ pass: true, primarySnapshot: { sha256: 'fresh', size: 1 } }),
      derive(status) {
        const nextStatus = structuredClone(status);
        nextStatus.currentStage = 'code-review';
        nextStatus.stageRevision += 1;
        return { nextStatus, postCursor: { stage: 'code-review' } };
      },
    };
    const { store, statusStore, adapter } = makeHarness({ workflow });
    const supervisor = makeSupervisor({
      store, statusStore, adapter, workflow,
      faultInjector(point) {
        if (crash && point === 'after-workflow-status-cas') {
          crash = false;
          throw new Error('crash-after-workflow-cas');
        }
      },
    });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    store.publishReceipt({
      protocolVersion: 1, eventId: 'complete-crash', jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId, leaseToken: prepared.attempt.leaseToken,
      kind: 'job.completed', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {},
    });

    await assert.rejects(() => supervisor.pumpOnce(), /crash-after-workflow-cas/);
    const restarted = makeSupervisor({ store, statusStore, adapter, workflow });
    assert.equal((await restarted.pumpOnce()).status, 'idle');
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'workflow-completed');
    assert.equal(store.readAttempt(prepared.attempt.attemptId).workflowState, 'workflow-completed');
    assert.equal(store.readLease('fake.work'), null);
    assert.equal(store.readOperation(prepared.operationId).phase, 'workflow-completed');
  });

  it('recovers cancellation records after a crash immediately following terminal status CAS', async () => {
    let crash = true;
    const { store, statusStore, adapter } = makeHarness();
    const supervisor = makeSupervisor({
      store, statusStore, adapter,
      faultInjector(point) {
        if (crash && point === 'after-terminal-status-cas') {
          crash = false;
          throw new Error('crash-after-terminal-cas');
        }
      },
    });
    const prepared = await supervisor.prepare(jobInput);
    await supervisor.dispatch(prepared.operationId, { timeoutMs: 100 });
    await assert.rejects(() => supervisor.cancel({
      jobId: prepared.job.jobId,
      attemptId: prepared.attempt.attemptId,
      leaseToken: prepared.attempt.leaseToken,
    }), /crash-after-terminal-cas/);

    const restarted = makeSupervisor({ store, statusStore, adapter });
    restarted.recoverOperations();
    assert.equal(store.readAttempt(prepared.attempt.attemptId).state, 'cancelled');
    assert.equal(store.readJob(prepared.job.jobId).workflowState, 'cancelled');
    assert.equal(store.readLease('fake.work'), null);
    assert.equal(store.readOperation(prepared.operationId).phase, 'cancelled');
  });
});
