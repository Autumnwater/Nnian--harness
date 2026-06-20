# HEXAI Review Harness V3 Phase 6 — Real Wrapper and macOS Helper Plan

**Date:** 2026-06-20
**Status:** Plan for review
**Baseline:** Phase 5 commit `3d8a044`
**Scope:** real Claude Code wrapper/session proof, real hook capability capture, real `warp-macos` helper capability evidence, target binding/challenge, shadow validation, and fail-closed enablement for the existing Phase 5 pilot gate
**Out of scope:** broad production rollout, automatic approval of Claude Code permission prompts, automatic delivery acceptance, automatic commit/push/tag, clipboard/frontmost/title-only dispatch, screen-text/sleep/fresh-output completion inference, bypassing Phase 5 allowlist, or running the W6 pilot before Plan Review and Code Review are Approved

## 1. Goal

Phase 5 proved the pilot gate and kept real W6 dispatch fail-closed when only fixture evidence exists. Phase 6 adds the missing real evidence producers so `pilot-doctor W6-A` can become allowed without weakening the Phase 2-5 contracts.

The goal is not to make Harness autonomous. The goal is to prove this identity and side-effect chain with real local processes:

```text
Harness task/attempt
  -> wrapper binding and session secret
  -> real Claude Code worker process
  -> authoritative hook/receipt publisher
  -> real Warp target fingerprint
  -> real helper submit evidence
  -> Phase 5 allowlisted Supervisor run
```

If any link is missing, stale, ambiguous, or fixture-only, Phase 6 must remain fail-closed.

## 2. Boundary

Phase 6 may implement:

- a real wrapper launcher for Claude Code worker sessions;
- wrapper heartbeat and session challenge proof;
- real Claude Code hook payload capability probe and receipt publisher;
- a real `warp-macos` helper interface for target discovery, two-scan stability, submit, interrupt, and durable submit evidence;
- `warp-doctor --probe-real` capability collection;
- real target challenge and target binding against a wrapper-bound Warp/Claude session;
- shadow/dry-run validation commands that do not run W6 workflow stages;
- diagnostics that show exactly which evidence is missing for Phase 5 pilot readiness.

Phase 6 must not implement:

- automatic permission approval in Claude Code;
- automatic delivery, acceptance, commit, push, or tag;
- any clipboard dispatch path;
- frontmost-window, title-only, or sleep-based inference;
- UI selector logic in Core or Supervisor modules;
- direct production dispatch without Phase 5 allowlist and explicit operator confirmations;
- a real W6 pilot run until this plan and its implementation both pass independent review.

## 3. Evidence Model

Phase 6 introduces no new trust bypass. It only creates real non-fixture evidence that existing Phase 5 gates already require.

### 3.1 Hook capability evidence

Path:

```text
runs/<taskId>/capabilities/claude-hook.json
```

Required fields:

```json
{
  "protocolVersion": 1,
  "kind": "claude-hook.capability",
  "source": "real-claude-code-hook",
  "capturedAt": "2026-06-20T00:00:00.000Z",
  "hookSource": "claude-code",
  "hookVersion": "2.1.160",
  "completionPhase": "claude-completed",
  "attemptRefSource": "wrapper-injected",
  "bindingSessionSource": "wrapper-injected",
  "publisherSource": "wrapper-launched-claude-hook-publisher",
  "publisherProvenance": {
    "bindingId": "wrapper.work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:...",
    "wrapperPid": 12345,
    "wrapperSessionProofVerified": true,
    "source": "wrapper-env-and-local-secret"
  },
  "needsInputCategorySource": "hook-payload",
  "observedFields": [
    "kind",
    "occurredAt",
    "needsInputCategory"
  ],
  "sampleNeedsInputCategory": "agent-question",
  "compatible": true,
  "versionDrift": false
}
```

Rules:

- Raw hook payloads may be captured only into a local review artifact when explicitly requested; the capability record stores a bounded field summary, not full terminal transcript or prompt body.
- `worker-hook-probe W6-A --payload <payload.json>` is a shadow/fixture diagnostic command only. It may write bounded diagnostics under `runs/<taskId>/diagnostics/hook-fixtures/`, but it must not create or update `runs/<taskId>/capabilities/claude-hook.json`, must not set `completionReceiptCapability`, and must not make `pilot-doctor` eligible.
- Real hook capability evidence must be produced by a hook publisher launched by `scripts/claude-wrapper.js` for the bound Claude Code process. The publisher must prove wrapper source provenance by verifying the wrapper-injected binding/session identity against the current binding record and the local raw nonce secret before writing capability evidence.
- Wrapper session proof values are verification inputs only. Capability evidence may store proof verification metadata, `sessionNonceHash`, and opaque provenance ids, but must not persist raw HMAC proof material.
- `completionReceiptCapability` is available only when completion phase semantics are proven as `claude-completed`.
- `needsInputCapability` is available only when the hook or wrapper can produce one of the approved categories: `permission-request`, `agent-question`, `authentication-required`, `external-intervention`.
- Missing, stale, version-drifted, or fixture-only hook evidence keeps `pilot-doctor` unavailable.

### 3.2 Wrapper binding evidence

Paths:

```text
runs/<taskId>/bindings/<bindingId>.json
runs/<taskId>/bindings/.secrets/<bindingId>.nonce
```

The binding record stores only `sessionNonceHash`, `sessionId`, `bindingGeneration`, role, cwd policy, heartbeat, and wrapper process metadata. The raw nonce remains in the 0600 secret/env path and must never appear in binding records, receipts, events, diagnostics, or logs.

Required wrapper behavior:

- launch or attach to a Claude Code worker session for exactly one role: `work` or `review`;
- receive raw nonce through env or the existing `ExecutionStore` 0600 file at `runs/<taskId>/bindings/.secrets/<bindingId>.nonce`;
- maintain heartbeat while the worker is usable;
- answer binding challenge by HMAC over canonical challenge payload;
- publish receipts with HMAC proof bound to the attempt, binding, session, event, and details;
- stop publishing when detached, terminal, stale, or cwd/role/session changes.

Rules:

- Phase 6 must continue using the existing `ExecutionStore` binding secret location. It must not add a parallel secret store such as `runs/<taskId>/secrets/<bindingId>.secret`.
- Secret files must be created with mode `0600`; parent `.secrets` directories must not be world/group writable.
- Diagnostics and command output may include the secret file path only when useful for operator troubleshooting, but never the raw nonce contents.

### 3.3 Warp capability evidence

Path:

```text
runs/<taskId>/capabilities/warp-macos.json
```

Required fields:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.capability",
  "capturedAt": "2026-06-20T00:00:00.000Z",
  "fixture": false,
  "helper": {
    "kind": "warp-macos-helper",
    "version": 1,
    "pathHash": "sha256:..."
  },
  "warp": {
    "detected": true,
    "bundleId": "dev.warp.Warp-Stable",
    "version": "..."
  },
  "accessibility": {
    "permission": "granted",
    "helper": "real-helper",
    "helperVersion": 1
  },
  "targetDiscovery": {
    "available": true,
    "stableFingerprintFields": ["bundleId", "windowId", "tabId", "roleBindingMarker"],
    "requiresTwoScanStability": true
  },
  "inputSubmission": {
    "available": true,
    "method": "accessibility-key-events",
    "usesClipboard": false,
    "settleBarrier": "helper-submit-result"
  },
  "targetIdentity": {
    "available": true,
    "requiresWrapperBinding": true,
    "requiresChallenge": true
  },
  "diagnosticEligible": true,
  "phase4RunEnabled": false,
  "phase5ProductionCandidate": true,
  "reasons": []
}
```

Rules:

- `fixture` must be `false` for Phase 5 pilot eligibility.
- The helper must prove Accessibility permission and supported Warp version before setting `phase5ProductionCandidate: true`.
- If the helper cannot observe stable non-title target fields, production candidate remains false.
- If the helper uses clipboard, production candidate remains false.

### 3.4 Target binding evidence

Target binding remains attached to the existing wrapper binding:

```json
{
  "targetBinding": {
    "adapter": "warp-macos",
    "role": "work",
    "candidateId": "opaque-helper-candidate-id",
    "targetFingerprintHash": "sha256:...",
    "targetChallengeId": "uuid",
    "targetBindingVerifiedAt": "2026-06-20T00:00:00.000Z",
    "capabilityEvidenceId": "warp-macos:<capturedAt>"
  }
}
```

Rules:

- Target binding requires two stable scans immediately before challenge issue.
- Target challenge response must be HMAC-bound to wrapper session identity, target fingerprint, challenge id, and the helper's challenge submit evidence.
- A target challenge is one-time and TTL-bound.
- Target binding replacement during an active attempt is rejected.
- A local wrapper HMAC response is not sufficient to update `targetBinding`. The challenge must be delivered to the concrete scanned Warp candidate through the helper and the response must return through an approved target-local response channel.
- If no secure target-local response channel is available for the scanned target, `warp-bind-target --real` must fail closed and leave existing target binding unchanged.

### 3.5 Target-local challenge protocol

`warp-bind-target --real` must prove that the responding wrapper is reachable through the exact Warp target/pane found by `scan-targets`.

Protocol:

1. The adapter performs two immediate scans and selects exactly one candidate with an identical fingerprint.
2. The adapter writes a pending challenge artifact under `runs/<taskId>/target-challenges/pending/<targetChallengeId>.json`. The challenge includes task id, role, binding id, binding generation, session id, `sessionNonceHash`, candidate id, `targetFingerprintHash`, `capabilityEvidenceId`, TTL, nonce, and one-time use marker.
3. The helper performs a non-clipboard `submit-target-challenge` operation to that exact candidate and returns durable challenge submit evidence containing `operationId`, `transportEvidenceId`, `candidateId`, `targetFingerprintHash`, `sideEffectState`, and `settled`.
4. The target-local response must be produced by the wrapper-launched Claude session that received the challenge through that candidate. Accepted response channels are limited to:
   - a wrapper-launched hook publisher event that includes the `targetChallengeId` and verifies wrapper binding/session provenance; or
   - a local control endpoint owned by the wrapper process when the helper can prove the endpoint is bound to the same target-local TTY/process session observed for the scanned candidate.
5. The response writes `runs/<taskId>/target-challenges/responses/<targetChallengeId>.json` with the challenge id, helper `transportEvidenceId`, binding/session identity, `targetFingerprintHash`, `capabilityEvidenceId`, observed-at timestamp, and HMAC over the canonical response payload.
6. The adapter verifies the pending challenge, TTL, one-time marker, helper challenge submit evidence, target-local response channel, binding heartbeat, raw nonce secret hash, HMAC proof, and exact target fingerprint before moving the artifact to `processed/` and updating `targetBinding`.

Failure rules:

- wrong pane, zero candidates, duplicate candidates, changed fingerprint, title-only identity, or frontmost-only identity fail closed;
- a response from a different binding, role, wrapper pid, session id, binding generation, or nonce hash fails closed;
- a stale target, stale helper capability, stale wrapper heartbeat, or replaced binding fails closed;
- replaying an already processed challenge or reusing a `targetChallengeId` with a different payload fails closed;
- local direct HMAC responses that are not tied to helper challenge submit evidence and an approved target-local response channel are rejected.

## 4. Real Wrapper Design

Add a wrapper entrypoint:

```text
scripts/claude-wrapper.js
```

Initial CLI shape:

```bash
node scripts/claude-wrapper.js \
  --task W6-A \
  --role work \
  --binding wrapper.work \
  --cwd /Users/admin/project/ai/work/HEXAI \
  --harness-root /Users/admin/project/ai/review/Harness
```

Responsibilities:

1. call or consume `worker-attach` output to create/read binding;
2. place raw nonce only in env or 0600 secret file;
3. launch Claude Code in the requested cwd;
4. export attempt/binding context for hook publisher;
5. write heartbeat while Claude process is alive;
6. provide a local challenge response path;
7. shut down or mark binding terminal when the wrapper exits.

Non-goals:

- The wrapper must not intercept or transform production prompts for exactly-once delivery.
- The wrapper must not infer completion from terminal text.
- The wrapper must not auto-approve Claude Code tool calls.

### 4.1 Heartbeat and stale behavior

Heartbeat interval must be less than half of the existing stale threshold. If heartbeat cannot be written, wrapper must mark itself unhealthy and stop publishing receipts.

Supervisor receipt validation already rejects stale binding; Phase 6 tests must verify a stale wrapper cannot complete or needs-input an active attempt.

### 4.2 Hook publisher

Add a publisher module or script:

```text
scripts/claude-hook-publisher.js
```

It receives hook payload plus wrapper-injected environment:

```text
HARNESS_ROOT
HARNESS_TASK_ID
HARNESS_BINDING_ID
HARNESS_SESSION_ID
HARNESS_ATTEMPT_ID
HARNESS_JOB_ID
HARNESS_LEASE_TOKEN
HARNESS_WRAPPER_PID
HARNESS_WRAPPER_SESSION_PROOF_ID
```

It publishes only approved receipt kinds:

- `job.completed`
- `job.failed`
- `job.needs-input`

It must not trust a sequence number from the environment. Sequence allocation is durable and per attempt:

- each attempt owns a receipt sequence ledger under `runs/<taskId>/attempts/<attemptId>/receipt-sequence-ledger.json`;
- the ledger is updated under the existing task execution lock or an equivalent atomic compare-and-rename lock;
- the next sequence is allocated only after the publisher has validated AttemptRef, lease token, lock epoch, binding/session identity, wrapper provenance, event kind, payload hash, and stale checks;
- the ledger stores `nextSequence`, accepted `eventId -> payloadHash` mappings, and the durable receipt path for idempotent replays;
- accepted distinct events for the same attempt must have strictly increasing sequence numbers. A `job.needs-input` event followed by a later `job.completed` event must allocate a later sequence for completion.

It must reject:

- missing AttemptRef;
- missing or stale binding;
- missing raw nonce;
- unsupported needs-input category;
- event timestamp beyond clock-skew allowance;
- duplicate event id with a different canonical payload hash;
- duplicate hook payload that attempts to allocate a new sequence instead of returning the prior idempotent receipt;
- hook replay after the attempt is terminal, lease token is stale, or binding/session provenance no longer matches;
- parallel publisher attempts that do not serialize through the ledger or that come from a different live wrapper session for the same attempt.

Event identity and collision rules:

- `eventId` must be deterministic from wrapper session identity plus the source hook event id when Claude provides one; otherwise it must be derived from canonical hook payload hash, attempt id, event kind, and occurred-at timestamp.
- If an existing `eventId` maps to the same payload hash, the publisher returns the existing receipt path and does not allocate a new sequence.
- If an existing `eventId` maps to a different payload hash, the publisher fails closed with a stable collision classification and writes no receipt.
- Payload hash uses the same canonical JSON normalization as existing receipt/event hashing.

## 5. Real macOS Helper Design

Add a helper adapter boundary without changing Core or Supervisor:

```text
scripts/warp-macos-helper.js
```

It should expose a small JSON protocol so tests can replace it with fixtures:

```bash
node scripts/warp-macos-helper.js scan-targets --role work --json
node scripts/warp-macos-helper.js submit-text --request <path|json> --json
node scripts/warp-macos-helper.js interrupt --request <path|json> --json
node scripts/warp-macos-helper.js probe-capability --json
```

Side-effect commands must accept only a complete fenced request through `--request <path|json>`. They must not accept split ambient arguments such as `--target`, `--input-file`, or `--attempt-ref`, because those forms allow the helper to reconstruct missing fencing fields from current state.

### 5.1 Target candidate schema

```json
{
  "adapter": "warp-macos",
  "role": "work",
  "candidateId": "opaque",
  "fingerprint": {
    "bundleId": "dev.warp.Warp-Stable",
    "windowId": "opaque-window-id",
    "tabId": "opaque-tab-id",
    "roleBindingMarker": "wrapper.work"
  },
  "targetFingerprintHash": "sha256:..."
}
```

Rules:

- `windowTitle`, `tabTitle`, and `frontmost` may be diagnostic fields only; they cannot participate as the sole identity.
- Two scans must resolve exactly one matching candidate with identical fingerprint.
- Zero, duplicate, changed fingerprint, title-only, and frontmost-only candidates fail closed.

### 5.2 SubmitRequest and InterruptRequest schema

The adapter must create a complete fenced request before any helper operation that can mutate input or interrupt a target. The helper must validate the request before focus, key events, or any other side effect.

Required `SubmitRequest` fields:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.submit-request",
  "operationId": "uuid",
  "attemptRef": {
    "jobId": "job-id",
    "attemptId": "attempt-id",
    "leaseToken": "lease-token"
  },
  "lockEpoch": 12,
  "binding": {
    "bindingId": "wrapper.work",
    "role": "work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:..."
  },
  "targetFingerprintHash": "sha256:...",
  "targetChallengeId": "uuid",
  "capabilityEvidenceId": "warp-macos:<capturedAt>",
  "pilotAuthorization": {
    "allowlistId": "W6-A-04-plan-review",
    "allowlistHash": "sha256:...",
    "expiresAt": "2026-06-20T00:00:00.000Z"
  },
  "inputSnapshot": {
    "path": "runs/<taskId>/attempts/<attemptId>/input.txt",
    "hash": "sha256:..."
  }
}
```

Required `InterruptRequest` fields:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.interrupt-request",
  "operationId": "uuid",
  "attemptRef": {
    "jobId": "job-id",
    "attemptId": "attempt-id",
    "leaseToken": "lease-token"
  },
  "lockEpoch": 12,
  "binding": {
    "bindingId": "wrapper.work",
    "role": "work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:..."
  },
  "targetFingerprintHash": "sha256:...",
  "targetChallengeId": "uuid",
  "capabilityEvidenceId": "warp-macos:<capturedAt>",
  "pilotAuthorization": {
    "allowlistId": "W6-A-04-plan-review",
    "allowlistHash": "sha256:...",
    "expiresAt": "2026-06-20T00:00:00.000Z"
  },
  "inputSnapshot": {
    "path": "runs/<taskId>/attempts/<attemptId>/input.txt",
    "hash": "sha256:..."
  },
  "reason": "operator-cancel"
}
```

Validation rules:

- The adapter must derive these requests from the active job/attempt/lease snapshot, active execution lock epoch, attempt-captured binding/session identity, current target binding, current capability evidence, current allowlist authorization snapshot, and immutable input snapshot.
- The helper must reject missing fields, wrong operation id shape, wrong or stale lease token, stale `lockEpoch`, stale binding/session identity, wrong `targetChallengeId`, wrong `targetFingerprintHash`, stale or mismatched `capabilityEvidenceId`, expired or drifted allowlist hash, unreadable input snapshot, or input hash mismatch before any target side effect.
- The helper must not silently fill missing fencing fields from current ambient state.
- Capability drift between request creation and helper validation fails closed before side effect.

### 5.3 SubmitResult and InterruptResult schema

The helper must write durable evidence before returning a side-effectful result:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.submit-result",
  "operationId": "uuid",
  "attemptRef": {
    "jobId": "job-id",
    "attemptId": "attempt-id",
    "leaseToken": "lease-token"
  },
  "lockEpoch": 12,
  "binding": {
    "bindingId": "wrapper.work",
    "role": "work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:..."
  },
  "targetFingerprintHash": "sha256:...",
  "targetChallengeId": "uuid",
  "capabilityEvidenceId": "warp-macos:<capturedAt>",
  "pilotAuthorization": {
    "allowlistId": "W6-A-04-plan-review",
    "allowlistHash": "sha256:...",
    "expiresAt": "2026-06-20T00:00:00.000Z"
  },
  "inputSnapshot": {
    "path": "runs/<taskId>/attempts/<attemptId>/input.txt",
    "hash": "sha256:..."
  },
  "transportEvidenceId": "uuid",
  "sideEffectState": "none|input-mutated|submitted|unknown",
  "settled": true,
  "usedClipboard": false,
  "evidencePath": "runs/<taskId>/transports/...",
  "submittedAt": "2026-06-20T00:00:00.000Z"
}
```

Mapping:

- `none` + durable matching evidence can map to safe pre-side-effect failure.
- `submitted` + durable matching evidence maps to dispatch submitted.
- `input-mutated`, `unknown`, timeout, helper crash, clipboard use, missing evidence, or fingerprint mismatch maps to dispatch uncertain/fail-closed.

Required `InterruptResult` fields:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.interrupt-result",
  "operationId": "uuid",
  "attemptRef": {
    "jobId": "job-id",
    "attemptId": "attempt-id",
    "leaseToken": "lease-token"
  },
  "lockEpoch": 12,
  "binding": {
    "bindingId": "wrapper.work",
    "role": "work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:..."
  },
  "targetFingerprintHash": "sha256:...",
  "targetChallengeId": "uuid",
  "capabilityEvidenceId": "warp-macos:<capturedAt>",
  "pilotAuthorization": {
    "allowlistId": "W6-A-04-plan-review",
    "allowlistHash": "sha256:...",
    "expiresAt": "2026-06-20T00:00:00.000Z"
  },
  "inputSnapshot": {
    "path": "runs/<taskId>/attempts/<attemptId>/input.txt",
    "hash": "sha256:..."
  },
  "transportEvidenceId": "uuid",
  "sideEffectState": "none|interrupted|unknown",
  "settled": true,
  "usedClipboard": false,
  "evidencePath": "runs/<taskId>/transports/...",
  "interruptedAt": "2026-06-20T00:00:00.000Z"
}
```

Mirror rules:

- `SubmitResult` and `InterruptResult` must mirror the request's `operationId`, `attemptRef.jobId`, `attemptRef.attemptId`, `attemptRef.leaseToken`, `lockEpoch`, every `binding` field, `targetFingerprintHash`, `targetChallengeId`, `capabilityEvidenceId`, every `pilotAuthorization` field, and every `inputSnapshot` field with the same field names.
- The helper must not rename `targetFingerprintHash` to `candidateFingerprintHash` or any other alias in side-effect results.
- The adapter must verify every mirrored field before accepting submitted/cancelled or safe pre-side-effect classifications.
- Missing, renamed, or mismatched mirror fields make the outcome uncertain/fail-closed and cannot be accepted as submitted/cancelled.

## 6. CLI Surface

Keep command-first style.

New or extended commands:

```bash
node scripts/harness.js worker-launch W6-A --role work --binding wrapper.work --cwd <path>
node scripts/harness.js worker-heartbeat W6-A --binding wrapper.work
node scripts/harness.js worker-detach W6-A --binding wrapper.work --reason <text>
node scripts/harness.js worker-hook-probe W6-A --payload <payload.json>
node scripts/harness.js warp-doctor W6-A --probe-real --json
node scripts/harness.js warp-bind-target W6-A --role work --binding wrapper.work --candidate <candidateId> --real
node scripts/harness.js pilot-doctor W6-A --json
```

Compatibility:

- existing `worker-attach`, `worker-challenge`, `worker-receipt`, `warp-doctor --probe-fixture`, and fixture tests remain unchanged;
- `worker-launch` may be implemented as a wrapper around `worker-attach`, but it must not weaken active-attempt replacement guards;
- `warp-bind-target --real` must never fall back to fixture discovery.
- `worker-hook-probe W6-A --payload <payload.json>` remains a fixture/shadow diagnostic command. It must label artifacts as fixture, keep hook capability unavailable, and cannot authorize `pilot-doctor` or `pilot-doctor` readiness.
- real hook capability capture must use wrapper-launched hook publisher provenance, not arbitrary local JSON.

Exit behavior:

- capability unavailable returns non-zero and writes no dispatchable attempt;
- shadow commands may write diagnostic artifacts but must not modify workflow status;
- `pilot-doctor` remains read-only.
- `warp-bind-target --real` returns non-zero when target-local challenge delivery or target-local response is unavailable, stale, replayed, or not tied to the scanned candidate.

## 7. Shadow Validation Before Real Pilot

Phase 6 must pass these in order:

1. Claude Code health check by operator: a no-tool prompt returns expected text.
2. Wrapper-launched real hook publisher records fresh compatible `claude-hook` evidence; `worker-hook-probe --payload` remains fixture/shadow only and does not satisfy this step.
3. Wrapper launch creates live work and review bindings with heartbeat.
4. Binding challenge verifies HMAC proof.
5. Real warp capability probe records non-fixture `phase5ProductionCandidate: true`.
6. Real target discovery returns exactly one stable work target and one stable review target.
7. Target challenge binds each target to its wrapper session.
8. Shadow send submits a no-op diagnostic prompt only to a scratch or explicitly confirmed shadow target; it must not mutate repo files or workflow status.
9. `pilot-doctor W6-A --json` reports allowed only after allowlist, hook evidence, wrapper binding, warp capability, and target binding are all fresh.

The actual W6 pilot run remains a separate operator decision after Code Review approval.

## 8. Security and Privacy Constraints

Phase 6 must not persist:

- raw session nonce outside 0600 secret/env;
- HMAC proof values in ordinary diagnostics;
- terminal transcript;
- prompt body;
- clipboard content;
- full Accessibility tree/path;
- unredacted user content.

Allowed persisted evidence is bounded metadata: hashes, opaque IDs, timestamps, capability booleans, version strings, and failure classifications.

## 9. Recovery and Fencing

All Phase 6 side effects must continue using existing Phase 2-5 fencing:

- task execution lock for status/artifact mutations;
- `stateRevision`, `stageRevision`, and stage cursor CAS;
- AttemptRef: `jobId`, `attemptId`, `leaseToken`;
- `lockEpoch`;
- binding generation, session id, and session nonce hash;
- target fingerprint hash and target challenge id;
- capability evidence id;
- pilotAuthorization allowlist hash and expiry.

Helper submit/interrupt side effects add no ambient trust. `SubmitRequest` and `InterruptRequest` must carry the full fencing snapshot and must be passed to helper side-effect commands as the single `--request <path|json>` input. `SubmitResult`/`InterruptResult` must mirror the request fencing fields with identical field names. The adapter verifies the mirrored result against the active operation before any workflow state transition. A request or result with missing fields, wrong operation id, wrong lease token, stale lock epoch, wrong target challenge id, capability drift, allowlist drift, input snapshot mismatch, renamed `targetFingerprintHash`, or any mirror mismatch is rejected or marked uncertain according to the side-effect state.

Restart behavior:

- stale wrapper heartbeat invalidates future receipts;
- stale helper capability invalidates dispatch/cancel before side effect;
- stale target fingerprint invalidates dispatch/cancel before side effect;
- late receipts from old attempts are rejected by existing receipt fencing;
- ambiguous submit results enter dispatch-uncertain and require reconcile.

## 10. Tests

Follow TDD. Add tests before implementation.

Required unit/CLI tests:

- `worker-launch` writes binding and the raw nonce only to `runs/<taskId>/bindings/.secrets/<bindingId>.nonce` with mode `0600`; it must not create `runs/<taskId>/secrets/<bindingId>.secret` or leak raw nonce in binding JSON, receipts, events, diagnostics, logs, or stdout.
- heartbeat refreshes binding; stale heartbeat rejects completion and needs-input.
- binding challenge bad proof/replay/stale binding fail closed.
- hook capability probe rejects missing completion phase, missing injection source, unsupported needs-input category, stale evidence, and version drift.
- `worker-hook-probe W6-A --payload <payload.json>` writes only fixture/shadow diagnostics and cannot authorize `pilot-doctor`.
- arbitrary local JSON hook payload cannot enable `completionReceiptCapability`, `needsInputCapability`, or `pilot-doctor` allowed.
- fixture hook evidence remains unavailable for real pilot even when it has a valid-looking payload.
- real hook capability requires wrapper-launched publisher proof and source provenance.
- receipt publisher crash/restart continues sequence allocation from the durable per-attempt ledger.
- duplicate hook payload returns the prior idempotent receipt without allocating a new sequence.
- duplicate `eventId` with a different payload hash fails closed as a collision.
- hook replay after terminal/stale lease/stale binding fails closed.
- `job.needs-input` followed by `job.completed` uses strictly increasing receipt sequences.
- parallel hook publishers for one attempt serialize through the ledger; mismatched wrapper session publisher fails closed.
- `warp-doctor --probe-real` refuses fixture evidence and requires non-clipboard input submission.
- real helper target scan rejects zero, duplicate, changed fingerprint, title-only, and frontmost-only.
- `warp-bind-target --real` refuses active attempt and never falls back to fixture.
- `warp-bind-target --real` fails closed when no target-local response channel exists.
- target challenge wrong pane, wrong wrapper, stale target, stale wrapper, and replayed challenge fail closed without updating `targetBinding`.
- direct wrapper HMAC response without helper challenge submit evidence and approved target-local response channel is rejected.
- `SubmitRequest` missing required fencing fields is rejected before side effect.
- helper `submit-text` and `interrupt` reject split side-effect CLI arguments such as `--target`, `--input-file`, and `--attempt-ref`; only `--request <path|json>` is accepted.
- submit/interrupt with wrong `operationId`, wrong `leaseToken`, stale `lockEpoch`, wrong `targetChallengeId`, wrong `targetFingerprintHash`, stale `capabilityEvidenceId`, capability drift, allowlist drift, or input snapshot hash mismatch is rejected before side effect.
- `SubmitResult` and `InterruptResult` missing, renaming, or changing mirrored fencing fields are rejected or marked uncertain, never accepted as submitted/cancelled.
- `SubmitResult` using `candidateFingerprintHash` instead of request-mirrored `targetFingerprintHash` is rejected.
- `InterruptRequest` and `InterruptResult` missing `inputSnapshot.path` or `inputSnapshot.hash` are rejected.
- submit result with missing durable evidence or wrong fingerprint maps to uncertain.
- helper crash/timeout after focus maps to uncertain, not safe retry.
- `pilot-doctor` remains read-only.
- `run --phase5-pilot` still fails before prepare if any evidence is missing or stale.
- no test stores raw nonce, HMAC proof, terminal transcript, prompt body, clipboard content, or full Accessibility path.

Opt-in local tests:

- run only when an explicit env flag is set, for example `HARNESS_ENABLE_REAL_WARP_HELPER=1`;
- may inspect local Warp/Accessibility state;
- must not run in default `pnpm test`;
- must write bounded artifacts for manual review.

## 11. Implementation Steps

1. Add tests for wrapper binding/heartbeat/challenge, existing `ExecutionStore` raw nonce path, secret permissions, and raw nonce non-persistence.
2. Implement wrapper store commands: `worker-launch`, `worker-heartbeat`, `worker-detach`.
3. Add hook probe tests proving local JSON payloads remain fixture/shadow diagnostics and cannot authorize real pilot.
4. Add hook publisher tests for wrapper provenance, durable per-attempt receipt sequence ledger, idempotent `eventId`, collision rejection, crash/restart, needs-input to completion ordering, replay rejection, and parallel publisher serialization.
5. Implement `claude-hook-publisher`, sequence ledger, and capability evidence writer.
6. Add helper protocol tests using deterministic helper fixtures for `--request <path|json>` only, full `SubmitRequest`/`InterruptRequest` fencing, and same-field-name mirrored result validation.
7. Implement `warp-macos-helper` process boundary and adapter integration.
8. Add `warp-doctor --probe-real` with fail-closed capability derivation.
9. Add `warp-bind-target --real` with strict two-scan, target-local challenge delivery, target-local response channel verification, one-time TTL, and direct-HMAC rejection.
10. Add shadow validation commands and diagnostics.
11. Run `pnpm test`, `node --check`, schema parse, and `git diff --check`.
12. Request independent Code Review.
13. Only after Code Review approval, ask operator before any real W6 pilot run.

## 12. Acceptance Criteria

Phase 6 is complete only when:

1. default `pnpm test` passes without requiring Warp, Accessibility, or Claude login;
2. opt-in real helper probes produce bounded evidence and fail closed when unavailable;
3. `pilot-doctor` clearly distinguishes missing hook, missing wrapper, missing warp capability, missing target binding, stale evidence, and allowed;
4. fixture evidence cannot authorize real Phase 5 pilot;
5. real `phase5ProductionCandidate` requires non-fixture helper evidence;
6. arbitrary local hook JSON payloads cannot authorize real pilot; real hook capability requires wrapper-launched publisher provenance;
7. wrapper receipts are HMAC-bound to attempt, binding, session, event, and details, and receipt sequences come only from a durable per-attempt ledger;
8. target binding is HMAC-bound to wrapper session, target fingerprint, helper challenge submit evidence, and an approved target-local response channel;
9. `warp-bind-target --real` fails closed when secure target-local challenge response is unavailable;
10. submit/interrupt side effects are invoked only with complete `--request <path|json>` payloads and are fenced by AttemptRef, lease, lockEpoch, binding/session identity, target identity, target challenge id, capability evidence id, pilotAuthorization, and input snapshot hash/path;
11. ambiguous helper outcomes produce dispatch-uncertain, not automatic retry;
12. no raw nonce, proof, prompt body, transcript, clipboard content, or full Accessibility path is persisted in ordinary artifacts;
13. raw nonce storage uses the existing `runs/<taskId>/bindings/.secrets/<bindingId>.nonce` path and does not introduce a parallel secret store;
14. independent Plan Review and Code Review return Approved before any real W6 pilot run.

## 13. Current W6-A Readiness Snapshot

As of this plan:

- Claude Code manual health check: passed by operator.
- Phase 5 allowlist: available for `W6-A-04 implementation-plan -> plan-review`.
- Active job/attempt: none.
- Hook capability: missing.
- Wrapper bindings: missing.
- Warp capability: missing.
- Warp target bindings: missing.
- Pilot readiness: fail-closed, as expected.
