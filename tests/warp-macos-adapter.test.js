import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExecutionStore } from '../scripts/execution-store.js';
import { createBinding } from '../scripts/execution-protocol.js';
import {
  WARP_CAPABILITY_NAME,
  FixtureWarpMacosHelper,
  WarpMacosAdapter,
  assertSideEffectMapping,
  createTargetChallengePayload,
  createTargetChallengeResponse,
  deriveWarpCapabilities,
  discoverStableTarget,
  targetFingerprintHash,
  validateTargetChallengeResponse,
} from '../scripts/warp-macos-adapter.js';

const makeStore = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-warp-adapter-'));
  const store = new ExecutionStore({ harnessRoot: root, taskId: 'W9-A' });
  return { root, store };
};

const capabilityEvidence = overrides => ({
  protocolVersion: 1,
  kind: 'warp-macos.capability',
  capturedAt: new Date().toISOString(),
  fixture: true,
  warp: { detected: true, bundleId: 'fixture.warp', version: 'fixture' },
  accessibility: { permission: 'granted', helper: 'fixture-helper', helperVersion: 1 },
  targetDiscovery: { available: true, stableFingerprintFields: ['bindingId', 'role'], requiresTwoScanStability: true },
  inputSubmission: { available: true, method: 'fixture-submit', usesClipboard: false, settleBarrier: 'fixture-submit-result' },
  targetIdentity: { available: true, requiresWrapperBinding: true, requiresChallenge: true },
  diagnosticEligible: true,
  phase4RunEnabled: false,
  phase5ProductionCandidate: false,
  reasons: [],
  ...overrides,
});

describe('V3 Phase 4 warp-macos adapter contract', () => {
  it('keeps warp-macos unavailable by default and separates diagnostic from phase4 run enablement', () => {
    assert.equal(deriveWarpCapabilities(null).diagnosticEligible, false);

    const diagnostic = deriveWarpCapabilities(capabilityEvidence());
    assert.equal(diagnostic.diagnosticEligible, true);
    assert.equal(diagnostic.phase4RunEnabled, false);

    const productionTest = deriveWarpCapabilities(
      capabilityEvidence({ phase4RunEnabled: true }),
      { requireProductionTest: true }
    );
    assert.equal(productionTest.diagnosticEligible, true);
    assert.equal(productionTest.phase4RunEnabled, true);
    assert.equal(productionTest.dispatch, true);
  });

  it('maps submit side-effect states fail-closed', () => {
    const expectedTargetFingerprintHash = targetFingerprintHash({ stableId: 'candidate-1' });
    const expectedAttempt = { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' };
    const evidence = {
      protocolVersion: 1,
      kind: 'warp-macos.submit-evidence',
      transportEvidenceId: 'evidence-1',
      operationId: 'operation-1',
      jobId: 'job-1',
      attemptId: 'attempt-1',
      leaseToken: 'lease-1',
      candidateFingerprintHash: expectedTargetFingerprintHash,
      sideEffectState: 'none',
      usedClipboard: false,
    };
    assert.deepEqual(
      assertSideEffectMapping({
        operationId: 'operation-1',
        jobId: 'job-1',
        attemptId: 'attempt-1',
        leaseToken: 'lease-1',
        candidateFingerprintHash: expectedTargetFingerprintHash,
        sideEffectState: 'none',
        settled: true,
        usedClipboard: false,
        transportEvidenceId: 'evidence-1',
        evidencePath: 'fixture://evidence',
      }, { expectedTargetFingerprintHash, expectedAttempt, evidence }),
      { status: 'failed-before-side-effect', safeBeforeSideEffect: true }
    );
    assert.equal(assertSideEffectMapping({
      sideEffectState: 'input-mutated',
      settled: true,
      usedClipboard: false,
    }).status, 'dispatch-uncertain');
    assert.equal(assertSideEffectMapping({
      sideEffectState: 'unknown',
      settled: false,
      usedClipboard: false,
    }).status, 'dispatch-uncertain');
    assert.equal(assertSideEffectMapping({
      operationId: 'operation-1',
      jobId: 'job-1',
      attemptId: 'attempt-1',
      leaseToken: 'lease-1',
      candidateFingerprintHash: 'sha256:wrong',
      sideEffectState: 'submitted',
      settled: true,
      usedClipboard: false,
      transportEvidenceId: 'evidence-1',
      evidencePath: 'fixture://evidence',
    }, { expectedTargetFingerprintHash, expectedAttempt, evidence }).status, 'dispatch-uncertain');
    assert.equal(assertSideEffectMapping({
      operationId: 'operation-1',
      jobId: 'job-1',
      attemptId: 'attempt-1',
      leaseToken: 'lease-1',
      candidateFingerprintHash: expectedTargetFingerprintHash,
      sideEffectState: 'none',
      settled: true,
      usedClipboard: false,
      transportEvidenceId: 'missing-evidence',
      evidencePath: 'fixture://missing',
    }, { expectedTargetFingerprintHash, expectedAttempt, evidence: null }).status, 'dispatch-uncertain');
    assert.throws(() => assertSideEffectMapping({
      sideEffectState: 'submitted',
      settled: true,
      usedClipboard: true,
      transportEvidenceId: 'evidence-1',
      evidencePath: 'fixture://evidence',
    }), /clipboard-dispatch-forbidden/);
  });

  it('requires two stable scans with one unique non-title target before binding', async () => {
    const candidate = {
      bindingId: 'wrapper.work',
      role: 'work',
      candidateId: 'candidate-1',
      fingerprint: { bundleId: 'dev.warp.Warp-Stable', windowId: 'window-1', tabId: 'tab-1' },
    };
    const stable = await discoverStableTarget(new FixtureWarpMacosHelper({ candidates: [candidate] }), {
      role: 'work',
      candidateId: 'candidate-1',
    });
    assert.equal(stable.targetFingerprintHash, targetFingerprintHash(candidate.fingerprint));

    await assert.rejects(() => discoverStableTarget(new FixtureWarpMacosHelper({ candidates: [] }), {
      role: 'work',
      candidateId: 'candidate-1',
    }), /target-discovery-zero/);
    await assert.rejects(() => discoverStableTarget(new FixtureWarpMacosHelper({ candidates: [candidate, candidate] }), {
      role: 'work',
      candidateId: 'candidate-1',
    }), /target-discovery-duplicate/);
    await assert.rejects(() => discoverStableTarget(new FixtureWarpMacosHelper({
      scanSequences: [
        [candidate],
        [{ ...candidate, fingerprint: { ...candidate.fingerprint, windowId: 'window-2' } }],
      ],
    }), {
      role: 'work',
      candidateId: 'candidate-1',
    }), /target-discovery-changed/);
    await assert.rejects(() => discoverStableTarget(new FixtureWarpMacosHelper({
      candidates: [{ ...candidate, fingerprint: { windowTitle: 'Warp', tabTitle: 'work' } }],
    }), {
      role: 'work',
      candidateId: 'candidate-1',
    }), /target-fingerprint-unstable/);
  });

  it('validates one-time target challenge response and stores no raw nonce in binding records', () => {
    const { root, store } = makeStore();
    const { binding, rawNonce } = createBinding({
      taskId: 'W9-A',
      bindingId: 'wrapper.work',
      role: 'work',
    });
    store.writeBinding(binding);
    store.writeBindingSecret(binding.bindingId, rawNonce);
    store.writeCapability(WARP_CAPABILITY_NAME, capabilityEvidence());

    const fingerprintHash = targetFingerprintHash({ bindingId: binding.bindingId, role: 'work', candidateId: 'candidate-1' });
    const payload = createTargetChallengePayload({
      taskId: 'W9-A',
      role: 'work',
      binding,
      candidateId: 'candidate-1',
      targetFingerprintHash: fingerprintHash,
      capabilityEvidenceId: 'warp-macos:test',
      challengeId: 'challenge-1',
    });
    const challenge = { status: 'issued', payload };
    store.writeTargetChallenge(challenge);
    const response = createTargetChallengeResponse({ payload, rawNonce, eventId: 'response-1' });
    store.publishTargetChallengeResponse(response);

    const targetBinding = validateTargetChallengeResponse({
      challenge,
      response,
      binding,
      rawNonce,
    });
    assert.equal(targetBinding.challengeId, 'challenge-1');
    store.writeTargetChallenge({ ...challenge, status: 'verified', verifiedAt: targetBinding.verifiedAt });
    store.finalizeTargetChallengeResponse('challenge-1', 'response-1', 'processed');

    assert.throws(
      () => validateTargetChallengeResponse({
        challenge: store.readTargetChallenge('challenge-1'),
        response,
        binding,
        rawNonce,
      }),
      /target-challenge-replay/
    );
    assert.equal(fs.readFileSync(path.join(root, 'runs', 'W9-A', 'bindings', 'wrapper.work.json'), 'utf8').includes(rawNonce), false);
  });

  it('fences dispatch and cancel against current binding identity and durable submit evidence', async () => {
    const { store } = makeStore();
    const { binding, rawNonce } = createBinding({
      taskId: 'W9-A',
      bindingId: 'wrapper.work',
      role: 'work',
    });
    const targetFingerprintHashValue = targetFingerprintHash({
      bundleId: 'dev.warp.Warp-Stable',
      windowId: 'window-1',
      tabId: 'work',
    });
    const capabilityCapturedAt = new Date().toISOString();
    const targetBinding = {
      adapter: 'warp-macos',
      targetFingerprintHash: targetFingerprintHashValue,
      verifiedAt: new Date().toISOString(),
      challengeId: 'challenge-1',
      capabilityEvidenceId: `${WARP_CAPABILITY_NAME}:${capabilityCapturedAt}`,
      candidateId: 'candidate-1',
    };
    const bound = { ...binding, targetBinding };
    store.writeBinding(bound);
    store.writeBindingSecret(binding.bindingId, rawNonce);
    store.writeCapability(WARP_CAPABILITY_NAME, capabilityEvidence({
      capturedAt: capabilityCapturedAt,
      phase4RunEnabled: true,
    }));
    const target = {
      adapter: 'warp-macos',
      bindingId: binding.bindingId,
      role: 'work',
      candidateId: 'candidate-1',
      targetFingerprintHash: targetFingerprintHashValue,
      fingerprint: { bundleId: 'dev.warp.Warp-Stable', windowId: 'window-1', tabId: 'work' },
      adapterIdentity: {
        adapter: 'warp-macos',
        role: 'work',
        bindingId: binding.bindingId,
        bindingGeneration: binding.bindingGeneration,
        sessionId: binding.sessionId,
        sessionNonceHash: binding.sessionNonceHash,
        targetFingerprintHash: targetFingerprintHashValue,
        targetChallengeId: 'challenge-1',
        targetBindingVerifiedAt: targetBinding.verifiedAt,
        capabilityEvidenceId: `${WARP_CAPABILITY_NAME}:${capabilityCapturedAt}`,
      },
    };
    const adapter = new WarpMacosAdapter({
      store,
      productionTest: true,
      scratchTask: true,
      helper: new FixtureWarpMacosHelper({ candidates: [target], store }),
    });
    const submitted = await adapter.dispatch({
      promptText: 'shadow',
      attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' },
    }, target, { operationId: 'operation-1' });
    assert.equal(submitted.status, 'dispatch-submitted');

    store.writeBinding({ ...bound, heartbeatAt: '2000-01-01T00:00:00.000Z' });
    const stale = await adapter.dispatch({
      promptText: 'shadow',
      attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' },
    }, target, { operationId: 'operation-2' });
    assert.equal(stale.status, 'target-unavailable');
    assert.equal(stale.error, 'binding-stale');
    const cancel = await adapter.cancel({ jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' }, target);
    assert.equal(cancel.status, 'stale-attempt');
    assert.equal(cancel.reason, 'binding-stale');
  });
});
