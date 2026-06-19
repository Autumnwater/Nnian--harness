import { createHash, randomUUID } from 'node:crypto';

import {
  bindingIdentity,
  createSessionProof,
  verifySessionProof,
} from './execution-protocol.js';

export const WARP_CAPABILITY_NAME = 'warp-macos';
export const WARP_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const TARGET_CHALLENGE_TTL_MS = 2 * 60 * 1000;

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
} = {}) => {
  if (!evidence) return unavailableCapabilities('missing-warp-capability-evidence');
  if (evidence.fixture === true && !requireProductionTest) {
    return unavailableCapabilities('fixture-evidence-not-production');
  }
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
  return {
    dispatch: phase4RunEnabled,
    cancel: phase4RunEnabled,
    abortableDispatch: phase4RunEnabled,
    settleBarrier: phase4RunEnabled,
    mode: 'warp-macos',
    diagnosticEligible,
    phase4RunEnabled,
    phase5ProductionCandidate: diagnosticEligible && evidence.phase5ProductionCandidate === true,
    reasons,
    capturedAt: evidence.capturedAt,
  };
};

export const assertSideEffectMapping = result => {
  const state = result?.sideEffectState;
  if (!['none', 'input-mutated', 'submitted', 'unknown'].includes(state)) {
    throw new Error('invalid-submit-side-effect-state');
  }
  if (result.usedClipboard !== false) throw new Error('clipboard-dispatch-forbidden');
  if (state === 'none') {
    if (result.settled !== true || !result.transportEvidenceId || !result.evidencePath) {
      return { status: 'dispatch-uncertain', reason: 'missing-durable-none-evidence' };
    }
    return { status: 'failed-before-side-effect', safeBeforeSideEffect: true };
  }
  if (state === 'submitted') {
    if (result.settled !== true || !result.transportEvidenceId || !result.evidencePath) {
      return { status: 'dispatch-uncertain', reason: 'missing-durable-submit-evidence' };
    }
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
  constructor({ candidates = [], submitResult = null, crash = false } = {}) {
    this.candidates = candidates.map(candidate => ({ ...candidate }));
    this.submitResult = submitResult;
    this.crash = crash;
    this.submissions = [];
    this.interruptions = [];
  }

  async probe() {
    return { platform: 'fixture', accessibility: 'fixture' };
  }

  async scanTargets(query = {}) {
    return this.candidates
      .filter(candidate => !query.role || candidate.role === query.role)
      .map(candidate => ({ ...candidate }));
  }

  async submitText(candidate, payload, options = {}) {
    if (this.crash) throw new Error('helper-crash');
    this.submissions.push({ candidate, payload, options });
    if (this.submitResult) return { ...this.submitResult };
    return {
      protocolVersion: 1,
      kind: 'warp-macos.submit-result',
      operationId: options.operationId || randomUUID(),
      jobId: options.attempt?.jobId || null,
      attemptId: options.attempt?.attemptId || null,
      leaseToken: options.attempt?.leaseToken || null,
      candidateFingerprintHash: candidate.targetFingerprintHash || targetFingerprintHash(candidate.fingerprint),
      transportEvidenceId: randomUUID(),
      sideEffectState: 'submitted',
      settled: true,
      usedClipboard: false,
      submittedAt: new Date().toISOString(),
      evidencePath: 'fixture://warp-macos-submit-evidence',
    };
  }

  async interrupt(candidate, attempt) {
    this.interruptions.push({ candidate, attempt });
    return { status: 'cancelled', interrupted: true, attemptId: attempt.attemptId };
  }
}

export class WarpMacosAdapter {
  constructor({ store, helper = new FixtureWarpMacosHelper(), productionTest = false, scratchTask = false } = {}) {
    this.store = store;
    this.helper = helper;
    this.productionTest = productionTest;
    this.scratchTask = scratchTask;
  }

  async capabilities() {
    const evidence = this.store?.readCapability(WARP_CAPABILITY_NAME);
    return deriveWarpCapabilities(evidence, { requireProductionTest: this.productionTest && this.scratchTask });
  }

  async discoverTargets() {
    const candidates = await this.helper.scanTargets({});
    return candidates.map(candidate => ({
      ...candidate,
      adapter: 'warp-macos',
      bindingId: candidate.bindingId,
      role: candidate.role,
      targetFingerprintHash: candidate.targetFingerprintHash || targetFingerprintHash(candidate.fingerprint),
      adapterIdentity: candidate.adapterIdentity || null,
    }));
  }

  async health(target) {
    const capabilities = await this.capabilities();
    if (!capabilities.diagnosticEligible) return { healthy: false, reason: capabilities.reason || capabilities.reasons?.[0] };
    const first = await this.helper.scanTargets({ role: target.role });
    const second = await this.helper.scanTargets({ role: target.role });
    const matches = second.filter(candidate =>
      (candidate.targetFingerprintHash || targetFingerprintHash(candidate.fingerprint)) === target.targetFingerprintHash
    );
    return {
      healthy: first.length === 1 && matches.length === 1,
      targetFingerprintHash: target.targetFingerprintHash,
    };
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
    const mapped = assertSideEffectMapping(result);
    return { ...result, ...mapped };
  }

  async cancel(attempt, target) {
    const current = await this.health(target);
    if (!current.healthy) return { status: 'stale-attempt', interrupted: false, reason: current.reason || 'target-unhealthy' };
    return this.helper.interrupt(target, attempt);
  }

  async settleDispatch() {
    return { settled: false, outcome: 'unknown' };
  }
}
