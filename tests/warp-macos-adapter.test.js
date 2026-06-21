import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ExecutionStore } from '../scripts/execution-store.js';
import { createBinding } from '../scripts/execution-protocol.js';
import {
  WARP_CAPABILITY_NAME,
  FixtureWarpMacosHelper,
  ProcessWarpMacosHelper,
  WarpMacosAdapter,
  assertRealWarpCapabilityEvidence,
  assertSideEffectMapping,
  assertWarpResultMirrorsRequest,
  createTargetChallengePayload,
  createTargetChallengeResponse,
  createWarpSideEffectRequest,
  deriveWarpCapabilities,
  discoverStableTarget,
  targetFingerprintHash,
  validateTargetChallengeResponse,
} from '../scripts/warp-macos-adapter.js';

const HELPER_SCRIPT = fileURLToPath(new URL('../scripts/warp-macos-helper.js', import.meta.url));

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

const realCapabilityEvidence = overrides => capabilityEvidence({
  fixture: false,
  helper: {
    kind: 'warp-macos-helper',
    version: 1,
    pathHash: `sha256:${'a'.repeat(64)}`,
  },
  warp: { detected: true, bundleId: 'dev.warp.Warp-Stable', version: 'real-test' },
  accessibility: { permission: 'granted', helper: 'real-helper', helperVersion: 1 },
  targetDiscovery: {
    available: true,
    stableFingerprintFields: ['bundleId', 'windowId', 'tabId', 'roleBindingMarker'],
    requiresTwoScanStability: true,
  },
  inputSubmission: {
    available: true,
    method: 'accessibility-key-events',
    usesClipboard: false,
    settleBarrier: 'helper-submit-result',
  },
  targetIdentity: { available: true, requiresWrapperBinding: true, requiresChallenge: true },
  phase5ProductionCandidate: true,
  ...overrides,
});

const makeBoundWarpTarget = () => {
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
  return { store, target };
};

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

  it('requires strict real helper provenance before phase5 warp eligibility', () => {
    const valid = deriveWarpCapabilities(realCapabilityEvidence(), { requirePhase5Pilot: true });
    assert.equal(valid.phase5ProductionCandidate, true);
    assert.equal(valid.dispatch, true);

    const missingFixture = realCapabilityEvidence();
    delete missingFixture.fixture;
    const missingHelper = realCapabilityEvidence();
    delete missingHelper.helper;
    for (const evidence of [
      missingFixture,
      missingHelper,
      realCapabilityEvidence({ kind: 'warp-macos.other-capability' }),
      realCapabilityEvidence({ protocolVersion: 2 }),
    ]) {
      const capabilities = deriveWarpCapabilities(evidence, { requirePhase5Pilot: true });
      assert.equal(capabilities.phase5ProductionCandidate, false);
      assert.equal(capabilities.dispatch, false);
    }
    assert.throws(() => assertRealWarpCapabilityEvidence(missingFixture), /real-helper-fixture-flag-required/);
    assert.throws(() => assertRealWarpCapabilityEvidence(missingHelper), /real-helper-kind-invalid/);
  });

  it('maps submit side-effect states fail-closed', () => {
    const expectedTargetFingerprintHash = targetFingerprintHash({ stableId: 'candidate-1' });
    const expectedAttempt = { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' };
    const evidence = {
      protocolVersion: 1,
      kind: 'warp-macos.submit-evidence',
      transportEvidenceId: 'evidence-1',
      operationId: 'operation-1',
      attemptRef: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' },
      targetFingerprintHash: expectedTargetFingerprintHash,
      sideEffectState: 'none',
      usedClipboard: false,
    };
    assert.deepEqual(
      assertSideEffectMapping({
        operationId: 'operation-1',
        attemptRef: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' },
        targetFingerprintHash: expectedTargetFingerprintHash,
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
      targetFingerprintHash: 'sha256:wrong',
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
      targetFingerprintHash: expectedTargetFingerprintHash,
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
      attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1', lockEpoch: 0 },
    }, target, { operationId: 'operation-1' });
    assert.equal(submitted.status, 'dispatch-submitted');
    assert.equal(submitted.targetFingerprintHash, target.targetFingerprintHash);
    assert.equal(submitted.attemptRef.jobId, 'job-1');
    assert.equal(submitted.lockEpoch, 0);

    store.writeBinding({ ...bound, heartbeatAt: '2000-01-01T00:00:00.000Z' });
    const stale = await adapter.dispatch({
      promptText: 'shadow',
      attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1', lockEpoch: 0 },
    }, target, { operationId: 'operation-2' });
    assert.equal(stale.status, 'target-unavailable');
    assert.equal(stale.error, 'binding-stale');
    const cancel = await adapter.cancel({ jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' }, target);
    assert.equal(cancel.status, 'stale-attempt');
    assert.equal(cancel.reason, 'binding-stale');
  });

  it('creates fenced helper side-effect requests and rejects split ambient request shapes', async () => {
    const { store, target } = makeBoundWarpTarget();
    const helper = new FixtureWarpMacosHelper({ candidates: [target], store });
    const adapter = new WarpMacosAdapter({
      store,
      productionTest: true,
      scratchTask: true,
      helper,
    });
    const job = {
      promptPath: '/tmp/prompt.md',
      promptSha256: 'sha256:prompt',
      attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1', lockEpoch: 7 },
      pilotAuthorization: {
        allowlistId: 'allow-1',
        allowlistHash: 'sha256:allow',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };

    const request = createWarpSideEffectRequest({
      kind: 'submit',
      operationId: 'operation-1',
      job,
      target,
    });
    assert.equal(request.kind, 'warp-macos.submit-request');
    assert.equal(request.lockEpoch, 7);
    assert.equal(request.targetFingerprintHash, target.targetFingerprintHash);
    assert.deepEqual(request.inputSnapshot, { path: '/tmp/prompt.md', hash: 'sha256:prompt' });

    const result = await adapter.dispatch(job, target, { operationId: 'operation-1' });
    assert.equal(result.status, 'dispatch-submitted');
    assert.equal(helper.submissions[0].request.operationId, 'operation-1');
    assert.equal(helper.submissions[0].request.lockEpoch, 7);

    await assert.rejects(
      () => helper.submitText(target, '/tmp/prompt.md', { attempt: job.attempt, operationId: 'operation-split' }),
      /invalid-side-effect-request-kind|request\.attemptRef is required|side-effect-request-kind-mismatch/
    );
  });

  it('uses the warp-macos helper process boundary and rejects split side-effect CLI arguments', async () => {
    const { target } = makeBoundWarpTarget();
    const helper = new ProcessWarpMacosHelper({ scriptPath: HELPER_SCRIPT });
    const capability = await helper.probeCapability();
    assert.equal(capability.kind, 'warp-macos.capability');
    assert.equal(capability.fixture, false);
    assert.equal(capability.phase5ProductionCandidate, false);
    assert.equal(capability.inputSubmission.usesClipboard, false);
    assert.deepEqual(await helper.scanTargets({ role: 'work' }), []);

    const request = createWarpSideEffectRequest({
      kind: 'submit',
      operationId: 'operation-process-helper',
      job: {
        promptPath: '/tmp/prompt.md',
        promptSha256: 'sha256:prompt',
        attempt: { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1', lockEpoch: 2 },
        pilotAuthorization: {
          allowlistId: 'allow-1',
          allowlistHash: 'sha256:allow',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      target,
    });
    const result = await helper.submitText(request);
    assert.equal(result.kind, 'warp-macos.submit-result');
    assert.equal(result.operationId, request.operationId);
    assert.equal(result.targetFingerprintHash, request.targetFingerprintHash);
    assert.equal(result.sideEffectState, 'none');
    assert.equal(result.usedClipboard, false);

    const split = spawnSync(process.execPath, [
      HELPER_SCRIPT,
      'submit-text',
      '--target',
      'candidate-1',
      '--input-file',
      '/tmp/prompt.md',
      '--json',
    ], { encoding: 'utf8' });
    assert.notEqual(split.status, 0);
    assert.match(split.stderr, /split-side-effect-argument-forbidden/);

    const unknownSubmitArg = spawnSync(process.execPath, [
      HELPER_SCRIPT,
      'submit-text',
      '--request',
      JSON.stringify(request),
      '--foo',
      'bar',
      '--json',
    ], { encoding: 'utf8' });
    assert.notEqual(unknownSubmitArg.status, 0);
    assert.match(unknownSubmitArg.stderr, /side-effect-argument-forbidden: --foo/);

    const interruptRequest = {
      ...request,
      kind: 'warp-macos.interrupt-request',
      operationId: 'operation-process-helper-interrupt',
    };
    const unknownInterruptArg = spawnSync(process.execPath, [
      HELPER_SCRIPT,
      'interrupt',
      '--request',
      JSON.stringify(interruptRequest),
      '--foo',
      'bar',
      '--json',
    ], { encoding: 'utf8' });
    assert.notEqual(unknownInterruptArg.status, 0);
    assert.match(unknownInterruptArg.stderr, /side-effect-argument-forbidden: --foo/);
  });

  it('rejects submit results that rename or fail to mirror fenced request fields', async () => {
    const setup = makeBoundWarpTarget();
    const aliasHelper = new FixtureWarpMacosHelper({
      candidates: [setup.target],
      store: setup.store,
      submitResult: {
        protocolVersion: 1,
        kind: 'warp-macos.submit-result',
        candidateFingerprintHash: setup.target.targetFingerprintHash,
        transportEvidenceId: 'evidence-alias',
        sideEffectState: 'submitted',
        settled: true,
        usedClipboard: false,
        evidencePath: 'fixture://alias',
        submittedAt: new Date().toISOString(),
      },
    });
    const aliasAdapter = new WarpMacosAdapter({
      store: setup.store,
      helper: aliasHelper,
      productionTest: true,
      scratchTask: true,
    });
    const aliasResult = await aliasAdapter.dispatch({
      promptText: 'shadow',
      attempt: { jobId: 'job-alias', attemptId: 'attempt-alias', leaseToken: 'lease-alias', lockEpoch: 0 },
    }, setup.target, { operationId: 'operation-alias' });
    assert.equal(aliasResult.status, 'dispatch-uncertain');
    assert.equal(aliasResult.reason, 'target-fingerprint-alias-forbidden');

    const mismatchSetup = makeBoundWarpTarget();
    const mismatchHelper = new FixtureWarpMacosHelper({
      candidates: [mismatchSetup.target],
      store: mismatchSetup.store,
      submitResult: {
        protocolVersion: 1,
        kind: 'warp-macos.submit-result',
        lockEpoch: 999,
        transportEvidenceId: 'evidence-mismatch',
        sideEffectState: 'submitted',
        settled: true,
        usedClipboard: false,
        evidencePath: 'fixture://mismatch',
        submittedAt: new Date().toISOString(),
      },
    });
    const mismatchAdapter = new WarpMacosAdapter({
      store: mismatchSetup.store,
      helper: mismatchHelper,
      productionTest: true,
      scratchTask: true,
    });
    const mismatchResult = await mismatchAdapter.dispatch({
      promptText: 'shadow',
      attempt: { jobId: 'job-mismatch', attemptId: 'attempt-mismatch', leaseToken: 'lease-mismatch', lockEpoch: 0 },
    }, mismatchSetup.target, { operationId: 'operation-mismatch' });
    assert.equal(mismatchResult.status, 'dispatch-uncertain');
    assert.equal(mismatchResult.reason, 'side-effect-result-lockEpoch-mismatch');
  });

  it('requires interrupt results to mirror request fencing including input snapshot', async () => {
    const { store, target } = makeBoundWarpTarget();
    const helper = new FixtureWarpMacosHelper({ candidates: [target], store });
    const request = createWarpSideEffectRequest({
      kind: 'interrupt',
      operationId: 'operation-cancel',
      job: {
        promptText: 'cancel',
        attempt: { jobId: 'job-cancel', attemptId: 'attempt-cancel', leaseToken: 'lease-cancel', lockEpoch: 3 },
      },
      target,
      reason: 'operator-cancel',
    });
    const result = await helper.interrupt(request);
    assert.equal(assertWarpResultMirrorsRequest({
      result,
      request,
      resultKind: 'warp-macos.interrupt-result',
    }).ok, true);

    const missingInput = structuredClone(result);
    delete missingInput.inputSnapshot;
    assert.deepEqual(assertWarpResultMirrorsRequest({
      result: missingInput,
      request,
      resultKind: 'warp-macos.interrupt-result',
    }), { ok: false, reason: 'side-effect-result-inputSnapshot.path-mismatch' });
  });

  it('rejects dispatch and cancel when either side-effect pre-scan drifts from the captured target', async () => {
    const candidate = windowId => ({
      bindingId: 'wrapper.work',
      role: 'work',
      candidateId: 'candidate-1',
      fingerprint: { bundleId: 'dev.warp.Warp-Stable', windowId, tabId: 'work' },
    });
    for (const [caseName, scanSequences] of [
      ['first-wrong-second-correct', [[candidate('window-wrong')], [candidate('window-1')]]],
      ['first-correct-second-wrong', [[candidate('window-1')], [candidate('window-wrong')]]],
    ]) {
      const dispatchSetup = makeBoundWarpTarget();
      const dispatchHelper = new FixtureWarpMacosHelper({ scanSequences, store: dispatchSetup.store });
      const dispatchAdapter = new WarpMacosAdapter({
        store: dispatchSetup.store,
        helper: dispatchHelper,
        productionTest: true,
        scratchTask: true,
      });
      const dispatched = await dispatchAdapter.dispatch({
        promptText: 'shadow',
        attempt: { jobId: `job-${caseName}`, attemptId: `attempt-${caseName}`, leaseToken: `lease-${caseName}`, lockEpoch: 0 },
      }, dispatchSetup.target, { operationId: `operation-${caseName}` });
      assert.equal(dispatched.status, 'target-unavailable');
      assert.equal(dispatched.error, 'target-discovery-changed');
      assert.equal(dispatchHelper.submissions.length, 0);

      const cancelSetup = makeBoundWarpTarget();
      const cancelHelper = new FixtureWarpMacosHelper({ scanSequences, store: cancelSetup.store });
      const cancelAdapter = new WarpMacosAdapter({
        store: cancelSetup.store,
        helper: cancelHelper,
        productionTest: true,
        scratchTask: true,
      });
      const cancelled = await cancelAdapter.cancel(
        { jobId: `job-${caseName}`, attemptId: `attempt-${caseName}`, leaseToken: `lease-${caseName}` },
        cancelSetup.target
      );
      assert.equal(cancelled.status, 'stale-attempt');
      assert.equal(cancelled.reason, 'target-discovery-changed');
      assert.equal(cancelHelper.interruptions.length, 0);
    }
  });
});
