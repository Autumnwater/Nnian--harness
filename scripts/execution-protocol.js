import { randomUUID } from 'node:crypto';

export const STATUS_SCHEMA_VERSION = 4;
export const WORKER_PROTOCOL_VERSION = 1;

const EXECUTION_DEFAULTS = Object.freeze({
  mode: 'manual',
  activeJobId: null,
  activeAttemptId: null,
  activeLeaseToken: null,
  lockEpoch: 0,
  lastJobId: null,
});

const isoNow = () => new Date().toISOString();

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
};

const nonNegativeInteger = (value, field) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
};

const positiveInteger = (value, field) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
};

export const createExecutionDefaults = () => ({ ...EXECUTION_DEFAULTS });

export const migrateExecutionState = status => {
  let migrated = false;
  const sourceSchemaVersion = status.schemaVersion;
  const isLegacy = sourceSchemaVersion === undefined || sourceSchemaVersion < STATUS_SCHEMA_VERSION;

  if (status.schemaVersion !== undefined &&
      (!Number.isInteger(status.schemaVersion) || status.schemaVersion < 1)) {
    throw new Error('schemaVersion must be a positive integer');
  }
  if (status.schemaVersion > STATUS_SCHEMA_VERSION) {
    throw new Error(`Unsupported status schemaVersion: ${status.schemaVersion}`);
  }

  if (!status.schemaVersion || status.schemaVersion < STATUS_SCHEMA_VERSION) {
    status.schemaVersion = STATUS_SCHEMA_VERSION;
    migrated = true;
  }
  if (status.stateRevision === undefined && isLegacy) {
    status.stateRevision = 0;
    migrated = true;
  } else if (status.stateRevision === undefined) {
    throw new Error('stateRevision is required for schemaVersion 4');
  } else {
    nonNegativeInteger(status.stateRevision, 'stateRevision');
  }
  if (status.stageRevision === undefined && isLegacy) {
    status.stageRevision = 0;
    migrated = true;
  } else if (status.stageRevision === undefined) {
    throw new Error('stageRevision is required for schemaVersion 4');
  } else {
    nonNegativeInteger(status.stageRevision, 'stageRevision');
  }

  if ((!status.execution || typeof status.execution !== 'object' || Array.isArray(status.execution)) && isLegacy) {
    status.execution = createExecutionDefaults();
    migrated = true;
  } else if (!status.execution || typeof status.execution !== 'object' || Array.isArray(status.execution)) {
    throw new Error('execution must be an object for schemaVersion 4');
  } else {
    if (status.execution.mode !== undefined && !['manual', 'worker'].includes(status.execution.mode)) {
      throw new Error('execution.mode must be manual or worker');
    }
    if (status.execution.lockEpoch !== undefined) {
      nonNegativeInteger(status.execution.lockEpoch, 'execution.lockEpoch');
    }
    for (const field of ['activeJobId', 'activeAttemptId', 'activeLeaseToken', 'lastJobId']) {
      const value = status.execution[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length === 0)) {
        throw new Error(`execution.${field} must be null or a non-empty string`);
      }
    }
    for (const [key, value] of Object.entries(EXECUTION_DEFAULTS)) {
      if (status.execution[key] === undefined) {
        if (!isLegacy) throw new Error(`execution.${key} is required for schemaVersion 4`);
        status.execution[key] = value;
        migrated = true;
      }
    }
  }

  return migrated;
};

export const createStageCursor = ({
  subtaskId,
  stage,
  round,
  stageRevision,
  activeAttemptId = null,
}) => ({
  subtaskId: requiredString(subtaskId, 'subtaskId'),
  stage: requiredString(stage, 'stage'),
  round: positiveInteger(round, 'round'),
  stageRevision: nonNegativeInteger(stageRevision, 'stageRevision'),
  activeAttemptId,
});

export const assertStageCursor = (expected, actual) => {
  const fields = ['subtaskId', 'stage', 'round', 'stageRevision', 'activeAttemptId'];
  const mismatches = fields.filter(field => expected?.[field] !== actual?.[field]);
  if (mismatches.length > 0) {
    throw new Error(`stage-cas-conflict: ${mismatches.join(', ')}`);
  }
};

export const assertAttemptRef = (expected, actual) => {
  const fields = ['jobId', 'attemptId', 'leaseToken'];
  const mismatches = fields.filter(field => (expected?.[field] || null) !== (actual?.[field] || null));
  if (mismatches.length > 0) {
    throw new Error(`attempt-fence-conflict: ${mismatches.join(', ')}`);
  }
};

export const canAutomaticallyRetryAttempt = attempt =>
  attempt?.state === 'failed-before-dispatch' && attempt?.dispatchingPersisted === false;

export const markDispatchUncertain = (attempt, reason) => {
  if (!attempt || !['dispatching', 'dispatch-submitted'].includes(attempt.state)) {
    throw new Error('dispatch-uncertain requires an attempt at or beyond dispatching');
  }
  return {
    ...attempt,
    state: 'dispatch-uncertain',
    dispatchUncertainAt: isoNow(),
    dispatchUncertainReason: requiredString(reason, 'reason'),
    reconciliationRequired: true,
  };
};

export const createJob = input => {
  const taskId = requiredString(input.taskId, 'taskId');
  const subtaskId = requiredString(input.subtaskId, 'subtaskId');
  const stage = requiredString(input.stage, 'stage');
  const id = input.jobId || `${taskId}:${subtaskId}:${stage}:${input.round}:${randomUUID()}`;

  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    jobId: id,
    taskId,
    subtaskId,
    stage,
    round: positiveInteger(input.round, 'round'),
    expectedStageRevision: nonNegativeInteger(input.expectedStageRevision, 'expectedStageRevision'),
    role: requiredString(input.role, 'role'),
    targetBinding: requiredString(input.targetBinding, 'targetBinding'),
    promptPath: requiredString(input.promptPath, 'promptPath'),
    promptSha256: requiredString(input.promptSha256, 'promptSha256'),
    primaryReportPath: requiredString(input.primaryReportPath, 'primaryReportPath'),
    outputBaseline: input.outputBaseline || { exists: false, size: 0, mtimeMs: 0, sha256: '' },
    createdAt: input.createdAt || isoNow(),
    timeoutMs: positiveInteger(input.timeoutMs ?? 7_200_000, 'timeoutMs'),
    state: 'queued',
  };
};

export const createAttempt = ({ jobId, lockEpoch, attemptId, createdAt }) => {
  const id = attemptId || randomUUID();
  const epoch = nonNegativeInteger(lockEpoch, 'lockEpoch');

  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    jobId: requiredString(jobId, 'jobId'),
    attemptId: id,
    leaseToken: `${id}:${epoch}:${randomUUID()}`,
    lockEpoch: epoch,
    state: 'queued',
    createdAt: createdAt || isoNow(),
  };
};

export const createLease = ({ bindingId, attempt, ttlMs = 60_000, createdAt }) => {
  const startedAt = createdAt || isoNow();
  const validTtlMs = positiveInteger(ttlMs, 'ttlMs');
  const expiresAt = new Date(new Date(startedAt).getTime() + validTtlMs).toISOString();
  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    bindingId: requiredString(bindingId, 'bindingId'),
    jobId: requiredString(attempt?.jobId, 'attempt.jobId'),
    attemptId: requiredString(attempt?.attemptId, 'attempt.attemptId'),
    leaseToken: requiredString(attempt?.leaseToken, 'attempt.leaseToken'),
    lockEpoch: nonNegativeInteger(attempt.lockEpoch, 'attempt.lockEpoch'),
    acquiredAt: startedAt,
    expiresAt,
  };
};

export const createEvent = ({ kind, source, attempt, eventId, sequence, occurredAt, details = {} }) => ({
  protocolVersion: WORKER_PROTOCOL_VERSION,
  eventId: eventId || randomUUID(),
  jobId: requiredString(attempt?.jobId, 'attempt.jobId'),
  attemptId: requiredString(attempt?.attemptId, 'attempt.attemptId'),
  leaseToken: requiredString(attempt?.leaseToken, 'attempt.leaseToken'),
  kind: requiredString(kind, 'kind'),
  source: requiredString(source, 'source'),
  sequence: positiveInteger(sequence, 'sequence'),
  occurredAt: occurredAt || isoNow(),
  details,
});

export class ManualWorkerAdapter {
  async capabilities() {
    return { dispatch: false, cancel: false, abortableDispatch: false, settleBarrier: false, mode: 'manual' };
  }

  async discoverTargets() {
    return [];
  }

  async health() {
    return { healthy: true, mode: 'manual' };
  }

  async dispatch(job, target) {
    return {
      status: 'manual-required',
      submitted: false,
      jobId: job.jobId,
      bindingId: target?.bindingId || null,
    };
  }

  async cancel(attempt) {
    return { status: 'manual-required', attemptId: attempt.attemptId, interrupted: false };
  }

  async settleDispatch(attempt) {
    return { settled: true, outcome: 'failed-before-side-effect', attemptId: attempt.attemptId };
  }
}

export class FakeWorkerAdapter {
  constructor({ targets = [], dispatchController = null, transportStore = null } = {}) {
    this.targets = targets.map(target => ({ ...target }));
    this.activeAttempts = new Map();
    this.dispatchController = dispatchController;
    this.transportStore = transportStore;
  }

  readActive(bindingId) {
    return this.activeAttempts.get(bindingId) || this.transportStore?.readTransport(bindingId) || null;
  }

  writeActive(bindingId, record) {
    this.activeAttempts.set(bindingId, { ...record });
    this.transportStore?.writeTransport(bindingId, record);
  }

  async capabilities() {
    return { dispatch: true, cancel: true, abortableDispatch: true, settleBarrier: true, mode: 'fake' };
  }

  async discoverTargets() {
    return this.targets.map(target => ({ ...target }));
  }

  async health(target) {
    return { healthy: this.targets.some(item => item.bindingId === target.bindingId) };
  }

  async dispatch(job, target, options = {}) {
    requiredString(target?.bindingId, 'target.bindingId');
    const attempt = job.attempt;
    requiredString(attempt?.jobId, 'job.attempt.jobId');
    requiredString(attempt?.attemptId, 'job.attempt.attemptId');
    requiredString(attempt?.leaseToken, 'job.attempt.leaseToken');

    const existing = this.readActive(target.bindingId);
    if (existing && existing.transportState !== 'quiesced') {
      const sameAttempt = existing.attemptId === attempt.attemptId &&
        existing.leaseToken === attempt.leaseToken;
      return {
        status: sameAttempt ? 'already-dispatched' : 'target-busy',
        submitted: false,
        attemptId: existing.attemptId,
      };
    }

    const inFlight = { ...attempt, operationId: options.operationId || null, transportState: 'transport-in-flight' };
    this.writeActive(target.bindingId, inFlight);
    if (this.dispatchController?.dispatch) {
      let result;
      try {
        result = await this.dispatchController.dispatch(job, target, options);
      } catch (error) {
        if (error?.safeBeforeSideEffect === true) {
          this.writeActive(target.bindingId, { ...inFlight, transportState: 'quiesced', outcome: 'failed-before-side-effect' });
        }
        throw error;
      }
      if (result?.status === 'dispatch-submitted' || result?.submitted === true) {
        this.writeActive(target.bindingId, { ...inFlight, transportState: 'submitted' });
      } else if (result?.safeBeforeSideEffect === true || result?.outcome === 'failed-before-side-effect') {
        this.writeActive(target.bindingId, { ...inFlight, transportState: 'quiesced', outcome: 'failed-before-side-effect' });
      }
      return result;
    }
    this.writeActive(target.bindingId, { ...inFlight, transportState: 'submitted' });
    return { status: 'dispatch-submitted', submitted: true, attemptId: attempt.attemptId };
  }

  async cancel(attempt, target) {
    const active = this.readActive(target.bindingId);
    if (!active || active.jobId !== attempt.jobId || active.attemptId !== attempt.attemptId ||
        active.leaseToken !== attempt.leaseToken) {
      return { status: 'stale-attempt', interrupted: false };
    }
    this.writeActive(target.bindingId, { ...active, transportState: 'quiesced', outcome: 'aborted-before-side-effect' });
    return { status: 'cancelled', interrupted: true, attemptId: attempt.attemptId };
  }

  getActiveAttempt(bindingId) {
    const attempt = this.readActive(bindingId);
    return attempt && attempt.transportState !== 'quiesced' ? { ...attempt } : null;
  }

  async settleDispatch(attempt, target, options = {}) {
    if (this.dispatchController?.settle) {
      return this.dispatchController.settle(attempt, target, options);
    }
    const active = this.readActive(target.bindingId);
    if (!active) return { settled: false, outcome: 'unknown' };
    if (active.attemptId !== attempt.attemptId || active.leaseToken !== attempt.leaseToken) {
      return { settled: false, outcome: 'fenced-transport-record' };
    }
    if (active.transportState === 'quiesced') return { settled: true, outcome: active.outcome };
    if (active.transportState === 'submitted') return { settled: true, outcome: 'submitted' };
    return { settled: false, outcome: 'unknown' };
  }
}
