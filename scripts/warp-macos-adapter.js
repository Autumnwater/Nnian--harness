import { createHash, randomUUID } from 'node:crypto';

import {
  bindingIdentity,
  createSessionProof,
  hashSessionNonce,
  verifySessionProof,
} from './execution-protocol.js';

export const WARP_CAPABILITY_NAME = 'warp-macos';
export const WARP_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const TARGET_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const BINDING_HEARTBEAT_STALE_MS = 300_000;

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const parseTime = (value, field) => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO timestamp`);
  return ms;
};

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])])
    );
  }
  return value;
};

export const canonicalTargetFingerprint = fingerprint => JSON.stringify(stableValue(fingerprint || {}));

export const targetFingerprintHash = fingerprint => {
  return `sha256:${createHash('sha256').update(canonicalTargetFingerprint(fingerprint)).digest('hex')}`;
};

const targetFingerprintHashForCandidate = candidate => {
  if (candidate?.targetFingerprintHash) return requiredString(candidate.targetFingerprintHash, 'targetFingerprintHash');
  const fingerprint = candidate?.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) {
    throw new Error('target-fingerprint-unavailable');
  }
  const keys = Object.keys(fingerprint).filter(key => fingerprint[key] !== undefined && fingerprint[key] !== null);
  const weakFields = new Set(['title', 'windowTitle', 'tabTitle', 'frontmost']);
  if (keys.length === 0 || keys.every(key => weakFields.has(key))) {
    throw new Error('target-fingerprint-unstable');
  }
  if (fingerprint.frontmost === true && keys.every(key => weakFields.has(key))) {
    throw new Error('target-fingerprint-frontmost-only');
  }
  return targetFingerprintHash(fingerprint);
};

const selectUniqueCandidate = (candidates, { role, candidateId }) => {
  const matches = candidates.filter(candidate =>
    candidate.role === role &&
    (candidate.candidateId || candidate.bindingId) === candidateId
  );
  if (matches.length === 0) throw new Error('target-discovery-zero');
  if (matches.length > 1) throw new Error('target-discovery-duplicate');
  const targetFingerprintHashValue = targetFingerprintHashForCandidate(matches[0]);
  return { ...matches[0], targetFingerprintHash: targetFingerprintHashValue };
};

export const discoverStableTarget = async (helper, { role, candidateId }) => {
  const first = await helper.scanTargets({ role });
  const second = await helper.scanTargets({ role });
  const firstMatch = selectUniqueCandidate(first, { role, candidateId });
  const secondMatch = selectUniqueCandidate(second, { role, candidateId });
  if (firstMatch.targetFingerprintHash !== secondMatch.targetFingerprintHash) {
    throw new Error('target-discovery-changed');
  }
  return {
    ...secondMatch,
    adapter: 'warp-macos',
    candidateId,
    targetFingerprintHash: secondMatch.targetFingerprintHash,
  };
};

const unavailableCapabilities = reason => ({
  dispatch: false,
  cancel: false,
  abortableDispatch: false,
  settleBarrier: false,
  mode: 'warp-macos',
  diagnosticEligible: false,
  phase4RunEnabled: false,
  phase5ProductionCandidate: false,
  reason,
});

export const deriveWarpCapabilities = (evidence, {
  nowMs = Date.now(),
  requireProductionTest = false,
  requirePhase5Pilot = false,
} = {}) => {
  if (!evidence) return unavailableCapabilities('missing-warp-capability-evidence');
  const capturedAtMs = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedAtMs) ||
      nowMs - capturedAtMs > WARP_CAPABILITY_TTL_MS ||
      capturedAtMs > nowMs + 60_000) {
    return unavailableCapabilities('warp-capability-evidence-stale');
  }
  const reasons = [];
  if (evidence.warp?.detected !== true) reasons.push('warp-not-detected');
  if (evidence.accessibility?.permission !== 'granted') reasons.push('accessibility-unavailable');
  if (evidence.targetDiscovery?.available !== true) reasons.push('target-discovery-unavailable');
  if (!Array.isArray(evidence.targetDiscovery?.stableFingerprintFields) ||
      evidence.targetDiscovery.stableFingerprintFields.length === 0) {
    reasons.push('target-fingerprint-fields-unavailable');
  }
  if (evidence.inputSubmission?.available !== true) reasons.push('input-submission-unavailable');
  if (evidence.inputSubmission?.usesClipboard !== false) reasons.push('clipboard-dispatch-forbidden');
  if (evidence.targetIdentity?.available !== true) reasons.push('target-identity-unavailable');
  if (evidence.targetIdentity?.requiresWrapperBinding !== true ||
      evidence.targetIdentity?.requiresChallenge !== true) {
    reasons.push('target-identity-contract-incomplete');
  }
  const diagnosticEligible = reasons.length === 0;
  const phase4RunEnabled = diagnosticEligible &&
    requireProductionTest &&
    evidence.phase4RunEnabled === true &&
    evidence.fixture === true;
  const phase5ProductionCandidate = diagnosticEligible &&
    evidence.phase5ProductionCandidate === true &&
    evidence.fixture !== true;
  const phase5RunEnabled = requirePhase5Pilot && phase5ProductionCandidate;
  return {
    dispatch: phase4RunEnabled || phase5RunEnabled,
    cancel: phase4RunEnabled || phase5RunEnabled,
    abortableDispatch: phase4RunEnabled || phase5RunEnabled,
    settleBarrier: phase4RunEnabled || phase5RunEnabled,
    mode: 'warp-macos',
    diagnosticEligible,
    phase4RunEnabled,
    phase5ProductionCandidate,
    reasons,
    capturedAt: evidence.capturedAt,
  };
};

const assertSubmitEvidence = ({ result, evidence, expectedTargetFingerprintHash, expectedAttempt }) => {
  if (!expectedTargetFingerprintHash || result.candidateFingerprintHash !== expectedTargetFingerprintHash) {
    return { ok: false, status: 'dispatch-uncertain', reason: 'target-fingerprint-mismatch' };
  }
  if (!evidence) return { ok: false, status: 'dispatch-uncertain', reason: 'missing-durable-submit-evidence' };
  const checks = [
    ['protocolVersion', 1],
    ['kind', 'warp-macos.submit-evidence'],
    ['transportEvidenceId', result.transportEvidenceId],
    ['operationId', result.operationId],
    ['jobId', expectedAttempt?.jobId || result.jobId || null],
    ['attemptId', expectedAttempt?.attemptId || result.attemptId || null],
    ['leaseToken', expectedAttempt?.leaseToken || result.leaseToken || null],
    ['candidateFingerprintHash', expectedTargetFingerprintHash],
    ['sideEffectState', result.sideEffectState],
    ['usedClipboard', result.usedClipboard],
  ];
  const mismatch = checks.find(([field, expected]) => (evidence[field] ?? null) !== (expected ?? null));
  if (mismatch) {
    return { ok: false, status: 'dispatch-uncertain', reason: `submit-evidence-${mismatch[0]}-mismatch` };
  }
  return { ok: true };
};

export const assertSideEffectMapping = (result, { expectedTargetFingerprintHash = null, evidence = null, expectedAttempt = null } = {}) => {
  const state = result?.sideEffectState;
  if (!['none', 'input-mutated', 'submitted', 'unknown'].includes(state)) {
    throw new Error('invalid-submit-side-effect-state');
  }
  if (result.usedClipboard !== false) throw new Error('clipboard-dispatch-forbidden');
  if (state === 'none') {
    if (result.settled !== true || !result.transportEvidenceId || !result.evidencePath) {
      return { status: 'dispatch-uncertain', reason: 'missing-durable-none-evidence' };
    }
    const evidenceCheck = assertSubmitEvidence({ result, evidence, expectedTargetFingerprintHash, expectedAttempt });
    if (!evidenceCheck.ok) return { status: evidenceCheck.status, reason: evidenceCheck.reason };
    return { status: 'failed-before-side-effect', safeBeforeSideEffect: true };
  }
  if (state === 'submitted') {
    if (result.settled !== true || !result.transportEvidenceId || !result.evidencePath) {
      return { status: 'dispatch-uncertain', reason: 'missing-durable-submit-evidence' };
    }
    const evidenceCheck = assertSubmitEvidence({ result, evidence, expectedTargetFingerprintHash, expectedAttempt });
    if (!evidenceCheck.ok) return { status: evidenceCheck.status, reason: evidenceCheck.reason };
    return { status: 'dispatch-submitted', submitted: true };
  }
  return { status: 'dispatch-uncertain', reason: state };
};

export const createTargetChallengePayload = ({
  taskId,
  role,
  binding,
  adapter = 'warp-macos',
  candidateId,
  targetFingerprintHash,
  capabilityEvidenceId,
  challengeId = randomUUID(),
  issuedAt = new Date().toISOString(),
}) => {
  const issuedAtMs = parseTime(issuedAt, 'issuedAt');
  return {
    protocolVersion: 1,
    kind: 'target.challenge',
    challengeId,
    taskId: requiredString(taskId, 'taskId'),
    role: requiredString(role, 'role'),
    ...bindingIdentity(binding),
    adapter,
    candidateId: requiredString(candidateId, 'candidateId'),
    targetFingerprintHash: requiredString(targetFingerprintHash, 'targetFingerprintHash'),
    capabilityEvidenceId: requiredString(capabilityEvidenceId, 'capabilityEvidenceId'),
    issuedAt,
    expiresAt: new Date(issuedAtMs + TARGET_CHALLENGE_TTL_MS).toISOString(),
    mode: 'shadow-noop',
  };
};

export const createTargetChallengeResponse = ({ payload, rawNonce, eventId = randomUUID(), occurredAt = new Date().toISOString() }) => {
  const response = {
    protocolVersion: 1,
    kind: 'target.challenge-response',
    eventId,
    challengeId: requiredString(payload?.challengeId, 'payload.challengeId'),
    taskId: requiredString(payload?.taskId, 'payload.taskId'),
    role: requiredString(payload?.role, 'payload.role'),
    bindingId: requiredString(payload?.bindingId, 'payload.bindingId'),
    bindingGeneration: payload.bindingGeneration,
    sessionId: requiredString(payload?.sessionId, 'payload.sessionId'),
    sessionNonceHash: requiredString(payload?.sessionNonceHash, 'payload.sessionNonceHash'),
    adapter: payload.adapter || 'warp-macos',
    targetFingerprintHash: requiredString(payload?.targetFingerprintHash, 'payload.targetFingerprintHash'),
    capabilityEvidenceId: requiredString(payload?.capabilityEvidenceId, 'payload.capabilityEvidenceId'),
    occurredAt,
  };
  response.proof = createSessionProof(rawNonce, response);
  return response;
};

export const validateTargetChallengeResponse = ({ challenge, response, binding, rawNonce, nowMs = Date.now() }) => {
  if (!challenge?.payload) throw new Error('target-challenge-not-found');
  if (challenge.status === 'verified') throw new Error('target-challenge-replay');
  const payload = challenge.payload;
  if (parseTime(payload.expiresAt, 'expiresAt') < nowMs) throw new Error('target-challenge-expired');
  if (response?.kind !== 'target.challenge-response') throw new Error('target-challenge-invalid-kind');
  for (const field of [
    'challengeId', 'taskId', 'role', 'bindingId', 'bindingGeneration', 'sessionId',
    'sessionNonceHash', 'adapter', 'targetFingerprintHash', 'capabilityEvidenceId',
  ]) {
    if (response[field] !== payload[field]) throw new Error(`target-challenge-${field}-mismatch`);
  }
  const currentIdentity = bindingIdentity(binding);
  for (const field of ['bindingId', 'role', 'bindingGeneration', 'sessionId', 'sessionNonceHash']) {
    if (currentIdentity[field] !== response[field]) throw new Error(`target-challenge-binding-${field}-mismatch`);
  }
  if (!rawNonce) throw new Error('target-challenge-secret-unavailable');
  if (!verifySessionProof(rawNonce, response)) throw new Error('target-challenge-proof-invalid');
  return {
    adapter: response.adapter,
    targetFingerprintHash: response.targetFingerprintHash,
    verifiedAt: response.occurredAt,
    challengeId: response.challengeId,
    challengeResponseEventId: response.eventId,
    capabilityEvidenceId: response.capabilityEvidenceId,
  };
};

export class FixtureWarpMacosHelper {
  constructor({ candidates = [], scanSequences = null, submitResult = null, crash = false, store = null } = {}) {
    this.candidates = candidates.map(candidate => ({ ...candidate }));
    this.scanSequences = Array.isArray(scanSequences)
      ? scanSequences.map(scan => scan.map(candidate => ({ ...candidate })))
      : null;
    this.scanIndex = 0;
    this.submitResult = submitResult;
    this.crash = crash;
    this.store = store;
    this.submissions = [];
    this.interruptions = [];
  }

  setStore(store) {
    this.store = store;
  }

  async probe() {
    return { platform: 'fixture', accessibility: 'fixture' };
  }

  async scanTargets(query = {}) {
    const source = this.scanSequences
      ? this.scanSequences[Math.min(this.scanIndex++, this.scanSequences.length - 1)]
      : this.candidates;
    return source
      .filter(candidate => !query.role || candidate.role === query.role)
      .map(candidate => ({ ...candidate }));
  }

  async submitText(candidate, payload, options = {}) {
    if (this.crash) throw new Error('helper-crash');
    this.submissions.push({ candidate, payload, options });
    if (this.submitResult) {
      const supplied = { ...this.submitResult };
      supplied.operationId ??= options.operationId ?? null;
      supplied.jobId ??= options.attempt?.jobId ?? null;
      supplied.attemptId ??= options.attempt?.attemptId ?? null;
      supplied.leaseToken ??= options.attempt?.leaseToken ?? null;
      supplied.candidateFingerprintHash ??= candidate.targetFingerprintHash || targetFingerprintHashForCandidate(candidate);
      if (this.store && supplied.writeEvidence !== false && supplied.transportEvidenceId) {
        this.store.writeTransportEvidence(supplied.transportEvidenceId, {
          protocolVersion: 1,
          kind: 'warp-macos.submit-evidence',
          transportEvidenceId: supplied.transportEvidenceId,
          operationId: supplied.operationId,
          jobId: supplied.jobId,
          attemptId: supplied.attemptId,
          leaseToken: supplied.leaseToken,
          candidateFingerprintHash: supplied.candidateFingerprintHash,
          sideEffectState: supplied.sideEffectState,
          usedClipboard: supplied.usedClipboard,
          createdAt: new Date().toISOString(),
        });
      }
      return supplied;
    }
    const transportEvidenceId = randomUUID();
    const result = {
      protocolVersion: 1,
      kind: 'warp-macos.submit-result',
      operationId: options.operationId || randomUUID(),
      jobId: options.attempt?.jobId || null,
      attemptId: options.attempt?.attemptId || null,
      leaseToken: options.attempt?.leaseToken || null,
      candidateFingerprintHash: candidate.targetFingerprintHash || targetFingerprintHashForCandidate(candidate),
      transportEvidenceId,
      sideEffectState: 'submitted',
      settled: true,
      usedClipboard: false,
      submittedAt: new Date().toISOString(),
      evidencePath: `transport://${transportEvidenceId}`,
    };
    this.store?.writeTransportEvidence(transportEvidenceId, {
      protocolVersion: 1,
      kind: 'warp-macos.submit-evidence',
      transportEvidenceId,
      operationId: result.operationId,
      jobId: result.jobId,
      attemptId: result.attemptId,
      leaseToken: result.leaseToken,
      candidateFingerprintHash: result.candidateFingerprintHash,
      sideEffectState: result.sideEffectState,
      usedClipboard: result.usedClipboard,
      createdAt: result.submittedAt,
    });
    return result;
  }

  async interrupt(candidate, attempt) {
    this.interruptions.push({ candidate, attempt });
    return { status: 'cancelled', interrupted: true, attemptId: attempt.attemptId };
  }
}

export class WarpMacosAdapter {
  constructor({ store, helper = new FixtureWarpMacosHelper(), productionTest = false, scratchTask = false, phase5Pilot = false } = {}) {
    this.store = store;
    this.helper = helper;
    this.helper?.setStore?.(store);
    this.productionTest = productionTest;
    this.scratchTask = scratchTask;
    this.phase5Pilot = phase5Pilot;
  }

  async capabilities() {
    const evidence = this.store?.readCapability(WARP_CAPABILITY_NAME);
    return deriveWarpCapabilities(evidence, {
      requireProductionTest: this.productionTest && this.scratchTask,
      requirePhase5Pilot: this.phase5Pilot,
    });
  }

  async discoverTargets() {
    const candidates = await this.helper.scanTargets({});
    return candidates.map(candidate => ({
      ...candidate,
      adapter: 'warp-macos',
      bindingId: candidate.bindingId,
      role: candidate.role,
      targetFingerprintHash: targetFingerprintHashForCandidate(candidate),
      adapterIdentity: candidate.adapterIdentity || null,
    }));
  }

  async health(target) {
    const capabilities = await this.capabilities();
    if (!capabilities.diagnosticEligible) return { healthy: false, reason: capabilities.reason || capabilities.reasons?.[0] };
    const candidateId = target.candidateId || target.adapterIdentity?.candidateId || target.bindingId;
    let stable;
    try {
      stable = await discoverStableTarget(this.helper, { role: target.role, candidateId });
    } catch (error) {
      return { healthy: false, reason: error.message, targetFingerprintHash: target.targetFingerprintHash };
    }
    const expectedFingerprintHash = target.adapterIdentity?.targetFingerprintHash || target.targetFingerprintHash;
    if (stable.targetFingerprintHash !== expectedFingerprintHash) {
      return {
        healthy: false,
        reason: 'target-discovery-fingerprint-mismatch',
        targetFingerprintHash: stable.targetFingerprintHash,
      };
    }
    return { healthy: true, targetFingerprintHash: stable.targetFingerprintHash };
  }

  assertCurrentTargetIdentity(target) {
    const identity = target?.adapterIdentity;
    if (!identity) throw new Error('adapter-identity-unavailable');
    const binding = this.store?.readBinding(identity.bindingId);
    if (!binding) throw new Error('binding-unavailable');
    if (['terminal', 'revoked', 'detached'].includes(binding.state)) throw new Error('binding-unavailable');
    const heartbeatAt = binding.heartbeatAt || binding.createdAt;
    const heartbeatMs = Date.parse(heartbeatAt);
    if (!Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > BINDING_HEARTBEAT_STALE_MS) {
      throw new Error('binding-stale');
    }
    for (const field of ['role', 'bindingGeneration', 'sessionId', 'sessionNonceHash']) {
      if ((binding[field] ?? null) !== (identity[field] ?? null)) throw new Error(`adapter-identity-${field}-mismatch`);
    }
    const rawNonce = this.store?.readBindingSecret(identity.bindingId);
    if (!rawNonce) throw new Error('session-secret-unavailable');
    if (hashSessionNonce(rawNonce) !== identity.sessionNonceHash) throw new Error('session-secret-hash-mismatch');
    const targetBinding = binding.targetBinding;
    if (!targetBinding) throw new Error('target-binding-unavailable');
    const targetFields = [
      ['targetFingerprintHash', targetBinding.targetFingerprintHash],
      ['targetChallengeId', targetBinding.challengeId],
      ['targetBindingVerifiedAt', targetBinding.verifiedAt],
      ['capabilityEvidenceId', targetBinding.capabilityEvidenceId],
    ];
    const mismatch = targetFields.find(([field, actual]) => (actual ?? null) !== (identity[field] ?? null));
    if (mismatch) throw new Error(`adapter-identity-${mismatch[0]}-mismatch`);
    const capability = this.store?.readCapability(WARP_CAPABILITY_NAME);
    const capabilityId = capability ? `${WARP_CAPABILITY_NAME}:${capability.capturedAt}` : null;
    if (capabilityId !== identity.capabilityEvidenceId) throw new Error('adapter-identity-capabilityEvidenceId-mismatch');
    return binding;
  }

  async dispatch(job, target, options = {}) {
    const capabilities = await this.capabilities();
    if (!capabilities.dispatch) {
      return { status: 'target-unavailable', submitted: false, error: 'warp-macos-production-disabled', safeBeforeSideEffect: true };
    }
    const current = await this.health(target);
    if (!current.healthy) {
      return { status: 'target-unavailable', submitted: false, error: current.reason || 'target-unhealthy', safeBeforeSideEffect: true };
    }
    try {
      this.assertCurrentTargetIdentity(target);
    } catch (error) {
      return { status: 'target-unavailable', submitted: false, error: error.message, safeBeforeSideEffect: true };
    }
    let result;
    try {
      result = await this.helper.submitText(target, job.promptText || job.promptPath, {
        operationId: options.operationId,
        attempt: job.attempt,
        signal: options.signal,
      });
    } catch (error) {
      return { status: 'dispatch-error', error: error.message, ambiguous: true };
    }
    const evidence = result.transportEvidenceId ? this.store?.readTransportEvidence(result.transportEvidenceId) : null;
    const mapped = assertSideEffectMapping(result, {
      expectedTargetFingerprintHash: target.targetFingerprintHash,
      expectedAttempt: job.attempt,
      evidence,
    });
    return { ...result, ...mapped };
  }

  async cancel(attempt, target) {
    const current = await this.health(target);
    if (!current.healthy) return { status: 'stale-attempt', interrupted: false, reason: current.reason || 'target-unhealthy' };
    try {
      this.assertCurrentTargetIdentity(target);
    } catch (error) {
      return { status: 'stale-attempt', interrupted: false, reason: error.message };
    }
    return this.helper.interrupt(target, attempt);
  }

  async settleDispatch() {
    return { settled: false, outcome: 'unknown' };
  }
}
