import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionStore, canonicalPayloadHash } from '../scripts/execution-store.js';

const makeStore = (options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-store-'));
  return { root, store: new ExecutionStore({ harnessRoot: root, taskId: 'W9-A', ...options }) };
};

const attempt = {
  jobId: 'job-1',
  attemptId: 'attempt-1',
  leaseToken: 'attempt-1:0:token',
};

describe('V3 Phase 2 execution store', () => {
  it('atomically writes and replaces durable JSON records without exposing temp files', () => {
    const { root, store } = makeStore();

    store.writeJob({ jobId: 'job-1', state: 'preparing' });
    store.writeJob({ jobId: 'job-1', state: 'prepared' });

    assert.equal(store.readJob('job-1').state, 'prepared');
    const jobsDir = path.join(root, 'runs', 'W9-A', 'jobs');
    assert.deepEqual(fs.readdirSync(jobsDir), ['job-1.json']);
  });

  it('leaves the previous record intact when a crash is injected before rename', () => {
    let crash = false;
    const { store } = makeStore({
      faultInjector(point) {
        if (crash && point === 'before-json-rename') throw new Error('injected-crash');
      },
    });
    store.writeAttempt({ ...attempt, state: 'prepared' });
    crash = true;

    assert.throws(
      () => store.writeAttempt({ ...attempt, state: 'dispatching' }),
      /injected-crash/
    );
    assert.equal(store.readAttempt(attempt.attemptId).state, 'prepared');
  });

  it('keeps multiple attempts, events, and receipts in independent paths', () => {
    const { store } = makeStore();
    store.writeAttempt({ ...attempt, state: 'running' });
    store.writeAttempt({ ...attempt, attemptId: 'attempt-2', leaseToken: 'attempt-2:0:token', state: 'running' });
    store.publishReceipt({ ...attempt, protocolVersion: 1, eventId: 'event-1', kind: 'job.running', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {} });
    store.publishReceipt({ ...attempt, attemptId: 'attempt-2', leaseToken: 'attempt-2:0:token', protocolVersion: 1, eventId: 'event-2', kind: 'job.running', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {} });

    assert.equal(store.listReceipts('inbox').length, 2);
    assert.equal(store.readAttempt('attempt-1').attemptId, 'attempt-1');
    assert.equal(store.readAttempt('attempt-2').attemptId, 'attempt-2');
  });

  it('refuses receipt overwrite and detects event id payload collisions', () => {
    const { store } = makeStore();
    const receipt = { ...attempt, protocolVersion: 1, eventId: 'event-1', kind: 'job.running', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {} };
    store.publishReceipt(receipt);

    assert.deepEqual(store.publishReceipt(receipt), { status: 'duplicate', payloadHash: canonicalPayloadHash(receipt) });
    assert.throws(
      () => store.publishReceipt({ ...receipt, kind: 'job.completed' }),
      /event-id-collision/
    );
  });

  it('deduplicates the event journal by eventId even after append-before-index crash', () => {
    let crash = true;
    const { store } = makeStore({
      faultInjector(point) {
        if (crash && point === 'after-event-append') throw new Error('append-crash');
      },
    });
    const event = { ...attempt, eventId: 'event-1', kind: 'job.running' };

    assert.throws(() => store.appendEvent(event), /append-crash/);
    crash = false;
    assert.deepEqual(store.appendEvent(event), { appended: false, eventId: 'event-1' });

    const lines = store.readEvents();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].eventId, 'event-1');
  });

  it('truncates an incomplete JSONL tail and can append the event once', () => {
    const { store } = makeStore();
    store.appendEvent({ ...attempt, eventId: 'event-1', kind: 'job.running' });
    fs.appendFileSync(store.paths.eventsFile, '{"eventId":"broken"');

    const result = store.recoverEventJournal();
    assert.equal(result.truncated, true);
    store.appendEvent({ ...attempt, eventId: 'event-2', kind: 'job.completed' });

    assert.deepEqual(store.readEvents().map(event => event.eventId), ['event-1', 'event-2']);
  });

  it('moves receipts to a stable processed or rejected classification', () => {
    const { store } = makeStore();
    const receipt = { ...attempt, protocolVersion: 1, eventId: 'event-1', kind: 'job.running', sequence: 1, occurredAt: new Date().toISOString(), source: 'fake', details: {} };
    store.publishReceipt(receipt);
    store.writeReceiptApplication(attempt.attemptId, receipt.eventId, {
      eventId: receipt.eventId,
      attemptId: attempt.attemptId,
      payloadHash: canonicalPayloadHash(receipt),
      classification: 'accepted',
      phase: 'committed',
    });

    store.finalizeReceipt(attempt.attemptId, receipt.eventId, 'processed');
    assert.equal(store.listReceipts('inbox').length, 0);
    assert.equal(store.listReceipts('processed').length, 1);
    assert.equal(store.readReceiptApplication(attempt.attemptId, receipt.eventId).classification, 'accepted');
    assert.deepEqual(store.finalizeReceipt(attempt.attemptId, receipt.eventId, 'processed'), { finalized: false, alreadyFinalized: true });
  });

  it('replays an operation from its durable phase without overwriting payload identity', () => {
    const { store } = makeStore();
    const operation = {
      operationId: 'op-1',
      kind: 'dispatch-prepare',
      phase: 'intent',
      payloadHash: 'hash-1',
      attemptRef: attempt,
    };
    store.writeOperation(operation);
    store.writeOperation({ ...operation, phase: 'committed' });

    assert.equal(store.readOperation('op-1').phase, 'committed');
    assert.throws(
      () => store.writeOperation({ ...operation, payloadHash: 'hash-2' }),
      /operation-payload-conflict/
    );
  });

  it('only releases a lease that matches operation and attempt fencing', () => {
    const { store } = makeStore();
    store.writeLease({ bindingId: 'fake.work', operationId: 'op-1', ...attempt, state: 'active' });

    assert.equal(store.releaseLease('fake.work', { operationId: 'op-2', ...attempt }), false);
    assert.ok(store.readLease('fake.work'));
    assert.equal(store.releaseLease('fake.work', { operationId: 'op-1', ...attempt }), true);
    assert.equal(store.readLease('fake.work'), null);
  });
});
