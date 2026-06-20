import { randomUUID } from 'node:crypto';

import {
  assertAttemptRef,
  bindingIdentity,
  createAttempt,
  createJob,
  createLease,
  hashSessionNonce,
  verifySessionProof,
} from './execution-protocol.js';
import { canonicalPayloadHash } from './execution-store.js';

const isoNow = () => new Date().toISOString();
const BINDING_HEARTBEAT_STALE_MS = 300_000;
const NEEDS_INPUT_CATEGORIES = new Set([
  'permission-request',
  'agent-question',
  'authentication-required',
  'external-intervention',
]);

const required = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const attemptRef = attempt => ({
  jobId: attempt.jobId,
  attemptId: attempt.attemptId,
  leaseToken: attempt.leaseToken,
});

const targetBindingIdentity = target => {
  if (!target?.sessionId && !target?.sessionNonceHash && target?.bindingGeneration === undefined) return null;
  return bindingIdentity(target);
};

const targetAdapterIdentity = target => {
  if (!target?.adapterIdentity && !target?.targetFingerprintHash) return null;
  const identity = target.adapterIdentity || {};
  return {
    adapter: identity.adapter || target.adapter || null,
    role: identity.role || target.role || null,
    bindingId: identity.bindingId || target.bindingId || null,
    bindingGeneration: identity.bindingGeneration ?? target.bindingGeneration ?? null,
    sessionId: identity.sessionId || target.sessionId || null,
    sessionNonceHash: identity.sessionNonceHash || target.sessionNonceHash || null,
    targetFingerprintHash: identity.targetFingerprintHash || target.targetFingerprintHash || null,
    targetChallengeId: identity.targetChallengeId || target.targetChallengeId || null,
    targetBindingVerifiedAt: identity.targetBindingVerifiedAt || target.targetBindingVerifiedAt || null,
    capabilityEvidenceId: identity.capabilityEvidenceId || target.capabilityEvidenceId || null,
  };
};

const assertAdapterIdentity = (expected, actual) => {
  if (!expected && !actual) return;
  if (!expected || !actual) throw new Error('adapter-identity-fence-conflict');
  const fields = [
    'adapter', 'role', 'bindingId', 'bindingGeneration', 'sessionId',
    'sessionNonceHash', 'targetFingerprintHash', 'targetChallengeId',
    'targetBindingVerifiedAt', 'capabilityEvidenceId',
  ];
  const mismatches = fields.filter(field => (expected[field] || null) !== (actual[field] || null));
  if (mismatches.length > 0) throw new Error(`adapter-identity-fence-conflict: ${mismatches.join(', ')}`);
};

const validateReceipt = (receipt, nowMs, maxClockSkewMs) => {
  if (receipt?.protocolVersion !== 1) throw new Error('receipt-rejected:invalid-protocol-version');
  for (const field of ['eventId', 'jobId', 'attemptId', 'leaseToken', 'kind', 'occurredAt', 'source']) {
    if (typeof receipt?.[field] !== 'string' || receipt[field].length === 0) {
      throw new Error(`receipt-rejected:missing-${field}`);
    }
  }
  if (!['job.running', 'job.completed', 'job.failed', 'job.needs-input'].includes(receipt.kind)) {
    throw new Error('receipt-rejected:invalid-kind');
  }
  if (receipt.kind === 'job.needs-input') {
    if (!NEEDS_INPUT_CATEGORIES.has(receipt.details?.category)) {
      throw new Error('receipt-rejected:needs-input-invalid-category');
    }
  }
  if (!Number.isInteger(receipt.sequence) || receipt.sequence <= 0) {
    throw new Error('receipt-rejected:invalid-sequence');
  }
  const occurredAtMs = Date.parse(receipt.occurredAt);
  if (!Number.isFinite(occurredAtMs)) throw new Error('receipt-rejected:invalid-occurred-at');
  if (occurredAtMs > nowMs + maxClockSkewMs) throw new Error('receipt-rejected:occurred-at-in-future');
  return receipt;
};

export class ExecutionSupervisor {
  constructor({ taskId, store, statusStore, adapter, workflow, clock = isoNow, faultInjector = null, maxClockSkewMs = 60_000, transaction = callback => callback(), validatePilotAuthorization = null, onPilotEvent = null, onWorkflowCommitted = null }) {
    this.taskId = required(taskId, 'taskId');
    this.store = store;
    this.statusStore = statusStore;
    this.adapter = adapter;
    this.workflow = workflow;
    this.clock = clock;
    this.faultInjector = faultInjector;
    this.maxClockSkewMs = maxClockSkewMs;
    this.transaction = transaction;
    this.validatePilotAuthorization = validatePilotAuthorization;
    this.onPilotEvent = onPilotEvent;
    this.onWorkflowCommitted = onWorkflowCommitted;
  }

  validatePilot(context, phase, { failClosed = true } = {}) {
    const authorization = context?.attempt?.pilotAuthorization || context?.job?.pilotAuthorization || context?.operation?.pilotAuthorization || null;
    if (!authorization || !this.validatePilotAuthorization) return { status: 'not-applicable' };
    try {
      this.validatePilotAuthorization(authorization, { ...context, phase });
      return { status: 'current' };
    } catch (error) {
      const result = { status: 'stale-or-drifted', reason: error.message };
      if (context.operation) {
        this.store.writeOperation({
          ...context.operation,
          pilotAuthorizationAudit: [
            ...(context.operation.pilotAuthorizationAudit || []),
            { phase, ...result, checkedAt: this.clock() },
          ],
        });
      }
      if (failClosed) throw error;
      return result;
    }
  }

  emitPilotEvent(type, context = {}) {
    const authorization = context?.attempt?.pilotAuthorization || context?.job?.pilotAuthorization || context?.operation?.pilotAuthorization || null;
    if (!authorization || !this.onPilotEvent) return null;
    return this.onPilotEvent({ type, authorization, ...context });
  }

  inject(point, details = {}) {
    this.faultInjector?.(point, details);
  }

  async resolveTarget(jobInput) {
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.dispatch || !capabilities.abortableDispatch || !capabilities.settleBarrier) {
      if (capabilities.mode === 'manual') throw new Error('manual-required');
      throw new Error('adapter-capability-unavailable: abortableDispatch + settleBarrier required');
    }
    const targets = await this.adapter.discoverTargets();
    const matches = targets.filter(target =>
      target.bindingId === jobInput.targetBinding && target.role === jobInput.role
    );
    if (matches.length !== 1) {
      throw new Error(`target-resolution-failed: expected one ${jobInput.role}/${jobInput.targetBinding}, found ${matches.length}`);
    }
    return matches[0];
  }

  async prepare(jobInput) {
    const target = await this.resolveTarget(jobInput);
    return this.transaction(() => {
      this.recoverOperations();
      const status = this.statusStore.load();
    if (status.execution?.activeJobId || status.execution?.activeAttemptId) {
      throw new Error('active-job-conflict');
    }
    if (status.stageRevision !== jobInput.expectedStageRevision) {
      throw new Error('stage-cas-conflict: stageRevision');
    }

    const operationId = randomUUID();
    const capturedBindingIdentity = targetBindingIdentity(target);
    const capturedAdapterIdentity = targetAdapterIdentity(target);
    const pilotAuthorization = jobInput.pilotAuthorization || null;
    const jobBase = createJob(jobInput);
    const attemptBase = createAttempt({ jobId: jobBase.jobId, lockEpoch: status.execution.lockEpoch });
    let job = {
      ...jobBase,
      operationId,
      attemptId: attemptBase.attemptId,
      executionState: 'preparing',
      workflowState: 'pending',
      target,
      bindingIdentity: capturedBindingIdentity,
      adapterIdentity: capturedAdapterIdentity,
      ...(pilotAuthorization ? { pilotAuthorization } : {}),
    };
    let attempt = {
      ...attemptBase,
      operationId,
      bindingId: target.bindingId,
      bindingIdentity: capturedBindingIdentity,
      adapterIdentity: capturedAdapterIdentity,
      ...(pilotAuthorization ? { pilotAuthorization } : {}),
      state: 'prepared',
      transportState: 'prepared',
      dispatchingPersisted: false,
      executionState: 'prepared',
      workflowState: 'pending',
      lastSequence: 0,
      appliedEventIds: [],
    };
    const lease = {
      ...createLease({ bindingId: target.bindingId, attempt }),
      operationId,
      state: 'pending',
      bindingIdentity: capturedBindingIdentity,
      adapterIdentity: capturedAdapterIdentity,
      ...(pilotAuthorization ? { pilotAuthorization } : {}),
    };
    const payloads = { job, attempt, lease };
    const payloadHash = canonicalPayloadHash(payloads);
    let operation = {
      operationId,
      kind: 'dispatch-prepare',
      phase: 'intent',
      payloadHash,
      expectedStateRevision: status.stateRevision,
      expectedStageRevision: status.stageRevision,
      attemptRef: attemptRef(attemptBase),
      bindingId: target.bindingId,
      payloads,
      ...(pilotAuthorization ? { pilotAuthorization } : {}),
      createdAt: this.clock(),
    };
    this.store.writeOperation(operation);
    this.inject('after-operation-intent', { operationId });
    this.store.writeJob(job);
    this.inject('after-job-write', { operationId });
    this.store.writeAttempt(attempt);
    this.inject('after-attempt-write', { operationId });
    this.store.writeLease(lease);
    this.inject('after-lease-write', { operationId });

    const nextStatus = structuredClone(status);
    nextStatus.execution.mode = 'worker';
    nextStatus.execution.activeJobId = job.jobId;
    nextStatus.execution.activeAttemptId = attempt.attemptId;
    nextStatus.execution.activeLeaseToken = attempt.leaseToken;
    nextStatus.history = nextStatus.history || [];
    nextStatus.history.push({
      timestamp: this.clock(),
      action: 'worker-dispatch-committed',
      details: { operationId, ...attemptRef(attempt) },
    });
    this.statusStore.saveCas(status.stateRevision, nextStatus);
    this.inject('after-status-commit', { operationId });

    operation = { ...operation, phase: 'committed', committedAt: this.clock() };
    job = { ...job, executionState: 'prepared' };
    attempt = { ...attempt, state: 'prepared' };
    this.store.writeOperation(operation);
    this.store.writeJob(job);
    this.store.writeAttempt(attempt);
    this.store.writeLease({ ...lease, state: 'active' });
    this.emitPilotEvent('prepared', {
      status: nextStatus,
      operation,
      job,
      attempt,
      lease: { ...lease, state: 'active' },
    });
      return { operationId, job, attempt, target };
    });
  }

  recoverOperations() {
    const status = this.statusStore.load();
    let rolledBack = 0;
    let rolledForward = 0;
    for (const operation of this.store.listOperations()) {
      if (operation.phase === 'terminal-committing') {
        const commit = operation.terminalCommit;
        const marker = (status.history || []).find(entry =>
          entry.action === commit?.action &&
          entry.details?.operationId === operation.operationId &&
          entry.details?.attemptId === operation.attemptRef.attemptId
        );
        if (!marker) continue;
        if (status.execution.activeJobId || status.execution.activeAttemptId || status.execution.activeLeaseToken) {
          throw new Error(`execution-corrupt: terminal commit ${operation.operationId} retained active refs`);
        }
        this.store.writeJob(commit.job);
        this.store.writeAttempt(commit.attempt);
        this.store.releaseLease(operation.bindingId, { operationId: operation.operationId, ...operation.attemptRef });
        this.store.writeOperation({ ...operation, phase: commit.jobState, recoveredAt: this.clock() });
        rolledForward += 1;
        continue;
      }
      if (operation.phase === 'workflow-committing') {
        const marker = (status.history || []).find(entry =>
          entry.action === 'worker-workflow-committed' &&
          entry.details?.operationId === operation.operationId &&
          entry.details?.completionEventId === operation.workflowCommit?.completionEventId
        );
        if (!marker) continue;
        const commit = operation.workflowCommit;
        if (status.execution.activeJobId || status.execution.activeAttemptId || status.execution.activeLeaseToken) {
          throw new Error(`execution-corrupt: workflow commit ${operation.operationId} retained active refs`);
        }
        this.store.writeJob(commit.job);
        this.store.writeAttempt(commit.attempt);
        this.store.releaseLease(operation.bindingId, { operationId: operation.operationId, ...operation.attemptRef });
        this.store.writeOperation({ ...operation, phase: 'workflow-completed', recoveredAt: this.clock() });
        this.onWorkflowCommitted?.({
          job: commit.job,
          attempt: commit.attempt,
          postCursor: commit.pilotRoleProgress?.postCursor || marker.details?.postCursor || null,
          pilotRoleProgress: commit.pilotRoleProgress || null,
          recovered: true,
        });
        rolledForward += 1;
        continue;
      }
      if (!['dispatch-prepare', 'dispatch-retry'].includes(operation.kind) ||
          !['intent', 'committed'].includes(operation.phase)) continue;
      if (!operation.payloads || canonicalPayloadHash(operation.payloads) !== operation.payloadHash) {
        throw new Error(`operation-payload-conflict: ${operation.operationId}`);
      }
      const marker = (status.history || []).find(entry =>
        ['worker-dispatch-committed', 'worker-retry-committed'].includes(entry.action) &&
        entry.details?.operationId === operation.operationId
      );
      const refsMatch = marker &&
        status.execution.activeJobId === operation.attemptRef.jobId &&
        status.execution.activeAttemptId === operation.attemptRef.attemptId &&
        status.execution.activeLeaseToken === operation.attemptRef.leaseToken;
      if (refsMatch) {
        const { job, attempt, lease } = operation.payloads;
        try {
          this.validatePilot({ status, operation, job, attempt, lease }, 'restart-recovery');
        } catch (error) {
          this.store.writeJob({ ...job, executionState: 'operator-required', terminalReason: error.message });
          this.store.writeAttempt({ ...attempt, state: 'operator-required', terminalReason: error.message });
          this.store.writeLease({ ...lease, state: 'active' });
          this.store.writeOperation({ ...this.store.readOperation(operation.operationId), phase: 'pilot-authorization-stale', terminalReason: error.message, recoveredAt: this.clock() });
          rolledForward += 1;
          continue;
        }
        this.store.writeJob({ ...job, executionState: 'prepared' });
        this.store.writeAttempt({ ...attempt, state: 'prepared' });
        this.store.writeLease({ ...lease, state: 'active' });
        this.store.writeOperation({ ...operation, phase: 'committed', recoveredAt: this.clock() });
        rolledForward += 1;
        continue;
      }
      if (marker || operation.phase === 'committed') {
        throw new Error(`execution-corrupt: committed operation ${operation.operationId} does not match status refs`);
      }
      const existingJob = this.store.readJob(operation.attemptRef.jobId);
      if (existingJob?.operationId === operation.operationId) {
        if (operation.kind === 'dispatch-retry' && operation.previousJob) {
          this.store.writeJob(operation.previousJob);
        } else {
          this.store.writeJob({ ...existingJob, executionState: 'rolled-back' });
        }
      }
      const existingAttempt = this.store.readAttempt(operation.attemptRef.attemptId);
      if (existingAttempt?.operationId === operation.operationId) {
        this.store.writeAttempt({ ...existingAttempt, state: 'rolled-back' });
      }
      this.store.releaseLease(operation.bindingId, { operationId: operation.operationId, ...operation.attemptRef });
      this.store.writeOperation({ ...operation, phase: 'rolled-back', rolledBackAt: this.clock() });
      rolledBack += 1;
    }
    return { rolledBack, rolledForward };
  }

  async dispatch(operationId, { timeoutMs = 30_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
    const claim = await this.transaction(() => {
      const operation = this.store.readOperation(operationId);
      if (!operation) throw new Error('dispatch-operation-not-ready');
      if (operation.phase !== 'committed') {
        if (['dispatching', 'dispatch-submitted', 'dispatch-uncertain'].includes(operation.phase)) {
          return { claimed: false, status: operation.phase === 'dispatching' ? 'already-dispatching' : operation.phase };
        }
        throw new Error('dispatch-operation-not-ready');
      }
      const attempt = this.store.readAttempt(operation.attemptRef.attemptId);
      const job = this.store.readJob(operation.attemptRef.jobId);
      assertAttemptRef(operation.attemptRef, attemptRef(attempt));
      const lease = this.store.readLease(operation.bindingId);
      assertAttemptRef(operation.attemptRef, lease);
      assertAdapterIdentity(job.adapterIdentity || null, attempt.adapterIdentity || null);
      assertAdapterIdentity(job.adapterIdentity || null, lease.adapterIdentity || null);
      const status = this.statusStore.load();
      assertAttemptRef(operation.attemptRef, {
        jobId: status.execution.activeJobId,
        attemptId: status.execution.activeAttemptId,
        leaseToken: status.execution.activeLeaseToken,
      });
      if (lease.lockEpoch !== status.execution.lockEpoch || attempt.lockEpoch !== status.execution.lockEpoch) {
        throw new Error('attempt-fence-conflict: lockEpoch');
      }
      this.validatePilotAuthorization?.(job.pilotAuthorization, {
        phase: 'dispatch',
        status,
        operation,
        job,
        attempt,
        lease,
      });
      this.emitPilotEvent('dispatch-started', { status, operation, job, attempt, lease });
      const dispatching = {
        ...attempt,
        state: 'dispatching',
        transportState: 'transport-in-flight',
        dispatchingPersisted: true,
        dispatchingAt: this.clock(),
      };
      this.store.writeAttempt(dispatching);
      this.store.writeOperation({ ...operation, phase: 'dispatching', dispatchingAt: this.clock() });
      return { claimed: true, operation, attempt, job, target: job.target, dispatching };
    });
    if (!claim.claimed) return { status: claim.status };
    const { operation, attempt, job, target, dispatching } = claim;

    const controller = new AbortController();
    let dispatchPromise;
    try {
      dispatchPromise = Promise.resolve(this.adapter.dispatch(
        { ...job, attempt: attemptRef(dispatching) },
        target,
        { operationId, signal: controller.signal }
      ));
    } catch (error) {
      dispatchPromise = Promise.reject(error);
    }
    let timer;
    const timeoutMarker = Symbol('dispatch-timeout');
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
    });
    let result;
    try {
      result = await Promise.race([dispatchPromise, timeoutPromise]);
    } catch (error) {
      result = {
        status: 'dispatch-error',
        error: error.message,
        safeBeforeSideEffect: error?.safeBeforeSideEffect === true,
        ambiguous: error?.safeBeforeSideEffect !== true,
      };
    } finally {
      clearTimeout(timer);
    }

    if (result === timeoutMarker) {
      controller.abort(new Error('dispatch-timeout'));
      await this.transaction(() => {
        const currentOperation = this.assertCurrentTransport(operationId, attemptRef(attempt), ['dispatching']);
        const uncertain = {
          ...this.store.readAttempt(attempt.attemptId),
          state: 'dispatch-uncertain',
          transportState: 'transport-in-flight',
          abortRequested: true,
          dispatchUncertainReason: 'dispatch-timeout-before-settle',
        };
        this.store.writeAttempt(uncertain);
        this.store.writeOperation({
          ...currentOperation,
          phase: 'dispatch-uncertain',
          transportState: 'transport-in-flight',
        });
      });
      dispatchPromise.then(
        lateResult => this.recordLateTransportResult(operationId, attemptRef(attempt), lateResult),
        error => this.recordLateTransportResult(operationId, attemptRef(attempt), { status: 'dispatch-error', error: error.message })
      );
      return { status: 'dispatch-uncertain', attemptId: attempt.attemptId };
    }

    if (result?.safeBeforeSideEffect === true || result?.outcome === 'failed-before-side-effect') {
      return this.transaction(() => {
        const currentOperation = this.assertCurrentTransport(operationId, attemptRef(attempt), ['dispatching']);
        const currentAttempt = this.store.readAttempt(attempt.attemptId);
        return this.commitTerminalAttempt(
          {
            status: this.statusStore.load(),
            attempt: {
              ...currentAttempt,
              dispatchingPersisted: false,
              transportState: 'quiesced',
              transportOutcome: 'failed-before-side-effect',
            },
            job: this.store.readJob(attempt.jobId),
            operation: currentOperation,
          },
          {
            attemptState: 'failed-before-dispatch',
            jobState: 'failed-before-dispatch',
            action: 'worker-dispatch-failed-before-side-effect',
            reason: result.error || result.status || 'failed-before-side-effect',
          }
        );
      });
    }

    if (result?.status === 'dispatch-submitted' || result?.submitted === true) {
      await this.transaction(() => {
        const currentOperation = this.assertCurrentTransport(operationId, attemptRef(attempt), ['dispatching']);
        this.store.writeAttempt({
          ...this.store.readAttempt(attempt.attemptId),
          state: 'dispatch-submitted',
          transportState: 'submitted',
          dispatchSubmittedAt: this.clock(),
        });
        this.store.writeOperation({ ...currentOperation, phase: 'dispatch-submitted' });
        this.emitPilotEvent('submitted', {
          status: this.statusStore.load(),
          operation: currentOperation,
          job: this.store.readJob(attempt.jobId),
          attempt: this.store.readAttempt(attempt.attemptId),
          lease: this.store.readLease(operation.bindingId),
        });
      });
      return { ...result, status: 'dispatch-submitted' };
    }

    await this.transaction(() => {
      const currentOperation = this.assertCurrentTransport(operationId, attemptRef(attempt), ['dispatching']);
      this.store.writeAttempt({
        ...this.store.readAttempt(attempt.attemptId),
        state: 'dispatch-uncertain',
        transportState: 'ambiguous-settled',
        dispatchUncertainReason: result?.error || result?.status || 'ambiguous-result',
      });
      this.store.writeOperation({ ...currentOperation, phase: 'dispatch-uncertain', transportState: 'ambiguous-settled' });
    });
    return { status: 'dispatch-uncertain', attemptId: attempt.attemptId };
  }

  assertCurrentTransport(operationId, expectedAttempt, allowedPhases) {
    const operation = this.store.readOperation(operationId);
    if (!operation || !allowedPhases.includes(operation.phase)) throw new Error('stale-transport-result');
    assertAttemptRef(expectedAttempt, operation.attemptRef);
    const attempt = this.store.readAttempt(expectedAttempt.attemptId);
    const lease = this.store.readLease(operation.bindingId);
    const status = this.statusStore.load();
    assertAttemptRef(expectedAttempt, attemptRef(attempt));
    assertAttemptRef(expectedAttempt, lease);
    assertAttemptRef(expectedAttempt, {
      jobId: status.execution.activeJobId,
      attemptId: status.execution.activeAttemptId,
      leaseToken: status.execution.activeLeaseToken,
    });
    if (attempt.lockEpoch !== status.execution.lockEpoch || lease.lockEpoch !== status.execution.lockEpoch) {
      throw new Error('attempt-fence-conflict: lockEpoch');
    }
    return operation;
  }

  async recordLateTransportResult(operationId, expectedAttempt, result) {
    try {
      await this.transaction(() => {
        const operation = this.assertCurrentTransport(
          operationId,
          expectedAttempt,
          ['dispatching', 'dispatch-uncertain', 'dispatch-submitted']
        );
        const attempt = this.store.readAttempt(expectedAttempt.attemptId);
        this.store.writeAttempt({ ...attempt, lateTransportResult: result, lateTransportAt: this.clock() });
        this.store.writeOperation({ ...operation, lateTransportResult: result, lateTransportAt: this.clock() });
      });
      return { applied: true };
    } catch {
      return { applied: false, reason: 'stale-attempt' };
    }
  }

  async settleTransport(attemptId) {
    const attempt = this.store.readAttempt(attemptId);
    if (!attempt) throw new Error('attempt-not-found');
    const job = this.store.readJob(attempt.jobId);
    const result = await this.adapter.settleDispatch(attemptRef(attempt), job.target, { operationId: attempt.operationId });
    if (!result?.settled) return { status: 'transport-in-flight' };
    await this.transaction(() => {
      const operation = this.assertCurrentTransport(
        attempt.operationId,
        attemptRef(attempt),
        ['dispatching', 'dispatch-uncertain', 'dispatch-submitted']
      );
      const current = this.store.readAttempt(attemptId);
      this.store.writeAttempt({
        ...current,
        transportState: result.outcome === 'submitted' ? 'submitted' : 'quiesced',
        transportOutcome: result.outcome,
        settledAt: this.clock(),
      });
      this.store.writeOperation({
        ...operation,
        transportState: result.outcome === 'submitted' ? 'submitted' : 'quiesced',
        transportOutcome: result.outcome,
        settledAt: this.clock(),
      });
    });
    return { status: 'transport-settled', outcome: result.outcome };
  }

  reconcileNotSent(attemptId, evidence) {
    const attempt = this.store.readAttempt(attemptId);
    if (!attempt) throw new Error('attempt-not-found');
    if (attempt.transportState !== 'quiesced' ||
        !['aborted-before-side-effect', 'failed-before-side-effect'].includes(attempt.transportOutcome)) {
      throw new Error('transport-not-quiesced');
    }
    for (const field of ['confirmTargetQuiescent', 'confirmPromptNotVisible', 'confirmPromptNotRunning']) {
      if (evidence?.[field] !== true) throw new Error(`reconcile-evidence-required: ${field}`);
    }
    required(evidence?.reason, 'reason');
    required(evidence?.residualRisk, 'residualRisk');
    this.store.writeAttempt({
      ...attempt,
      state: 'reconciled-not-sent',
      reconciliation: { ...evidence, decidedAt: this.clock() },
    });
    return { status: 'reconciled-not-sent', attemptId };
  }

  assertActiveAttempt(expected) {
    const status = this.statusStore.load();
    const attempt = this.store.readAttempt(expected.attemptId);
    if (!attempt) throw new Error('attempt-not-found');
    assertAttemptRef(expected, attemptRef(attempt));
    assertAttemptRef(expected, {
      jobId: status.execution.activeJobId,
      attemptId: status.execution.activeAttemptId,
      leaseToken: status.execution.activeLeaseToken,
    });
    const job = this.store.readJob(expected.jobId);
    const operation = this.store.readOperation(attempt.operationId);
    const lease = this.store.readLease(attempt.bindingId);
    assertAttemptRef(expected, lease);
    assertAdapterIdentity(job?.adapterIdentity || null, attempt.adapterIdentity || null);
    assertAdapterIdentity(job?.adapterIdentity || null, lease.adapterIdentity || null);
    if (attempt.lockEpoch !== status.execution.lockEpoch || lease.lockEpoch !== status.execution.lockEpoch) {
      throw new Error('attempt-fence-conflict: lockEpoch');
    }
    return { status, attempt, job, operation, lease };
  }

  commitTerminalAttempt(context, { attemptState, jobState, action, reason, fence = true }) {
    const { status, attempt, job, operation } = context;
    const nextStatus = structuredClone(status);
    nextStatus.execution.activeJobId = null;
    nextStatus.execution.activeAttemptId = null;
    nextStatus.execution.activeLeaseToken = null;
    nextStatus.execution.lastJobId = job.jobId;
    if (fence) nextStatus.execution.lockEpoch += 1;
    nextStatus.history = nextStatus.history || [];
    nextStatus.history.push({
      timestamp: this.clock(),
      action,
      details: { ...attemptRef(attempt), operationId: attempt.operationId, reason },
    });
    const terminalAttempt = { ...attempt, state: attemptState, executionState: attemptState, terminalAt: this.clock(), terminalReason: reason };
    const terminalJob = { ...job, executionState: jobState, workflowState: jobState, terminalAt: this.clock(), terminalReason: reason };
    this.store.writeOperation({
      ...operation,
      phase: 'terminal-committing',
      terminalCommit: { action, jobState, job: terminalJob, attempt: terminalAttempt },
    });
    this.statusStore.saveCas(status.stateRevision, nextStatus);
    this.inject('after-terminal-status-cas', { operationId: attempt.operationId, action });
    this.store.writeAttempt(terminalAttempt);
    this.store.writeJob(terminalJob);
    this.store.releaseLease(attempt.bindingId, { operationId: attempt.operationId, ...attemptRef(attempt) });
    this.store.writeOperation({ ...this.store.readOperation(attempt.operationId), phase: jobState, terminalAt: this.clock(), terminalReason: reason });
    return { status: jobState, attemptId: attempt.attemptId };
  }

  async cancel(expected) {
    assertAttemptRef(expected, expected);
    const ref = { jobId: expected.jobId, attemptId: expected.attemptId, leaseToken: expected.leaseToken };
    const claim = await this.transaction(() => {
      let context;
      try {
        context = this.assertActiveAttempt(ref);
      } catch (error) {
        const attempt = this.store.readAttempt(ref.attemptId);
        if (attempt && ['cancelled', 'abandoned', 'workflow-completed'].includes(attempt.state || attempt.workflowState)) {
          return { terminal: true, result: { status: 'already-terminal', attemptId: ref.attemptId } };
        }
        throw error;
      }
      const pending = {
        ...context.attempt,
        state: 'cancel-pending-settle',
        abortRequested: true,
        cancelRequestedAt: this.clock(),
      };
      const authorization = this.validatePilot(context, 'cancel', { failClosed: false });
      this.store.writeAttempt(pending);
      this.store.writeOperation({ ...this.store.readOperation(context.operation.operationId), cancelRequestedAt: this.clock(), pilotAuthorizationAtCancel: authorization });
      return { terminal: false, context: { ...context, attempt: pending } };
    });
    if (claim.terminal) return claim.result;
    const { attempt, job } = claim.context;
    await this.adapter.cancel(attemptRef(attempt), job.target);
    const settled = await this.settleTransport(attempt.attemptId);
    if (settled.status === 'transport-in-flight') return { status: 'cancel-pending-settle', attemptId: attempt.attemptId };
    if (settled.outcome === 'submitted') return { status: 'cancel-pending-settle', attemptId: attempt.attemptId };
    return this.transaction(() => this.commitTerminalAttempt(
      this.assertActiveAttempt(ref),
      { attemptState: 'cancelled', jobState: 'cancelled', action: 'worker-cancelled', reason: 'operator-cancel' }
    ));
  }

  async reconcile(attemptId, decision, evidence = {}) {
    if (!['sent', 'not-sent', 'abandon'].includes(decision)) throw new Error('invalid-reconcile-decision');
    return this.transaction(() => {
      const attempt = this.store.readAttempt(attemptId);
      if (!attempt) throw new Error('attempt-not-found');
      const context = this.assertActiveAttempt(attemptRef(attempt));
      const authorization = this.validatePilot(context, 'reconcile', { failClosed: false });
      if (!['dispatch-uncertain', 'abandon-pending-settle'].includes(attempt.state)) {
        throw new Error('reconcile-not-uncertain');
      }
      if (decision === 'sent') {
        const reason = required(evidence.reason, 'reason');
        this.store.writeAttempt({
          ...attempt,
          state: 'reconciled-sent',
          transportState: 'submitted',
          reconciliation: { decision, reason, operator: evidence.operator || 'cli', decidedAt: this.clock() },
        });
        this.store.writeOperation({ ...context.operation, phase: 'dispatch-submitted', reconciliationDecision: decision });
        this.emitPilotEvent('reconciled-sent', { ...context, authorizationStatus: authorization });
        return { status: 'reconciled-sent', attemptId };
      }
      if (decision === 'not-sent') {
        this.reconcileNotSent(attemptId, evidence);
        const refreshed = this.assertActiveAttempt(attemptRef(attempt));
        this.emitPilotEvent('reconciled-not-sent', { ...refreshed, authorizationStatus: authorization });
        return this.commitTerminalAttempt(refreshed, {
          attemptState: 'reconciled-not-sent',
          jobState: 'reconciled-not-sent',
          action: 'worker-reconciled-not-sent',
          reason: evidence.reason,
        });
      }
      const reason = required(evidence.reason, 'reason');
      if (attempt.transportState === 'transport-in-flight') {
        this.store.writeAttempt({
          ...attempt,
          state: 'abandon-pending-settle',
          reconciliation: { decision, reason, operator: evidence.operator || 'cli', decidedAt: this.clock() },
        });
        return { status: 'abandon-pending-settle', attemptId };
      }
      return this.commitTerminalAttempt(context, {
        attemptState: 'abandoned', jobState: 'abandoned', action: 'worker-abandoned', reason,
      });
    });
  }

  async takeover(reason) {
    required(reason, 'reason');
    return this.transaction(() => {
      const status = this.statusStore.load();
      if (!status.execution.activeAttemptId) return { status: 'no-active-attempt' };
      const attempt = this.store.readAttempt(status.execution.activeAttemptId);
      if (attempt.state === 'dispatch-uncertain' || attempt.state === 'abandon-pending-settle') {
        throw new Error('reconcile-required');
      }
      if (attempt.transportState === 'transport-in-flight') throw new Error('transport-not-quiesced');
      const context = this.assertActiveAttempt(attemptRef(attempt));
      const authorization = this.validatePilot(context, 'takeover', { failClosed: false });
      this.emitPilotEvent('takeover', { ...context, authorizationStatus: authorization });
      return this.commitTerminalAttempt(context, {
        attemptState: 'taken-over', jobState: 'taken-over', action: 'worker-takeover', reason,
      });
    });
  }

  async retry(jobId) {
    return this.transaction(() => {
      this.recoverOperations();
      const status = this.statusStore.load();
      if (status.execution.activeJobId || status.execution.activeAttemptId) throw new Error('active-job-conflict');
      const previousJob = this.store.readJob(jobId);
      if (!previousJob) throw new Error('job-not-found');
      const previousAttempt = this.store.readAttempt(previousJob.attemptId);
      if (!previousAttempt) throw new Error('attempt-not-found');
      const safePreDispatchFailure = previousAttempt.state === 'failed-before-dispatch' && previousAttempt.dispatchingPersisted === false;
      const safeNotSent = previousAttempt.state === 'reconciled-not-sent' && previousAttempt.transportState === 'quiesced';
      if (previousAttempt.transportState === 'transport-in-flight' ||
          (previousAttempt.abortRequested && previousAttempt.transportState !== 'quiesced')) {
        throw new Error('transport-not-quiesced');
      }
      if (!safePreDispatchFailure && !safeNotSent) throw new Error('retry-not-allowed');

      const previousOperation = this.store.readOperation(previousAttempt.operationId);
      const previousLease = this.store.readLease(previousAttempt.bindingId);
      this.validatePilot({ status, operation: previousOperation, job: previousJob, attempt: previousAttempt, lease: previousLease }, 'retry');
      this.emitPilotEvent(safePreDispatchFailure ? 'safe-retry-check' : 'not-sent-retry-check', {
        status,
        operation: previousOperation,
        job: previousJob,
        attempt: previousAttempt,
        lease: previousLease,
      });

      const operationId = randomUUID();
      const attemptBase = createAttempt({ jobId, lockEpoch: status.execution.lockEpoch });
      const attempt = {
        ...attemptBase,
        operationId,
        bindingId: previousAttempt.bindingId,
        bindingIdentity: previousAttempt.bindingIdentity || previousJob.bindingIdentity || null,
        adapterIdentity: previousAttempt.adapterIdentity || previousJob.adapterIdentity || null,
        state: 'prepared',
        transportState: 'prepared',
        dispatchingPersisted: false,
        executionState: 'prepared',
        workflowState: 'pending',
        lastSequence: 0,
        appliedEventIds: [],
        retryOfAttemptId: previousAttempt.attemptId,
        ...(previousAttempt.pilotAuthorization || previousJob.pilotAuthorization
          ? { pilotAuthorization: previousAttempt.pilotAuthorization || previousJob.pilotAuthorization }
          : {}),
      };
      const job = {
        ...previousJob,
        operationId,
        attemptId: attempt.attemptId,
        attemptIds: [...new Set([...(previousJob.attemptIds || [previousAttempt.attemptId]), attempt.attemptId])],
        executionState: 'prepared',
        workflowState: 'pending',
        ...(previousJob.pilotAuthorization ? { pilotAuthorization: previousJob.pilotAuthorization } : {}),
      };
      const lease = {
        ...createLease({ bindingId: attempt.bindingId, attempt }),
        operationId,
        state: 'pending',
        bindingIdentity: attempt.bindingIdentity || null,
        adapterIdentity: attempt.adapterIdentity || null,
        ...(attempt.pilotAuthorization ? { pilotAuthorization: attempt.pilotAuthorization } : {}),
      };
      const payloads = { job, attempt, lease };
      const operation = {
        operationId,
        kind: 'dispatch-retry',
        phase: 'intent',
        payloadHash: canonicalPayloadHash(payloads),
        expectedStateRevision: status.stateRevision,
        expectedStageRevision: status.stageRevision,
        attemptRef: attemptRef(attempt),
        bindingId: attempt.bindingId,
        payloads,
        previousJob,
        ...(attempt.pilotAuthorization ? { pilotAuthorization: attempt.pilotAuthorization } : {}),
        createdAt: this.clock(),
      };
      this.store.writeOperation(operation);
      this.inject('after-retry-operation-intent', { operationId });
      this.store.writeJob(job);
      this.inject('after-retry-job-write', { operationId });
      this.store.writeAttempt(attempt);
      this.inject('after-retry-attempt-write', { operationId });
      this.store.writeLease(lease);
      this.inject('after-retry-lease-write', { operationId });
      const nextStatus = structuredClone(status);
      nextStatus.execution.mode = 'worker';
      nextStatus.execution.activeJobId = jobId;
      nextStatus.execution.activeAttemptId = attempt.attemptId;
      nextStatus.execution.activeLeaseToken = attempt.leaseToken;
      nextStatus.history = nextStatus.history || [];
      nextStatus.history.push({ timestamp: this.clock(), action: 'worker-retry-committed', details: { operationId, ...attemptRef(attempt) } });
      this.statusStore.saveCas(status.stateRevision, nextStatus);
      this.inject('after-retry-status-commit', { operationId });
      this.store.writeLease({ ...lease, state: 'active' });
      this.store.writeOperation({ ...operation, phase: 'committed' });
      this.emitPilotEvent(safePreDispatchFailure ? 'safe-retry-prepared' : 'not-sent-retry-prepared', {
        status: nextStatus,
        operation,
        job,
        attempt,
        lease,
      });
      return { status: 'retry-prepared', operationId, job, attempt };
    });
  }

  async pumpOnce() {
    await this.transaction(() => this.recoverOperations());
    const status = this.statusStore.load();
    const activeAttemptId = status.execution?.activeAttemptId;
    if (activeAttemptId) {
      const attempt = this.store.readAttempt(activeAttemptId);
      if (attempt?.transportState === 'transport-in-flight') {
        const settle = await this.settleTransport(activeAttemptId);
        if (settle.status === 'transport-in-flight') return settle;
      }
    }
    return this.transaction(() => this.pumpOnceLocked());
  }

  async pumpOnceLocked() {
    const inbox = this.store.listReceipts('inbox')
      .sort((a, b) => a.attemptId.localeCompare(b.attemptId) ||
        (Number.isInteger(a.receipt?.sequence) ? a.receipt.sequence : Number.MAX_SAFE_INTEGER) -
        (Number.isInteger(b.receipt?.sequence) ? b.receipt.sequence : Number.MAX_SAFE_INTEGER));
    let sequenceGap = false;
    for (const envelope of inbox) {
      if (envelope.error) {
        this.rejectMalformedReceipt(envelope);
        continue;
      }
      const receipt = envelope.receipt;
      try {
        await this.applyReceipt(receipt);
      } catch (error) {
        if (error.message === 'receipt-sequence-gap') {
          sequenceGap = true;
          continue;
        }
        if (error.message.startsWith('receipt-rejected:')) {
          this.rejectReceipt(receipt, error.message.slice('receipt-rejected:'.length));
          continue;
        }
        throw error;
      }
    }

    const status = this.statusStore.load();
    const activeAttemptId = status.execution?.activeAttemptId;
    if (!activeAttemptId) return { status: 'idle' };
    const attempt = this.store.readAttempt(activeAttemptId);
    if (!attempt) throw new Error('execution-corrupt: active attempt missing');

    const currentAttempt = this.store.readAttempt(activeAttemptId);
    const job = this.store.readJob(currentAttempt.jobId);
    if (job.executionState === 'failed' || currentAttempt.executionState === 'failed') {
      return this.commitTerminalAttempt(
        this.assertActiveAttempt(attemptRef(currentAttempt)),
        {
          attemptState: 'failed',
          jobState: 'failed',
          action: 'worker-failed',
          reason: currentAttempt.failureEvidence?.eventId || 'worker-failed-receipt',
        }
      );
    }
    if (job.workflowState === 'needs-input-awaiting-operator' ||
        currentAttempt.workflowState === 'needs-input-awaiting-operator') {
      return { status: 'needs-input', attemptId: currentAttempt.attemptId };
    }
    if (job.workflowState === 'worker-completed-awaiting-check' || job.workflowState === 'check-blocked') {
      return this.evaluateAndCommitWorkflow(job, currentAttempt);
    }
    if (sequenceGap) return { status: 'sequence-gap' };
    return { status: currentAttempt.state };
  }

  rejectMalformedReceipt(envelope) {
    this.store.writeReceiptApplication(envelope.attemptId, envelope.eventId, {
      eventId: envelope.eventId,
      attemptId: envelope.attemptId,
      payloadHash: envelope.payloadHash,
      classification: 'rejected',
      phase: 'committed',
      reason: 'malformed-json',
      rejectedAt: this.clock(),
    });
    this.store.finalizeReceipt(envelope.attemptId, envelope.eventId, 'rejected');
  }

  rejectReceipt(receipt, reason) {
    const payloadHash = canonicalPayloadHash(receipt);
    const existing = this.store.readReceiptApplication(receipt.attemptId, receipt.eventId);
    const collision = existing && existing.payloadHash !== payloadHash;
    const applicationId = collision ? `${receipt.eventId}.collision-${payloadHash.slice(0, 12)}` : receipt.eventId;
    this.store.writeReceiptApplication(receipt.attemptId, applicationId, {
      eventId: receipt.eventId,
      attemptId: receipt.attemptId,
      payloadHash,
      classification: 'rejected',
      phase: 'committed',
      reason: collision ? 'event-id-collision' : reason,
      collisionOf: collision ? receipt.eventId : undefined,
      rejectedAt: this.clock(),
    });
    this.store.finalizeReceipt(receipt.attemptId, receipt.eventId, 'rejected');
    return { status: 'receipt-rejected', reason };
  }

  validateReceiptBinding(receipt, attempt, job, lease) {
    const expected = attempt.bindingIdentity || job.bindingIdentity || lease.bindingIdentity || null;
    if (!expected) return;
    if (Object.prototype.hasOwnProperty.call(receipt, 'rawNonce') ||
        Object.prototype.hasOwnProperty.call(receipt, 'sessionNonce')) {
      throw new Error('receipt-rejected:raw-nonce-forbidden');
    }
    for (const field of ['bindingId', 'role', 'bindingGeneration', 'sessionId', 'sessionNonceHash', 'proof']) {
      if (receipt[field] === undefined || receipt[field] === null || receipt[field] === '') {
        throw new Error(`receipt-rejected:missing-${field}`);
      }
    }
    for (const field of ['bindingId', 'role', 'bindingGeneration', 'sessionId', 'sessionNonceHash']) {
      if (receipt[field] !== expected[field]) {
        throw new Error(`receipt-rejected:binding-${field}-mismatch`);
      }
    }
    const binding = this.store.readBinding(expected.bindingId);
    if (!binding) throw new Error('receipt-rejected:binding-unavailable');
    for (const field of ['bindingId', 'role', 'bindingGeneration', 'sessionId', 'sessionNonceHash']) {
      if (binding[field] !== expected[field]) {
        throw new Error(`receipt-rejected:binding-${field}-mismatch`);
      }
    }
    if (['terminal', 'revoked', 'detached'].includes(binding.state)) {
      throw new Error('receipt-rejected:binding-unavailable');
    }
    const heartbeatAt = binding.heartbeatAt || binding.createdAt;
    const heartbeatMs = Date.parse(heartbeatAt);
    const nowMs = Date.parse(this.clock());
    if (!Number.isFinite(heartbeatMs) || !Number.isFinite(nowMs) ||
        nowMs - heartbeatMs > BINDING_HEARTBEAT_STALE_MS) {
      throw new Error('receipt-rejected:binding-stale');
    }
    const rawNonce = this.store.readBindingSecret(expected.bindingId);
    if (!rawNonce) throw new Error('receipt-rejected:session-secret-unavailable');
    if (hashSessionNonce(rawNonce) !== expected.sessionNonceHash) {
      throw new Error('receipt-rejected:binding-secret-mismatch');
    }
    if (!verifySessionProof(rawNonce, receipt)) {
      throw new Error('receipt-rejected:session-proof-invalid');
    }
  }

  async applyReceipt(receiptInput) {
    const receipt = validateReceipt(receiptInput, Date.parse(this.clock()), this.maxClockSkewMs);
    const payloadHash = canonicalPayloadHash(receipt);
    let application = this.store.readReceiptApplication(receipt.attemptId, receipt.eventId);
    if (application && application.payloadHash !== payloadHash) throw new Error('receipt-rejected:event-id-collision');
    if (application?.phase === 'committed') {
      this.store.finalizeReceipt(receipt.attemptId, receipt.eventId, 'processed');
      return { status: 'receipt-already-applied' };
    }
    let attempt = this.store.readAttempt(receipt.attemptId);
    if (!attempt) throw new Error('receipt-rejected:superseded-attempt');
    if (attempt.jobId !== receipt.jobId || attempt.leaseToken !== receipt.leaseToken) {
      throw new Error('receipt-rejected:attempt-ref-mismatch');
    }
    const status = this.statusStore.load();
    if (status.execution.activeJobId !== attempt.jobId ||
        status.execution.activeAttemptId !== attempt.attemptId ||
        status.execution.activeLeaseToken !== attempt.leaseToken) {
      throw new Error('receipt-rejected:superseded-attempt');
    }
    const lease = this.store.readLease(attempt.bindingId);
    if (!lease || lease.operationId !== attempt.operationId ||
        lease.jobId !== attempt.jobId || lease.attemptId !== attempt.attemptId ||
        lease.leaseToken !== attempt.leaseToken) {
      throw new Error('receipt-rejected:lease-fence-conflict');
    }
    const jobForReceipt = this.store.readJob(receipt.jobId);
    try {
      assertAdapterIdentity(jobForReceipt?.adapterIdentity || null, attempt.adapterIdentity || null);
      assertAdapterIdentity(jobForReceipt?.adapterIdentity || null, lease.adapterIdentity || null);
    } catch {
      throw new Error('receipt-rejected:adapter-identity-fence-conflict');
    }
    if (attempt.lockEpoch !== status.execution.lockEpoch || lease.lockEpoch !== status.execution.lockEpoch) {
      throw new Error('receipt-rejected:fenced-lock-epoch');
    }
    this.validateReceiptBinding(receipt, attempt, jobForReceipt, lease);
    const operation = this.store.readOperation(attempt.operationId);
    if (!operation || operation.attemptRef?.attemptId !== attempt.attemptId ||
        operation.attemptRef?.leaseToken !== attempt.leaseToken) {
      throw new Error('receipt-rejected:operation-fence-conflict');
    }
    if (!application) {
      if (receipt.sequence > attempt.lastSequence + 1) throw new Error('receipt-sequence-gap');
      if (receipt.sequence === attempt.lastSequence) throw new Error('receipt-rejected:duplicate-sequence');
      if (receipt.sequence < attempt.lastSequence) throw new Error('receipt-rejected:stale-sequence');
      application = {
        eventId: receipt.eventId,
        attemptId: receipt.attemptId,
        payloadHash,
        classification: 'accepted',
        phase: 'validated',
        sequence: receipt.sequence,
      };
      this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, application);
    }
    if (application.phase === 'validated') {
      this.store.appendEvent(receipt);
      application = { ...application, phase: 'journaled' };
      this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, application);
    }

    const completionEvidence = { eventId: receipt.eventId, payloadHash, occurredAt: receipt.occurredAt };
    attempt = this.store.readAttempt(receipt.attemptId);
    if (!(attempt.appliedEventIds || []).includes(receipt.eventId)) {
      const nextAttempt = {
        ...attempt,
        lastSequence: receipt.sequence,
        appliedEventIds: [...(attempt.appliedEventIds || []), receipt.eventId],
      };
      if (receipt.kind === 'job.completed') {
        nextAttempt.executionState = 'worker-completed';
        nextAttempt.workflowState = 'worker-completed-awaiting-check';
        nextAttempt.completionEvidence = completionEvidence;
      } else if (receipt.kind === 'job.failed') {
        nextAttempt.executionState = 'failed';
        nextAttempt.failureEvidence = completionEvidence;
      } else if (receipt.kind === 'job.needs-input') {
        nextAttempt.executionState = 'needs-input';
        nextAttempt.workflowState = 'needs-input-awaiting-operator';
        nextAttempt.needsInputEvidence = completionEvidence;
      } else {
        nextAttempt.executionState = 'running';
      }
      this.store.writeAttempt(nextAttempt);
      this.inject('after-receipt-attempt-write', { eventId: receipt.eventId });
    }

    const job = this.store.readJob(receipt.jobId);
    if (!(job.appliedEventIds || []).includes(receipt.eventId)) {
      const nextJob = { ...job, appliedEventIds: [...(job.appliedEventIds || []), receipt.eventId] };
      if (receipt.kind === 'job.completed') {
        nextJob.executionState = 'worker-completed';
        nextJob.workflowState = 'worker-completed-awaiting-check';
        nextJob.completionEvidence = completionEvidence;
      } else if (receipt.kind === 'job.failed') {
        nextJob.executionState = 'failed';
        nextJob.failureEvidence = completionEvidence;
      } else if (receipt.kind === 'job.needs-input') {
        nextJob.executionState = 'needs-input';
        nextJob.workflowState = 'needs-input-awaiting-operator';
        nextJob.needsInputEvidence = completionEvidence;
      } else {
        nextJob.executionState = 'running';
      }
      this.store.writeJob(nextJob);
    }
    this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, { ...application, phase: 'committed' });
    this.store.finalizeReceipt(receipt.attemptId, receipt.eventId, 'processed');
    return { status: 'receipt-applied', kind: receipt.kind };
  }

  async evaluateAndCommitWorkflow(job, attempt) {
    const initialContext = this.assertActiveAttempt(attemptRef(attempt));
    const status = initialContext.status;
    const evaluation = await this.workflow.evaluate(structuredClone(status), structuredClone(attempt), structuredClone(job));
    if (!evaluation?.pass) {
      this.store.writeJob({
        ...job,
        workflowState: 'check-blocked',
        lastCheckDiagnostic: { reasons: evaluation?.reasons || ['check-failed'], evaluatedAt: this.clock() },
      });
      this.store.writeAttempt({ ...attempt, workflowState: 'check-blocked' });
      return { status: 'check-blocked', reasons: evaluation?.reasons || [] };
    }

    const transition = await this.workflow.derive(structuredClone(status), evaluation, structuredClone(attempt), structuredClone(job));
    this.assertActiveAttempt(attemptRef(attempt));
    const nextStatus = structuredClone(transition.nextStatus);
    nextStatus.execution.activeJobId = null;
    nextStatus.execution.activeAttemptId = null;
    nextStatus.execution.activeLeaseToken = null;
    nextStatus.execution.lastJobId = job.jobId;
    nextStatus.history = nextStatus.history || [];
    nextStatus.history.push({
      timestamp: this.clock(),
      action: 'worker-workflow-committed',
      details: {
        operationId: attempt.operationId,
        completionEventId: attempt.completionEvidence.eventId,
        preStageRevision: status.stageRevision,
        postCursor: transition.postCursor,
      },
    });
    const completedJob = { ...job, workflowState: 'workflow-completed', workflowCompletedAt: this.clock() };
    const completedAttempt = { ...attempt, workflowState: 'workflow-completed' };
    const operation = this.store.readOperation(attempt.operationId);
    const pilotAuthorization = attempt.pilotAuthorization || job.pilotAuthorization || null;
    const pilotRoleProgress = pilotAuthorization ? {
      role: pilotAuthorization.role,
      operationId: attempt.operationId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      leaseToken: attempt.leaseToken,
      completionEventId: attempt.completionEvidence.eventId,
      outputHash: evaluation?.primarySnapshot?.sha256 || '',
      postCursor: transition.postCursor,
      expectedStageRevision: pilotAuthorization.expectedStageRevision,
    } : null;
    this.store.writeOperation({
      ...operation,
      phase: 'workflow-committing',
      workflowCommit: {
        completionEventId: attempt.completionEvidence.eventId,
        job: completedJob,
        attempt: completedAttempt,
        ...(pilotRoleProgress ? { pilotRoleProgress } : {}),
      },
    });
    this.statusStore.saveCas(status.stateRevision, nextStatus);
    this.inject('after-workflow-status-cas', { operationId: attempt.operationId });
    this.onWorkflowCommitted?.({
      job: completedJob,
      attempt: completedAttempt,
      evaluation,
      preStatus: status,
      nextStatus,
      postCursor: transition.postCursor,
      pilotRoleProgress,
    });
    this.store.writeJob(completedJob);
    this.store.writeAttempt(completedAttempt);
    this.store.releaseLease(attempt.bindingId, { operationId: attempt.operationId, ...attemptRef(attempt) });
    this.store.writeOperation({ ...this.store.readOperation(attempt.operationId), phase: 'workflow-completed' });
    return { status: 'workflow-completed', postCursor: transition.postCursor };
  }
}
