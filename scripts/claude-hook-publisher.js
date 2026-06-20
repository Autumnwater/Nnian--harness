#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createEvent, hashSessionNonce } from './execution-protocol.js';
import { ExecutionStore, canonicalPayloadHash } from './execution-store.js';

const NEEDS_INPUT_CATEGORIES = new Set([
  'permission-request',
  'agent-question',
  'authentication-required',
  'external-intervention',
]);
const BINDING_HEARTBEAT_STALE_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 60_000;

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const parseArgs = argv => {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
};

const readPayload = input => {
  const value = requiredString(input, '--payload');
  if (value.trim().startsWith('{')) return JSON.parse(value);
  return JSON.parse(fs.readFileSync(path.resolve(value), 'utf8'));
};

const parseInteger = (value, field) => {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${field} must be an integer`);
  return number;
};

const stableHookPayloadHash = payload => {
  const { eventId: _eventId, hookEventId: _hookEventId, receiptSequence: _receiptSequence, sequence: _sequence, ...stable } = payload || {};
  return canonicalPayloadHash(stable);
};

const derivedEventId = ({ payload, binding, attemptId, kind, payloadHash }) => {
  const sourceEventId = payload.eventId || payload.hookEventId || null;
  const seed = sourceEventId
    ? `${binding.sessionId}:${sourceEventId}`
    : `${binding.sessionId}:${attemptId}:${kind}:${payloadHash}`;
  return `hook-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
};

const receiptExists = (store, attemptId, eventId) => ['inbox', 'processed', 'rejected']
  .some(bucket => fs.existsSync(store.receiptPath(bucket, attemptId, eventId)));

const assertNotTerminal = attempt => {
  if (attempt.completionEvidence || attempt.failureEvidence) throw new Error('attempt-terminal');
  if (['completed', 'failed', 'cancelled', 'terminal'].includes(attempt.state) ||
      ['completed', 'failed', 'cancelled', 'terminal'].includes(attempt.transportState)) {
    throw new Error('attempt-terminal');
  }
};

const assertBindingFresh = ({ binding, rawNonce, nowMs }) => {
  if (['terminal', 'revoked', 'detached'].includes(binding.state)) throw new Error('binding-unavailable');
  if (!rawNonce) throw new Error('binding-secret-unavailable');
  if (hashSessionNonce(rawNonce) !== binding.sessionNonceHash) throw new Error('binding-secret-mismatch');
  const heartbeatMs = Date.parse(binding.heartbeatAt || binding.createdAt || '');
  if (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > BINDING_HEARTBEAT_STALE_MS) {
    throw new Error('binding-stale');
  }
};

export const publishClaudeHookReceipt = ({
  harnessRoot,
  taskId,
  payload,
  env = process.env,
  now = () => new Date().toISOString(),
}) => {
  const effectiveTaskId = requiredString(taskId || env.HARNESS_TASK_ID, 'HARNESS_TASK_ID');
  const effectiveHarnessRoot = requiredString(harnessRoot || env.HARNESS_ROOT, 'HARNESS_ROOT');
  if (env.HARNESS_TASK_ID && env.HARNESS_TASK_ID !== effectiveTaskId) throw new Error('task-id-mismatch');
  const store = new ExecutionStore({ harnessRoot: effectiveHarnessRoot, taskId: effectiveTaskId });
  const bindingId = requiredString(env.HARNESS_BINDING_ID, 'HARNESS_BINDING_ID');
  const attemptId = requiredString(env.HARNESS_ATTEMPT_ID, 'HARNESS_ATTEMPT_ID');
  const jobId = requiredString(env.HARNESS_JOB_ID, 'HARNESS_JOB_ID');
  const leaseToken = requiredString(env.HARNESS_LEASE_TOKEN, 'HARNESS_LEASE_TOKEN');
  const sessionId = requiredString(env.HARNESS_SESSION_ID, 'HARNESS_SESSION_ID');
  const lockEpoch = parseInteger(env.HARNESS_LOCK_EPOCH, 'HARNESS_LOCK_EPOCH');
  const wrapperPid = parseInteger(env.HARNESS_WRAPPER_PID, 'HARNESS_WRAPPER_PID');
  requiredString(env.HARNESS_WRAPPER_SESSION_PROOF_ID, 'HARNESS_WRAPPER_SESSION_PROOF_ID');

  const attempt = store.readAttempt(attemptId);
  if (!attempt) throw new Error('attempt-not-found');
  assertNotTerminal(attempt);
  if (attempt.jobId !== jobId || attempt.leaseToken !== leaseToken || attempt.lockEpoch !== lockEpoch) {
    throw new Error('attempt-ref-mismatch');
  }
  const job = store.readJob(jobId);
  if (!job) throw new Error('job-not-found');
  const lease = store.readLease(bindingId);
  if (!lease || lease.state !== 'active' || lease.jobId !== jobId ||
      lease.attemptId !== attemptId || lease.leaseToken !== leaseToken || lease.lockEpoch !== lockEpoch) {
    throw new Error('lease-fence-conflict');
  }
  const binding = store.readBinding(bindingId);
  if (!binding) throw new Error('binding-not-found');
  if (binding.sessionId !== sessionId) throw new Error('binding-session-mismatch');
  for (const expected of [attempt.bindingIdentity, job.bindingIdentity, lease.bindingIdentity].filter(Boolean)) {
    for (const field of ['bindingId', 'role', 'bindingGeneration', 'sessionId', 'sessionNonceHash']) {
      if (binding[field] !== expected[field]) throw new Error(`binding-${field}-mismatch`);
    }
  }
  const rawNonce = store.readBindingSecret(bindingId);
  const occurredAt = payload.occurredAt || now();
  const occurredAtMs = Date.parse(occurredAt);
  const nowMs = Date.parse(now());
  if (!Number.isFinite(occurredAtMs)) throw new Error('invalid-occurred-at');
  if (occurredAtMs > nowMs + MAX_CLOCK_SKEW_MS) throw new Error('occurred-at-in-future');
  assertBindingFresh({ binding, rawNonce, nowMs });

  const kind = requiredString(payload.kind, 'payload.kind');
  if (!['job.completed', 'job.failed', 'job.needs-input'].includes(kind)) throw new Error('unsupported-hook-kind');
  const category = payload.needsInputCategory || payload.category || payload.details?.category || null;
  if (kind === 'job.needs-input' && !NEEDS_INPUT_CATEGORIES.has(category)) {
    throw new Error('needs-input-invalid-category');
  }
  const details = {
    ...(category ? { category } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    publisherProvenance: {
      source: 'wrapper-launched-claude-hook-publisher',
      bindingId,
      sessionId,
      wrapperPid,
      wrapperSessionProofId: env.HARNESS_WRAPPER_SESSION_PROOF_ID,
    },
  };
  const hookPayloadHash = stableHookPayloadHash({ ...payload, kind, occurredAt, details });
  const eventId = derivedEventId({ payload, binding, attemptId, kind, payloadHash: hookPayloadHash });
  const plannedReceiptPath = store.receiptPath('inbox', attemptId, eventId);
  const allocation = store.allocateReceiptSequence({
    attemptId,
    eventId,
    payloadHash: hookPayloadHash,
    receiptPath: plannedReceiptPath,
  });
  if (env.HARNESS_TEST_CRASH_AFTER_RECEIPT_LEDGER === '1') throw new Error('crash-after-receipt-ledger');
  const receipt = createEvent({
    kind,
    source: 'wrapper-hook',
    attempt,
    sequence: allocation.sequence,
    eventId: allocation.eventId,
    occurredAt,
    details,
    binding,
    rawNonce,
  });
  let published = { status: allocation.status, payloadHash: canonicalPayloadHash(receipt) };
  if (!receiptExists(store, attemptId, allocation.eventId)) {
    published = store.publishReceipt(receipt);
  }
  return {
    status: published.status,
    allocationStatus: allocation.status,
    eventId: allocation.eventId,
    attemptId,
    sequence: allocation.sequence,
    receiptPath: allocation.receiptPath,
    payloadHash: published.payloadHash,
    ignoredReceiptSequenceEnv: env.HARNESS_RECEIPT_SEQUENCE !== undefined,
  };
};

const main = () => {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const payload = readPayload(opts.payload);
    const result = publishClaudeHookReceipt({
      harnessRoot: opts['harness-root'] || process.env.HARNESS_ROOT,
      taskId: opts.task || process.env.HARNESS_TASK_ID,
      payload,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exitCode = 1;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) main();
