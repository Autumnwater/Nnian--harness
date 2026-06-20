# HEXAI Review Harness V3 Phase 5 — W6 Pilot Enablement Plan

**Date:** 2026-06-20  
**Status:** Plan for review  
**Baseline:** Phase 4 commit `0bc55e6`  
**Scope:** controlled W6 pilot gate, one low-risk non-delivery work/review stage pair, sequential `work`/`review` worker execution, restart/retry/reconcile validation with real `warp-macos` adapter contracts  
**Out of scope:** broad production rollout, parallel workers, automatic permission approval, automatic delivery acceptance, automatic commit/push/tag, clipboard/frontmost fallback, screen-text/sleep/fresh-output completion inference

## 1. Goal

Phase 5 turns the Phase 4 `warp-macos` capability spike into a narrowly controlled W6 pilot.

The goal is not to make Harness fully autonomous. The goal is to prove that the existing V3 contracts remain correct when one real W6 non-delivery stage uses the real adapter path:

1. dispatch only to verified `work` or `review` Warp targets;
2. completion only through Phase 3 authoritative wrapper receipts;
3. workflow advancement only through the Phase 2 Supervisor CAS path;
4. failure/uncertain states require explicit operator action;
5. manual mode remains the immediate fallback.

The pilot must exercise implementation and review roles sequentially. It must not run delivery, human acceptance, commit checkpoint, push, or tag automatically.

## 2. Approved Boundary

Phase 5 may implement:

- a Phase 5 pilot gate for real W6 `run --adapter warp-macos`;
- a pilot-unit allowlist for one non-delivery W6 work/review stage pair;
- explicit operator confirmation flags for real target dispatch;
- pilot evidence records under `runs/<taskId>/pilot/`;
- sequential work/review orchestration using the existing Supervisor;
- restart, cancel, retry, reconcile, takeover, and late receipt tests against the real adapter contract, using fixture helpers where needed.

Phase 5 must not implement:

- automatic approval of Claude Code tool calls or permission prompts;
- automatic delivery acceptance;
- automatic commit, push, or tag;
- broad real-task production enablement outside the selected pilot stage;
- concurrent worker dispatch for work and review roles;
- fallback to frontmost Warp window or clipboard;
- any completion inference from Warp UI, terminal text, sleeps, notifications, or fresh output alone.

## 3. Preconditions

Before any real W6 pilot run can prepare a job, all of the following must be true inside the task execution lock:

1. status schema is `schemaVersion: 4`;
2. no active job/attempt/lease exists for the task;
3. the selected pilot unit is in the Phase 5 allowlist and its `workStageId`/`reviewStageId` are derived from canonical workflow metadata, current, non-delivery, non-acceptance, non-commit-checkpoint, non-push, and non-tag stages;
4. Phase 4 `warp-macos` capability evidence is fresh and has:
   - `diagnosticEligible: true`;
   - `phase5ProductionCandidate: true`;
   - input submission available with `usesClipboard: false`;
   - target discovery requiring two-scan stability;
5. Phase 3 hook capability evidence is fresh and has both:
   - `completionReceiptCapability: available`;
   - `needsInputCapability: available`;
6. wrapper bindings for required roles are verified, live, and not stale;
7. target bindings for required roles are verified, live, and not stale;
8. allowlist authorization snapshot and binding generation, session id/hash, target fingerprint, target challenge id, and capability evidence id are captured into operation/job/attempt/lease records;
9. operator supplies explicit pilot confirmations.

If any precondition fails, `run --adapter warp-macos --phase5-pilot` must fail before creating a dispatchable attempt.

## 4. Pilot Allowlist

Add a durable allowlist record:

```text
runs/<taskId>/pilot/allowlist.json
```

Example:

```json
{
  "protocolVersion": 1,
  "kind": "phase5.pilot-allowlist",
  "allowlistId": "01J-allowlist",
  "allowlistHash": "sha256:...",
  "taskId": "W6-A",
  "createdAt": "2026-06-20T00:00:00.000Z",
  "createdBy": "operator",
  "allowedPilotUnits": [
    {
      "pilotUnitId": "W6-A-<subtask>-code-pilot",
      "subtaskId": "W6-A-<subtask>",
      "workStageId": "code-implementation",
      "reviewStageId": "code-review",
      "expectedWorkStageRevision": 12,
      "expectedReviewStageRevision": 13,
      "requiresSequentialRoles": true,
      "manualFallbackRequired": true,
      "attemptBudget": {
        "maxPreparedAttemptsPerRole": 3,
        "maxDispatchAttemptsPerRole": 2,
        "maxSubmittedAttemptsPerRole": 1,
        "maxSafeRetryAttemptsPerRole": 1,
        "maxNotSentRetryAttemptsPerRole": 1
      },
      "derivedClassification": {
        "source": "canonical-workflow-metadata",
        "classificationHash": "sha256:...",
        "workStage": {
          "delivery": false,
          "acceptance": false,
          "commitCheckpoint": false,
          "push": false,
          "tag": false,
          "irreversible": false
        },
        "reviewStage": {
          "delivery": false,
          "acceptance": false,
          "commitCheckpoint": false,
          "push": false,
          "tag": false,
          "irreversible": false
        }
      }
    }
  ],
  "expiresAt": "2026-06-21T00:00:00.000Z",
  "reason": "Phase 5 controlled pilot"
}
```

Rules:

- Allowlist records are operator-created and reviewed before use.
- The allowlist expires within 24 hours.
- A stale allowlist cannot authorize dispatch.
- `pilot-allow` must derive stage risk classification from canonical workflow/status metadata. Operator-provided `delivery:false`, `commitCheckpoint:false`, or equivalent free-form flags are ignored and cannot authorize a stage.
- The allowlist stores the derived `classificationHash`; `run`, restart recovery, retry, cancel, reconcile, and takeover must recompute the canonical classification and reject when it drifts.
- The selected pilot unit must be resolved by current subtask, stage cursor, `stageRevision`, and canonical stage order at run time; stale cursor or stage drift fails closed.
- The allowlist cannot include delivery, acceptance, commit checkpoint, push, tag, or any irreversible task.
- Editing the allowlist while an active attempt exists is rejected.

### 4.1 Allowlist Authorization Snapshot

Every dispatchable pilot operation must capture an immutable authorization snapshot into operation, job, attempt, and lease records:

```json
{
  "pilotAuthorization": {
    "allowlistId": "01J-allowlist",
    "allowlistHash": "sha256:...",
    "pilotUnitId": "W6-A-<subtask>-code-pilot",
    "taskId": "W6-A",
    "subtaskId": "W6-A-<subtask>",
    "role": "work",
    "workStageId": "code-implementation",
    "reviewStageId": "code-review",
    "expectedStageId": "code-implementation",
    "expectedStageRevision": 12,
    "expiresAt": "2026-06-21T00:00:00.000Z",
    "attemptBudget": {
      "maxPreparedAttemptsPerRole": 3,
      "maxDispatchAttemptsPerRole": 2,
      "maxSubmittedAttemptsPerRole": 1,
      "maxSafeRetryAttemptsPerRole": 1,
      "maxNotSentRetryAttemptsPerRole": 1
    },
    "derivedClassificationHash": "sha256:...",
    "reasonHash": "sha256:..."
  }
}
```

Fencing rules:

- `prepare` captures the snapshot after re-reading status and allowlist under task lock.
- `dispatch` revalidates the captured snapshot before any helper side effect. Expired allowlist, allowlist hash drift, stage cursor drift, `stageRevision` drift, classification hash drift, or role mismatch returns before side effect.
- `restart recovery` must re-run the same validation before continuing a pre-dispatch operation. If authorization is stale or drifted, it moves the attempt to operator-required failure/uncertain state and never dispatches.
- `retry` revalidates the captured snapshot and the current allowlist. Safe retry cannot extend an expired or drifted authorization.
- `cancel` may still cancel the captured active attempt when AttemptRef/lease/lockEpoch match, but it must not choose a new target when authorization drifted; if target identity cannot be revalidated, it sends no interrupt and reports fail-closed.
- `reconcile` and `takeover` must record whether the original authorization snapshot was stale/drifted at adjudication time. They cannot use a stale snapshot to authorize replacement dispatch.

## 5. CLI Surface

Keep command-first parser compatibility.

### `pilot-doctor <taskId>`

Read-only. Reports:

- status schema and active job state;
- selected pilot allowlist status;
- hook capability freshness;
- warp capability freshness;
- wrapper binding freshness;
- target binding freshness;
- whether `run --adapter warp-macos --phase5-pilot` would be allowed.

It must not write status or artifacts.

### `pilot-allow <taskId> --subtask <subtaskId> --work-stage <stageId> --review-stage <stageId> --roles work,review --reason <text> --expires-at <iso>`

Writes the allowlist under the task execution lock.

Required behavior:

- rejects active attempts;
- rejects delivery/acceptance/commit/push/tag stages;
- derives irreversible flags from canonical workflow/status metadata and ignores operator-provided false flags;
- rejects missing reason;
- rejects expiration longer than 24 hours;
- records audit event.

### `run <taskId> --adapter warp-macos --phase5-pilot --pilot-unit <pilotUnitId> --role work|review --confirm-real-target --confirm-manual-fallback --confirm-no-auto-approval`

Production pilot entry point.

Required behavior:

- without `--phase5-pilot`, real W6 `warp-macos` run remains disabled;
- without all confirmation flags, fail before prepare;
- `role=work` can run only when status cursor is at `workStageId`;
- `role=review` can run only when status cursor is at `reviewStageId` and the work role completion evidence is bound to the same pilot unit;
- both roles use the same Supervisor run loop, receipt inbox, CAS, lease, lockEpoch, and recovery path as Phase 2/3/4;
- delivery acceptance and commit checkpoint still require manual commands.

## 6. Sequential Role and Workflow Semantics

Phase 5 does not put two worker roles under one workflow stage. A pilot unit is a pair of existing canonical workflow stages:

```text
workStageId  ->  reviewStageId  ->  next canonical stage or manual gate
```

`work` and `review` completion both use the existing Phase 2 workflow CAS path:

- `work` dispatches only while `status.currentStage === workStageId`.
- `work` completion applies check evidence and advances status from `workStageId` to `reviewStageId` in one Supervisor status CAS.
- `work` terminal commit clears active refs, releases the matching lease, closes the job/attempt, and records the work output hash.
- `review` dispatches only while `status.currentStage === reviewStageId`, after verifying the committed work evidence.
- `review` completion applies check evidence and advances status from `reviewStageId` to the next canonical stage or manual gate in one Supervisor status CAS.
- Only `review` completion can satisfy the pilot unit and allow later manual delivery/acceptance/commit-checkpoint steps. `work` completion alone never satisfies the pilot unit.

Role progress is an audit/sequencing artifact, not a second source of workflow truth:

```text
runs/<taskId>/pilot/<pilotUnitId>/roles.json
```

Example:

```json
{
  "protocolVersion": 1,
  "kind": "phase5.role-progress",
  "taskId": "W6-A",
  "pilotUnitId": "W6-A-<subtask>-code-pilot",
  "subtaskId": "W6-A-<subtask>",
  "workStageId": "code-implementation",
  "reviewStageId": "code-review",
  "workStageRevision": 12,
  "reviewStageRevision": 13,
  "roles": {
    "work": {
      "state": "completed",
      "jobId": "job-work",
      "attemptId": "attempt-work",
      "leaseToken": "lease-work",
      "completedAt": "2026-06-20T00:00:00.000Z",
      "outputHash": "sha256:...",
      "advancedToStage": "code-review"
    },
    "review": {
      "state": "not-started"
    }
  }
}
```

Rules:

- Role progress is updated only under task execution lock.
- Role progress is advisory evidence for pilot sequencing; status cursor, `stageRevision`, active refs, leases, and Supervisor records remain authoritative.
- `review` requires both `work.state === completed` and current status cursor at `reviewStageId`; the work job/attempt must be terminal, non-stale, and have matching pilot authorization, stage revision, output hash, AttemptRef, and history marker.
- If status advances manually between roles, the stored cursor/revision must be revalidated. Drift fails closed and requires operator reconciliation.
- If role progress and status disagree, status/CAS/fencing wins. Role progress must be rebuilt from committed job/attempt/history markers or marked `inconsistent-needs-operator`.

### 6.1 Role Completion Crash Recovery

Recovery algorithm:

1. Re-read status, role progress, jobs, attempts, leases, and event journal under task lock.
2. If a work job is terminal and status already advanced to `reviewStageId` but role progress is stale, rebuild the work role progress from the committed history marker; do not rerun work.
3. If role progress says work completed but status is still at `workStageId` and no committed workflow history marker exists, treat role progress as incomplete evidence and require pump/replay of the original receipt; do not dispatch review.
4. If status is beyond `reviewStageId` but review role is not terminal, fail closed and require operator reconciliation; do not mark pilot success from role progress alone.
5. If review completion CAS committed but role progress update crashed, rebuild review progress from status history and the terminal review job/attempt.
6. Any rebuild must be idempotent and must not increment stage revision or re-append duplicate workflow history.

Negative invariants:

- work completion must never skip `reviewStageId`;
- review must never dispatch when status is not exactly at `reviewStageId`;
- review completion is the only pilot completion that can satisfy the next manual gate;
- role progress can never advance workflow by itself.

## 6.2 Attempt Budget Semantics

Attempt budget distinguishes prepared attempts, dispatch attempts, and side-effectful submitted attempts.

Counters are maintained per pilot unit and role in role progress:

```json
{
  "attemptCounters": {
    "work": {
      "prepared": 1,
      "dispatchStarted": 1,
      "submitted": 1,
      "safeRetries": 0,
      "notSentRetries": 0
    }
  }
}
```

Rules:

- `prepared` increments when a job/attempt/lease is durably prepared.
- `dispatchStarted` increments when the operation enters dispatching.
- `submitted` increments only when durable helper evidence proves `sideEffectState=submitted` or an operator reconciles an uncertain send as `sent`.
- Safe-before-side-effect retry does not increment `submitted`, but increments `safeRetries` and is capped by `maxSafeRetryAttemptsPerRole`.
- Explicit `not-sent` retry does not increment `submitted`, but increments `notSentRetries` and is capped by `maxNotSentRetryAttemptsPerRole`.
- `dispatch-uncertain` cannot be retried unless reconciled. If reconciled as `sent`, it consumes the single submitted budget; if reconciled as `not-sent`, it may use the not-sent retry budget.
- A second side-effectful submitted attempt for the same pilot unit/role is rejected, even if prepared or dispatch budgets remain.
- All counters update monotonically under task lock using durable dispatch evidence or structured reconcile evidence.

## 7. Dispatch and Receipt Contracts

Phase 5 does not weaken Phase 2–4 contracts:

- adapter dispatch still performs immediate pre-side-effect target two-scan stability;
- submit evidence must match operation id, AttemptRef, candidate fingerprint, and target identity;
- only durable `sideEffectState=none` evidence can produce `failed-before-side-effect`;
- unknown, partial, timed-out, or helper-crash dispatch becomes `dispatch-uncertain`;
- receipt validation still requires AttemptRef, leaseToken, lockEpoch, binding/session identity, live heartbeat, nonce hash, and HMAC proof;
- stale target or binding changes after prepare fail closed before side effect;
- late receipts from old attempts are classified and archived, not applied.

Phase 5 may add pilot diagnostics to events, but must not store raw nonce, HMAC proof, terminal transcript, prompt body, clipboard content, full Accessibility path, or unredacted user content.

## 8. Operator Actions and Fallback

Allowed operator actions during pilot:

- `cancel` current attempt;
- `reconcile sent|not-sent|abandon` for `dispatch-uncertain`;
- `retry` only when protocol proves safe before side effect or after explicit `not-sent`;
- `--takeover --reason` to return to manual mode;
- manual `check`, `advance`, `accept`, and commit checkpoint commands after takeover or normal gate completion.

Rules:

- `dispatch-uncertain` cannot be bypassed by generic takeover into a resend path. It must be reconciled or abandoned.
- `not-sent` still requires structured evidence from Phase 2/4: target static, prompt not visible, prompt not running, no durable submit evidence, reason, and residual risk.
- Manual fallback does not clear audit history or old attempt records.
- A pilot failure must leave enough evidence for review and restart.

## 9. Crash and Restart Recovery

Tests must cover at least:

1. crash after pilot allowlist write;
2. crash after prepare before dispatch;
3. crash after helper reports submitted before receipt;
4. crash after completion receipt before workflow CAS;
5. crash after workflow CAS before role progress update;
6. crash after work role completion before review role dispatch;
7. stale target/binding/capability between prepare and dispatch;
8. late completion after cancel/retry/takeover;
9. lockEpoch increment from stale lock recovery before receipt;
10. restart while run loop waits for needs-input.

Recovery rules:

- status and Supervisor records remain authoritative;
- role progress can be rebuilt from committed job/attempt/history markers;
- no restart path may auto-resubmit an attempt that reached or may have reached dispatching;
- if recovery cannot prove a safe state, it must enter operator-required or dispatch-uncertain.

## 10. Test Plan

Add tests before implementation.

### Unit/contract tests

- allowlist rejects delivery/acceptance/commit stages;
- allowlist derives delivery/acceptance/commit/push/tag classification from canonical workflow metadata and ignores operator-provided false flags;
- allowlist rejects active attempt edits;
- allowlist hash/classification hash drift rejects run before prepare;
- expired allowlist rejects dispatch;
- crash after prepare then allowlist expiration fails before dispatch;
- restart of a pre-dispatch operation with stale allowlist fails closed;
- missing confirmation flags reject before prepare;
- missing Phase 3 completion capability rejects before prepare;
- missing needs-input capability rejects before prepare;
- missing Phase 4 `phase5ProductionCandidate` rejects before prepare;
- stale wrapper binding rejects before prepare/dispatch;
- stale target binding rejects before prepare/dispatch;
- role sequencing rejects review before work completion;
- work completion advances only to `reviewStageId` and never skips review;
- review completion, not work completion, satisfies the pilot unit and later manual gate;
- status/stage revision drift rejects role continuation;
- role progress rebuild from status markers is idempotent.
- safe-before-side-effect retry increments safe retry counter without consuming submitted budget;
- explicit not-sent retry increments not-sent retry counter without consuming submitted budget;
- second side-effectful submitted attempt for a role is rejected;
- dispatch-uncertain retry is rejected until explicit reconcile.

### CLI multi-process tests

- `pilot-doctor` is read-only;
- `pilot-allow` writes under lock and refuses active attempt;
- `run --phase5-pilot --role work` can be cancelled by another process while waiting;
- `run --phase5-pilot --role work` exits on `needs-input` with active refs retained;
- `run --phase5-pilot --role review` refuses until work evidence is present;
- `run --phase5-pilot --role review` refuses after status cursor or `stageRevision` drift;
- restart/pump after receipt applies once;
- stale/late receipts are rejected and archived without blocking other receipts.

### Adapter fixture tests

- pre-dispatch two-scan mismatch sends no input;
- cancel target mismatch sends no interrupt;
- submit evidence mismatch enters uncertain/fail-closed;
- helper crash after possible input becomes dispatch-uncertain;
- durable `none` evidence permits safe retry only once.
- submitted evidence consumes the single submitted budget for that role.

## 11. Implementation Steps

1. Add failing allowlist and pilot-doctor tests.
2. Implement pilot artifact store helpers using existing atomic write/CAS patterns.
3. Implement canonical stage classification derivation and hash validation; do not trust allowlist-provided risk booleans.
4. Add `pilot-doctor` read-only command.
5. Add `pilot-allow` locked write command and audit.
6. Add pilot authorization snapshot capture to operation/job/attempt/lease prepare records.
7. Add pilot preflight and pre-dispatch gates to `run --adapter warp-macos --phase5-pilot`.
8. Add role progress artifact, sequencing checks, and attempt budget counters.
9. Extend Supervisor integration only through existing run loop and adapter interface; do not add a second state machine.
10. Add crash/fault injection coverage for pilot artifacts, allowlist drift/expiration, and role progress rebuild.
11. Run full regression.
12. Request independent Code Review before any real W6 pilot execution.

## 12. Acceptance Criteria

Phase 5 implementation is complete only when:

1. `pnpm test` passes with new pilot unit, CLI, fixture, and crash-restart tests;
2. `pilot-doctor` is read-only and accurately reports unavailable conditions;
3. real W6 `run --adapter warp-macos` still fails unless `--phase5-pilot`, allowlist, capabilities, bindings, and confirmations are all present;
4. the selected pilot unit is a non-delivery, non-irreversible, canonically classified work/review stage pair;
5. allowlist authorization snapshot is captured into operation/job/attempt/lease and revalidated before dispatch, restart recovery, retry, cancel, reconcile, and takeover;
6. work completion advances only to review, and review completion is required before the pilot unit can reach later manual gates;
7. delivery acceptance and commit checkpoint remain manual;
8. all dispatch/cancel side effects remain fenced by AttemptRef, leaseToken, lockEpoch, binding/session identity, target identity, and pilot authorization snapshot;
9. uncertain dispatch cannot be retried without explicit reconcile;
10. attempt budget permits safe retry/not-sent retry only within their separate caps and rejects a second side-effectful submitted attempt per role;
11. restart recovery never auto-resubmits a possibly submitted attempt;
12. manual fallback can resume without losing audit evidence;
13. no Phase 5 code stores raw nonce, HMAC proof, terminal transcript, prompt body, clipboard content, or full Accessibility path;
14. independent Plan Review and Code Review return Approved before real pilot use.
