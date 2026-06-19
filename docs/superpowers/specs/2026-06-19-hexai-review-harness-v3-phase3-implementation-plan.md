# HEXAI Review Harness V3 Phase 3 — Claude Completion Integration Plan

**Date:** 2026-06-19  
**Status:** Plan for review  
**Baseline:** Phase 2 commit `35772fc`  
**Scope:** Claude wrapper/attach handshake, session identity, completion and needs-input receipt integration, shadow/dry-run verification  
**Out of scope:** Warp Accessibility input injection, prompt submission to real Warp panes, automatic command approval, automatic commit/push/tag, Phase 4 macOS target discovery spike

## 1. Goal

Phase 3 connects the Phase 2 Supervisor to an attempt-scoped Claude completion signal without depending on Warp UI automation.

The target outcome is:

1. A worker session can attach with a stable role and session nonce.
2. Completion and needs-input producers can publish receipts that the existing Supervisor accepts only when they match the active attempt, lease, lock epoch, binding, role, and session identity.
3. Missing, duplicate, stale, malformed, mismatched, and late receipts fail closed and remain auditable.
4. Operators can run shadow/dry-run checks before any real Warp input injection exists.

Phase 3 must not make Harness infer completion from terminal UI, screen text, fixed sleeps, file freshness alone, or Warp notifications.

## 2. Approved Boundary

Phase 3 implements the “Claude completion integration” slice from the V3 design:

- wrapper/attach handshake;
- `sessionNonce`;
- challenge-bound local session identity;
- correlated `job.completed`, `job.failed`, and `job.needs-input` receipts;
- diagnostics and shadow/dry-run mode.

Phase 3 does not implement:

- Warp Accessibility target discovery or input injection;
- selecting a Warp pane by title;
- sending prompts to Claude through the adapter;
- automatic permission approval;
- authoritative success from output freshness alone;
- real W6 pilot execution.

If the installed Claude Code hook payload cannot provide the required fields, Phase 3 must stop at degraded/shadow mode. It must not weaken the receipt contract to force production enablement. Hook capability evidence is a Phase 3 prerequisite, not a post-implementation question.

## 3. Current Phase 2 Baseline

Phase 2 already provides:

- task execution lock and lockEpoch fencing;
- schemaVersion 4 status, `stateRevision`, `stageRevision`, and stage cursor CAS;
- durable job/attempt/operation/lease/event/receipt store;
- fake/manual adapters;
- foreground `run` loop with short-lock pump;
- receipt inbox, replay, rejection, and event journal idempotency;
- cancel/retry/reconcile/takeover contracts;
- real CLI fake-adapter multi-process tests.

Phase 3 should reuse these boundaries. It should not add a second workflow state machine or bypass `ExecutionSupervisor.applyReceipt()` / `pumpOnce()`.

## 4. Proposed Components

### 4.1 Wrapper command

Add a command shape equivalent to:

```text
node scripts/harness-worker.js attach \
  --task W6-A \
  --binding work-agent \
  --role work \
  --cwd /absolute/code/repo \
  -- claude
```

The exact executable name may be adjusted to match project conventions, but it must remain separate from core workflow logic.

Responsibilities:

- generate a random `sessionNonce`;
- persist a binding record under `runs/<taskId>/bindings/<bindingId>.json`;
- write the raw nonce only to a local 0600 secret file and the wrapper process environment;
- record role, cwd policy, pid, startedAt, heartbeatAt, protocolVersion, `sessionId`, `bindingGeneration`, and `sessionNonceHash`;
- expose enough local metadata for hooks to construct attempt-scoped receipts;
- optionally launch the child command after binding is written;
- maintain heartbeat while alive;
- mark binding stale or terminal on wrapper exit when possible.

The wrapper must not dispatch prompts and must not interpret Claude output. Raw `sessionNonce` must never be written to ordinary binding records, receipts, event journals, `doctor`/`jobs` diagnostics, or test snapshots.

### 4.2 Binding record

Add durable binding records:

```json
{
  "protocolVersion": 1,
  "bindingId": "work-agent",
  "role": "work",
  "taskId": "W6-A",
  "bindingGeneration": 3,
  "sessionId": "01J-session",
  "sessionNonceHash": "sha256:...",
  "pid": 12345,
  "cwd": "/absolute/code/repo",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "heartbeatAt": "2026-06-19T00:00:05.000Z",
  "state": "active"
}
```

Validation rules:

- role must be one of the configured worker roles;
- one live binding per role unless operator explicitly replaces it under the task lock;
- stale heartbeat invalidates dispatchability but must not mutate workflow state by itself;
- binding replacement increments `bindingGeneration` and creates a new `sessionId`;
- binding replacement is prohibited while any active attempt for the same role/binding exists. It must fail with `active-binding-attempt-conflict`;
- Phase 3 does not provide `--replace-active`. If a live session is lost during an active attempt, the operator must use existing `cancel`, `reconcile`, or `--takeover` flows under the task lock;
- job, attempt, and lease records for wrapper-backed attempts capture `bindingId`, `role`, `bindingGeneration`, `sessionId`, and `sessionNonceHash` at prepare/dispatch time. Receipt validation uses this attempt-captured identity, not whichever binding is current at pump time.

### 4.2.1 Nonce proof contract

The raw nonce is a bearer secret and must not be used as a durable identity field.

Storage and proof rules:

- raw nonce is stored only in `runs/<taskId>/bindings/.secrets/<bindingId>.nonce` with mode `0600`, and optionally in the wrapper child environment;
- ordinary binding JSON stores `sessionId` and `sessionNonceHash`;
- receipt JSON stores `sessionId`, `sessionNonceHash`, and `proof`, never the raw nonce;
- `proof = HMAC-SHA256(rawNonce, canonicalReceiptPayloadWithoutProof)`;
- canonical receipt payload includes at minimum `protocolVersion`, `eventId`, `kind`, `jobId`, `attemptId`, `leaseToken`, `sequence`, `occurredAt`, `bindingId`, `role`, `bindingGeneration`, `sessionId`, `sessionNonceHash`, and event details;
- Supervisor verifies `proof` using the local secret for the attempt-captured `bindingId`/`sessionId`. Missing secret, wrong proof, copied proof on a modified payload, or nonce hash mismatch is rejected before workflow evaluation;
- diagnostics may show `sessionId`, `bindingGeneration`, and a truncated nonce hash, but never the raw nonce or HMAC key material.

### 4.3 Challenge-bound identity

Phase 3 cannot prove Warp Accessibility target identity yet, but it can prove wrapper/session identity.

Introduce a challenge command or store API that:

1. reads a binding;
2. writes a one-time challenge record;
3. requires the wrapper/hook side to answer with an HMAC proof over the challenge using the raw nonce;
4. persists `verifiedAt` and challenge result.

Acceptance for Phase 3 is session-level identity. The Accessibility fingerprint remains Phase 4.

### 4.4 Hook receipt publisher

Add a small receipt publisher utility that can be called by a Claude Code hook or a local fixture:

```text
node scripts/harness-worker.js receipt \
  --task W6-A \
  --binding work-agent \
  --kind job.completed \
  --job <jobId> \
  --attempt <attemptId> \
  --lease-token <leaseToken> \
  --sequence 1
```

The publisher must:

- read the binding record;
- include `protocolVersion`, `eventId`, `kind`, `jobId`, `attemptId`, `leaseToken`, `sequence`, `occurredAt`, `source`;
- include Phase 3 identity fields: `bindingId`, `role`, `bindingGeneration`, `sessionId`, `sessionNonceHash`, and `proof`;
- refuse overwrite;
- write to `receipts/inbox/<attemptId>/<eventId>.json` using the existing atomic receipt path;
- never append directly to the worker event journal.

The Supervisor remains the only event journal writer.

### 4.5 Receipt validation extension

Extend Phase 2 receipt validation to require, when a job/attempt declares a binding identity:

- receipt `bindingId` matches the attempt-captured binding;
- receipt `role` matches job role;
- receipt `bindingGeneration`, `sessionId`, and `sessionNonceHash` match the attempt-captured identity;
- receipt HMAC proof verifies against the local raw nonce secret for that attempt-captured identity;
- stale heartbeat, missing secret, nonce hash mismatch, or invalid proof becomes a stable rejected classification;
- duplicate or late events remain auditable and cannot mutate current state.

Existing Phase 2 receipts without session fields may remain valid for fake adapter tests if the attempt is explicitly fake/manual and does not declare a binding identity. Real wrapper-backed attempts must require the Phase 3 fields.

### 4.6 Needs-input receipt profile

Define authoritative `job.needs-input` receipt categories:

- `permission-request`;
- `agent-question`;
- `authentication-required`;
- `external-intervention`.

Required fields:

- AttemptRef fields;
- binding/session identity fields;
- sequence and occurredAt;
- category;
- summary or reason;
- optional safe diagnostic metadata.

Behavior:

- `needs-input` persists attempt/job state as `needs-input-awaiting-operator` and stops `run` without advancing;
- active status refs and the target lease remain in place;
- `run` returns status `needs-input` with success false / operator action required;
- it does not approve or deny anything;
- repeated needs-input events are idempotent by eventId and monotonic sequence;
- stale or mismatched needs-input receipts are rejected like completion receipts;
- retry is rejected while the attempt is `needs-input-awaiting-operator` because the attempt is still active;
- `cancel` remains allowed with the full AttemptRef and must release only the matching lease;
- `--takeover --reason` remains allowed and fences the old attempt without treating needs-input as success;
- if the same active attempt later emits a valid monotonic `job.completed` receipt, the Supervisor may continue normal receipt processing and gate evaluation. This represents the operator resolving the prompt inside the target manually; Harness still does not approve anything automatically;
- restart preserves `needs-input-awaiting-operator` and does not auto-resume or auto-advance. A later valid receipt or explicit operator command is required.

If authoritative needs-input cannot be validated from local Claude Code hook payloads, `doctor` must report unavailable and production worker mode must remain disabled for that capability.

## 5. CLI Surface

Canonical Phase 3 CLI uses top-level commands because the current parser is command-first. Nested `worker <subcommand>` syntax is not required for Phase 3.

```text
pnpm harness worker-attach W6-A --role work --binding work-agent --cwd <path> --dry-run
pnpm harness worker-bindings W6-A --json
pnpm harness worker-challenge W6-A --binding work-agent
pnpm harness worker-receipt W6-A --binding work-agent --kind job.completed --attempt <id> ...
pnpm harness doctor W6-A --adapter fake
```

Existing Phase 2 commands remain unchanged: `doctor`, `run`, `pump`, `jobs`, `retry`, `cancel`, and `reconcile`.

Optional aliases may be added later, but tests and documentation for Phase 3 use only the canonical top-level commands above.

Command behavior:

| Command | Writes status.json | Writes run artifacts | Success output | Failure behavior |
| --- | --- | --- | --- | --- |
| `worker-attach --dry-run` | no | no | JSON preview with `bindingId`, `role`, `sessionId`, `sessionNonceHash`, `wouldWrite: false` | exit 1 on invalid args |
| `worker-attach` | no | binding + secret + heartbeat | JSON binding summary without raw nonce | exit 1 on duplicate live binding or active attempt conflict |
| `worker-bindings` | no | no | JSON list with status/heartbeat age, no raw nonce/proof | exit 1 on invalid task |
| `worker-challenge` | no | challenge record / verification record | JSON challenge result | exit 1 on missing/stale binding or bad proof |
| `worker-receipt` | no | immutable receipt inbox file | JSON receipt path and eventId, no raw nonce | exit 1 on missing binding, bad capability, invalid args, overwrite |
| `doctor` / `jobs` | no | no | existing JSON extended with capability/binding diagnostics | existing failure behavior |

`--dry-run` must:

- validate arguments;
- show the binding record that would be written;
- not launch Claude;
- not write status;
- not create active jobs.

## 6. Shadow / Dry-run Test Strategy

Phase 3 validation must run before real Warp dispatch:

1. Start from a clean task run.
2. Create a fake active attempt through existing Phase 2 fake adapter path.
3. Attach or simulate wrapper binding for the attempt role.
4. Publish a completion receipt through the Phase 3 publisher.
5. Pump and verify existing Phase 2 gates still govern advancement.
6. Repeat with mismatched nonce, role, binding, leaseToken, attemptId, stale lockEpoch, duplicate sequence, late old attempt, and malformed payload.

The test proves receipt identity and replay. It does not prove real Warp target discovery or prompt submission.

## 7. Implementation Steps

### Step 0 — Hook payload capability probe

- Add a read-only capability probe that captures or validates the locally installed Claude Code hook payload shape without launching an irreversible worker task.
- Record evidence under `runs/<taskId>/capabilities/claude-hook.json` or an equivalent inspected artifact with hook source/version, observed fields, capture time, and missing required fields.
- Required completion capability fields: event kind, attempt/job identifiers or a safe way for the wrapper to inject them, occurredAt-equivalent timestamp, and a hook phase that means Claude has actually finished the attempt.
- Required needs-input capability fields: a hook phase or event source that can distinguish permission request, agent question, authentication required, or external intervention. If this cannot be proven, `needsInputCapability = unavailable`.
- `doctor` must derive `completionReceiptCapability` and `needsInputCapability` from this evidence, not from fixture tests alone.
- If capability evidence is missing, stale, or incompatible, wrapper-backed production run fails closed and only fixture/shadow mode is allowed.
- Add negative tests for unavailable payload, missing AttemptRef/binding/session fields, missing needs-input category source, and payload version drift.

### Step 1 — Binding store and schema

- Add binding read/write/list helpers to `ExecutionStore`.
- Add stable validation for binding records.
- Add tests for atomic write, raw nonce secret mode, raw nonce absence from ordinary records, stale heartbeat detection, duplicate live role handling, active-attempt replacement conflict, and replacement fencing.

### Step 2 — Wrapper attach skeleton

- Add wrapper attach command in a separate worker-facing script or module.
- Implement `--dry-run`.
- Implement real binding write and heartbeat for a no-child fixture mode.
- Add tests that wrapper exit or stale heartbeat does not mutate workflow state.

### Step 3 — Receipt publisher

- Implement receipt publisher utility using existing immutable inbox semantics.
- Include binding/session identity fields and HMAC proof.
- Add create/publish tests for completion, failure, and needs-input receipts.
- Add tests that raw nonce never appears in receipt JSON, event JSONL, `doctor`, `jobs`, or binding diagnostics.

### Step 4 — Supervisor validation extension

- Persist attempt-captured `bindingId`, `role`, `bindingGeneration`, `sessionId`, and `sessionNonceHash` during prepare/dispatch for wrapper-backed attempts.
- Extend receipt validation/application with binding identity and HMAC proof checks when required by the attempt.
- Add stable rejected reasons:
  - `binding-mismatch`;
  - `role-mismatch`;
  - `binding-generation-mismatch`;
  - `session-id-mismatch`;
  - `session-nonce-hash-mismatch`;
  - `session-proof-invalid`;
  - `session-secret-unavailable`;
  - `binding-stale`;
  - `needs-input-invalid-category`.
- Ensure invalid receipts never block other inbox events.

### Step 5 — Doctor and diagnostics

- Extend `doctor` and `jobs` output with binding status:
  - active/stale/missing;
  - role;
  - heartbeat age;
  - needsInputCapability;
  - completionReceiptCapability.
- No diagnostic command should write `status.json`.

### Step 6 — Shadow E2E

- Add real CLI tests that run Phase 2 fake adapter plus Phase 3 receipt publisher.
- Cover:
  - valid completion receipt advances only with fresh output;
  - completion without fresh output stops at check-blocked;
  - fresh output without receipt does not advance;
  - needs-input stops run with active refs and lease preserved;
  - mismatched proof/nonce hash/role/binding rejected;
  - copied proof on a modified payload rejected;
  - late old-attempt completion rejected;
  - duplicate event/sequence stable replay;
  - CLI restart between publish and pump.

## 8. Negative Tests Required Before Implementation Approval

The implementation must include tests for:

1. title/binding name alone cannot authorize a receipt;
2. stale heartbeat cannot complete an active attempt;
3. raw nonce is absent from binding JSON, receipt JSON, event journal, doctor/jobs output, and test snapshots;
4. role mismatch (`work` receipt for `review` job) rejected;
5. missing Phase 3 identity fields rejected for wrapper-backed attempts;
6. fake/manual attempts remain compatible with Phase 2 receipt fixtures;
7. `job.needs-input` with invalid category rejected;
8. duplicate `job.completed` with same eventId and different payload rejected as collision;
9. late completion from superseded attempt remains rejected;
10. restart after receipt publish but before pump applies exactly once;
11. wrapper dry-run writes no state;
12. binding diagnostics are read-only.
13. wrong HMAC proof is rejected and does not block a later valid receipt;
14. copying an old proof to a new event or modified payload is rejected;
15. active attempt prevents binding replacement for the same role/binding;
16. old binding receipt and new binding receipt are classified by attempt-captured identity, not current binding state;
17. unavailable/missing/drifted hook payload capability keeps wrapper-backed production run disabled;
18. needs-input keeps active refs and lease, rejects retry, allows fenced cancel/takeover, and accepts a later valid sequence+1 completion for the same active attempt.

## 9. Recovery Rules

- Wrapper restart creates a new `bindingGeneration`, `sessionId`, and nonce. Old receipts are evaluated against the attempt-captured identity, not the new current binding.
- Missing binding for a wrapper-backed attempt stops as `binding-unavailable`, not success.
- Stale heartbeat stops as `binding-stale`, not success.
- Binding replacement is rejected while an active attempt for that binding/role exists. If the operator wants to continue manually, they must use `cancel`, `reconcile`, or `--takeover`.
- Hook/publisher crash before atomic receipt rename produces no event.
- Hook/publisher crash after atomic receipt rename is replayed by the next pump.
- Supervisor crash after accepting a receipt follows existing Phase 2 receipt application recovery.
- Needs-input survives restart as durable receipt/evidence with active refs/lease preserved and does not auto-resume. A later valid completion receipt for the same active attempt may continue processing; otherwise operator action is required.
- Capability evidence missing or version-drifted after restart keeps wrapper-backed production runs disabled until the read-only probe is refreshed.

## 10. Acceptance Criteria

Phase 3 is complete only when:

1. read-only Claude hook payload capability probe records evidence and `doctor` derives capability status from it;
2. wrapper/attach can create a durable binding with `sessionId`, `bindingGeneration`, nonce hash, 0600 nonce secret, and heartbeat;
3. receipt publisher writes immutable attempt-scoped receipts with binding/session identity and HMAC proof;
4. raw nonce never appears in ordinary durable records, receipts, event journal, or diagnostics;
5. job/attempt/lease capture binding generation/session identity at prepare/dispatch time;
6. binding replacement during active attempt fails closed or requires existing fenced operator flows; it never silently changes active attempt identity;
7. Supervisor validates Phase 3 identity fields and HMAC proof for wrapper-backed attempts;
8. valid completion + fresh output can advance through the existing Phase 2 workflow;
9. completion without fresh output and fresh output without completion cannot advance;
10. needs-input persists `needs-input-awaiting-operator`, keeps active refs/lease, stops automation, and does not approve anything;
11. stale/mismatched/late/duplicate receipts are rejected and auditable;
12. CLI restart and pump replay apply accepted receipts exactly once;
13. doctor/jobs expose binding capability and status without writing state or secrets;
14. all Phase 1/2 tests remain green;
15. no Warp Accessibility input injection exists in this phase;
16. wrapper-backed production enablement remains disabled if local Claude hook payload capability is not proven.

## 11. Fixed Protocol Decisions

1. Raw `sessionNonce` is never stored in ordinary JSON records or diagnostics. It is stored only in a 0600 secret file and wrapper environment; receipts carry hash + HMAC proof.
2. Binding replacement during an active attempt is fail-closed in Phase 3. There is no silent replacement and no Phase 3 `--replace-active` shortcut.
3. Real Claude Code hook payload discovery is Step 0 and must produce read-only capability evidence before wrapper-backed production paths are enabled.

## 12. Proposed Verification Commands

```text
node --test tests/execution-store.test.js tests/execution-supervisor.test.js tests/workflow-core.test.js
node --test --test-name-pattern='V3 Phase 3' tests/harness.test.js
pnpm test
node --check scripts/harness.js
node --check scripts/execution-supervisor.js
node --check scripts/execution-store.js
node --check scripts/workflow-core.js
git diff --check
```

## 13. Rollback / Fallback

If Phase 3 capability checks fail:

- keep schemaVersion 4 and Phase 2 fake/manual worker behavior;
- leave `execution.mode = manual` by default;
- report `completionReceiptCapability = unavailable`;
- do not enable wrapper-backed production worker runs;
- proceed only with manual or fake adapter until capability gaps are resolved.

## 14. Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH3-PLAN-P1-01 | fixed | 明确 raw nonce 仅存 0600 secret/env；binding/receipt/event/diagnostics 只用 `sessionId`、`sessionNonceHash` 和 HMAC proof；补充错误 proof、复制 proof、raw nonce 不落盘测试。 | session proof 不能作为实现时开放问题，必须先收敛为可测试安全契约。 |
| V3-PH3-PLAN-P1-02 | fixed | 明确 job/attempt/lease 捕获 `bindingGeneration`、`sessionId`、`sessionNonceHash`；active attempt 期间 binding replacement fail-closed；receipt 按 attempt-captured identity 验证。 | 防止 current binding 替换导致旧/新 session 错误完成 active attempt。 |
| V3-PH3-PLAN-P1-03 | fixed | 增加 Step 0 read-only hook payload capability probe；doctor 基于 evidence 输出能力；缺字段/版本漂移时 wrapper-backed production run fail-closed，仅允许 fixture/shadow。 | fixture publisher 不能替代真实 hook payload 能力证明。 |
| V3-PH3-PLAN-P1-04 | fixed | 定义 `needs-input-awaiting-operator` 状态：保留 active refs/lease、run 返回需人工、retry 拒绝、cancel/takeover 明确、sequence+1 completion 可继续。 | needs-input 不是 terminal success，也不能清 active refs 或自动恢复。 |
| V3-PH3-PLAN-P2-01 | fixed | 明确 canonical CLI 为 top-level `worker-attach`/`worker-bindings`/`worker-challenge`/`worker-receipt`；列出写入边界、exit code 和 JSON 输出要求；Phase 2 命令保持不变。 | 与现有 command-first parser 兼容，避免实现阶段 CLI 形态不确定。 |
