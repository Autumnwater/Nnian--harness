import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publishClaudeHookReceipt } from '../scripts/claude-hook-publisher.js';
import { ExecutionStore } from '../scripts/execution-store.js';
import { bindingIdentity, createBinding } from '../scripts/execution-protocol.js';

const NOW = '2026-06-20T00:00:00.000Z';

const makeRuntime = ({ heartbeatAt = NOW, attemptPatch = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-publisher-'));
  const taskId = 'W9-A';
  const store = new ExecutionStore({ harnessRoot: root, taskId });
  const { binding, rawNonce } = createBinding({
    taskId,
    bindingId: 'wrapper.work',
    role: 'work',
    createdAt: NOW,
    heartbeatAt,
  });
  const identity = bindingIdentity(binding);
  const attempt = {
    jobId: 'job-1',
    attemptId: 'attempt-1',
    leaseToken: 'lease-1',
    lockEpoch: 7,
    bindingId: binding.bindingId,
    bindingIdentity: identity,
    lastSequence: 0,
    state: 'submitted',
    transportState: 'submitted',
    ...attemptPatch,
  };
  const job = {
    jobId: attempt.jobId,
    role: 'work',
    bindingId: binding.bindingId,
    bindingIdentity: identity,
  };
  const lease = {
    operationId: 'operation-1',
    bindingId: binding.bindingId,
    jobId: attempt.jobId,
    attemptId: attempt.attemptId,
    leaseToken: attempt.leaseToken,
    lockEpoch: attempt.lockEpoch,
    state: 'active',
    bindingIdentity: identity,
  };
  store.writeBinding(binding);
  store.writeBindingSecret(binding.bindingId, rawNonce);
  store.writeJob(job);
  store.writeAttempt(attempt);
  store.writeLease(lease);
  store.writeOperation({
    operationId: lease.operationId,
    kind: 'dispatch-prepare',
    payloadHash: 'payload-hash',
    attemptRef: {
      jobId: attempt.jobId,
      attemptId: attempt.attemptId,
      leaseToken: attempt.leaseToken,
    },
  });
  const env = {
    HARNESS_ROOT: root,
    HARNESS_TASK_ID: taskId,
    HARNESS_BINDING_ID: binding.bindingId,
    HARNESS_SESSION_ID: binding.sessionId,
    HARNESS_ATTEMPT_ID: attempt.attemptId,
    HARNESS_JOB_ID: attempt.jobId,
    HARNESS_LEASE_TOKEN: attempt.leaseToken,
    HARNESS_LOCK_EPOCH: String(attempt.lockEpoch),
    HARNESS_WRAPPER_PID: '12345',
    HARNESS_WRAPPER_SESSION_PROOF_ID: 'proof-1',
  };
  return { root, taskId, store, binding, attempt, env };
};

const publish = (runtime, payload, envPatch = {}) => publishClaudeHookReceipt({
  harnessRoot: runtime.root,
  taskId: runtime.taskId,
  payload: { occurredAt: NOW, ...payload },
  env: { ...runtime.env, ...envPatch },
  now: () => NOW,
});

describe('V3 Phase 6 Claude hook publisher', () => {
  it('allocates receipt sequences from a durable per-attempt ledger, ignoring env sequence', () => {
    const runtime = makeRuntime();

    const first = publish(runtime, {
      kind: 'job.needs-input',
      needsInputCategory: 'agent-question',
      hookEventId: 'needs-input-1',
    }, { HARNESS_RECEIPT_SEQUENCE: '99' });
    const second = publish(runtime, {
      kind: 'job.completed',
      hookEventId: 'completed-1',
    }, { HARNESS_RECEIPT_SEQUENCE: '99' });

    assert.equal(first.sequence, 1);
    assert.equal(first.ignoredReceiptSequenceEnv, true);
    assert.equal(second.sequence, 2);
    const ledger = JSON.parse(fs.readFileSync(runtime.store.receiptSequenceLedgerPath(runtime.attempt.attemptId), 'utf8'));
    assert.equal(ledger.nextSequence, 3);
    assert.equal(Object.keys(ledger.events).length, 2);
  });

  it('returns the prior receipt for duplicate hook payloads without allocating a new sequence', () => {
    const runtime = makeRuntime();

    const first = publish(runtime, {
      kind: 'job.completed',
      hookEventId: 'source-event-1',
      reason: 'done',
    });
    const duplicatePayload = publish(runtime, {
      kind: 'job.completed',
      hookEventId: 'source-event-2',
      reason: 'done',
    });

    assert.equal(duplicatePayload.allocationStatus, 'duplicate-payload');
    assert.equal(duplicatePayload.eventId, first.eventId);
    assert.equal(duplicatePayload.sequence, first.sequence);
    const ledger = JSON.parse(fs.readFileSync(runtime.store.receiptSequenceLedgerPath(runtime.attempt.attemptId), 'utf8'));
    assert.equal(ledger.nextSequence, 2);
  });

  it('rejects duplicate event ids with a different canonical payload hash', () => {
    const runtime = makeRuntime();
    publish(runtime, { kind: 'job.completed', hookEventId: 'same-source-event' });

    assert.throws(
      () => publish(runtime, { kind: 'job.failed', hookEventId: 'same-source-event', reason: 'different' }),
      /event-id-collision/
    );
  });

  it('recovers after a crash between ledger allocation and receipt write without skipping sequence', () => {
    const runtime = makeRuntime();

    assert.throws(
      () => publish(runtime, { kind: 'job.completed', hookEventId: 'crashy' }, {
        HARNESS_TEST_CRASH_AFTER_RECEIPT_LEDGER: '1',
      }),
      /crash-after-receipt-ledger/
    );
    assert.equal(runtime.store.listReceipts('inbox').length, 0);

    const restarted = publish(runtime, { kind: 'job.completed', hookEventId: 'crashy' });
    assert.equal(restarted.allocationStatus, 'duplicate-event');
    assert.equal(restarted.sequence, 1);
    assert.equal(runtime.store.listReceipts('inbox').length, 1);
    const ledger = JSON.parse(fs.readFileSync(runtime.store.receiptSequenceLedgerPath(runtime.attempt.attemptId), 'utf8'));
    assert.equal(ledger.nextSequence, 2);
  });

  it('fails closed for stale binding, terminal attempt, and unsupported needs-input category', () => {
    const stale = makeRuntime({ heartbeatAt: '2026-06-19T23:50:00.000Z' });
    assert.throws(
      () => publish(stale, { kind: 'job.completed', hookEventId: 'stale' }),
      /binding-stale/
    );

    const terminal = makeRuntime({ attemptPatch: { completionEvidence: { eventId: 'done' } } });
    assert.throws(
      () => publish(terminal, { kind: 'job.completed', hookEventId: 'terminal' }),
      /attempt-terminal/
    );

    const badCategory = makeRuntime();
    assert.throws(
      () => publish(badCategory, {
        kind: 'job.needs-input',
        needsInputCategory: 'free-form',
        hookEventId: 'bad-category',
      }),
      /needs-input-invalid-category/
    );
  });
});
