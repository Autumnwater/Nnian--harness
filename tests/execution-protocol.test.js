import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeWorkerAdapter,
  ManualWorkerAdapter,
  STATUS_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  assertAttemptRef,
  assertStageCursor,
  canAutomaticallyRetryAttempt,
  createAttempt,
  createEvent,
  createJob,
  createLease,
  createStageCursor,
  markDispatchUncertain,
  migrateExecutionState,
} from '../scripts/execution-protocol.js';

describe('V3 Phase 1 execution protocol', () => {
  it('migrates schema 3 status to schema 4 in manual mode', () => {
    const status = { schemaVersion: 3 };

    const migrated = migrateExecutionState(status);

    assert.equal(migrated, true);
    assert.equal(status.schemaVersion, STATUS_SCHEMA_VERSION);
    assert.equal(status.stateRevision, 0);
    assert.equal(status.stageRevision, 0);
    assert.deepEqual(status.execution, {
      mode: 'manual',
      activeJobId: null,
      activeAttemptId: null,
      activeLeaseToken: null,
      lockEpoch: 0,
      lastJobId: null,
    });
  });

  it('does not overwrite existing V3 execution state during migration', () => {
    const status = {
      schemaVersion: 4,
      stateRevision: 7,
      stageRevision: 3,
      execution: {
        mode: 'worker',
        activeJobId: 'job-1',
        activeAttemptId: 'attempt-1',
        activeLeaseToken: 'attempt-1:2:token',
        lockEpoch: 2,
        lastJobId: 'job-0',
      },
    };

    assert.equal(migrateExecutionState(status), false);
    assert.equal(status.execution.activeAttemptId, 'attempt-1');
    assert.equal(status.stageRevision, 3);
  });

  it('rejects a future status schema instead of rewriting it', () => {
    assert.throws(
      () => migrateExecutionState({ schemaVersion: STATUS_SCHEMA_VERSION + 1 }),
      /Unsupported status schemaVersion/
    );
  });

  it('rejects invalid schema 4 execution field types', () => {
    assert.throws(
      () => migrateExecutionState({ schemaVersion: 3.5 }),
      /schemaVersion must be a positive integer/
    );
    assert.throws(
      () => migrateExecutionState({
        schemaVersion: 4,
        stateRevision: 0,
        stageRevision: 0,
        execution: { mode: 'auto' },
      }),
      /execution.mode must be manual or worker/
    );
    assert.throws(
      () => migrateExecutionState({
        schemaVersion: 4,
        stateRevision: 0,
        stageRevision: 0,
        execution: { mode: 'manual', lockEpoch: -1 },
      }),
      /execution.lockEpoch must be a non-negative integer/
    );
    assert.throws(
      () => migrateExecutionState({
        schemaVersion: 4,
        stateRevision: 0,
        stageRevision: 0,
        execution: { mode: 'manual', lockEpoch: 0, activeJobId: 42 },
      }),
      /execution.activeJobId must be null or a non-empty string/
    );
  });

  it('rejects incomplete schema 4 state instead of filling defaults', () => {
    for (const status of [
      { schemaVersion: 4 },
      { schemaVersion: 4, stateRevision: 0 },
      { schemaVersion: 4, stateRevision: 0, stageRevision: 0 },
      { schemaVersion: 4, stateRevision: 0, stageRevision: 0, execution: null },
      { schemaVersion: 4, stateRevision: 0, stageRevision: 0, execution: [] },
    ]) {
      assert.throws(() => migrateExecutionState(status), /required|execution must be an object/);
    }
    assert.throws(
      () => migrateExecutionState({
        schemaVersion: 4,
        stateRevision: 0,
        stageRevision: 0,
        execution: { mode: 'manual', lockEpoch: 0 },
      }),
      /execution.activeJobId is required/
    );
    const completeExecution = {
      mode: 'manual',
      activeJobId: null,
      activeAttemptId: null,
      activeLeaseToken: null,
      lockEpoch: 0,
      lastJobId: null,
    };
    for (const missingField of ['activeJobId', 'activeAttemptId', 'activeLeaseToken', 'lockEpoch', 'lastJobId']) {
      const execution = { ...completeExecution };
      delete execution[missingField];
      assert.throws(
        () => migrateExecutionState({
          schemaVersion: 4,
          stateRevision: 0,
          stageRevision: 0,
          execution,
        }),
        new RegExp(`execution\\.${missingField} is required`)
      );
    }
  });

  it('requires an exact stage cursor match', () => {
    const expected = {
      subtaskId: 'W6-A-04',
      stage: 'implementation-plan',
      round: 1,
      stageRevision: 4,
      activeAttemptId: 'attempt-1',
    };

    assert.doesNotThrow(() => assertStageCursor(expected, { ...expected }));
    assert.throws(
      () => assertStageCursor(expected, { ...expected, stageRevision: 5 }),
      /stage-cas-conflict/
    );
    assert.throws(
      () => assertStageCursor(expected, { ...expected, activeAttemptId: 'attempt-2' }),
      /stage-cas-conflict/
    );
  });

  it('rejects invalid cursor and protocol numbers', () => {
    for (const invalid of [NaN, Infinity, -1, 1.5]) {
      assert.throws(
        () => createStageCursor({
          subtaskId: 'W6-A-04',
          stage: 'implementation-plan',
          round: invalid,
          stageRevision: 0,
        }),
        /round must be a positive integer/
      );
      assert.throws(
        () => createAttempt({ jobId: 'job-1', lockEpoch: invalid }),
        /lockEpoch must be a non-negative integer/
      );
    }

    const baseJob = {
      taskId: 'W6-A',
      subtaskId: 'W6-A-04',
      stage: 'implementation-plan',
      round: 1,
      expectedStageRevision: 0,
      role: 'work',
      targetBinding: 'fake.work',
      promptPath: '/tmp/prompt.md',
      promptSha256: 'abc',
      primaryReportPath: '/tmp/report.md',
    };
    for (const invalid of [NaN, Infinity, -1, 1.5]) {
      assert.throws(
        () => createJob({ ...baseJob, expectedStageRevision: invalid }),
        /expectedStageRevision must be a non-negative integer/
      );
      assert.throws(
        () => createJob({ ...baseJob, timeoutMs: invalid }),
        /timeoutMs must be a positive integer/
      );
    }

    const attempt = createAttempt({ jobId: 'job-1', lockEpoch: 0 });
    for (const invalid of [NaN, Infinity, 0, -1, 1.5]) {
      assert.throws(
        () => createLease({ bindingId: 'fake.work', attempt, ttlMs: invalid }),
        /ttlMs must be a positive integer/
      );
    }
  });

  it('binds evidence to the exact attempt and lease token', () => {
    const active = { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'attempt-1:2:token' };
    assert.doesNotThrow(() => assertAttemptRef(active, { ...active }));
    assert.throws(
      () => assertAttemptRef(active, { ...active, leaseToken: 'attempt-1:3:other' }),
      /attempt-fence-conflict/
    );
  });

  it('requires manual reconciliation after an uncertain dispatch', () => {
    const uncertain = markDispatchUncertain({
      jobId: 'job-1',
      attemptId: 'attempt-1',
      leaseToken: 'attempt-1:2:token',
      state: 'dispatching',
    }, 'adapter result was ambiguous');

    assert.equal(uncertain.state, 'dispatch-uncertain');
    assert.equal(uncertain.reconciliationRequired, true);
    assert.equal(canAutomaticallyRetryAttempt(uncertain), false);
    assert.equal(canAutomaticallyRetryAttempt({ state: 'unknown' }), false);
    assert.equal(canAutomaticallyRetryAttempt({}), false);
    assert.equal(canAutomaticallyRetryAttempt({
      state: 'failed-before-dispatch',
      dispatchingPersisted: false,
    }), true);
  });

  it('creates fenced job and attempt records', () => {
    const job = createJob({
      taskId: 'W6-A',
      subtaskId: 'W6-A-04',
      stage: 'implementation-plan',
      round: 1,
      expectedStageRevision: 4,
      role: 'work',
      targetBinding: 'warp.work',
      promptPath: '/tmp/prompt.md',
      promptSha256: 'abc',
      primaryReportPath: '/tmp/report.md',
      outputBaseline: { exists: false, size: 0, mtimeMs: 0, sha256: '' },
    });
    const attempt = createAttempt({ jobId: job.jobId, lockEpoch: 3 });

    assert.equal(job.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
    assert.equal(job.expectedStageRevision, 4);
    assert.equal(attempt.jobId, job.jobId);
    assert.ok(attempt.attemptId);
    assert.match(attempt.leaseToken, new RegExp(`^${attempt.attemptId}:3:`));
    assert.equal(attempt.state, 'queued');

    const lease = createLease({
      bindingId: 'fake.work',
      attempt,
      ttlMs: 60_000,
    });
    const event = createEvent({
      kind: 'job.queued',
      source: 'supervisor',
      attempt,
      sequence: 1,
    });
    assert.equal(lease.attemptId, attempt.attemptId);
    assert.equal(lease.leaseToken, attempt.leaseToken);
    assert.ok(lease.expiresAt);
    assert.equal(event.protocolVersion, WORKER_PROTOCOL_VERSION);
    assert.equal(event.attemptId, attempt.attemptId);
    assert.equal(event.leaseToken, attempt.leaseToken);
    assert.equal(event.sequence, 1);
    assert.ok(event.occurredAt);
  });

  it('creates receipts that satisfy the supervisor profile', () => {
    const attempt = createAttempt({ jobId: 'job-1', lockEpoch: 0 });
    const event = createEvent({
      kind: 'job.completed',
      source: 'fake-adapter',
      attempt,
      sequence: 2,
      occurredAt: '2026-06-19T00:00:00.000Z',
    });

    assert.deepEqual(Object.keys(event).sort(), [
      'attemptId', 'details', 'eventId', 'jobId', 'kind', 'leaseToken',
      'occurredAt', 'protocolVersion', 'sequence', 'source',
    ]);
    assert.throws(
      () => createEvent({ kind: 'job.completed', source: 'fake', attempt, sequence: 0 }),
      /sequence must be a positive integer/
    );
  });

  it('manual adapter reports manual-required without dispatch side effects', async () => {
    const adapter = new ManualWorkerAdapter();
    const result = await adapter.dispatch({ jobId: 'job-1' }, { bindingId: 'manual.work' });

    assert.equal(result.status, 'manual-required');
    assert.equal(result.submitted, false);
  });

  it('fake adapter fences stale cancel attempts', async () => {
    const adapter = new FakeWorkerAdapter({
      targets: [{ bindingId: 'fake.work', role: 'work' }],
    });
    const target = (await adapter.discoverTargets())[0];
    const active = {
      jobId: 'job-1',
      attemptId: 'attempt-new',
      leaseToken: 'attempt-new:2:token',
    };
    await adapter.dispatch({ jobId: active.jobId, attempt: active }, target);

    const stale = await adapter.cancel({
      jobId: 'job-1',
      attemptId: 'attempt-old',
      leaseToken: 'attempt-old:1:token',
    }, target);
    assert.equal(stale.status, 'stale-attempt');
    assert.equal(adapter.getActiveAttempt(target.bindingId).attemptId, 'attempt-new');

    const cancelled = await adapter.cancel(active, target);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(adapter.getActiveAttempt(target.bindingId), null);
  });
});
