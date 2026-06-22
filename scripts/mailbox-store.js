import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  appendJsonLine,
  atomicWriteFile,
  atomicWriteJson,
  canonicalHash,
  canonicalJson,
  ensureDirInsideRoot,
  fsyncDirectory,
  hmacSha256,
  listJsonFiles,
  readJson,
  readJsonLines,
  recoverJsonl,
  resolveInsideRoot,
  sha256Text,
  timingSafeEqualString,
} from './file-protocol.js';

export const MAILBOX_PROTOCOL_VERSION = 1;

export const MAILBOX_SESSION_STATES = Object.freeze([
  'published',
  'claimed',
  'running',
  'receipt-seen',
  'output-detected',
  'check-passed',
  'needs-input',
  'failed',
  'abandoned',
  'rejected',
  'taken-over',
  'closed',
]);

const BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECEIPT_KINDS = Object.freeze([
  'session.claimed',
  'session.running',
  'session.completed',
  'session.failed',
  'session.needs-input',
  'session.heartbeat',
]);

const RECEIPT_SOURCES = Object.freeze([
  'claude-code-operator',
  'claude-code-operator-fallback',
  'claude-code-worker',
]);

const ROLE_EVIDENCE_STATES = Object.freeze([
  'claimed',
  'receipt-accepted',
  'gate-satisfied',
  'gate-rejected',
]);

const PUBLISH_PHASE_ORDER = Object.freeze({
  intent: 0,
  'prompt-written': 1,
  'session-written': 2,
  'envelope-published': 3,
  'status-active': 4,
  committed: 5,
});

const ALLOWED_RECORD_FIELDS = Object.freeze({
  'hexai.mailbox.binding': new Set([
    'protocolVersion',
    'kind',
    'taskId',
    'bindingId',
    'role',
    'bindingGeneration',
    'sessionId',
    'sessionNonceHash',
    'workerIdentityHash',
    'createdAt',
    'heartbeatAt',
    'state',
    'metadata',
    'replacedAt',
  ]),
  'hexai.mailbox.session': new Set([
    'protocolVersion',
    'kind',
    'taskId',
    'sessionId',
    'attemptId',
    'state',
    'stageCursor',
    'activeCursorHash',
    'bindingId',
    'claimBindingId',
    'claimBindingGeneration',
    'claimWorkerIdentityHash',
    'claimSource',
    'claimedAt',
    'promptPath',
    'promptSha256',
    'primaryReportPath',
    'createdAt',
    'updatedAt',
    'closedAt',
    'lastEventId',
    'closeReason',
  ]),
  'hexai.mailbox.publish-ledger': new Set([
    'protocolVersion',
    'kind',
    'taskId',
    'publishOperationId',
    'sessionId',
    'attemptId',
    'stageCursor',
    'activeCursorHash',
    'phase',
    'promptHash',
    'envelopeHash',
    'expectedOutputPathHash',
    'publishContentHash',
    'statusRevisionBefore',
    'statusRevisionAfter',
    'statusCasToken',
    'operationHash',
    'createdAt',
    'updatedAt',
    'committedAt',
    'recoveryEvents',
  ]),
  'hexai.mailbox.publish-committed': new Set([
    'protocolVersion',
    'kind',
    'taskId',
    'publishOperationId',
    'sessionId',
    'attemptId',
    'activeCursorHash',
    'operationHash',
    'expectedOutputPathHash',
    'publishContentHash',
    'committedAt',
  ]),
  'hexai.mailbox.close-ledger': new Set([
    'protocolVersion',
    'kind',
    'taskId',
    'sessionId',
    'attemptId',
    'closeOperationId',
    'activeCursorHash',
    'phase',
    'terminalPreconditionState',
    'statusWasActive',
    'createdAt',
    'updatedAt',
    'committedAt',
    'payloadHash',
    'recovered',
    'recoveryEvents',
  ]),
});

const isoNow = () => new Date().toISOString();

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const optionalString = (value, field) => {
  if (value !== null && value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${field} must be null or a non-empty string`);
  }
  return value ?? null;
};

const positiveInteger = (value, field) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
};

const nonNegativeInteger = (value, field) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
};

const assertPlainObject = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
};

const assertNoUnknownFields = (kind, record) => {
  const allowed = ALLOWED_RECORD_FIELDS[kind];
  if (!allowed) throw new Error(`unknown-mailbox-kind: ${kind}`);
  const unknown = Object.keys(record).filter(field => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`${kind}.unknown-fields: ${unknown.join(',')}`);
};

const safeEvidenceFileName = value => requiredString(value, 'evidenceName').replace(/[^A-Za-z0-9._-]/g, '_');

const subtaskWeek = subtaskId => {
  const match = requiredString(subtaskId, 'subtaskId').match(/^W\d+/);
  if (!match) throw new Error(`invalid-subtask-week: ${subtaskId}`);
  return match[0];
};

const hasSensitivePathSegment = filePath => {
  const lowered = filePath.toLowerCase();
  return filePath.split(path.sep).includes('.claude') ||
    /(^|[._/-])(api[-_]?key|token|cookie|secret)([._/-]|$)/i.test(lowered);
};

const sha256File = filePath => `sha256:${createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex')}`;

const PUBLISH_COMMITTED_IDENTITY_FIELDS = Object.freeze([
  'publishOperationId',
  'sessionId',
  'attemptId',
  'activeCursorHash',
  'operationHash',
  'expectedOutputPathHash',
  'publishContentHash',
]);

const assertLedgerScopedRecord = (ledger, record, label) => {
  if (record.taskId !== ledger.taskId) throw new Error(`${label}-task-mismatch`);
  if (record.sessionId !== ledger.sessionId) throw new Error(`${label}-session-mismatch`);
  if (record.attemptId !== ledger.attemptId) throw new Error(`${label}-attempt-mismatch`);
  if (record.activeCursorHash !== ledger.activeCursorHash) throw new Error(`${label}-cursor-hash-mismatch`);
  const cursor = createMailboxStageCursor(record.stageCursor);
  if (canonicalHash(cursor) !== canonicalHash(ledger.stageCursor)) throw new Error(`${label}-stage-cursor-mismatch`);
  if (activeCursorHash(cursor) !== ledger.activeCursorHash) throw new Error(`${label}-stage-cursor-hash-mismatch`);
};

export const assertBindingId = bindingId => {
  requiredString(bindingId, 'bindingId');
  if (bindingId.normalize('NFC') !== bindingId || !BINDING_ID_PATTERN.test(bindingId)) {
    throw new Error(`invalid-binding-id: ${bindingId}`);
  }
  return bindingId;
};

export const createMailboxStageCursor = ({
  subtaskId,
  stage,
  round,
  stageRevision,
  activeSessionId,
  activeAttemptId,
}) => ({
  subtaskId: requiredString(subtaskId, 'subtaskId'),
  stage: requiredString(stage, 'stage'),
  round: positiveInteger(round, 'round'),
  stageRevision: nonNegativeInteger(stageRevision, 'stageRevision'),
  activeSessionId: requiredString(activeSessionId, 'activeSessionId'),
  activeAttemptId: requiredString(activeAttemptId, 'activeAttemptId'),
});

export const activeCursorHash = cursor => canonicalHash(createMailboxStageCursor(cursor));

const hashOperation = ledger => canonicalHash({
  protocolVersion: ledger.protocolVersion,
  kind: ledger.kind,
  taskId: ledger.taskId,
  publishOperationId: ledger.publishOperationId,
  sessionId: ledger.sessionId,
  attemptId: ledger.attemptId,
  stageCursor: ledger.stageCursor,
  activeCursorHash: ledger.activeCursorHash,
  statusRevisionBefore: ledger.statusRevisionBefore,
});

const hashPublishContent = ledger => canonicalHash({
  taskId: ledger.taskId,
  publishOperationId: ledger.publishOperationId,
  sessionId: ledger.sessionId,
  attemptId: ledger.attemptId,
  activeCursorHash: ledger.activeCursorHash,
  promptHash: ledger.promptHash,
  envelopeHash: ledger.envelopeHash,
  expectedOutputPathHash: ledger.expectedOutputPathHash,
});

const hashClosePayload = ledger => canonicalHash({
  protocolVersion: ledger.protocolVersion,
  kind: ledger.kind,
  taskId: ledger.taskId,
  sessionId: ledger.sessionId,
  attemptId: ledger.attemptId,
  closeOperationId: ledger.closeOperationId,
  activeCursorHash: ledger.activeCursorHash,
  terminalPreconditionState: ledger.terminalPreconditionState,
  statusWasActive: ledger.statusWasActive,
});

export const canonicalReceiptPayload = receipt => {
  const { proof, rawNonce, ...payload } = receipt || {};
  return payload;
};

export const validateMailboxRecord = (kind, record) => {
  assertPlainObject(record, kind);
  assertNoUnknownFields(kind, record);
  if (record.protocolVersion !== MAILBOX_PROTOCOL_VERSION) throw new Error(`${kind}.protocolVersion must be ${MAILBOX_PROTOCOL_VERSION}`);
  if (record.kind !== kind) throw new Error(`${kind}.kind mismatch`);
  requiredString(record.taskId, `${kind}.taskId`);
  switch (kind) {
    case 'hexai.mailbox.binding':
      assertBindingId(record.bindingId);
      if (!['work', 'review'].includes(record.role)) throw new Error('binding.role must be work or review');
      positiveInteger(record.bindingGeneration, 'binding.bindingGeneration');
      requiredString(record.sessionId, 'binding.sessionId');
      requiredString(record.sessionNonceHash, 'binding.sessionNonceHash');
      optionalString(record.workerIdentityHash, 'binding.workerIdentityHash');
      if (!['live', 'replaced'].includes(record.state)) throw new Error('binding.state must be live or replaced');
      break;
    case 'hexai.mailbox.session':
      requiredString(record.sessionId, 'session.sessionId');
      requiredString(record.attemptId, 'session.attemptId');
      if (!MAILBOX_SESSION_STATES.includes(record.state)) throw new Error(`invalid-session-state: ${record.state}`);
      assertPlainObject(record.stageCursor, 'session.stageCursor');
      requiredString(record.activeCursorHash, 'session.activeCursorHash');
      optionalString(record.bindingId, 'session.bindingId');
      optionalString(record.claimBindingId, 'session.claimBindingId');
      if (record.claimBindingGeneration !== null && record.claimBindingGeneration !== undefined) {
        positiveInteger(record.claimBindingGeneration, 'session.claimBindingGeneration');
      }
      optionalString(record.claimWorkerIdentityHash, 'session.claimWorkerIdentityHash');
      optionalString(record.claimSource, 'session.claimSource');
      optionalString(record.claimedAt, 'session.claimedAt');
      break;
    case 'hexai.mailbox.publish-ledger':
      requiredString(record.publishOperationId, 'publish.publishOperationId');
      requiredString(record.sessionId, 'publish.sessionId');
      requiredString(record.attemptId, 'publish.attemptId');
      assertPlainObject(record.stageCursor, 'publish.stageCursor');
      requiredString(record.activeCursorHash, 'publish.activeCursorHash');
      if (!['intent', 'prompt-written', 'session-written', 'envelope-published', 'status-active', 'committed'].includes(record.phase)) {
        throw new Error(`invalid-publish-phase: ${record.phase}`);
      }
      requiredString(record.operationHash, 'publish.operationHash');
      if (record.publishContentHash !== null) requiredString(record.publishContentHash, 'publish.publishContentHash');
      break;
    case 'hexai.mailbox.publish-committed':
      requiredString(record.publishOperationId, 'committed.publishOperationId');
      requiredString(record.sessionId, 'committed.sessionId');
      requiredString(record.attemptId, 'committed.attemptId');
      requiredString(record.activeCursorHash, 'committed.activeCursorHash');
      requiredString(record.operationHash, 'committed.operationHash');
      requiredString(record.expectedOutputPathHash, 'committed.expectedOutputPathHash');
      requiredString(record.publishContentHash, 'committed.publishContentHash');
      break;
    case 'hexai.mailbox.close-ledger':
      requiredString(record.sessionId, 'close.sessionId');
      requiredString(record.attemptId, 'close.attemptId');
      requiredString(record.closeOperationId, 'close.closeOperationId');
      requiredString(record.activeCursorHash, 'close.activeCursorHash');
      if (!['close-intent', 'close-event-written', 'session-closed', 'status-cleared', 'close-committed'].includes(record.phase)) {
        throw new Error(`invalid-close-phase: ${record.phase}`);
      }
      requiredString(record.terminalPreconditionState, 'close.terminalPreconditionState');
      if (typeof record.statusWasActive !== 'boolean') throw new Error('close.statusWasActive must be boolean');
      requiredString(record.payloadHash, 'close.payloadHash');
      break;
    default:
      throw new Error(`unknown-mailbox-kind: ${kind}`);
  }
  return record;
};

export class MailboxStore {
  constructor({ harnessRoot, taskId, reviewRoot = null, faultInjector = null }) {
    if (!harnessRoot || !taskId) throw new Error('harnessRoot and taskId are required');
    this.harnessRoot = harnessRoot;
    this.taskId = taskId;
    this.reviewRoot = reviewRoot || path.dirname(harnessRoot);
    this.faultInjector = faultInjector;
    const runRoot = path.join(harnessRoot, 'runs', taskId);
    const mailboxRoot = path.join(runRoot, 'mailbox');
    this.paths = {
      runRoot,
      mailboxRoot,
      bindings: path.join(mailboxRoot, 'bindings'),
      bindingReplaced: path.join(mailboxRoot, 'bindings', 'replaced'),
      bindingSecrets: path.join(mailboxRoot, 'bindings', '.secrets'),
      publishLedger: path.join(mailboxRoot, 'publish-ledger'),
      publishCommitted: path.join(mailboxRoot, 'publish-committed'),
      closeLedger: path.join(mailboxRoot, 'close-ledger'),
      inbox: path.join(mailboxRoot, 'inbox'),
      claimed: path.join(mailboxRoot, 'claimed'),
      done: path.join(mailboxRoot, 'done'),
      rejected: path.join(mailboxRoot, 'rejected'),
      sessions: path.join(mailboxRoot, 'sessions'),
      receipts: path.join(mailboxRoot, 'receipts'),
      receiptLedger: path.join(mailboxRoot, 'receipt-ledger'),
      roleEvidence: path.join(mailboxRoot, 'role-evidence'),
      roleEvidenceLedger: path.join(mailboxRoot, 'role-evidence', 'ledger.jsonl'),
      roleEvidenceByWorker: path.join(mailboxRoot, 'role-evidence', 'by-worker'),
      roleEvidenceBySession: path.join(mailboxRoot, 'role-evidence', 'by-session'),
      eventsDir: path.join(mailboxRoot, 'events'),
      eventsFile: path.join(mailboxRoot, 'events', 'mailbox.jsonl'),
      eventIndex: path.join(mailboxRoot, 'events', 'index'),
    };
  }

  bindingPath(bindingId) {
    return path.join(this.paths.bindings, `${assertBindingId(bindingId)}.json`);
  }

  bindingSecretPath(bindingId) {
    return path.join(this.paths.bindingSecrets, `${assertBindingId(bindingId)}.nonce`);
  }

  replacedBindingPath(bindingId, generation) {
    return path.join(this.paths.bindingReplaced, `${assertBindingId(bindingId)}.${positiveInteger(generation, 'bindingGeneration')}.json`);
  }

  sessionPath(sessionId) {
    return path.join(this.paths.sessions, `${requiredString(sessionId, 'sessionId')}.json`);
  }

  envelopePath(sessionId) {
    return path.join(this.paths.inbox, `${requiredString(sessionId, 'sessionId')}.json`);
  }

  publishLedgerPath(sessionId) {
    return path.join(this.paths.publishLedger, `${requiredString(sessionId, 'sessionId')}.json`);
  }

  publishCommittedPath(sessionId) {
    return path.join(this.paths.publishCommitted, `${requiredString(sessionId, 'sessionId')}.json`);
  }

  closeLedgerPath(sessionId) {
    return path.join(this.paths.closeLedger, `${requiredString(sessionId, 'sessionId')}.json`);
  }

  assertMailboxRootContained() {
    return resolveInsideRoot(this.paths.mailboxRoot, this.paths.runRoot);
  }

  assertMailboxFileTarget(filePath) {
    this.assertMailboxRootContained();
    return resolveInsideRoot(filePath, this.paths.mailboxRoot, { allowMissingLeaf: true });
  }

  ensureMailboxRoot() {
    ensureDirInsideRoot(this.paths.mailboxRoot, this.paths.runRoot);
    return resolveInsideRoot(this.paths.mailboxRoot, this.paths.runRoot);
  }

  ensureMailboxDir(directory) {
    this.ensureMailboxRoot();
    ensureDirInsideRoot(directory, this.paths.mailboxRoot);
    return resolveInsideRoot(directory, this.paths.mailboxRoot);
  }

  ensureMailboxFileTarget(filePath) {
    this.ensureMailboxDir(path.dirname(filePath));
    return this.assertMailboxFileTarget(filePath);
  }

  atomicWriteMailboxJson(filePath, value) {
    this.ensureMailboxFileTarget(filePath);
    atomicWriteJson(filePath, value, { faultInjector: this.faultInjector });
  }

  atomicWriteMailboxFile(filePath, contents, options = {}) {
    this.ensureMailboxFileTarget(filePath);
    atomicWriteFile(filePath, contents, { ...options, faultInjector: this.faultInjector });
  }

  readMailboxRecord(kind, filePath) {
    if (!fs.existsSync(filePath)) return null;
    this.assertMailboxFileTarget(filePath);
    const record = readJson(filePath);
    return record ? validateMailboxRecord(kind, record) : null;
  }

  readBinding(bindingId) {
    return this.readMailboxRecord('hexai.mailbox.binding', this.bindingPath(bindingId));
  }

  readBindingSecret(bindingId) {
    const secretPath = this.bindingSecretPath(bindingId);
    if (!fs.existsSync(secretPath)) return null;
    this.assertMailboxFileTarget(secretPath);
    return fs.readFileSync(secretPath, 'utf8');
  }

  createBinding({ bindingId, role, replace = false, metadata = {}, workerIdentityHash = null, createdAt = isoNow() }) {
    assertBindingId(bindingId);
    if (!['work', 'review'].includes(role)) throw new Error('role must be work or review');
    const existing = this.readBinding(bindingId);
    if (existing?.state === 'live' && !replace) throw new Error(`binding-already-live: ${bindingId}`);
    const bindingGeneration = existing ? positiveInteger(existing.bindingGeneration, 'binding.bindingGeneration') + 1 : 1;
    const rawNonce = randomBytes(32).toString('base64url');
    this.ensureMailboxDir(this.paths.bindings);
    this.ensureMailboxDir(this.paths.bindingSecrets);
    this.ensureMailboxFileTarget(this.bindingPath(bindingId));
    this.ensureMailboxFileTarget(this.bindingSecretPath(bindingId));
    if (existing && replace) {
      this.ensureMailboxFileTarget(this.replacedBindingPath(bindingId, existing.bindingGeneration));
    }
    const binding = validateMailboxRecord('hexai.mailbox.binding', {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.binding',
      taskId: this.taskId,
      bindingId,
      role,
      bindingGeneration,
      sessionId: randomUUID(),
      sessionNonceHash: sha256Text(rawNonce),
      workerIdentityHash: workerIdentityHash || sha256Text(`worker:${bindingId}`),
      createdAt,
      heartbeatAt: createdAt,
      state: 'live',
      metadata,
    });
    if (existing && replace) {
      this.atomicWriteMailboxJson(this.replacedBindingPath(bindingId, existing.bindingGeneration), {
        ...existing,
        state: 'replaced',
        replacedAt: createdAt,
      });
    }
    this.atomicWriteMailboxJson(this.bindingPath(bindingId), binding);
    this.faultInjector?.('after-binding-json-before-nonce', { bindingId });
    this.atomicWriteMailboxFile(this.bindingSecretPath(bindingId), rawNonce, { mode: 0o600 });
    return { binding, rawNonce };
  }

  verifyBindingProof(bindingId, receipt) {
    const binding = this.readBinding(bindingId);
    if (!binding || binding.state !== 'live') return false;
    if (receipt?.binding?.bindingGeneration !== binding.bindingGeneration) return false;
    const rawNonce = this.readBindingSecret(bindingId);
    if (!rawNonce || sha256Text(rawNonce) !== binding.sessionNonceHash) return false;
    return timingSafeEqualString(receipt.proof, hmacSha256(rawNonce, canonicalReceiptPayload(receipt)));
  }

  roleEvidenceWorkerPath(workerIdentityHash) {
    return path.join(this.paths.roleEvidenceByWorker, `${safeEvidenceFileName(workerIdentityHash)}.json`);
  }

  roleEvidenceSessionPath(sessionId) {
    return path.join(this.paths.roleEvidenceBySession, `${safeEvidenceFileName(sessionId)}.json`);
  }

  readRoleEvidenceEvents() {
    if (!fs.existsSync(this.paths.roleEvidenceLedger)) return [];
    this.assertMailboxFileTarget(this.paths.roleEvidenceLedger);
    return readJsonLines(this.paths.roleEvidenceLedger).map(event => this.validateRoleEvidenceEvent(event));
  }

  validateRoleEvidenceEvent(event) {
    assertPlainObject(event, 'roleEvidence');
    if (event.protocolVersion !== MAILBOX_PROTOCOL_VERSION) throw new Error('roleEvidence.protocolVersion mismatch');
    if (event.kind !== 'hexai.mailbox.role-evidence') throw new Error('roleEvidence.kind mismatch');
    requiredString(event.eventId, 'roleEvidence.eventId');
    requiredString(event.taskId, 'roleEvidence.taskId');
    if (event.taskId !== this.taskId) throw new Error('roleEvidence.taskId mismatch');
    requiredString(event.sessionId, 'roleEvidence.sessionId');
    requiredString(event.attemptId, 'roleEvidence.attemptId');
    requiredString(event.activeCursorHash, 'roleEvidence.activeCursorHash');
    assertPlainObject(event.stageCursor, 'roleEvidence.stageCursor');
    if (!['work', 'review'].includes(event.stageRole)) throw new Error(`invalid-role-evidence-stage-role: ${event.stageRole}`);
    if (!ROLE_EVIDENCE_STATES.includes(event.evidenceState)) throw new Error(`invalid-role-evidence-state: ${event.evidenceState}`);
    assertBindingId(event.bindingId);
    positiveInteger(event.bindingGeneration, 'roleEvidence.bindingGeneration');
    requiredString(event.workerIdentityHash, 'roleEvidence.workerIdentityHash');
    requiredString(event.source, 'roleEvidence.source');
    return event;
  }

  buildRoleEvidenceWorkerIndex(workerIdentityHash, events = this.readRoleEvidenceEvents()) {
    const roles = {
      work: { claimed: [], receiptAccepted: [], gateSatisfied: [], gateRejected: [] },
      review: { claimed: [], receiptAccepted: [], gateSatisfied: [], gateRejected: [] },
    };
    for (const event of events.filter(item => item.workerIdentityHash === workerIdentityHash)) {
      const ref = {
        eventId: event.eventId,
        sessionId: event.sessionId,
        attemptId: event.attemptId,
        activeCursorHash: event.activeCursorHash,
        stage: event.stageCursor?.stage || null,
        occurredAt: event.occurredAt || null,
      };
      if (event.evidenceState === 'claimed') roles[event.stageRole].claimed.push(ref);
      if (event.evidenceState === 'receipt-accepted') roles[event.stageRole].receiptAccepted.push(ref);
      if (event.evidenceState === 'gate-satisfied') roles[event.stageRole].gateSatisfied.push(ref);
      if (event.evidenceState === 'gate-rejected') roles[event.stageRole].gateRejected.push(ref);
    }
    return {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.role-evidence-worker-index',
      taskId: this.taskId,
      workerIdentityHash,
      ledgerTailHash: canonicalHash(events),
      roles,
      updatedAt: isoNow(),
    };
  }

  buildRoleEvidenceSessionIndex(sessionId, events = this.readRoleEvidenceEvents()) {
    const sessionEvents = events.filter(item => item.sessionId === sessionId);
    const last = sessionEvents.at(-1) || null;
    return {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.role-evidence-session-index',
      taskId: this.taskId,
      sessionId,
      ledgerTailHash: canonicalHash(events),
      stageRole: last?.stageRole || null,
      bindingId: last?.bindingId || null,
      bindingGeneration: last?.bindingGeneration || null,
      workerIdentityHash: last?.workerIdentityHash || null,
      receiptAccepted: sessionEvents.filter(item => item.evidenceState === 'receipt-accepted').map(item => item.eventId),
      gateSatisfied: sessionEvents.some(item => item.evidenceState === 'gate-satisfied'),
      updatedAt: isoNow(),
    };
  }

  validateRoleEvidenceIndexes({ workerIdentityHash, sessionId = null, allowMissingEmpty = false } = {}) {
    let events;
    try {
      events = this.readRoleEvidenceEvents();
      const workerEvents = events.filter(item => item.workerIdentityHash === workerIdentityHash);
      const workerPath = this.roleEvidenceWorkerPath(workerIdentityHash);
      if (!fs.existsSync(workerPath)) {
        if (allowMissingEmpty && workerEvents.length === 0) return { events, workerIndex: this.buildRoleEvidenceWorkerIndex(workerIdentityHash, events), sessionIndex: null };
        throw new Error(`role-evidence-worker-index-missing: ${workerIdentityHash}`);
      }
      this.assertMailboxFileTarget(workerPath);
      const workerIndex = readJson(workerPath);
      const expectedWorker = this.buildRoleEvidenceWorkerIndex(workerIdentityHash, events);
      if (canonicalHash({ ...workerIndex, updatedAt: null }) !== canonicalHash({ ...expectedWorker, updatedAt: null })) {
        throw new Error(`role-evidence-worker-index-mismatch: ${workerIdentityHash}`);
      }
      let sessionIndex = null;
      if (sessionId) {
        const sessionEvents = events.filter(item => item.sessionId === sessionId);
        const sessionPath = this.roleEvidenceSessionPath(sessionId);
        if (!fs.existsSync(sessionPath)) {
          if (!(allowMissingEmpty && sessionEvents.length === 0)) throw new Error(`role-evidence-session-index-missing: ${sessionId}`);
        } else {
          this.assertMailboxFileTarget(sessionPath);
          sessionIndex = readJson(sessionPath);
          const expectedSession = this.buildRoleEvidenceSessionIndex(sessionId, events);
          if (canonicalHash({ ...sessionIndex, updatedAt: null }) !== canonicalHash({ ...expectedSession, updatedAt: null })) {
            throw new Error(`role-evidence-session-index-mismatch: ${sessionId}`);
          }
        }
      }
      return { events, workerIndex, sessionIndex };
    } catch (error) {
      this.appendRoleEvidenceQuarantine({
        reason: 'role-evidence-unverifiable',
        detail: error.message,
        workerIdentityHash,
        sessionId,
      });
      throw error;
    }
  }

  appendRoleEvidenceQuarantine({ reason, detail = null, workerIdentityHash = null, sessionId = null }) {
    this.appendEvent({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'mailbox.role-evidence-quarantine',
      eventId: randomUUID(),
      taskId: this.taskId,
      reason,
      detail,
      workerIdentityHash,
      sessionId,
      occurredAt: isoNow(),
    });
  }

  appendRoleEvidence(event) {
    const record = this.validateRoleEvidenceEvent({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.role-evidence',
      eventId: event.eventId || randomUUID(),
      taskId: this.taskId,
      occurredAt: isoNow(),
      receiptRefs: event.receiptRefs || [],
      checkResultHash: event.checkResultHash || null,
      primarySnapshotHash: event.primarySnapshotHash || null,
      ...event,
    });
    this.ensureMailboxFileTarget(this.paths.roleEvidenceLedger);
    appendJsonLine(this.paths.roleEvidenceLedger, record, { faultInjector: this.faultInjector });
    const events = this.readRoleEvidenceEvents();
    this.atomicWriteMailboxJson(this.roleEvidenceWorkerPath(record.workerIdentityHash), this.buildRoleEvidenceWorkerIndex(record.workerIdentityHash, events));
    this.atomicWriteMailboxJson(this.roleEvidenceSessionPath(record.sessionId), this.buildRoleEvidenceSessionIndex(record.sessionId, events));
    return record;
  }

  assertNoOppositeRoleGateSatisfied({ session, binding, stageRole, source, evidenceState = 'gate-rejected' }) {
    if (!binding?.workerIdentityHash || !['work', 'review'].includes(stageRole)) return null;
    const opposite = stageRole === 'work' ? 'review' : 'work';
    const { workerIndex } = this.validateRoleEvidenceIndexes({
      workerIdentityHash: binding.workerIdentityHash,
      sessionId: session.sessionId,
      allowMissingEmpty: true,
    });
    const conflict = workerIndex.roles[opposite].gateSatisfied.find(item => item.sessionId !== session.sessionId);
    if (!conflict) return null;
    this.appendRoleEvidence({
      sessionId: session.sessionId,
      attemptId: session.attemptId,
      activeCursorHash: session.activeCursorHash,
      stageCursor: session.stageCursor,
      stageRole,
      evidenceState,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workerIdentityHash: binding.workerIdentityHash,
      source,
      receiptRefs: [],
    });
    throw new Error(`mailbox-role-isolation-conflict: ${binding.workerIdentityHash}`);
  }

  appendClaimedRoleEvidence({ session, binding, source }) {
    this.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source });
    return this.appendRoleEvidence({
      sessionId: session.sessionId,
      attemptId: session.attemptId,
      activeCursorHash: session.activeCursorHash,
      stageCursor: session.stageCursor,
      stageRole: binding.role,
      evidenceState: 'claimed',
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workerIdentityHash: binding.workerIdentityHash,
      source,
      receiptRefs: [],
    });
  }

  appendReceiptAcceptedRoleEvidence(receipt) {
    if (receipt.source !== 'claude-code-worker') return null;
    const binding = this.readBinding(receipt.binding?.bindingId);
    if (!binding?.workerIdentityHash) return null;
    return this.appendRoleEvidence({
      sessionId: receipt.sessionId,
      attemptId: receipt.attemptId,
      activeCursorHash: receipt.activeCursorHash,
      stageCursor: receipt.stageCursor,
      stageRole: binding.role,
      evidenceState: 'receipt-accepted',
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workerIdentityHash: binding.workerIdentityHash,
      source: receipt.source,
      receiptRefs: [{ eventId: receipt.eventId, sequence: receipt.sequence, kind: receipt.kind }],
    });
  }

  appendGateSatisfiedRoleEvidence({ session, binding, source = 'claude-code-worker', checkResultHash = null, primarySnapshotHash = null, receiptRefs = [] }) {
    if (!binding?.workerIdentityHash) return null;
    this.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source });
    const { workerIndex } = this.validateRoleEvidenceIndexes({
      workerIdentityHash: binding.workerIdentityHash,
      sessionId: session.sessionId,
      allowMissingEmpty: false,
    });
    const existing = workerIndex.roles[binding.role].gateSatisfied.find(item => item.sessionId === session.sessionId);
    if (existing) return existing;
    return this.appendRoleEvidence({
      sessionId: session.sessionId,
      attemptId: session.attemptId,
      activeCursorHash: session.activeCursorHash,
      stageCursor: session.stageCursor,
      stageRole: binding.role,
      evidenceState: 'gate-satisfied',
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workerIdentityHash: binding.workerIdentityHash,
      source,
      checkResultHash,
      primarySnapshotHash,
      receiptRefs,
    });
  }

  writeSession(session) {
    validateMailboxRecord('hexai.mailbox.session', session);
    this.atomicWriteMailboxJson(this.sessionPath(session.sessionId), session);
    return session;
  }

  readSession(sessionId) {
    return this.readMailboxRecord('hexai.mailbox.session', this.sessionPath(sessionId));
  }

  validateEnvelopePaths(envelope, expectedOutputPath = null) {
    if (envelope?.kind !== 'hexai.mailbox.task') throw new Error('envelope.kind mismatch');
    requiredString(envelope.sessionId, 'envelope.sessionId');
    requiredString(envelope.attemptId, 'envelope.attemptId');
    requiredString(envelope.activeCursorHash, 'envelope.activeCursorHash');
    assertPlainObject(envelope.stageCursor, 'envelope.stageCursor');
    assertPlainObject(envelope.prompt, 'envelope.prompt');
    assertPlainObject(envelope.expectedOutput, 'envelope.expectedOutput');
    const promptPath = requiredString(envelope.prompt.path, 'envelope.prompt.path');
    requiredString(envelope.prompt.sha256, 'envelope.prompt.sha256');
    const outputPath = requiredString(envelope.expectedOutput.primaryReportPath, 'envelope.expectedOutput.primaryReportPath');
    for (const checkedPath of [promptPath, outputPath]) {
      if (hasSensitivePathSegment(checkedPath)) throw new Error(`sensitive-path-rejected: ${checkedPath}`);
    }

    const promptRoot = path.join(this.paths.runRoot, 'prompts');
    resolveInsideRoot(promptRoot, this.paths.runRoot);
    const promptRealpath = resolveInsideRoot(promptPath, promptRoot);
    const outputRoot = path.join(this.reviewRoot, subtaskWeek(envelope.stageCursor.subtaskId), envelope.stageCursor.subtaskId);
    ensureDirInsideRoot(outputRoot, this.reviewRoot);
    resolveInsideRoot(outputRoot, this.reviewRoot);
    const outputRealpath = resolveInsideRoot(outputPath, outputRoot, { allowMissingLeaf: true });
    if (expectedOutputPath) {
      const expectedRealpath = resolveInsideRoot(expectedOutputPath, outputRoot, { allowMissingLeaf: true });
      if (expectedRealpath !== outputRealpath) throw new Error('envelope-output-path-mismatch');
    }
    return {
      promptRealpath,
      outputRealpath,
      expectedOutputPathHash: sha256Text(outputRealpath),
    };
  }

  validatePromptForLedger(ledger, promptPath, promptHash, label) {
    if (!ledger?.promptHash) throw new Error('promptHash required before prompt validation');
    if (requiredString(promptHash, `${label}.promptSha256`) !== ledger.promptHash) {
      throw new Error(`${label}-prompt-hash-mismatch`);
    }
    const promptRoot = path.join(this.paths.runRoot, 'prompts');
    resolveInsideRoot(promptRoot, this.paths.runRoot);
    const promptRealpath = resolveInsideRoot(requiredString(promptPath, `${label}.promptPath`), promptRoot);
    if (sha256File(promptRealpath) !== ledger.promptHash) throw new Error(`${label}-prompt-file-hash-mismatch`);
    return promptRealpath;
  }

  validateEnvelopeForLedger(ledger, envelope, expectedOutputPath = null) {
    assertLedgerScopedRecord(ledger, envelope, 'envelope');
    const result = this.validateEnvelopePaths(envelope, expectedOutputPath);
    if (envelope.prompt.sha256 !== ledger.promptHash) throw new Error('envelope-prompt-hash-mismatch');
    if (sha256File(result.promptRealpath) !== ledger.promptHash) throw new Error('prompt-file-hash-mismatch');
    return result;
  }

  writeEnvelope() {
    throw new Error('unfenced-envelope-write');
  }

  writeEnvelopeForLedger(ledger, envelope, expectedOutputPath = null) {
    this.validateEnvelopeForLedger(ledger, envelope, expectedOutputPath);
    this.atomicWriteMailboxJson(this.envelopePath(ledger.sessionId), envelope);
    return envelope;
  }

  readEnvelope(sessionId) {
    if (fs.existsSync(this.envelopePath(sessionId))) this.assertMailboxFileTarget(this.envelopePath(sessionId));
    return readJson(this.envelopePath(sessionId));
  }

  createPublishIntent({
    publishOperationId = randomUUID(),
    sessionId = randomUUID(),
    attemptId = randomUUID(),
    stageCursor,
    statusRevisionBefore,
    createdAt = isoNow(),
  }) {
    const cursor = createMailboxStageCursor({ ...stageCursor, activeSessionId: sessionId, activeAttemptId: attemptId });
    const ledger = {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.publish-ledger',
      taskId: this.taskId,
      publishOperationId,
      sessionId,
      attemptId,
      stageCursor: cursor,
      activeCursorHash: activeCursorHash(cursor),
      phase: 'intent',
      promptHash: null,
      envelopeHash: null,
      expectedOutputPathHash: null,
      publishContentHash: null,
      statusRevisionBefore: nonNegativeInteger(statusRevisionBefore, 'statusRevisionBefore'),
      statusRevisionAfter: null,
      statusCasToken: null,
      operationHash: null,
      createdAt,
      updatedAt: createdAt,
      committedAt: null,
      recoveryEvents: [],
    };
    ledger.operationHash = hashOperation(ledger);
    this.writePublishLedger(ledger);
    return ledger;
  }

  readPublishLedger(sessionId) {
    return this.readMailboxRecord('hexai.mailbox.publish-ledger', this.publishLedgerPath(sessionId));
  }

  writePublishLedger(ledger) {
    validateMailboxRecord('hexai.mailbox.publish-ledger', ledger);
    if (ledger.operationHash !== hashOperation(ledger)) throw new Error(`publish-operation-hash-mismatch: ${ledger.sessionId}`);
    if (ledger.publishContentHash !== null && ledger.publishContentHash !== hashPublishContent(ledger)) {
      throw new Error(`publish-content-hash-mismatch: ${ledger.sessionId}`);
    }
    const existing = this.readPublishLedger(ledger.sessionId);
    if (existing) {
      if (existing.operationHash !== ledger.operationHash) throw new Error(`publish-operation-collision: ${ledger.sessionId}`);
      if (PUBLISH_PHASE_ORDER[ledger.phase] < PUBLISH_PHASE_ORDER[existing.phase]) {
        throw new Error(`publish-phase-rollback: ${existing.phase}->${ledger.phase}`);
      }
      if (existing.publishContentHash && ledger.publishContentHash !== existing.publishContentHash) {
        throw new Error(`publish-content-collision: ${ledger.sessionId}`);
      }
      if (existing.publishContentHash && ledger.publishContentHash && existing.publishContentHash !== ledger.publishContentHash) {
        throw new Error(`publish-content-collision: ${ledger.sessionId}`);
      }
    }
    this.atomicWriteMailboxJson(this.publishLedgerPath(ledger.sessionId), ledger);
    return ledger;
  }

  updatePublish(sessionId, updates, expectedPhase) {
    const current = this.readPublishLedger(sessionId);
    if (!current) throw new Error(`publish-ledger-not-found: ${sessionId}`);
    if (expectedPhase && current.phase !== expectedPhase) throw new Error(`publish-phase-conflict: expected ${expectedPhase}, got ${current.phase}`);
    const next = { ...current, ...updates, updatedAt: isoNow() };
    return this.writePublishLedger(next);
  }

  markPromptWritten(sessionId, promptHash) {
    return this.updatePublish(sessionId, { promptHash: requiredString(promptHash, 'promptHash'), phase: 'prompt-written' }, 'intent');
  }

  markSessionWritten(sessionId, session) {
    const current = this.readPublishLedger(sessionId);
    if (!current) throw new Error(`publish-ledger-not-found: ${sessionId}`);
    if (current.phase !== 'prompt-written') throw new Error(`publish-phase-conflict: expected prompt-written, got ${current.phase}`);
    validateMailboxRecord('hexai.mailbox.session', session);
    assertLedgerScopedRecord(current, session, 'session');
    this.validatePromptForLedger(current, session.promptPath, session.promptSha256, 'session');
    this.writeSession(session);
    return this.updatePublish(sessionId, { phase: 'session-written' }, 'prompt-written');
  }

  markEnvelopePublished(sessionId, envelope, expectedOutputPath) {
    const current = this.readPublishLedger(sessionId);
    if (!current?.promptHash) throw new Error('promptHash required before envelope publish');
    if (current.phase !== 'session-written') throw new Error(`publish-phase-conflict: expected session-written, got ${current.phase}`);
    const session = this.readSession(current.sessionId);
    if (!session) throw new Error(`session-record-not-found: ${current.sessionId}`);
    assertLedgerScopedRecord(current, session, 'session');
    this.validatePromptForLedger(current, session.promptPath, session.promptSha256, 'session');
    const { expectedOutputPathHash } = this.validateEnvelopeForLedger(current, envelope, expectedOutputPath);
    this.writeEnvelopeForLedger(current, envelope, expectedOutputPath);
    const envelopeHash = canonicalHash(envelope);
    const next = {
      ...current,
      phase: 'envelope-published',
      envelopeHash,
      expectedOutputPathHash,
      updatedAt: isoNow(),
    };
    next.publishContentHash = hashPublishContent(next);
    return this.writePublishLedger(next);
  }

  markStatusActive(sessionId, { statusRevisionAfter, statusCasToken = null }) {
    return this.updatePublish(sessionId, {
      phase: 'status-active',
      statusRevisionAfter: nonNegativeInteger(statusRevisionAfter, 'statusRevisionAfter'),
      statusCasToken,
    }, 'envelope-published');
  }

  commitPublish(sessionId, committedAt = isoNow()) {
    const ledger = this.readPublishLedger(sessionId);
    if (!ledger) throw new Error(`publish-ledger-not-found: ${sessionId}`);
    if (ledger.phase !== 'status-active' && ledger.phase !== 'committed') {
      throw new Error(`publish-not-status-active: ${sessionId}`);
    }
    if (!ledger.publishContentHash) throw new Error(`publish-content-hash-missing: ${sessionId}`);
    const committed = validateMailboxRecord('hexai.mailbox.publish-committed', {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.publish-committed',
      taskId: this.taskId,
      publishOperationId: ledger.publishOperationId,
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      activeCursorHash: ledger.activeCursorHash,
      operationHash: ledger.operationHash,
      expectedOutputPathHash: ledger.expectedOutputPathHash,
      publishContentHash: ledger.publishContentHash,
      committedAt,
    });
    const existing = this.readMailboxRecord('hexai.mailbox.publish-committed', this.publishCommittedPath(sessionId));
    if (existing) {
      for (const field of PUBLISH_COMMITTED_IDENTITY_FIELDS) {
        if (existing[field] !== committed[field]) throw new Error(`publish-committed-marker-collision: ${sessionId}`);
      }
      if (ledger.phase !== 'committed') {
        this.writePublishLedger({ ...ledger, phase: 'committed', committedAt: existing.committedAt, updatedAt: existing.committedAt });
      }
      return existing;
    }
    this.atomicWriteMailboxJson(this.publishCommittedPath(sessionId), committed);
    if (ledger.phase !== 'committed') {
      this.writePublishLedger({ ...ledger, phase: 'committed', committedAt, updatedAt: committedAt });
    }
    return committed;
  }

  assertPublishCommitted(sessionId) {
    const ledger = this.readPublishLedger(sessionId);
    const marker = this.readMailboxRecord('hexai.mailbox.publish-committed', this.publishCommittedPath(sessionId));
    if (!ledger || !marker) throw new Error(`publish-not-committed: ${sessionId}`);
    if (ledger.phase !== 'committed') throw new Error(`publish-ledger-not-committed: ${sessionId}`);
    for (const field of PUBLISH_COMMITTED_IDENTITY_FIELDS) {
      if (ledger[field] !== marker[field]) throw new Error(`publish-committed-marker-mismatch: ${field}`);
    }
    return { ledger, marker };
  }

  readCloseLedger(sessionId) {
    return this.readMailboxRecord('hexai.mailbox.close-ledger', this.closeLedgerPath(sessionId));
  }

  writeCloseLedger(ledger) {
    validateMailboxRecord('hexai.mailbox.close-ledger', ledger);
    if (ledger.payloadHash !== hashClosePayload(ledger)) throw new Error(`close-payload-hash-mismatch: ${ledger.sessionId}`);
    const existing = this.readCloseLedger(ledger.sessionId);
    if (existing && existing.payloadHash !== ledger.payloadHash) {
      throw new Error(`close-payload-collision: ${ledger.sessionId}`);
    }
    this.atomicWriteMailboxJson(this.closeLedgerPath(ledger.sessionId), ledger);
    return ledger;
  }

  createCloseIntent({
    sessionId,
    attemptId,
    activeCursorHash,
    terminalPreconditionState,
    statusWasActive = true,
    closeOperationId = randomUUID(),
    createdAt = isoNow(),
  }) {
    const ledger = {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'hexai.mailbox.close-ledger',
      taskId: this.taskId,
      sessionId: requiredString(sessionId, 'sessionId'),
      attemptId: requiredString(attemptId, 'attemptId'),
      closeOperationId,
      activeCursorHash: requiredString(activeCursorHash, 'activeCursorHash'),
      phase: 'close-intent',
      terminalPreconditionState: requiredString(terminalPreconditionState, 'terminalPreconditionState'),
      statusWasActive,
      createdAt,
      updatedAt: createdAt,
      committedAt: null,
      payloadHash: null,
      recovered: false,
      recoveryEvents: [],
    };
    ledger.payloadHash = hashClosePayload(ledger);
    return this.writeCloseLedger(ledger);
  }

  advanceCloseLedger(sessionId, phase, updates = {}) {
    const current = this.readCloseLedger(sessionId);
    if (!current) throw new Error(`close-ledger-not-found: ${sessionId}`);
    const next = {
      ...current,
      ...updates,
      phase,
      updatedAt: isoNow(),
      committedAt: phase === 'close-committed' ? (updates.committedAt || isoNow()) : current.committedAt,
    };
    return this.writeCloseLedger(next);
  }

  recoverCloseAfterStatusCleared(sessionId, { statusActiveSessionId = null, reason = 'status already cleared' } = {}) {
    const ledger = this.readCloseLedger(sessionId);
    const session = this.readSession(sessionId);
    if (!ledger) throw new Error(`close-ledger-not-found: ${sessionId}`);
    if (!session || session.state !== 'closed') throw new Error(`close-recovery-session-not-closed: ${sessionId}`);
    if (statusActiveSessionId && statusActiveSessionId !== sessionId) {
      const rejected = {
        eventId: randomUUID(),
        kind: 'mailbox.close-recovery',
        recoveryAction: 'reject-mismatch',
        sessionId,
        statusActiveSessionId,
        reason,
        occurredAt: isoNow(),
      };
      this.appendEvent(rejected);
      throw new Error(`close-recovery-status-active-other-session: ${statusActiveSessionId}`);
    }
    if (ledger.phase === 'close-committed') return { recovered: false, ledger };
    let next = ledger;
    if (ledger.phase === 'session-closed') {
      this.appendEvent({
        eventId: randomUUID(),
        kind: 'mailbox.close-recovery',
        recoveryAction: 'continue-status-cleared',
        sessionId,
        closeOperationId: ledger.closeOperationId,
        closePhaseBefore: 'session-closed',
        closePhaseAfter: 'status-cleared',
        reason,
        occurredAt: isoNow(),
      });
      next = this.advanceCloseLedger(sessionId, 'status-cleared', { recovered: true });
    }
    if (next.phase === 'status-cleared') {
      this.appendEvent({
        eventId: randomUUID(),
        kind: 'mailbox.close-recovery',
        recoveryAction: 'commit-close',
        sessionId,
        closeOperationId: next.closeOperationId,
        closePhaseBefore: 'status-cleared',
        closePhaseAfter: 'close-committed',
        reason,
        occurredAt: isoNow(),
      });
      next = this.advanceCloseLedger(sessionId, 'close-committed', { recovered: true });
    }
    return { recovered: true, ledger: next };
  }

  receiptPath(bucket, attemptId, eventId) {
    if (!['inbox', 'processed', 'rejected'].includes(bucket)) throw new Error(`invalid-receipt-bucket: ${bucket}`);
    return path.join(this.paths.receipts, bucket, requiredString(attemptId, 'attemptId'), `${requiredString(eventId, 'eventId')}.json`);
  }

  receiptSequenceLedgerPath(attemptId) {
    return path.join(this.paths.receiptLedger, `${requiredString(attemptId, 'attemptId')}.json`);
  }

  receiptSequenceLockPath(attemptId) {
    return `${this.receiptSequenceLedgerPath(attemptId)}.lock`;
  }

  recoverReceiptSequenceLock(attemptId, { reason = 'manual recovery' } = {}) {
    const lockPath = this.receiptSequenceLockPath(attemptId);
    if (!fs.existsSync(lockPath)) return { recovered: false, lockPath };
    this.assertMailboxFileTarget(lockPath);
    fs.rmSync(lockPath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
    this.appendEvent({
      eventId: randomUUID(),
      kind: 'mailbox.receipt-sequence-lock-recovery',
      attemptId,
      reason,
      occurredAt: isoNow(),
    });
    return { recovered: true, lockPath };
  }

  allocateReceiptSequence({ attemptId, eventId, inputHash, receiptPath }) {
    const ledgerPath = this.receiptSequenceLedgerPath(attemptId);
    const lockPath = this.receiptSequenceLockPath(attemptId);
    this.ensureMailboxDir(path.dirname(ledgerPath));
    let lockFd;
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(lockFd, JSON.stringify({ attemptId, pid: process.pid, createdAt: isoNow() }));
      fs.fsyncSync(lockFd);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`receipt-sequence-lock-exists: ${attemptId}`);
      throw error;
    }
    try {
      const ledger = readJson(ledgerPath) || {
        protocolVersion: MAILBOX_PROTOCOL_VERSION,
        attemptId,
        nextSequence: 1,
        events: {},
        payloads: {},
      };
      const existing = ledger.events[eventId];
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error(`event-id-collision: ${eventId}`);
        return { status: 'duplicate-event', ...existing };
      }
      const sequence = ledger.nextSequence;
      const next = {
        ...ledger,
        nextSequence: sequence + 1,
        events: { ...ledger.events, [eventId]: { eventId, inputHash, sequence, receiptPath } },
        payloads: { ...ledger.payloads, [inputHash]: eventId },
        updatedAt: isoNow(),
      };
      this.atomicWriteMailboxJson(ledgerPath, next);
      return { status: 'allocated', eventId, inputHash, sequence, receiptPath };
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
      fsyncDirectory(path.dirname(lockPath));
    }
  }

  publishReceipt(input) {
    const bindingId = requiredString(input.bindingId, 'bindingId');
    const binding = this.readBinding(bindingId);
    if (!binding || binding.state !== 'live') throw new Error(`binding-not-live: ${bindingId}`);
    if (binding.role !== input.role) throw new Error(`binding-role-mismatch: ${bindingId}`);
    const kind = requiredString(input.kind, 'kind');
    if (!RECEIPT_KINDS.includes(kind)) throw new Error(`invalid-receipt-kind: ${kind}`);
    const committed = this.assertPublishCommitted(requiredString(input.sessionId, 'sessionId'));
    if (committed.ledger.attemptId !== input.attemptId) throw new Error('receipt-attempt-mismatch');
    if (committed.ledger.activeCursorHash !== input.activeCursorHash) throw new Error('receipt-cursor-hash-mismatch');
    const stageCursor = createMailboxStageCursor(input.stageCursor);
    if (activeCursorHash(stageCursor) !== input.activeCursorHash) throw new Error('receipt-stage-cursor-hash-mismatch');
    const rawNonce = this.readBindingSecret(bindingId);
    if (!rawNonce || sha256Text(rawNonce) !== binding.sessionNonceHash) throw new Error(`binding-secret-missing-or-mismatch: ${bindingId}`);
    const source = input.source || 'claude-code-operator';
    if (!RECEIPT_SOURCES.includes(source)) throw new Error(`invalid-receipt-source: ${source}`);
    const payload = {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind,
      eventId: input.eventId || randomUUID(),
      taskId: this.taskId,
      sessionId: committed.ledger.sessionId,
      attemptId: requiredString(input.attemptId, 'attemptId'),
      source,
      occurredAt: input.occurredAt || isoNow(),
      binding: {
        bindingId,
        role: binding.role,
        bindingGeneration: binding.bindingGeneration,
        sessionId: binding.sessionId,
        sessionNonceHash: binding.sessionNonceHash,
        workerIdentityHash: binding.workerIdentityHash || null,
      },
      stageCursor,
      activeCursorHash: requiredString(input.activeCursorHash, 'activeCursorHash'),
      outputSnapshot: input.outputSnapshot || null,
      details: input.details || {},
    };
    const receiptPath = this.receiptPath('inbox', payload.attemptId, payload.eventId);
    if (fs.existsSync(receiptPath)) this.assertMailboxFileTarget(receiptPath);
    const allocation = this.allocateReceiptSequence({
      attemptId: payload.attemptId,
      eventId: payload.eventId,
      inputHash: canonicalHash(payload),
      receiptPath,
    });
    const receipt = {
      ...payload,
      sequence: allocation.sequence,
    };
    receipt.proof = hmacSha256(rawNonce, canonicalReceiptPayload(receipt));
    const existing = readJson(receiptPath);
    if (existing) {
      if (canonicalHash(existing) !== canonicalHash(receipt)) throw new Error(`event-id-collision: ${payload.eventId}`);
      return { status: 'duplicate', receipt, payloadHash: canonicalHash(receipt) };
    }
    this.atomicWriteMailboxJson(receiptPath, receipt);
    return { status: 'published', receipt, payloadHash: canonicalHash(receipt) };
  }

  listReceipts(bucket) {
    const directory = path.join(this.paths.receipts, bucket);
    if (!fs.existsSync(directory)) return [];
    resolveInsideRoot(directory, this.paths.mailboxRoot);
    return listJsonFiles(directory).map(filePath => {
      try {
        return { filePath, receipt: readJson(filePath), error: null };
      } catch (error) {
        return { filePath, receipt: null, error: error.message };
      }
    });
  }

  recoverEventJournal() {
    if (!fs.existsSync(this.paths.eventsFile)) return { truncated: false };
    this.assertMailboxFileTarget(this.paths.eventsFile);
    return recoverJsonl(this.paths.eventsFile);
  }

  readEvents() {
    if (!fs.existsSync(this.paths.eventsFile)) return [];
    this.assertMailboxFileTarget(this.paths.eventsFile);
    return readJsonLines(this.paths.eventsFile);
  }

  appendEvent(event) {
    if (!event?.eventId) throw new Error('eventId is required');
    const existing = this.readEvents().find(item => item.eventId === event.eventId);
    const indexPath = path.join(this.paths.eventIndex, `${event.eventId}.json`);
    if (existing) {
      if (canonicalHash(existing) !== canonicalHash(event)) throw new Error(`event-id-collision: ${event.eventId}`);
      if (!fs.existsSync(indexPath)) {
        this.atomicWriteMailboxJson(indexPath, { eventId: event.eventId, payloadHash: canonicalHash(event) });
      }
      return { appended: false, eventId: event.eventId };
    }
    this.ensureMailboxFileTarget(this.paths.eventsFile);
    appendJsonLine(this.paths.eventsFile, event, { faultInjector: this.faultInjector });
    this.atomicWriteMailboxJson(indexPath, { eventId: event.eventId, payloadHash: canonicalHash(event) });
    return { appended: true, eventId: event.eventId };
  }
}
