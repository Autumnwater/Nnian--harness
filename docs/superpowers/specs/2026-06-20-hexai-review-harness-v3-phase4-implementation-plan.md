# HEXAI Review Harness V3 Phase 4 — Warp macOS Adapter Spike Plan

**Date:** 2026-06-20  
**Status:** Plan for review  
**Baseline:** Phase 3 commit `707c71b`  
**Scope:** Warp macOS adapter capability spike, target discovery, target-to-wrapper identity proof, shadow input submission, failure-closed adapter integration  
**Out of scope:** real W6 pilot, real-task production `run --adapter warp-macos`, degraded production run, automatic permission approval, automatic commit/push/tag, screen-text completion inference, frontmost-window fallback, clipboard-based dispatch

## 1. Goal

Phase 4 proves whether a local macOS Warp adapter can safely become a WorkerAdapter target for the Phase 2 Supervisor and Phase 3 wrapper/receipt identity model.

The target outcome is not “run W6 automatically”. The target outcome is a reviewed, test-covered adapter spike that can answer these questions with durable evidence:

1. Can Harness discover exactly one Warp target for each role (`work`, `review`) without using the frontmost tab as a fallback?
2. Can Harness bind that Accessibility target to the Phase 3 wrapper session identity and reject title-only matches?
3. Can Harness submit bounded shadow input to the verified target without clipboard use?
4. Can Harness fail closed for missing, duplicate, stale, changed, or ambiguous targets?
5. Can the adapter be removed without changing Core/Supervisor workflow code?

Phase 4 does not enable real-task production `run --adapter warp-macos`, even when local capabilities are proven. A successful Phase 4 produces diagnostic eligibility and scratch/fixture evidence only; Phase 5 owns the separate production-run enablement decision and W6 pilot gate.

## 2. Approved Boundary

Phase 4 may implement:

- `warp-macos` adapter module behind explicit adapter selection;
- macOS helper boundary for target discovery and input submission;
- diagnostic commands and capability evidence records;
- target fingerprint records attached to wrapper bindings;
- fixture-backed contract tests for every adapter behavior;
- opt-in local spike scripts that collect evidence from the developer machine.

Phase 4 must not implement:

- a real W6 pilot or any irreversible task execution;
- automatic approval of Claude Code tool calls or permission prompts;
- automatic delivery acceptance, commit, push, or tag;
- completion inferred from Warp UI text, spinners, notifications, sleeps, or fresh output alone;
- fallback to frontmost Warp tab/window;
- clipboard, pasteboard, or `pbcopy` prompt dispatch;
- any Warp selector or Accessibility dependency inside Core/Supervisor modules.

The default execution mode remains manual. In Phase 4, `--adapter warp-macos` is allowed only for fixture, production-test, or scratch tasks that cannot mutate the real W6 workflow. Real W6 and real project-task production runs remain disabled until Phase 5.

## 3. Current Baseline

Phase 1–3 already provide:

- task execution lock, lockEpoch fencing, state/stage revisions, and CAS;
- durable job/attempt/operation/lease/event/receipt stores;
- foreground `run` loop with short-lock pump;
- receipt replay, rejection, and idempotent terminal commits;
- fake/manual adapters and multi-process CLI tests;
- wrapper binding records, nonce secret storage, HMAC proof validation;
- challenge issue/verify for wrapper/session identity;
- authoritative `job.completed`, `job.failed`, and `job.needs-input` receipt validation.

Phase 4 must reuse the existing `WorkerAdapter` interface and `ExecutionSupervisor`. It must not add a second workflow state machine.

## 4. Capability Evidence Model

Add a durable, redacted capability evidence record under:

```text
runs/<taskId>/capabilities/warp-macos.json
```

The record is diagnostic evidence, not authorization by itself:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.capability",
  "capturedAt": "2026-06-20T00:00:00.000Z",
  "host": {
    "platform": "darwin",
    "arch": "arm64"
  },
  "warp": {
    "detected": true,
    "bundleId": "dev.warp.Warp-Stable",
    "version": "redacted-or-version"
  },
  "accessibility": {
    "permission": "granted",
    "helper": "jxa-or-native-helper",
    "helperVersion": 1
  },
  "targetDiscovery": {
    "available": true,
    "stableFingerprintFields": ["appBundleId", "windowTitle", "tabTitle", "role", "cwdHint"],
    "requiresTwoScanStability": true
  },
  "inputSubmission": {
    "available": true,
    "method": "direct-key-events-or-accessibility-value",
    "usesClipboard": false,
    "settleBarrier": "helper-return-or-ambiguous"
  },
  "targetIdentity": {
    "available": true,
    "requiresWrapperBinding": true,
    "requiresChallenge": true
  },
  "diagnosticEligible": false,
  "phase4RunEnabled": false,
  "phase5ProductionCandidate": false,
  "reasons": []
}
```

Rules:

- `diagnosticEligible` means the adapter has enough evidence to run explicit Phase 4 probe commands.
- `phase4RunEnabled` may be true only for fixture, production-test, or scratch tasks that are marked as non-W6/non-production. It must remain false for real W6 and real project tasks throughout Phase 4.
- `phase5ProductionCandidate` can be true only when target discovery, input submission, wrapper binding, target challenge, hook completion, and needs-input capabilities are all available and fresh. It is an input to Phase 5 review, not permission to run production tasks in Phase 4.
- Evidence is fresh for at most 24 hours. Stale evidence makes `doctor --adapter warp-macos` unavailable.
- Evidence must not contain raw nonce, HMAC proof, terminal transcript, prompt content, or clipboard content.
- If the helper cannot identify stable fingerprint fields, the adapter remains diagnostic-only.
- Capability evidence from fixture tests must be clearly marked `fixture: true` and cannot enable real target dispatch.

## 5. Target Descriptor and Fingerprint

Introduce an adapter-owned target descriptor:

```json
{
  "protocolVersion": 1,
  "adapter": "warp-macos",
  "role": "work",
  "bindingId": "wrapper.work",
  "candidateId": "01J...",
  "fingerprint": {
    "appBundleId": "dev.warp.Warp-Stable",
    "windowTitle": "HEXAI work",
    "tabTitle": "work",
    "cwdHint": "/Users/admin/project/ai/main",
    "accessibilityPathHash": "sha256:..."
  },
  "observedAt": "2026-06-20T00:00:00.000Z",
  "source": "accessibility-helper"
}
```

Fingerprint rules:

- Only fields proven stable by the local capability spike may participate in the fingerprint.
- The adapter must perform two scans before binding and before dispatch. Both scans must resolve exactly one candidate with the same fingerprint.
- Missing, zero, duplicate, or changed candidates fail closed.
- The adapter must never dispatch based on tab title alone.
- The adapter must never select the focused/frontmost Warp target unless it also uniquely matches the configured fingerprint.
- Fingerprints are adapter-owned. Core/Supervisor stores only opaque adapter metadata captured in job/attempt records.

## 6. Target-to-Wrapper Identity Binding

Phase 3 proves local wrapper/session identity. Phase 4 must additionally prove that the Accessibility target is the same interactive session as the wrapper binding before prompt submission.

Add target binding metadata to the existing binding record:

```json
{
  "targetBinding": {
    "adapter": "warp-macos",
    "targetFingerprintHash": "sha256:...",
    "verifiedAt": "2026-06-20T00:00:00.000Z",
    "challengeId": "01J...",
    "challengeResponseEventId": "01J...",
    "capabilityEvidenceId": "warp-macos:2026-06-20T00:00:00.000Z"
  }
}
```

Identity rules:

- The target challenge is distinct from the Phase 3 local `worker-challenge`.
- It uses the same helper submission path as later dispatch, but only with the fixed no-op shadow payload below and only from an explicit operator probe command.
- The response must arrive as a `target.challenge-response` artifact in the challenge inbox. It is not a workflow receipt and cannot satisfy `job.completed`, `job.failed`, or `job.needs-input`.
- If the installed hook/wrapper cannot produce this target challenge response, target binding remains unavailable and Phase 4 `run --adapter warp-macos` remains limited to fixture-only tests.
- Active attempts capture target metadata at prepare time.
- Binding replacement is still prohibited while an active attempt exists.
- If the wrapper heartbeat, binding generation, sessionId, nonce hash, cwd policy, capability evidence, or target fingerprint changes after prepare, dispatch and cancel fail closed.

Target challenge payload schema:

```json
{
  "protocolVersion": 1,
  "kind": "target.challenge",
  "challengeId": "01J...",
  "taskId": "W6-A",
  "role": "work",
  "bindingId": "wrapper.work",
  "bindingGeneration": 3,
  "sessionId": "01J-session",
  "sessionNonceHash": "sha256:...",
  "adapter": "warp-macos",
  "candidateId": "01J-candidate",
  "targetFingerprintHash": "sha256:...",
  "capabilityEvidenceId": "warp-macos:2026-06-20T00:00:00.000Z",
  "issuedAt": "2026-06-20T00:00:00.000Z",
  "expiresAt": "2026-06-20T00:02:00.000Z",
  "mode": "shadow-noop"
}
```

Target challenge response schema:

```json
{
  "protocolVersion": 1,
  "kind": "target.challenge-response",
  "eventId": "01J-response",
  "challengeId": "01J...",
  "taskId": "W6-A",
  "role": "work",
  "bindingId": "wrapper.work",
  "bindingGeneration": 3,
  "sessionId": "01J-session",
  "sessionNonceHash": "sha256:...",
  "adapter": "warp-macos",
  "targetFingerprintHash": "sha256:...",
  "capabilityEvidenceId": "warp-macos:2026-06-20T00:00:00.000Z",
  "occurredAt": "2026-06-20T00:00:10.000Z",
  "proof": "hmac-sha256:..."
}
```

Challenge rules:

- Challenge records are written under `runs/<taskId>/target-challenges/pending/<challengeId>.json`.
- Responses are written under `runs/<taskId>/target-challenges/inbox/<challengeId>/<eventId>.json`.
- Accepted responses move to `target-challenges/processed/<challengeId>/<eventId>.json`; rejected responses move to `target-challenges/rejected/<challengeId>/<eventId>.json`.
- `expiresAt` must be at most two minutes after `issuedAt`.
- A challenge is one-time. A second response for the same `challengeId`, or a replay of an accepted response, is rejected as `target-challenge-replay`.
- The HMAC proof covers the canonical response payload without `proof` and is verified with the Phase 3 raw nonce secret for the captured binding/session.
- The response must match the pending challenge exactly for task, role, binding, generation, session, nonce hash, adapter, target fingerprint, and capability evidence id.
- Expired, mismatched, missing-secret, bad-proof, duplicate, or ambiguous challenge outcomes fail closed and cannot update `targetBinding`.
- A successful target challenge proves only Phase 4 target binding capability. It does not by itself authorize real-task production dispatch.
- If no non-agent control channel exists and the only available proof path is a shadow no-op agent prompt, then Phase 5 production dispatch remains unavailable until a separate pilot review accepts that risk.

Challenge safety:

- The no-op shadow payload must be clearly marked as a Harness target-binding probe.
- It must not ask Claude to modify files, run commands, commit, push, or approve tools.
- It must be allowed only for explicit operator-invoked binding/probe commands, not implicit `run`.
- A failed or ambiguous challenge cannot be retried automatically after any possible input submission.

## 6.1 Attempt-Captured Target Metadata

For `warp-macos` attempts, job, attempt, and lease records must capture opaque adapter target identity at prepare time:

```json
{
  "adapterIdentity": {
    "adapter": "warp-macos",
    "role": "work",
    "bindingId": "wrapper.work",
    "bindingGeneration": 3,
    "sessionId": "01J-session",
    "sessionNonceHash": "sha256:...",
    "targetFingerprintHash": "sha256:...",
    "targetChallengeId": "01J-challenge",
    "targetBindingVerifiedAt": "2026-06-20T00:00:00.000Z",
    "capabilityEvidenceId": "warp-macos:2026-06-20T00:00:00.000Z"
  }
}
```

Validation locations:

- `prepare`: resolves the current binding and target binding under the task lock, then stores `adapterIdentity` on job, attempt, and lease. Missing target binding fails before creating a dispatchable attempt.
- `dispatch`: before any side effect, re-reads current binding, target binding, capability evidence, and two-scan target descriptor; every captured field must still match. Any mismatch returns target unavailable before side effect when no input occurred.
- `cancel`: before target-side interrupt, verifies `AttemptRef`, lease token, lockEpoch, current target fingerprint, binding/session identity, and captured `adapterIdentity`. Any mismatch sends no interrupt.
- `recovery`: restart recovery reconstructs in-flight `warp-macos` attempts from job/attempt/lease `adapterIdentity`; stale or missing target metadata moves the attempt to operator-required failure/uncertain state rather than choosing a new target.
- `receipt`: Phase 3 completion and needs-input receipts are not required to carry `targetFingerprintHash` or target challenge proof. They remain fenced by AttemptRef, leaseToken, lockEpoch, binding/session identity, and HMAC proof. Therefore Phase 4 must not claim that late receipts are rejected by target fingerprint mismatch unless a later phase adds target proof to receipt payloads.

Diagnostics:

- Events may record redacted `targetFingerprintHash`, `targetChallengeId`, and `capabilityEvidenceId`.
- Events must not store full Accessibility path, terminal transcript, raw nonce, HMAC proof, or prompt body.

## 7. Adapter Interface Contract

Implement `WarpMacosAdapter` behind the existing `WorkerAdapter` interface:

```ts
class WarpMacosAdapter {
  capabilities(): Promise<AdapterCapabilities>
  discoverTargets(): Promise<TargetDescriptor[]>
  health(target: TargetDescriptor): Promise<HealthResult>
  dispatch(job: WorkerJob, target: TargetDescriptor): Promise<DispatchTransportResult>
  cancel(attempt: AttemptRef, target: TargetDescriptor): Promise<CancelResult>
}
```

Contract rules:

- `capabilities()` reads capability evidence and returns unavailable when evidence is missing, stale, fixture-only, or incomplete.
- `discoverTargets()` delegates to the helper and returns descriptors only; it must not mutate status or submit input.
- `health()` verifies wrapper heartbeat, binding state, capability evidence freshness, and two-scan fingerprint stability.
- `dispatch()` must:
  1. re-check target uniqueness and fingerprint stability immediately before side effect;
  2. reject if the job/attempt-captured binding or adapter target identity no longer matches the current binding and target binding;
  3. reject if hook completion capability is unavailable;
  4. verify prompt path/hash before loading text;
  5. persist no secrets or terminal transcript;
  6. submit only through a helper method that does not use clipboard;
  7. return `failed-before-side-effect` only when the helper proves no target input was sent;
  8. return ambiguous/uncertain for helper crash, timeout, unknown settle state, or any possible partial send.
- `cancel()` must:
  1. verify `jobId`, `attemptId`, and `leaseToken`;
  2. re-check target fingerprint, binding identity, and captured adapter identity immediately before target-side interrupt;
  3. send no interrupt when any identity/fencing check fails;
  4. return unavailable/ambiguous rather than interrupting a frontmost or unverified target.

## 8. macOS Helper Boundary

Create a helper boundary so the adapter core can be tested without macOS or Warp:

```ts
interface WarpMacosHelper {
  probe(): Promise<ProbeResult>
  scanTargets(query: TargetQuery): Promise<TargetCandidate[]>
  submitText(candidate: TargetCandidate, payload: string, options: SubmitOptions): Promise<SubmitResult>
  interrupt(candidate: TargetCandidate, attempt: AttemptRef): Promise<CancelResult>
}
```

Implementation rules:

- Production helper may use JXA, Swift, or a small native executable. The adapter must treat the helper as replaceable.
- Tests use a fixture helper with deterministic candidates and fault injection.
- Helper output is JSON only and must be schema-validated.
- Helper must never read or write `status.json`.
- Helper must not use clipboard/pasteboard APIs.
- Helper must surface side-effect state explicitly.

`SubmitResult` schema:

```json
{
  "protocolVersion": 1,
  "kind": "warp-macos.submit-result",
  "operationId": "01J-operation",
  "jobId": "job-id-or-null-for-shadow",
  "attemptId": "attempt-id-or-null-for-shadow",
  "leaseToken": "lease-or-null-for-shadow",
  "candidateFingerprintHash": "sha256:...",
  "transportEvidenceId": "01J-evidence",
  "sideEffectState": "none",
  "settled": true,
  "usedClipboard": false,
  "submittedAt": null,
  "evidencePath": "runs/W6-A/transports/warp-macos/01J-evidence.json",
  "reason": "permission-denied-before-focus"
}
```

`sideEffectState` values:

- `none` — helper durably proves it did not focus, mutate input, submit Enter, or otherwise deliver text to the candidate.
- `input-mutated` — helper may have written text into the input field but did not prove Enter/submission.
- `submitted` — helper reports text was submitted.
- `unknown` — helper cannot prove whether focus, input mutation, partial text, or Enter occurred.

Mapping rules:

- `failed-before-side-effect` is allowed only when `sideEffectState = none`, `settled = true`, `usedClipboard = false`, `candidateFingerprintHash` matches, and `transportEvidenceId` points to a durable helper evidence file that validates.
- `dispatch-submitted` is allowed only when `sideEffectState = submitted`, `settled = true`, `usedClipboard = false`, and durable helper evidence validates.
- `input-mutated`, `unknown`, timeout, invalid JSON, helper crash after focus, helper crash without durable evidence, or any possible partial send maps to `dispatch-uncertain`.
- `usedClipboard = true` is always a contract violation and fails closed. It cannot be classified as safe retry.
- Permission denial before target focus may map to `failed-before-side-effect` only with durable evidence showing `sideEffectState = none`.
- Crash before helper evidence is durably written maps to `dispatch-uncertain` unless the supervisor can prove `dispatching` had not been persisted.

## 9. CLI Surface

Keep command-first top-level CLI style.

Canonical Phase 4 commands:

```text
pnpm harness warp-doctor W6-A --json
pnpm harness warp-targets W6-A --role work --json
pnpm harness warp-bind-target W6-A --role work --binding wrapper.work --candidate <candidateId>
pnpm harness warp-shadow-send W6-A --role work --binding wrapper.work --message <fixture>
pnpm harness doctor W6-A --adapter warp-macos --json
pnpm harness run <scratch-task> --adapter warp-macos --production-test
```

Command behavior:

| Command | Writes status.json | Writes run artifacts | Success output | Failure behavior |
| --- | --- | --- | --- | --- |
| `warp-doctor` | no | capability evidence when explicitly probing | JSON capability report | unavailable on missing permissions/evidence |
| `warp-targets` | no | no | JSON candidate list with redacted fingerprints | exit 1 on invalid role/config |
| `warp-bind-target` | no | binding target metadata/challenge records | JSON target binding result | fail closed on missing/duplicate/stale/ambiguous target |
| `warp-shadow-send` | no | shadow receipt/challenge artifacts only | JSON dispatch result | ambiguous if submit settle is unknown |
| `doctor --adapter warp-macos` | no | no | combines Phase 3 hook and Phase 4 target capability | unavailable when any required capability is missing |
| `run --adapter warp-macos --production-test` | yes, through existing Supervisor only | jobs/attempts/leases/events/receipts | existing run result | Phase 4 allows only fixture/production-test/scratch tasks; real W6 and real project tasks are disabled |

`warp-shadow-send` is a spike/probe command. It must not attach to a real Harness workflow attempt, must not advance stages, and must not be used as evidence for check/advance.

Run gating:

- `run W6-A --adapter warp-macos` must fail in Phase 4 with `warp-macos-production-disabled`.
- `run <real-task> --adapter warp-macos` must also fail unless the task is explicitly marked as a scratch/production-test fixture.
- `--production-test` is accepted only for task ids/configs that are declared scratch and cannot write real review reports, source files, acceptance state, commit checkpoint state, or W6 workflow state.
- Completion-only degraded mode is prohibited in Phase 4. Missing authoritative completion or needs-input capability keeps the adapter unavailable for `run`, even on scratch tasks.
- `doctor --adapter warp-macos` may report `phase5ProductionCandidate: true`, but that does not enable production run in Phase 4.

## 10. Dispatch and Recovery Semantics

Phase 4 inherits Phase 2 uncertain-send semantics.

Allowed terminal classifications:

- `failed-before-dispatch`: helper durable evidence proves no input side effect occurred; retry may be allowed by existing retry rules.
- `dispatch-submitted`: helper reports local submit completion; completion still requires Phase 3 receipt and fresh output.
- `dispatch-uncertain`: helper crash, timeout, ambiguous return, possible partial send, or crash after `dispatching`; no automatic resend.
- `target-unavailable`: missing/stale/duplicate target before side effect.

Recovery rules:

- Restart after `dispatching` with no settled helper result becomes `dispatch-uncertain`.
- Restart after `dispatch-submitted` waits for Phase 3 receipts; it does not infer completion.
- Restart after shadow target challenge ambiguity requires operator reconcile; it cannot repeat the same shadow payload automatically.
- Late helper return cannot overwrite a newer attempt, lease, lockEpoch, or target fingerprint.
- Late completion receipts from superseded attempts are rejected by existing AttemptRef, leaseToken, lockEpoch, binding/session identity, and HMAC proof fencing. Phase 4 does not add target fingerprint proof to workflow receipts; target mismatch fencing applies to pre-dispatch, cancel, recovery, and diagnostics.

## 11. Testing Strategy

All ordinary `pnpm test` coverage must run without Warp, macOS Accessibility permission, or a real GUI. Real local spike tests are opt-in and produce artifacts for manual review.

### 11.1 Fixture helper contract tests

Add tests for:

- unique `work` and `review` target discovery;
- zero target fail-closed;
- duplicate target fail-closed;
- frontmost-only fallback rejected;
- target fingerprint changes between two scans rejected;
- target fingerprint changes between prepare and dispatch rejected;
- title-only target without wrapper binding rejected;
- stale wrapper heartbeat rejected;
- stale capability evidence rejected;
- fixture-only evidence cannot enable real target dispatch or real W6 run;
- target challenge payload and response schema validation;
- expired target challenge rejected;
- target challenge replay rejected;
- target challenge bad proof rejected;
- ambiguous target challenge cannot update target binding;
- target challenge success updates only target binding metadata, not workflow status;
- helper invalid JSON rejected;
- helper crash before side effect returns failed-before-side-effect only when durable `sideEffectState=none` evidence exists;
- helper crash after possible side effect returns dispatch-uncertain;
- helper `input-mutated` maps to dispatch-uncertain;
- helper `unknown` maps to dispatch-uncertain;
- helper `usedClipboard=true` fails closed;
- helper timeout leaves settle ambiguous and blocks retry/not-sent until reconciled;
- no clipboard/pasteboard method is invoked by the helper fixture;
- stale cancel does not send interrupt;
- verified cancel sends interrupt only to matching fingerprint and AttemptRef.

### 11.2 Supervisor integration tests

Add real CLI or store-backed tests for:

- `doctor --adapter warp-macos` unavailable without fresh evidence;
- `run W6-A --adapter warp-macos` always refuses in Phase 4 with `warp-macos-production-disabled`;
- `run <scratch-task> --adapter warp-macos --production-test` refuses when diagnostic capability is unavailable;
- `run <scratch-task> --adapter warp-macos --production-test` uses existing operation recovery and receipt processing when fixture evidence is explicitly marked production-test;
- `run <scratch-task> --adapter warp-macos --production-test` rejects completion-only degraded mode;
- job/attempt/lease capture `adapterIdentity` and dispatch/cancel/recovery validate it;
- dispatch-submitted followed by Phase 3 `job.completed` receipt and fresh output advances exactly once;
- dispatch-submitted followed by `job.needs-input` preserves active refs/lease;
- ambiguous submit enters `dispatch-uncertain` and rejects automatic retry;
- `reconcile sent` continues waiting for same attempt;
- `reconcile not-sent` requires explicit structured evidence and is refused while helper settle is in-flight/unknown;
- takeover fences old attempt and rejects late receipts through AttemptRef/lease/epoch/session fencing.

### 11.3 Opt-in local capability spike

Add an explicitly skipped or separately-invoked script:

```text
pnpm harness warp-doctor W6-A --probe-local --json
```

It may collect:

- Warp app detection;
- Accessibility permission status;
- candidate descriptor fields visible through the helper;
- whether two-scan fingerprint stability is achievable;
- whether non-clipboard input submission is technically possible in a scratch/shadow session;
- whether a target challenge can round-trip to the Phase 3 wrapper/receipt path.

It must not:

- dispatch a real Harness prompt;
- write to project source files;
- approve Claude commands;
- commit/push;
- store terminal transcript or raw nonce.

## 12. Implementation Order

Follow TDD. Do not start with real Accessibility automation.

1. Add Phase 4 fixture helper interfaces and schema validators.
2. Add capability evidence model and `doctor --adapter warp-macos` unavailable-by-default tests.
3. Add target descriptor/fingerprint model and discovery fail-closed tests.
4. Add target binding metadata and target challenge state tests.
5. Add `WarpMacosAdapter` with fixture helper only.
6. Wire `warp-doctor`, `warp-targets`, `warp-bind-target`, and `warp-shadow-send`.
7. Wire `run --adapter warp-macos --production-test` only for declared scratch tasks behind fresh diagnostic capability evidence; keep real W6 and real project tasks disabled.
8. Add dispatch/cancel/uncertain/recovery tests using the fixture helper.
9. Add opt-in local helper spike script after fixture contracts pass.
10. Run full regression and request Code Review before any real W6 pilot.

## 13. Acceptance Criteria

Phase 4 is complete only when:

1. `pnpm test` passes without requiring Warp or macOS Accessibility.
2. `doctor --adapter warp-macos` is unavailable by default without fresh local evidence.
3. Fixture tests prove missing, duplicate, frontmost-only, stale, and changed targets fail closed.
4. Fixture tests prove no clipboard/pasteboard dispatch path is used.
5. Fixture tests prove dispatch cannot occur without wrapper binding, target fingerprint, hook capability, and fresh target challenge.
6. Helper `SubmitResult` tests prove only durable `sideEffectState=none` evidence maps to safe pre-side-effect failure.
7. Ambiguous, input-mutated, unknown, timeout, invalid-json, crash-after-focus, and clipboard outcomes enter `dispatch-uncertain` or fail closed and cannot auto-retry.
8. Cancel cannot affect a stale attempt or an unverified target.
9. Real W6 and real project-task `run --adapter warp-macos` remain disabled in Phase 4.
10. `warp-macos` can be removed without changing Core/Supervisor workflow code.
11. Phase 3 receipt validation remains authoritative for completion and needs-input.
12. No real W6 task is run as part of Phase 4 completion.

## 14. Decisions for Phase 4

1. Helper implementation remains replaceable. Phase 4 may start with fixture helper and optional JXA/local helper spike; production helper choice does not change the adapter contract.
2. Target challenge is fixed as a shadow-only no-op input with `target.challenge` / `target.challenge-response` artifacts. It proves diagnostic target binding only and does not authorize real production dispatch.
3. Completion-only degraded production run is prohibited in Phase 4. Both authoritative completion and needs-input capability must be available even for scratch `--production-test` run.
4. Target metadata is stored on binding records for current state and captured immutably into job/attempt/lease `adapterIdentity` for fencing. Workflow receipts do not carry target proof in Phase 4.

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH4-PLAN-P1-01 | fixed | Phase 4 明确禁止 real W6 / real project production run；`productionEligible` 拆为 `diagnosticEligible`、`phase4RunEnabled`、`phase5ProductionCandidate`；删除 completion-only degraded production run。 | 消除 capability spike 与生产启用混淆，生产运行留到 Phase 5 gate。 |
| V3-PH4-PLAN-P1-02 | fixed | 定义 `target.challenge` / `target.challenge-response` schema、TTL、one-time/replay、proof、artifact path、失败分类，并明确 shadow challenge 只证明诊断 target binding。 | 让 target-to-wrapper challenge 成为可实现、可测试且不授权生产派发的契约。 |
| V3-PH4-PLAN-P1-03 | fixed | 增加 job/attempt/lease `adapterIdentity` 捕获字段与 prepare/dispatch/cancel/recovery/receipt 验证位置；删除 receipt target fingerprint mismatch 承诺。 | 将 target identity 与 Phase 2/3 fencing 结合，同时避免要求 Phase 3 receipt 承载未定义 target proof。 |
| V3-PH4-PLAN-P2-01 | fixed | 定义 helper `SubmitResult` schema 与 `sideEffectState`：`none`、`input-mutated`、`submitted`、`unknown`；只有 durable `none` evidence 可映射 safe pre-side-effect failure。 | 明确 Accessibility side-effect 边界，防止部分输入/未知 settle 被误判为可安全重试。 |
