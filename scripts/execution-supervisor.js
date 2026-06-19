import { randomUUID } from 'node:crypto';

import {
  assertAttemptRef,
  createAttempt,
  createJob,
  createLease,
} from './execution-protocol.js';
import { canonicalPayloadHash } from './execution-store.js';

const isoNow = () => new Date().toISOString();

const required = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const attemptRef = attempt => ({
  jobId: attempt.jobId,
  attemptId: attempt.attemptId,
  leaseToken: attempt.leaseToken,
});

const validateReceipt = receipt => {
  if (receipt?.protocolVersion !== 1) throw new Error('receipt-invalid: protocolVersion');
  for (const field of ['eventId', 'jobId', 'attemptId', 'leaseToken', 'kind', 'occurredAt', 'source']) {
    required(receipt?.[field], `receipt.${field}`);
  }
  if (!['job.running', 'job.completed', 'job.failed'].includes(receipt.kind)) {
    throw new Error('receipt-invalid: kind');
  }
  if (!Number.isInteger(receipt.sequence) || receipt.sequence <= 0) {
    throw new Error('receipt-invalid: sequence');
  }
  if (!Number.isFinite(Date.parse(receipt.occurredAt))) throw new Error('receipt-invalid: occurredAt');
  return receipt;
};

export class ExecutionSupervisor {
  constructor({ taskId, store, statusStore, adapter, workflow, clock = isoNow }) {
    this.taskId = required(taskId, 'taskId');
    this.store = store;
    this.statusStore = statusStore;
    this.adapter = adapter;
    this.workflow = workflow;
    this.clock = clock;
  }

  async resolveTarget(jobInput) {
    const capabilities = await this.adapter.capabilities();
    if (!capabilities.dispatch || !capabilities.abortableDispatch || !capabilities.settleBarrier) {
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
    const status = this.statusStore.load();
    if (status.execution?.activeJobId || status.execution?.activeAttemptId) {
      throw new Error('active-job-conflict');
    }
    if (status.stageRevision !== jobInput.expectedStageRevision) {
      throw new Error('stage-cas-conflict: stageRevision');
    }

    const jobBase = createJob(jobInput);
    const attemptBase = createAttempt({ jobId: jobBase.jobId, lockEpoch: status.execution.lockEpoch });
    const operationId = randomUUID();
    const payloadHash = canonicalPayloadHash({ job: jobBase, attempt: attemptBase, target });
    let operation = {
      operationId,
      kind: 'dispatch-prepare',
      phase: 'intent',
      payloadHash,
      expectedStateRevision: status.stateRevision,
      expectedStageRevision: status.stageRevision,
      attemptRef: attemptRef(attemptBase),
      bindingId: target.bindingId,
      createdAt: this.clock(),
    };
    this.store.writeOperation(operation);

    let job = {
      ...jobBase,
      operationId,
      attemptId: attemptBase.attemptId,
      executionState: 'preparing',
      workflowState: 'pending',
      target,
    };
    let attempt = {
      ...attemptBase,
      operationId,
      bindingId: target.bindingId,
      state: 'prepared',
      transportState: 'prepared',
      dispatchingPersisted: false,
      executionState: 'prepared',
      workflowState: 'pending',
      lastSequence: 0,
      appliedEventIds: [],
    };
    this.store.writeJob(job);
    this.store.writeAttempt(attempt);
    const lease = {
      ...createLease({ bindingId: target.bindingId, attempt }),
      operationId,
      state: 'pending',
    };
    this.store.writeLease(lease);

    const nextStatus = structuredClone(status);
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

    operation = { ...operation, phase: 'committed', committedAt: this.clock() };
    job = { ...job, executionState: 'prepared' };
    attempt = { ...attempt, state: 'prepared' };
    this.store.writeOperation(operation);
    this.store.writeJob(job);
    this.store.writeAttempt(attempt);
    this.store.writeLease({ ...lease, state: 'active' });
    return { operationId, job, attempt, target };
  }

  async dispatch(operationId, { timeoutMs = 30_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
    const operation = this.store.readOperation(operationId);
    if (!operation || operation.phase !== 'committed') throw new Error('dispatch-operation-not-ready');
    const attempt = this.store.readAttempt(operation.attemptRef.attemptId);
    const job = this.store.readJob(operation.attemptRef.jobId);
    assertAttemptRef(operation.attemptRef, attemptRef(attempt));
    const lease = this.store.readLease(operation.bindingId);
    assertAttemptRef(operation.attemptRef, lease);
    const target = job.target;

    const dispatching = {
      ...attempt,
      state: 'dispatching',
      transportState: 'transport-in-flight',
      dispatchingPersisted: true,
      dispatchingAt: this.clock(),
    };
    this.store.writeAttempt(dispatching);
    this.store.writeOperation({ ...operation, phase: 'dispatching', dispatchingAt: this.clock() });

    const controller = new AbortController();
    const dispatchPromise = Promise.resolve(this.adapter.dispatch(
      { ...job, attempt: attemptRef(dispatching) },
      target,
      { operationId, signal: controller.signal }
    ));
    let timer;
    const timeoutMarker = Symbol('dispatch-timeout');
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
    });
    let result;
    try {
      result = await Promise.race([dispatchPromise, timeoutPromise]);
    } catch (error) {
      result = { status: 'dispatch-error', error: error.message, ambiguous: true };
    } finally {
      clearTimeout(timer);
    }

    if (result === timeoutMarker) {
      controller.abort(new Error('dispatch-timeout'));
      const uncertain = {
        ...this.store.readAttempt(attempt.attemptId),
        state: 'dispatch-uncertain',
        transportState: 'transport-in-flight',
        abortRequested: true,
        dispatchUncertainReason: 'dispatch-timeout-before-settle',
      };
      this.store.writeAttempt(uncertain);
      this.store.writeOperation({
        ...this.store.readOperation(operationId),
        phase: 'dispatch-uncertain',
        transportState: 'transport-in-flight',
      });
      dispatchPromise.then(
        lateResult => this.recordLateTransportResult(operationId, attemptRef(attempt), lateResult),
        error => this.recordLateTransportResult(operationId, attemptRef(attempt), { status: 'dispatch-error', error: error.message })
      );
      return { status: 'dispatch-uncertain', attemptId: attempt.attemptId };
    }

    if (result?.status === 'dispatch-submitted' || result?.submitted === true) {
      this.store.writeAttempt({
        ...this.store.readAttempt(attempt.attemptId),
        state: 'dispatch-submitted',
        transportState: 'submitted',
        dispatchSubmittedAt: this.clock(),
      });
      this.store.writeOperation({ ...this.store.readOperation(operationId), phase: 'dispatch-submitted' });
      return { ...result, status: 'dispatch-submitted' };
    }

    this.store.writeAttempt({
      ...this.store.readAttempt(attempt.attemptId),
      state: 'dispatch-uncertain',
      transportState: 'ambiguous-settled',
      dispatchUncertainReason: result?.error || result?.status || 'ambiguous-result',
    });
    return { status: 'dispatch-uncertain', attemptId: attempt.attemptId };
  }

  recordLateTransportResult(operationId, expectedAttempt, result) {
    const operation = this.store.readOperation(operationId);
    if (!operation) return { applied: false, reason: 'missing-operation' };
    try {
      assertAttemptRef(expectedAttempt, operation.attemptRef);
      const attempt = this.store.readAttempt(expectedAttempt.attemptId);
      assertAttemptRef(expectedAttempt, attemptRef(attempt));
      this.store.writeAttempt({ ...attempt, lateTransportResult: result, lateTransportAt: this.clock() });
      this.store.writeOperation({ ...operation, lateTransportResult: result, lateTransportAt: this.clock() });
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
    const current = this.store.readAttempt(attemptId);
    assertAttemptRef(attemptRef(attempt), attemptRef(current));
    this.store.writeAttempt({
      ...current,
      transportState: result.outcome === 'submitted' ? 'submitted' : 'quiesced',
      transportOutcome: result.outcome,
      settledAt: this.clock(),
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

  async pumpOnce() {
    const status = this.statusStore.load();
    const activeAttemptId = status.execution?.activeAttemptId;
    if (!activeAttemptId) return { status: 'idle' };
    const attempt = this.store.readAttempt(activeAttemptId);
    if (!attempt) throw new Error('execution-corrupt: active attempt missing');

    const inbox = this.store.listReceipts('inbox')
      .map(item => item.receipt)
      .filter(receipt => receipt.attemptId === activeAttemptId)
      .sort((a, b) => a.sequence - b.sequence);
    if (inbox.length > 0) await this.applyReceipt(inbox[0]);

    const currentAttempt = this.store.readAttempt(activeAttemptId);
    const job = this.store.readJob(currentAttempt.jobId);
    if (job.workflowState === 'worker-completed-awaiting-check' || job.workflowState === 'check-blocked') {
      return this.evaluateAndCommitWorkflow(job, currentAttempt);
    }
    return { status: currentAttempt.state };
  }

  async applyReceipt(receiptInput) {
    const receipt = validateReceipt(receiptInput);
    const attempt = this.store.readAttempt(receipt.attemptId);
    if (!attempt) throw new Error('receipt-stale-attempt');
    assertAttemptRef(attemptRef(attempt), receipt);
    if (receipt.sequence !== attempt.lastSequence + 1) throw new Error('receipt-sequence-gap');
    const payloadHash = canonicalPayloadHash(receipt);
    let application = this.store.readReceiptApplication(receipt.attemptId, receipt.eventId);
    if (application?.phase === 'committed') {
      this.store.finalizeReceipt(receipt.attemptId, receipt.eventId, 'processed');
      return { status: 'receipt-already-applied' };
    }
    application = {
      eventId: receipt.eventId,
      attemptId: receipt.attemptId,
      payloadHash,
      classification: 'accepted',
      phase: 'validated',
      sequence: receipt.sequence,
    };
    this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, application);
    this.store.appendEvent(receipt);
    this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, { ...application, phase: 'journaled' });

    const nextAttempt = {
      ...attempt,
      lastSequence: receipt.sequence,
      appliedEventIds: [...(attempt.appliedEventIds || []), receipt.eventId],
    };
    const job = this.store.readJob(receipt.jobId);
    let nextJob = { ...job };
    if (receipt.kind === 'job.completed') {
      nextAttempt.executionState = 'worker-completed';
      nextAttempt.workflowState = 'worker-completed-awaiting-check';
      nextAttempt.completionEvidence = { eventId: receipt.eventId, payloadHash, occurredAt: receipt.occurredAt };
      nextJob.executionState = 'worker-completed';
      nextJob.workflowState = 'worker-completed-awaiting-check';
      nextJob.completionEvidence = nextAttempt.completionEvidence;
    } else if (receipt.kind === 'job.failed') {
      nextAttempt.executionState = 'failed';
      nextJob.executionState = 'failed';
    } else {
      nextAttempt.executionState = 'running';
      nextJob.executionState = 'running';
    }
    this.store.writeAttempt(nextAttempt);
    this.store.writeJob(nextJob);
    this.store.writeReceiptApplication(receipt.attemptId, receipt.eventId, { ...application, phase: 'committed' });
    this.store.finalizeReceipt(receipt.attemptId, receipt.eventId, 'processed');
    return { status: 'receipt-applied', kind: receipt.kind };
  }

  async evaluateAndCommitWorkflow(job, attempt) {
    const status = this.statusStore.load();
    assertAttemptRef(attemptRef(attempt), {
      jobId: status.execution.activeJobId,
      attemptId: status.execution.activeAttemptId,
      leaseToken: status.execution.activeLeaseToken,
    });
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
    this.statusStore.saveCas(status.stateRevision, nextStatus);
    this.store.writeJob({ ...job, workflowState: 'workflow-completed', workflowCompletedAt: this.clock() });
    this.store.writeAttempt({ ...attempt, workflowState: 'workflow-completed' });
    this.store.releaseLease(attempt.bindingId, { operationId: attempt.operationId, ...attemptRef(attempt) });
    return { status: 'workflow-completed', postCursor: transition.postCursor };
  }
}
