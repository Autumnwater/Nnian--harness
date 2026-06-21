import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

const requiredObject = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is required`);
  return value;
};

const requiredInteger = (value, field) => {
  if (!Number.isInteger(value)) throw new Error(`${field} is required`);
  return value;
};

const parseHelperJson = (result, command) => {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(stderr || `warp-macos-helper-${command}-failed`);
  }
  try {
    return JSON.parse(String(result.stdout || '{}'));
  } catch (error) {
    throw new Error(`warp-macos-helper-${command}-invalid-json: ${error.message}`);
  }
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

const sha256HashPattern = /^sha256:[a-f0-9]{64}$/;

const realCapabilityValidationReasons = evidence => {
  const reasons = [];
  if (evidence?.protocolVersion !== 1) reasons.push('warp-capability-protocol-invalid');
  if (evidence?.kind !== 'warp-macos.capability') reasons.push('warp-capability-kind-invalid');
  if (evidence?.fixture !== false) reasons.push('real-helper-fixture-flag-required');
  if (evidence?.helper?.kind !== 'warp-macos-helper') reasons.push('real-helper-kind-invalid');
  if (!Number.isInteger(evidence?.helper?.version) || evidence.helper.version < 1) {
    reasons.push('real-helper-version-invalid');
  }
  if (typeof evidence?.helper?.pathHash !== 'string' || !sha256HashPattern.test(evidence.helper.pathHash)) {
    reasons.push('real-helper-path-hash-invalid');
  }
  return reasons;
};

export const assertRealWarpCapabilityEvidence = evidence => {
  const reasons = realCapabilityValidationReasons(evidence);
  if (reasons.length > 0) throw new Error(`invalid-real-warp-capability-evidence: ${reasons.join(',')}`);
  return evidence;
};

export const deriveWarpCapabilities = (evidence, {
  nowMs = Date.now(),
  requireProductionTest = false,
  requirePhase5Pilot = false,
} = {}) => {
  if (!evidence) return unavailableCapabilities('missing-warp-capability-evidence');
  if (evidence.protocolVersion !== 1) return unavailableCapabilities('warp-capability-protocol-invalid');
  if (evidence.kind !== 'warp-macos.capability') return unavailableCapabilities('warp-capability-kind-invalid');
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
  const realCapabilityReasons = realCapabilityValidationReasons(evidence);
  const diagnosticEligible = reasons.length === 0;
  const phase4RunEnabled = diagnosticEligible &&
    requireProductionTest &&
    evidence.phase4RunEnabled === true &&
    evidence.fixture === true;
  const phase5ProductionCandidate = diagnosticEligible &&
    realCapabilityReasons.length === 0 &&
    evidence.phase5ProductionCandidate === true &&
    evidence.fixture === false;
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
    reasons: requirePhase5Pilot ? [...reasons, ...realCapabilityReasons] : reasons,
    capturedAt: evidence.capturedAt,
  };
};

const assertSubmitEvidence = ({ result, evidence, expectedTargetFingerprintHash, expectedAttempt }) => {
  if (Object.prototype.hasOwnProperty.call(result || {}, 'candidateFingerprintHash')) {
    return { ok: false, status: 'dispatch-uncertain', reason: 'target-fingerprint-alias-forbidden' };
  }
  if (!expectedTargetFingerprintHash || result.targetFingerprintHash !== expectedTargetFingerprintHash) {
    return { ok: false, status: 'dispatch-uncertain', reason: 'target-fingerprint-mismatch' };
  }
  if (!evidence) return { ok: false, status: 'dispatch-uncertain', reason: 'missing-durable-submit-evidence' };
  const checks = [
    [['protocolVersion'], 1],
    [['kind'], 'warp-macos.submit-evidence'],
    [['transportEvidenceId'], result.transportEvidenceId],
    [['operationId'], result.operationId],
    [['targetFingerprintHash'], expectedTargetFingerprintHash],
    [['sideEffectState'], result.sideEffectState],
    [['usedClipboard'], result.usedClipboard],
  ];
  if (expectedAttempt) {
    checks.push(
      [['attemptRef', 'jobId'], expectedAttempt.jobId || result.attemptRef?.jobId || null],
      [['attemptRef', 'attemptId'], expectedAttempt.attemptId || result.attemptRef?.attemptId || null],
      [['attemptRef', 'leaseToken'], expectedAttempt.leaseToken || result.attemptRef?.leaseToken || null]
    );
  }
  if (result.attemptRef) {
    checks.push(
      [['attemptRef', 'jobId'], result.attemptRef.jobId],
      [['attemptRef', 'attemptId'], result.attemptRef.attemptId],
      [['attemptRef', 'leaseToken'], result.attemptRef.leaseToken]
    );
  }
  const mismatch = checks.find(([field, expected]) => (pathValue(evidence, field) ?? null) !== (expected ?? null));
  if (mismatch) {
    return { ok: false, status: 'dispatch-uncertain', reason: `submit-evidence-${mismatch[0].join('.')}-mismatch` };
  }
  return { ok: true };
};

const hashInlineInput = value => `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;

const diagnosticPilotAuthorization = () => ({
  allowlistId: 'diagnostic-shadow',
  allowlistHash: 'sha256:diagnostic-shadow',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

export const createWarpSideEffectRequest = ({ kind, operationId, job, target, reason = null }) => {
  if (!['submit', 'interrupt'].includes(kind)) throw new Error('invalid-side-effect-request-kind');
  const attempt = requiredObject(job?.attempt, 'job.attempt');
  const adapterIdentity = requiredObject(target?.adapterIdentity, 'target.adapterIdentity');
  const inputHash = job.promptSha256 || hashInlineInput(job.promptText || job.promptPath || '');
  const inputPath = job.promptPath || `inline:${inputHash}`;
  const request = {
    protocolVersion: 1,
    kind: kind === 'submit' ? 'warp-macos.submit-request' : 'warp-macos.interrupt-request',
    operationId: requiredString(operationId, 'operationId'),
    attemptRef: {
      jobId: requiredString(attempt.jobId, 'attempt.jobId'),
      attemptId: requiredString(attempt.attemptId, 'attempt.attemptId'),
      leaseToken: requiredString(attempt.leaseToken, 'attempt.leaseToken'),
    },
    lockEpoch: requiredInteger(attempt.lockEpoch, 'attempt.lockEpoch'),
    binding: {
      bindingId: requiredString(adapterIdentity.bindingId, 'target.adapterIdentity.bindingId'),
      role: requiredString(adapterIdentity.role, 'target.adapterIdentity.role'),
      bindingGeneration: requiredInteger(adapterIdentity.bindingGeneration, 'target.adapterIdentity.bindingGeneration'),
      sessionId: requiredString(adapterIdentity.sessionId, 'target.adapterIdentity.sessionId'),
      sessionNonceHash: requiredString(adapterIdentity.sessionNonceHash, 'target.adapterIdentity.sessionNonceHash'),
    },
    targetFingerprintHash: requiredString(adapterIdentity.targetFingerprintHash || target.targetFingerprintHash, 'targetFingerprintHash'),
    targetChallengeId: requiredString(adapterIdentity.targetChallengeId || target.targetChallengeId, 'targetChallengeId'),
    capabilityEvidenceId: requiredString(adapterIdentity.capabilityEvidenceId || target.capabilityEvidenceId, 'capabilityEvidenceId'),
    pilotAuthorization: job.pilotAuthorization || attempt.pilotAuthorization || diagnosticPilotAuthorization(),
    inputSnapshot: {
      path: requiredString(inputPath, 'inputSnapshot.path'),
      hash: requiredString(inputHash, 'inputSnapshot.hash'),
    },
  };
  if (reason) request.reason = reason;
  assertWarpSideEffectRequest(request, request.kind);
  return request;
};

const mirrorFields = [
  ['operationId'],
  ['attemptRef', 'jobId'],
  ['attemptRef', 'attemptId'],
  ['attemptRef', 'leaseToken'],
  ['lockEpoch'],
  ['binding', 'bindingId'],
  ['binding', 'role'],
  ['binding', 'bindingGeneration'],
  ['binding', 'sessionId'],
  ['binding', 'sessionNonceHash'],
  ['targetFingerprintHash'],
  ['targetChallengeId'],
  ['capabilityEvidenceId'],
  ['pilotAuthorization', 'allowlistId'],
  ['pilotAuthorization', 'allowlistHash'],
  ['pilotAuthorization', 'expiresAt'],
  ['inputSnapshot', 'path'],
  ['inputSnapshot', 'hash'],
];

const pathValue = (object, parts) => parts.reduce((current, part) => current?.[part], object);

export const assertWarpSideEffectRequest = (request, expectedKind = null) => {
  requiredObject(request, 'request');
  if (expectedKind && request.kind !== expectedKind) throw new Error('side-effect-request-kind-mismatch');
  if (!['warp-macos.submit-request', 'warp-macos.interrupt-request'].includes(request.kind)) {
    throw new Error('invalid-side-effect-request-kind');
  }
  requiredString(request.operationId, 'request.operationId');
  requiredObject(request.attemptRef, 'request.attemptRef');
  requiredString(request.attemptRef.jobId, 'request.attemptRef.jobId');
  requiredString(request.attemptRef.attemptId, 'request.attemptRef.attemptId');
  requiredString(request.attemptRef.leaseToken, 'request.attemptRef.leaseToken');
  requiredInteger(request.lockEpoch, 'request.lockEpoch');
  requiredObject(request.binding, 'request.binding');
  requiredString(request.binding.bindingId, 'request.binding.bindingId');
  requiredString(request.binding.role, 'request.binding.role');
  requiredInteger(request.binding.bindingGeneration, 'request.binding.bindingGeneration');
  requiredString(request.binding.sessionId, 'request.binding.sessionId');
  requiredString(request.binding.sessionNonceHash, 'request.binding.sessionNonceHash');
  requiredString(request.targetFingerprintHash, 'request.targetFingerprintHash');
  requiredString(request.targetChallengeId, 'request.targetChallengeId');
  requiredString(request.capabilityEvidenceId, 'request.capabilityEvidenceId');
  requiredObject(request.pilotAuthorization, 'request.pilotAuthorization');
  requiredString(request.pilotAuthorization.allowlistId, 'request.pilotAuthorization.allowlistId');
  requiredString(request.pilotAuthorization.allowlistHash, 'request.pilotAuthorization.allowlistHash');
  parseTime(request.pilotAuthorization.expiresAt, 'request.pilotAuthorization.expiresAt');
  requiredObject(request.inputSnapshot, 'request.inputSnapshot');
  requiredString(request.inputSnapshot.path, 'request.inputSnapshot.path');
  requiredString(request.inputSnapshot.hash, 'request.inputSnapshot.hash');
  return request;
};

export const assertWarpResultMirrorsRequest = ({ result, request, resultKind }) => {
  requiredObject(result, 'result');
  assertWarpSideEffectRequest(request);
  if (result.kind !== resultKind) return { ok: false, reason: 'side-effect-result-kind-mismatch' };
  if (Object.prototype.hasOwnProperty.call(result, 'candidateFingerprintHash')) {
    return { ok: false, reason: 'target-fingerprint-alias-forbidden' };
  }
  const mismatch = mirrorFields.find(parts => (pathValue(result, parts) ?? null) !== (pathValue(request, parts) ?? null));
  if (mismatch) return { ok: false, reason: `side-effect-result-${mismatch.join('.')}-mismatch` };
  return { ok: true };
};

export const assertSideEffectMapping = (result, { expectedTargetFingerprintHash = null, evidence = null, expectedAttempt = null, expectedRequest = null } = {}) => {
  const state = result?.sideEffectState;
  if (!['none', 'input-mutated', 'submitted', 'unknown'].includes(state)) {
    throw new Error('invalid-submit-side-effect-state');
  }
  if (result.usedClipboard !== false) throw new Error('clipboard-dispatch-forbidden');
  if (expectedRequest) {
    const mirror = assertWarpResultMirrorsRequest({
      result,
      request: expectedRequest,
      resultKind: 'warp-macos.submit-result',
    });
    if (!mirror.ok) return { status: 'dispatch-uncertain', reason: mirror.reason };
  }
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

  async submitText(request, options = {}) {
    if (this.crash) throw new Error('helper-crash');
    assertWarpSideEffectRequest(request, 'warp-macos.submit-request');
    this.submissions.push({ request, options });
    if (this.submitResult) {
      const supplied = {
        ...this.submitResult,
        operationId: this.submitResult.operationId ?? request.operationId,
        attemptRef: this.submitResult.attemptRef ?? { ...request.attemptRef },
        lockEpoch: this.submitResult.lockEpoch ?? request.lockEpoch,
        binding: this.submitResult.binding ?? { ...request.binding },
        targetFingerprintHash: this.submitResult.targetFingerprintHash ?? request.targetFingerprintHash,
        targetChallengeId: this.submitResult.targetChallengeId ?? request.targetChallengeId,
        capabilityEvidenceId: this.submitResult.capabilityEvidenceId ?? request.capabilityEvidenceId,
        pilotAuthorization: this.submitResult.pilotAuthorization ?? { ...request.pilotAuthorization },
        inputSnapshot: this.submitResult.inputSnapshot ?? { ...request.inputSnapshot },
      };
      if (this.store && supplied.writeEvidence !== false && supplied.transportEvidenceId) {
        this.store.writeTransportEvidence(supplied.transportEvidenceId, {
          protocolVersion: 1,
          kind: 'warp-macos.submit-evidence',
          transportEvidenceId: supplied.transportEvidenceId,
          operationId: supplied.operationId,
          attemptRef: supplied.attemptRef,
          lockEpoch: supplied.lockEpoch,
          binding: supplied.binding,
          targetFingerprintHash: supplied.targetFingerprintHash,
          targetChallengeId: supplied.targetChallengeId,
          capabilityEvidenceId: supplied.capabilityEvidenceId,
          pilotAuthorization: supplied.pilotAuthorization,
          inputSnapshot: supplied.inputSnapshot,
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
      operationId: request.operationId,
      attemptRef: { ...request.attemptRef },
      lockEpoch: request.lockEpoch,
      binding: { ...request.binding },
      targetFingerprintHash: request.targetFingerprintHash,
      targetChallengeId: request.targetChallengeId,
      capabilityEvidenceId: request.capabilityEvidenceId,
      pilotAuthorization: { ...request.pilotAuthorization },
      inputSnapshot: { ...request.inputSnapshot },
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
      attemptRef: result.attemptRef,
      lockEpoch: result.lockEpoch,
      binding: result.binding,
      targetFingerprintHash: result.targetFingerprintHash,
      targetChallengeId: result.targetChallengeId,
      capabilityEvidenceId: result.capabilityEvidenceId,
      pilotAuthorization: result.pilotAuthorization,
      inputSnapshot: result.inputSnapshot,
      sideEffectState: result.sideEffectState,
      usedClipboard: result.usedClipboard,
      createdAt: result.submittedAt,
    });
    return result;
  }

  async interrupt(request) {
    assertWarpSideEffectRequest(request, 'warp-macos.interrupt-request');
    this.interruptions.push({ request });
    const transportEvidenceId = randomUUID();
    return {
      protocolVersion: 1,
      kind: 'warp-macos.interrupt-result',
      operationId: request.operationId,
      attemptRef: { ...request.attemptRef },
      lockEpoch: request.lockEpoch,
      binding: { ...request.binding },
      targetFingerprintHash: request.targetFingerprintHash,
      targetChallengeId: request.targetChallengeId,
      capabilityEvidenceId: request.capabilityEvidenceId,
      pilotAuthorization: { ...request.pilotAuthorization },
      inputSnapshot: { ...request.inputSnapshot },
      transportEvidenceId,
      sideEffectState: 'interrupted',
      settled: true,
      usedClipboard: false,
      evidencePath: `transport://${transportEvidenceId}`,
      interruptedAt: new Date().toISOString(),
      status: 'cancelled',
      interrupted: true,
      attemptId: request.attemptRef.attemptId,
    };
  }
}

export class ProcessWarpMacosHelper {
  constructor({ command = process.execPath, scriptPath = new URL('./warp-macos-helper.js', import.meta.url).pathname, env = process.env } = {}) {
    this.command = command;
    this.scriptPath = scriptPath;
    this.env = env;
  }

  run(args) {
    return parseHelperJson(spawnSync(this.command, [this.scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...this.env },
    }), args[0] || 'unknown');
  }

  async probeCapability() {
    return this.run(['probe-capability', '--json']);
  }

  async scanTargets({ role } = {}) {
    const args = ['scan-targets', '--json'];
    if (role) args.push('--role', role);
    const result = this.run(args);
    return Array.isArray(result.targets) ? result.targets : result;
  }

  async submitText(request) {
    assertWarpSideEffectRequest(request, 'warp-macos.submit-request');
    return this.run(['submit-text', '--request', JSON.stringify(request), '--json']);
  }

  async interrupt(request) {
    assertWarpSideEffectRequest(request, 'warp-macos.interrupt-request');
    return this.run(['interrupt', '--request', JSON.stringify(request), '--json']);
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
    let request;
    try {
      request = createWarpSideEffectRequest({
        kind: 'submit',
        operationId: options.operationId,
        job,
        target,
      });
    } catch (error) {
      return { status: 'target-unavailable', submitted: false, error: error.message, safeBeforeSideEffect: true };
    }
    let result;
    try {
      result = await this.helper.submitText(request, { signal: options.signal });
    } catch (error) {
      return { status: 'dispatch-error', error: error.message, ambiguous: true };
    }
    const evidence = result.transportEvidenceId ? this.store?.readTransportEvidence(result.transportEvidenceId) : null;
    const mapped = assertSideEffectMapping(result, {
      expectedTargetFingerprintHash: target.targetFingerprintHash,
      expectedAttempt: job.attempt,
      expectedRequest: request,
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
    const job = {
      attempt,
      promptText: '',
      pilotAuthorization: attempt.pilotAuthorization || diagnosticPilotAuthorization(),
    };
    const operationId = attempt.operationId || randomUUID();
    let request;
    try {
      request = createWarpSideEffectRequest({
        kind: 'interrupt',
        operationId,
        job,
        target,
        reason: 'operator-cancel',
      });
    } catch (error) {
      return { status: 'stale-attempt', interrupted: false, reason: error.message };
    }
    const result = await this.helper.interrupt(request);
    const mirror = assertWarpResultMirrorsRequest({
      result,
      request,
      resultKind: 'warp-macos.interrupt-result',
    });
    if (!mirror.ok) return { status: 'stale-attempt', interrupted: false, reason: mirror.reason };
    return result;
  }

  async settleDispatch() {
    return { settled: false, outcome: 'unknown' };
  }
}
