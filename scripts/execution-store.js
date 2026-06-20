import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])])
    );
  }
  return value;
};

export const canonicalPayloadHash = value => createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');

const ensureDir = directory => fs.mkdirSync(directory, { recursive: true });

const fsyncDirectory = directory => {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const atomicWriteJson = (filePath, value, faultInjector) => {
  const directory = path.dirname(filePath);
  ensureDir(directory);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    faultInjector?.('before-json-rename', { filePath, tempPath });
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(directory);
    faultInjector?.('after-json-rename', { filePath });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // A stale temp file is never authoritative and can be ignored by recovery.
    }
  }
};

const sleepSync = ms => {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
};

const acquireFileLock = (lockPath, timeoutMs = 1000) => {
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST' || Date.now() >= deadline) throw err;
      sleepSync(10);
    }
  }
};

const readJson = filePath => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`corrupt-json-record: ${filePath}: ${error.message}`);
  }
};

const listJsonFiles = directory => {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(entryPath);
    }
  };
  visit(directory);
  return output.sort();
};

export class ExecutionStore {
  constructor({ harnessRoot, taskId, faultInjector = null }) {
    if (!harnessRoot || !taskId) throw new Error('harnessRoot and taskId are required');
    this.taskId = taskId;
    this.faultInjector = faultInjector;
    const runRoot = path.join(harnessRoot, 'runs', taskId);
    this.paths = {
      runRoot,
      operations: path.join(runRoot, 'operations'),
      jobs: path.join(runRoot, 'jobs'),
      attempts: path.join(runRoot, 'attempts'),
      eventsDir: path.join(runRoot, 'events'),
      eventsFile: path.join(runRoot, 'events', 'worker.jsonl'),
      eventIndex: path.join(runRoot, 'events', 'index'),
      leases: path.join(runRoot, 'leases'),
      transports: path.join(runRoot, 'transports'),
      bindings: path.join(runRoot, 'bindings'),
      bindingSecrets: path.join(runRoot, 'bindings', '.secrets'),
      capabilities: path.join(runRoot, 'capabilities'),
      applications: path.join(runRoot, 'receipt-applications'),
      receipts: path.join(runRoot, 'receipts'),
      targetChallenges: path.join(runRoot, 'target-challenges'),
    };
  }

  recordPath(kind, id) {
    const directory = this.paths[kind];
    if (!directory) throw new Error(`unknown-record-kind: ${kind}`);
    return path.join(directory, `${id}.json`);
  }

  writeRecord(kind, id, value) {
    atomicWriteJson(this.recordPath(kind, id), value, this.faultInjector);
    return value;
  }

  readRecord(kind, id) {
    return readJson(this.recordPath(kind, id));
  }

  writeJob(job) {
    if (!job?.jobId) throw new Error('jobId is required');
    return this.writeRecord('jobs', job.jobId, job);
  }

  readJob(jobId) {
    return this.readRecord('jobs', jobId);
  }

  writeAttempt(attempt) {
    if (!attempt?.attemptId) throw new Error('attemptId is required');
    return this.writeRecord('attempts', attempt.attemptId, attempt);
  }

  readAttempt(attemptId) {
    return this.readRecord('attempts', attemptId);
  }

  receiptSequenceLedgerPath(attemptId) {
    if (!attemptId) throw new Error('attemptId is required');
    return path.join(this.paths.attempts, attemptId, 'receipt-sequence-ledger.json');
  }

  allocateReceiptSequence({ attemptId, eventId, payloadHash, receiptPath }) {
    if (!attemptId || !eventId || !payloadHash || !receiptPath) {
      throw new Error('attemptId, eventId, payloadHash, and receiptPath are required');
    }
    const ledgerPath = this.receiptSequenceLedgerPath(attemptId);
    const lockPath = `${ledgerPath}.lock`;
    const lockFd = acquireFileLock(lockPath);
    try {
      const ledger = readJson(ledgerPath) || {
        protocolVersion: 1,
        attemptId,
        nextSequence: 1,
        events: {},
        payloads: {},
      };
      if (ledger.attemptId !== attemptId) throw new Error(`receipt-sequence-ledger-attempt-mismatch: ${attemptId}`);
      if (!Number.isInteger(ledger.nextSequence) || ledger.nextSequence <= 0) {
        throw new Error(`receipt-sequence-ledger-corrupt: ${attemptId}`);
      }
      const existingEvent = ledger.events[eventId] || null;
      if (existingEvent) {
        if (existingEvent.payloadHash !== payloadHash) throw new Error(`event-id-collision: ${eventId}`);
        return { status: 'duplicate-event', ...existingEvent };
      }
      const duplicateEventId = ledger.payloads[payloadHash] || null;
      if (duplicateEventId) {
        const duplicate = ledger.events[duplicateEventId];
        if (duplicate) return { status: 'duplicate-payload', eventId: duplicateEventId, ...duplicate };
      }
      const sequence = ledger.nextSequence;
      const nextLedger = {
        ...ledger,
        nextSequence: sequence + 1,
        events: {
          ...ledger.events,
          [eventId]: { eventId, payloadHash, sequence, receiptPath },
        },
        payloads: {
          ...ledger.payloads,
          [payloadHash]: eventId,
        },
        updatedAt: new Date().toISOString(),
      };
      atomicWriteJson(ledgerPath, nextLedger, this.faultInjector);
      return { status: 'allocated', eventId, payloadHash, sequence, receiptPath };
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
      fsyncDirectory(path.dirname(lockPath));
    }
  }

  writeOperation(operation) {
    if (!operation?.operationId || !operation?.payloadHash) {
      throw new Error('operationId and payloadHash are required');
    }
    const existing = this.readOperation(operation.operationId);
    if (existing && existing.payloadHash !== operation.payloadHash) {
      throw new Error(`operation-payload-conflict: ${operation.operationId}`);
    }
    return this.writeRecord('operations', operation.operationId, operation);
  }

  readOperation(operationId) {
    return this.readRecord('operations', operationId);
  }

  listOperations() {
    return listJsonFiles(this.paths.operations).map(readJson);
  }

  writeLease(lease) {
    if (!lease?.bindingId) throw new Error('bindingId is required');
    return this.writeRecord('leases', lease.bindingId, lease);
  }

  readLease(bindingId) {
    return this.readRecord('leases', bindingId);
  }

  releaseLease(bindingId, expected) {
    const filePath = this.recordPath('leases', bindingId);
    const lease = readJson(filePath);
    if (!lease) return false;
    const fields = ['operationId', 'jobId', 'attemptId', 'leaseToken'];
    if (fields.some(field => lease[field] !== expected?.[field])) return false;
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
    return true;
  }

  writeTransport(bindingId, record) {
    if (!bindingId) throw new Error('bindingId is required');
    return this.writeRecord('transports', bindingId, { ...record, bindingId });
  }

  readTransport(bindingId) {
    return this.readRecord('transports', bindingId);
  }

  writeTransportEvidence(transportEvidenceId, record) {
    if (!transportEvidenceId) throw new Error('transportEvidenceId is required');
    return this.writeRecord('transports', transportEvidenceId, { ...record, transportEvidenceId });
  }

  readTransportEvidence(transportEvidenceId) {
    return this.readRecord('transports', transportEvidenceId);
  }

  writeBinding(binding) {
    if (!binding?.bindingId) throw new Error('bindingId is required');
    if (Object.prototype.hasOwnProperty.call(binding, 'rawNonce') ||
        Object.prototype.hasOwnProperty.call(binding, 'sessionNonce')) {
      throw new Error('raw session nonce must not be written to binding records');
    }
    return this.writeRecord('bindings', binding.bindingId, binding);
  }

  readBinding(bindingId) {
    return this.readRecord('bindings', bindingId);
  }

  listBindings() {
    return listJsonFiles(this.paths.bindings)
      .filter(filePath => !filePath.includes(`${path.sep}.secrets${path.sep}`))
      .map(readJson);
  }

  writeBindingSecret(bindingId, rawNonce) {
    if (!bindingId || typeof rawNonce !== 'string' || rawNonce.length === 0) {
      throw new Error('bindingId and rawNonce are required');
    }
    ensureDir(this.paths.bindingSecrets);
    const filePath = path.join(this.paths.bindingSecrets, `${bindingId}.nonce`);
    const tempPath = path.join(this.paths.bindingSecrets, `.${bindingId}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, rawNonce, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, filePath);
      fs.chmodSync(filePath, 0o600);
      fsyncDirectory(this.paths.bindingSecrets);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Temporary secret files are not authoritative.
      }
    }
    return filePath;
  }

  readBindingSecret(bindingId) {
    const filePath = path.join(this.paths.bindingSecrets, `${bindingId}.nonce`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  }

  writeCapability(name, record) {
    if (!name) throw new Error('capability name is required');
    return this.writeRecord('capabilities', name, { ...record, name });
  }

  readCapability(name) {
    return this.readRecord('capabilities', name);
  }

  targetChallengePath(bucket, challengeId, eventId = null) {
    if (!['pending', 'inbox', 'processed', 'rejected'].includes(bucket)) {
      throw new Error(`invalid-target-challenge-bucket: ${bucket}`);
    }
    if (bucket === 'pending') return path.join(this.paths.targetChallenges, bucket, `${challengeId}.json`);
    return path.join(this.paths.targetChallenges, bucket, challengeId, `${eventId}.json`);
  }

  writeTargetChallenge(challenge) {
    if (!challenge?.payload?.challengeId) throw new Error('target challengeId is required');
    const filePath = this.targetChallengePath('pending', challenge.payload.challengeId);
    const existing = readJson(filePath);
    if (existing && canonicalPayloadHash(existing.payload) !== canonicalPayloadHash(challenge.payload)) {
      throw new Error(`target-challenge-conflict: ${challenge.payload.challengeId}`);
    }
    atomicWriteJson(filePath, challenge, this.faultInjector);
    return challenge;
  }

  readTargetChallenge(challengeId) {
    return readJson(this.targetChallengePath('pending', challengeId));
  }

  publishTargetChallengeResponse(response) {
    if (!response?.challengeId || !response?.eventId) throw new Error('challengeId and eventId are required');
    const filePath = this.targetChallengePath('inbox', response.challengeId, response.eventId);
    const existing = readJson(filePath);
    if (existing && canonicalPayloadHash(existing) !== canonicalPayloadHash(response)) {
      throw new Error(`target-challenge-response-conflict: ${response.eventId}`);
    }
    atomicWriteJson(filePath, response, this.faultInjector);
    return { status: existing ? 'duplicate' : 'published', payloadHash: canonicalPayloadHash(response) };
  }

  finalizeTargetChallengeResponse(challengeId, eventId, destination) {
    if (!['processed', 'rejected'].includes(destination)) {
      throw new Error(`invalid-target-challenge-destination: ${destination}`);
    }
    const source = this.targetChallengePath('inbox', challengeId, eventId);
    const target = this.targetChallengePath(destination, challengeId, eventId);
    if (!fs.existsSync(source)) {
      if (fs.existsSync(target)) return { finalized: false, alreadyFinalized: true };
      throw new Error(`target-challenge-response-not-found: ${challengeId}/${eventId}`);
    }
    ensureDir(path.dirname(target));
    if (fs.existsSync(target)) {
      if (canonicalPayloadHash(readJson(source)) !== canonicalPayloadHash(readJson(target))) {
        throw new Error(`target-challenge-finalize-conflict: ${eventId}`);
      }
      fs.unlinkSync(source);
    } else {
      fs.renameSync(source, target);
    }
    fsyncDirectory(path.dirname(source));
    fsyncDirectory(path.dirname(target));
    return { finalized: true, destination };
  }

  receiptPath(bucket, attemptId, eventId) {
    if (!['inbox', 'processed', 'rejected'].includes(bucket)) {
      throw new Error(`invalid-receipt-bucket: ${bucket}`);
    }
    return path.join(this.paths.receipts, bucket, attemptId, `${eventId}.json`);
  }

  publishReceipt(receipt) {
    if (!receipt?.attemptId || !receipt?.eventId) throw new Error('attemptId and eventId are required');
    const filePath = this.receiptPath('inbox', receipt.attemptId, receipt.eventId);
    const payloadHash = canonicalPayloadHash(receipt);
    const existing = readJson(filePath);
    if (existing) {
      if (canonicalPayloadHash(existing) !== payloadHash) {
        throw new Error(`event-id-collision: ${receipt.eventId}`);
      }
      return { status: 'duplicate', payloadHash };
    }
    atomicWriteJson(filePath, receipt, this.faultInjector);
    return { status: 'published', payloadHash };
  }

  listReceipts(bucket) {
    const directory = path.join(this.paths.receipts, bucket);
    return listJsonFiles(directory).map(filePath => {
      const relative = path.relative(directory, filePath).split(path.sep);
      const attemptId = relative.at(-2);
      const eventId = path.basename(filePath, '.json');
      try {
        return { filePath, attemptId, eventId, receipt: readJson(filePath), error: null };
      } catch (error) {
        return {
          filePath,
          attemptId,
          eventId,
          receipt: null,
          error: error.message,
          payloadHash: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
        };
      }
    });
  }

  readReceiptApplication(attemptId, eventId) {
    return readJson(path.join(this.paths.applications, attemptId, `${eventId}.json`));
  }

  writeReceiptApplication(attemptId, eventId, application) {
    const filePath = path.join(this.paths.applications, attemptId, `${eventId}.json`);
    const existing = readJson(filePath);
    if (existing && existing.payloadHash !== application.payloadHash) {
      throw new Error(`receipt-application-conflict: ${eventId}`);
    }
    atomicWriteJson(filePath, application, this.faultInjector);
    return application;
  }

  finalizeReceipt(attemptId, eventId, destination) {
    if (!['processed', 'rejected'].includes(destination)) {
      throw new Error(`invalid-final-receipt-bucket: ${destination}`);
    }
    const source = this.receiptPath('inbox', attemptId, eventId);
    const target = this.receiptPath(destination, attemptId, eventId);
    if (!fs.existsSync(source)) {
      if (fs.existsSync(target)) return { finalized: false, alreadyFinalized: true };
      throw new Error(`receipt-not-found: ${attemptId}/${eventId}`);
    }
    ensureDir(path.dirname(target));
    if (fs.existsSync(target)) {
      if (canonicalPayloadHash(readJson(source)) !== canonicalPayloadHash(readJson(target))) {
        throw new Error(`receipt-finalize-conflict: ${eventId}`);
      }
      fs.unlinkSync(source);
    } else {
      fs.renameSync(source, target);
    }
    fsyncDirectory(path.dirname(source));
    fsyncDirectory(path.dirname(target));
    return { finalized: true, destination };
  }

  recoverEventJournal() {
    const filePath = this.paths.eventsFile;
    if (!fs.existsSync(filePath)) return { truncated: false };
    const contents = fs.readFileSync(filePath);
    if (contents.length === 0 || contents.at(-1) === 0x0a) return { truncated: false };
    const lastNewline = contents.lastIndexOf(0x0a);
    const validLength = lastNewline < 0 ? 0 : lastNewline + 1;
    const fd = fs.openSync(filePath, 'r+');
    try {
      fs.ftruncateSync(fd, validLength);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { truncated: true, removedBytes: contents.length - validLength };
  }

  readEvents() {
    this.recoverEventJournal();
    if (!fs.existsSync(this.paths.eventsFile)) return [];
    const content = fs.readFileSync(this.paths.eventsFile, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  }

  appendEvent(event) {
    if (!event?.eventId) throw new Error('eventId is required');
    this.recoverEventJournal();
    const existing = this.readEvents().find(item => item.eventId === event.eventId);
    const indexPath = path.join(this.paths.eventIndex, `${event.eventId}.json`);
    if (existing) {
      if (canonicalPayloadHash(existing) !== canonicalPayloadHash(event)) {
        throw new Error(`event-id-collision: ${event.eventId}`);
      }
      if (!fs.existsSync(indexPath)) {
        atomicWriteJson(indexPath, { eventId: event.eventId, payloadHash: canonicalPayloadHash(event) }, this.faultInjector);
      }
      return { appended: false, eventId: event.eventId };
    }

    ensureDir(this.paths.eventsDir);
    const fd = fs.openSync(this.paths.eventsFile, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.faultInjector?.('after-event-append', { eventId: event.eventId });
    atomicWriteJson(indexPath, { eventId: event.eventId, payloadHash: canonicalPayloadHash(event) }, this.faultInjector);
    return { appended: true, eventId: event.eventId };
  }
}
