#!/usr/bin/env node
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

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

const parseArgs = argv => {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i += 1;
    }
  }
  return { command, opts };
};

const parseRequest = value => {
  const input = requiredString(value, '--request');
  if (input.trim().startsWith('{')) return JSON.parse(input);
  return JSON.parse(fs.readFileSync(input, 'utf8'));
};

const parseTime = (value, field) => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO timestamp`);
  return ms;
};

const assertNoSplitSideEffectArgs = opts => {
  for (const forbidden of ['target', 'input-file', 'attempt-ref', 'attempt', 'lease-token']) {
    if (Object.prototype.hasOwnProperty.call(opts, forbidden)) {
      throw new Error(`split-side-effect-argument-forbidden: --${forbidden}`);
    }
  }
};

const assertOnlySideEffectArgs = opts => {
  assertNoSplitSideEffectArgs(opts);
  for (const key of Object.keys(opts)) {
    if (!['request', 'json'].includes(key)) {
      throw new Error(`side-effect-argument-forbidden: --${key}`);
    }
  }
};

const assertSideEffectRequest = (request, expectedKind) => {
  requiredObject(request, 'request');
  if (request.kind !== expectedKind) throw new Error('side-effect-request-kind-mismatch');
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

const unavailableCapability = () => ({
  protocolVersion: 1,
  kind: 'warp-macos.capability',
  capturedAt: new Date().toISOString(),
  fixture: false,
  helper: {
    kind: 'warp-macos-helper',
    version: 1,
    pathHash: `sha256:${createHash('sha256').update(import.meta.url).digest('hex')}`,
  },
  warp: {
    detected: false,
    bundleId: null,
    version: null,
  },
  accessibility: {
    permission: 'unavailable',
    helper: 'real-helper',
    helperVersion: 1,
  },
  targetDiscovery: {
    available: false,
    stableFingerprintFields: [],
    requiresTwoScanStability: true,
  },
  inputSubmission: {
    available: false,
    method: 'accessibility-key-events',
    usesClipboard: false,
    settleBarrier: 'helper-submit-result',
  },
  targetIdentity: {
    available: false,
    requiresWrapperBinding: true,
    requiresChallenge: true,
  },
  diagnosticEligible: false,
  phase4RunEnabled: false,
  phase5ProductionCandidate: false,
  reasons: ['real-helper-unavailable'],
});

const unavailableSideEffect = (request, sideEffectState, timestampField) => ({
  protocolVersion: 1,
  kind: request.kind === 'warp-macos.submit-request' ? 'warp-macos.submit-result' : 'warp-macos.interrupt-result',
  operationId: request.operationId,
  attemptRef: { ...request.attemptRef },
  lockEpoch: request.lockEpoch,
  binding: { ...request.binding },
  targetFingerprintHash: request.targetFingerprintHash,
  targetChallengeId: request.targetChallengeId,
  capabilityEvidenceId: request.capabilityEvidenceId,
  pilotAuthorization: { ...request.pilotAuthorization },
  inputSnapshot: { ...request.inputSnapshot },
  transportEvidenceId: randomUUID(),
  sideEffectState,
  settled: true,
  usedClipboard: false,
  evidencePath: 'warp-macos-helper://unavailable',
  [timestampField]: new Date().toISOString(),
});

const main = () => {
  try {
    const { command, opts } = parseArgs(process.argv.slice(2));
    let result;
    switch (command) {
      case 'probe-capability':
        result = unavailableCapability();
        break;
      case 'scan-targets':
        result = { targets: [] };
        break;
      case 'submit-text': {
        assertOnlySideEffectArgs(opts);
        const request = assertSideEffectRequest(parseRequest(opts.request), 'warp-macos.submit-request');
        result = unavailableSideEffect(request, 'none', 'submittedAt');
        break;
      }
      case 'interrupt': {
        assertOnlySideEffectArgs(opts);
        const request = assertSideEffectRequest(parseRequest(opts.request), 'warp-macos.interrupt-request');
        result = unavailableSideEffect(request, 'none', 'interruptedAt');
        result.interrupted = false;
        result.status = 'stale-attempt';
        result.reason = 'real-helper-unavailable';
        break;
      }
      default:
        throw new Error(`unknown-command: ${command || '<missing>'}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
};

main();
