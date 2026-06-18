# HEXAI Review Harness V3 — Worker/Adapter Design

**Date:** 2026-06-18  
**Product version:** V3 (design only)  
**Baseline:** tag `2.4` / commit `a7af647`  
**Status:** Revised draft for re-review (Changes Required addressed)

## 1. Decision Summary

V3 adds automatic prompt dispatch and completion collection without moving terminal-specific behavior into the Harness core.

The core remains a deterministic workflow engine. It creates a job, records the output baseline, dispatches the job through a versioned worker protocol, waits for a terminal event, then runs the existing `check → advance` gates. A worker adapter controls the execution surface.

All state-changing operations are serialized by a task-level execution lock and guarded by a stage cursor compare-and-swap (CAS). Worker events, freshness evidence, gate results, and advancement must reference the same active attempt and fencing token. Global audit writes use `stateRevision`; workflow cursor changes use a separate `stageRevision` so ordinary worker events do not invalidate a valid stage CAS.

The first production target is a macOS Warp adapter bound to two named Claude Code sessions:

- `work` — implementation and fix stages
- `review` — review and delivery stages

Warp UI automation is an adapter detail. The core must also work with a fake adapter, a manual adapter, and a future PTY or cloud adapter.

V3 does **not** automate manual acceptance, command approval, commit, push, or the delivery commit checkpoint.

## 2. Evidence and Constraints

Warp's current official documentation establishes these supported surfaces:

- [Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs/) can define a tab title, working directory, startup commands, pane type, and initial focus. A config can be opened through `warp://tab_config/<name>`.
- [Launch Configurations](https://docs.warp.dev/terminal/sessions/launch-configurations/) are legacy; new setups should use Tab Configs.
- [Claude Code in Warp](https://docs.warp.dev/agent-platform/cli-agents/claude-code/) is auto-detected and supports notifications, rich input, code review, Tab Configs, and Remote Control.
- [Remote Control](https://docs.warp.dev/agent-platform/cli-agents/remote-control/) supports human monitoring and steering of a published session.
- The public [Oz Agent API](https://github.com/warpdotdev/docs/blob/main/developers/agent-api-openapi.yaml) creates and manages cloud agent runs; it is not an API for injecting input into an existing local Warp tab.

The reviewed official documentation does not expose a supported local API for selecting an existing Warp tab by title and programmatically submitting terminal input. Therefore:

1. Warp target discovery and input injection are experimental adapter capabilities.
2. Completion must not be inferred by screen scraping or arbitrary sleep intervals.
3. V3 must retain manual mode when Accessibility permissions, target discovery, or hooks are unavailable.

## 3. Goals

1. Remove routine prompt copy/paste between the Harness window and A/B Claude Code windows.
2. Remove routine manual `step` after a worker finishes.
3. Preserve every V2.4 gate, freshness rule, mirror rule, acceptance gate, and commit checkpoint.
4. Recover safely after Harness, worker, Warp, or Claude Code restarts.
5. Prevent duplicate dispatch and cross-window prompt delivery.
6. Keep terminal automation replaceable through a small protocol.

## 4. Non-goals

- Replacing the existing workflow state machine.
- Automatically approving Claude Code tool calls or permission prompts.
- Automatically recording manual delivery acceptance.
- Automatically committing, pushing, tagging, or confirming a commit checkpoint.
- Parsing agent conclusions from terminal pixels.
- Making Warp a required dependency for `next`, `check`, `advance`, or manual `step`.
- Adopting Oz cloud runs in the first V3 release.

## 5. Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ Harness Core                                             │
│ state machine · prompt render · freshness · gates        │
└──────────────────────┬───────────────────────────────────┘
                       │ Worker Protocol v1
┌──────────────────────▼───────────────────────────────────┐
│ Worker Supervisor                                       │
│ lease · idempotency · event journal · timeout · recovery │
└───────────────┬──────────────────────┬───────────────────┘
                │                      │
     ┌──────────▼──────────┐  ┌────────▼─────────┐
     │ warp-macos adapter  │  │ manual/fake/PTY  │
     │ target + input only │  │ adapters         │
     └──────────┬──────────┘  └──────────────────┘
                │
     ┌──────────▼──────────────────────────────────────────┐
     │ Warp tabs: work / review                            │
     │ Claude Code + completion hook/receipt               │
     └─────────────────────────────────────────────────────┘
```

### Core ownership

The core exclusively owns:

- current stage and subtask
- prompt generation
- output baseline capture
- gate checks and conditional branches
- stage advancement
- delivery acceptance and commit checkpoint
- task-level execution lock, monotonic `stateRevision`/`stageRevision`, and stage cursor CAS

### Worker ownership

The worker exclusively owns:

- target discovery and health checks
- dispatch transport
- one active lease per target
- completion, failure, and needs-input events
- restart recovery for in-flight jobs
- attempt fencing and immutable receipt ingestion

The worker cannot mark a Harness stage complete or call `advance` directly. It can only publish attempt-scoped evidence. Core advancement is a separate CAS-protected transaction.

### Adapter ownership

An adapter translates worker operations into an execution surface. `warp-macos` may use macOS Accessibility APIs to focus the configured Warp target and submit input, but no Warp-specific selector or UI action may appear in core modules.

## 6. Worker Protocol v1

The protocol is transport-neutral. The local implementation uses append-only JSONL event files and atomic JSON job files so it remains inspectable and restart-safe.

The supervisor is the only JSONL event writer. Hooks and adapters publish atomic receipt files; the supervisor validates and converts those receipts into journal events. This avoids unsafe multi-process appends.

### Job envelope

```json
{
  "workerProtocolVersion": 1,
  "jobId": "W6-A:W6-A-04:implementation-plan:1:01J...",
  "attemptId": "01J...",
  "taskId": "W6-A",
  "subtaskId": "W6-A-04",
  "stage": "implementation-plan",
  "round": 1,
  "expectedStageRevision": 12,
  "role": "work",
  "targetBinding": "warp.work",
  "leaseToken": "01J...:7",
  "promptPath": "/absolute/path/to/prompt.md",
  "promptSha256": "...",
  "primaryReportPath": "/absolute/path/to/report.md",
  "outputBaseline": { "exists": true, "size": 10, "sha256": "..." },
  "createdAt": "...",
  "timeoutMs": 7200000
}
```

The worker reads prompt content from `promptPath` and verifies `promptSha256`. Large prompt text is not duplicated into `status.json`.

### Required adapter interface

```ts
interface WorkerAdapter {
  capabilities(): Promise<AdapterCapabilities>;
  discoverTargets(): Promise<TargetDescriptor[]>;
  health(target: TargetDescriptor): Promise<HealthResult>;
  dispatch(job: WorkerJob, target: TargetDescriptor): Promise<DispatchTransportResult>;
  cancel(attempt: AttemptRef, target: TargetDescriptor): Promise<CancelResult>;
}

interface AttemptRef {
  jobId: string;
  attemptId: string;
  leaseToken: string;
}
```

Completion is reported through worker events, not through a blocking adapter call.

Before sending an interrupt to the target, `cancel` must verify that all fields in `AttemptRef` match the target's currently bound active attempt. A cancel for a stale or superseded attempt returns `stale-attempt` and must not send Ctrl-C, close the pane, or otherwise affect the current attempt.

### Event types

- `job.queued`
- `target.resolved`
- `job.dispatch-prepared`
- `job.dispatching`
- `job.dispatch-submitted`
- `job.dispatch-uncertain`
- `job.running`
- `job.needs-input`
- `job.completed`
- `job.failed`
- `job.timed-out`
- `job.cancelled`

Every event contains `eventId`, `jobId`, `attemptId`, `timestamp`, `source`, and optional structured details. Consumers deduplicate by `eventId`.

### Idempotency

- `jobId` identifies one logical stage execution.
- `attemptId` identifies one dispatch attempt.
- Re-invoking dispatch for an attempt at or beyond `dispatching` returns its current state without submitting input again.
- Retry creates a new `attemptId` while preserving the job history.
- A target holds at most one unexpired lease.

## 7. Execution Lock, Fencing, and Stage CAS

### Task-level execution lock

Every state-changing Harness command acquires `runs/<taskId>/execution.lock` before reading the mutable state it intends to change. The lock record contains `ownerId`, `pid`, `acquiredAt`, `heartbeatAt`, and a monotonic `lockEpoch`.

Commands covered by the lock include `next`, `step`, `advance`, `accept`, `init`, `import`, `resume`, `set-current`, `interrupt`, `retry`, `cancel`, and worker event application. Read-only status commands do not acquire the write lock.

When an active non-terminal job exists, manual state-changing commands fail with `active-job-conflict`. They must not regenerate a baseline, run a gate, or advance the stage.

### Manual `--takeover`

A conflicting manual command may use `--takeover --reason "..."`. Takeover is an explicit fenced state transition performed under the task lock:

1. increment `lockEpoch` and issue a new task fencing token;
2. mark the old attempt `superseded` and revoke its target lease;
3. record the operator, reason, old attempt, and new epoch in history;
4. re-read state and revalidate the requested command from scratch;
5. execute only if its normal preconditions still pass.

Takeover never treats an old completion as success, never deletes receipts, and never bypasses `check`, acceptance, or the commit checkpoint. `advance --takeover` must run a new attempt-scoped check after fencing; it cannot reuse the superseded attempt's check result.

### Attempt and lease fencing

Every dispatch receives an unpredictable `attemptId` and `leaseToken = <attemptId>:<lockEpoch>:<random>`. All target acknowledgements, completion receipts, check evidence, and cancel events must carry both values.

Events with an old epoch, a revoked lease token, or a non-active attempt are recorded as `stale` for audit but cannot change current state.

Cancellation uses the same fencing twice. Under the task lock, Supervisor resolves the requested `attemptId` and verifies its `leaseToken` against the active attempt before invoking the adapter. Immediately before any target-side interrupt, the adapter repeats that check against the bound target session. A mismatch at either layer returns `stale-attempt` with no side effect. Repeating cancel for an already terminal attempt is idempotent and also sends no interrupt.

### Stage cursor CAS

The authoritative stage cursor is:

```json
{
  "subtaskId": "W6-A-04",
  "stage": "implementation-plan",
  "round": 1,
  "stageRevision": 12,
  "activeAttemptId": "01J..."
}
```

Every persisted mutation increments `stateRevision`. Only changes to subtask, stage, round, active attempt, baseline, or gate evidence increment `stageRevision`. Worker progress events do not increment `stageRevision`. Before advancing, the core compares the current stage cursor to the job's expected cursor and the check evidence. Advancement is rejected if any field differs.

`step` may reuse one check result only when that result contains the same cursor, `attemptId`, `leaseToken`, and primary artifact SHA-256 observed by `advance`.

## 8. Dispatch Delivery and Uncertain-send Adjudication

The UI transport cannot provide a true atomic send-and-receipt operation. V3 therefore does not claim exactly-once delivery across the crash window.

The V3 Warp adapter does not claim that its Wrapper or completion Hook can intercept a Prompt before Claude processes it. Target-side pre-processing deduplication is explicitly outside the approved design unless a later capability spike proves such a mechanism.

### Dispatch transaction

1. Persist `dispatch.prepared` with prompt hash, attempt, lease token, and target binding.
2. Immediately before invoking Accessibility input submission, persist `dispatching` for the attempt.
3. Submit an envelope containing those identifiers to the verified target.
4. If the Accessibility call returns normally, persist `dispatch-submitted`. This is a local transport result, not proof that Claude accepted or processed the Prompt.
5. Later completion/needs-input Hooks provide attempt-scoped execution evidence, but they do not retroactively make the send atomic.

Automatic retry is allowed only for a failure proven to occur before `dispatching` was persisted. Once an attempt reaches `dispatching`, neither restart recovery nor retry may submit that Prompt again automatically.

If the adapter or supervisor crashes while the attempt is `dispatching`, or if the Accessibility call returns an ambiguous result, the attempt enters `dispatch-uncertain`. Recovery may inspect receipts and target state for operator context, but absence of a receipt is not proof that the Prompt was not sent.

An operator must resolve `dispatch-uncertain` explicitly:

- `reconcile --decision sent` — keep the same fenced attempt and wait for its completion/needs-input evidence;
- `reconcile --decision not-sent --reason "..."` — allowed only after the operator verifies the bound target is quiescent and the Prompt is neither visible nor running; supersede and fence the uncertain attempt, record that evidence and residual risk, then permit creation of a new attempt;
- `reconcile --decision abandon --reason "..."` — fence the attempt and return control to manual mode without dispatching a replacement.

No decision is inferred from timeouts, missing receipts, UI text, or output freshness. When the operator cannot prove `not-sent`, the only safe choices are `sent` or `abandon`; a replacement attempt remains prohibited. This contract guarantees no **automatic** duplicate dispatch by stopping for human adjudication; it intentionally does not guarantee exactly-once processing.

## 9. Attempt/Event Receipt Inbox

`receipts/<jobId>.json` is not used. Producers publish one immutable file per event:

```text
runs/<taskId>/receipts/inbox/<attemptId>/<eventId>.json
runs/<taskId>/receipts/processed/<attemptId>/<eventId>.json
runs/<taskId>/receipts/rejected/<attemptId>/<eventId>.json
```

Receipt creation uses a temporary file plus atomic rename and refuses overwrite. A receipt contains `protocolVersion`, `eventId`, `jobId`, `attemptId`, `leaseToken`, `sessionNonce`, `kind`, `sequence`, `occurredAt`, and event-specific data.

The supervisor is the only event-journal writer. It validates identity, fencing, schema, and monotonic sequence before moving a receipt to `processed`. Duplicate, malformed, mismatched, revoked, or late receipts move to `rejected` with a reason and remain auditable.

Multiple attempts and multiple events can coexist safely. A late receipt for an older attempt never overwrites or completes the active attempt.

## 10. Completion Contract

`warp-macos` must use two independent signals bound to the same active attempt:

1. A Claude Code completion receipt carrying the active `jobId`, `attemptId`, `leaseToken`, and `sessionNonce`.
2. A Harness freshness check whose evidence carries the same `attemptId`, `leaseToken`, expected stage cursor, baseline hash, and resulting primary output hash.

Neither signal is sufficient alone. A hook without fresh output stops at `check`; fresh output without a matching completion event remains `running` until timeout or operator intervention.

On a passing check, core creates immutable `checkEvidence`:

```json
{
  "attemptId": "01J...",
  "leaseToken": "01J...:7:...",
  "expectedCursor": {
    "subtaskId": "W6-A-04",
    "stage": "implementation-plan",
    "round": 1,
    "stageRevision": 12
  },
  "baselineSha256": "...",
  "primarySha256": "...",
  "completionEventId": "01J...",
  "passed": true
}
```

`advance` accepts only this evidence, re-hashes the primary artifact, and performs the stage cursor CAS under the task lock. Evidence from different attempts cannot be combined, even when paths and stage names match.

Screen text, spinner state, notification text, and fixed delays are not completion signals.

For reliable correlation, the recommended Warp Tab Config starts Claude Code through a thin session wrapper:

```text
harness-worker attach --role work -- claude
harness-worker attach --role review -- claude
```

The wrapper exports the role/binding metadata and installs or validates the completion hook. An already-running unwrapped Claude session is supported only through an explicit bootstrap handshake and is not the default production path.

## 11. Wrapper Session and Warp Target Identity Chain

Tab title alone is not an identity. Binding requires a challenge-response chain:

1. `harness-worker attach` generates a random `sessionNonce` and starts a local authenticated control endpoint.
2. The wrapper registers `bindingId`, role, PID, TTY, cwd, Claude session identifier when available, and a heartbeat signed with the session nonce.
3. The Warp adapter resolves a candidate Accessibility target by configured window/tab metadata.
4. During explicit bind/bootstrap, the adapter sends a one-time challenge to that candidate.
5. Only the wrapper reached through that target can return the challenge with its `sessionNonce` through the receipt inbox.
6. The supervisor persists the verified relation: `bindingId ↔ sessionNonce ↔ wrapper identity ↔ Accessibility fingerprint`.

The Accessibility fingerprint contains only stable observable identifiers available in the local spike; it must not assume that Warp exposes its Tab Config `paneId`. Before dispatch, the adapter checks wrapper heartbeat, role, cwd policy, session nonce, and target fingerprint. Any mismatch invalidates the binding and requires rebind.

`work` and `review` must have distinct live session nonces. A title match without a valid wrapper challenge is never dispatchable.

## 12. Warp Adapter Design

### Target configuration

```json
{
  "execution": {
    "mode": "worker",
    "adapter": "warp-macos",
    "bindings": {
      "work": { "tabTitle": "work", "wrapperBindingId": "work-agent" },
      "review": { "tabTitle": "review", "wrapperBindingId": "review-agent" }
    }
  }
}
```

Role-to-target mapping is workflow configuration, not a hard-coded `if stage then Warp tab` branch.

`wrapperBindingId` is a Harness identity established by the attach handshake. The design does not assume Warp exposes its Tab Config pane ID through macOS Accessibility.

### Dispatch sequence

1. Run adapter preflight.
2. Resolve exactly one target matching the configured metadata.
3. Verify the target's challenge-bound wrapper identity and current `sessionNonce`.
4. Acquire a fenced target lease.
5. Verify the target is a Claude Code session and is ready for input.
6. Submit a dispatch envelope plus prompt content.
7. Persist the local submission result or enter `dispatch-uncertain` when the result is ambiguous.
8. Wait for matching completion/hook events only after a non-ambiguous submission or an operator `sent` decision.
9. Release the lease after terminal state.

If zero or multiple targets match, dispatch fails closed and prints a repair command. It must never choose the frontmost Warp tab as a fallback.

### Preflight requirements

- Warp installed and running.
- macOS Accessibility permission granted to the worker process.
- Unique `work` and `review` bindings.
- Claude Code completion integration available.
- No active lease for the target.
- Configured code and review paths exist.

### Tab provisioning

V3 should provide example Warp Tab Config files with stable titles, directories, pane IDs, and wrapper startup commands. Opening them may use the documented `warp://tab_config/<name>` URI. Provisioning is optional; target control still remains in the adapter.

## 13. `needs-input` Signal and Degraded Behavior

Authoritative `job.needs-input` events come from the attached Claude Code integration and must carry the active attempt fencing and identity fields. Supported categories are:

- `permission-request` — tool or command approval is required;
- `agent-question` — Claude explicitly requests operator input;
- `authentication-required` — login or credential interaction is required;
- `external-intervention` — an integration reports a blocking condition it cannot classify.

Warp desktop notifications and Accessibility text are advisory only. They may cause `attention-unknown`, which pauses observation, but they cannot create an authoritative needs-input event or approve anything.

If the installed Claude Code version cannot provide a validated needs-input hook, `worker doctor` reports `needsInputCapability = unavailable`. The adapter may then run only in degraded mode when explicitly enabled. In degraded mode:

- no automatic permission handling occurs;
- worker completion is still subject to the normal completion receipt;
- silence ends in `timed-out` or `attention-unknown`, never success;
- the operator must inspect the target and resume/retry explicitly.

Production enablement requires authoritative needs-input support. Degraded mode is limited to capability spikes and manual fallback.

## 14. Harness Commands

Existing V2.4 commands remain compatible.

New commands:

```text
pnpm harness worker doctor W6-A
pnpm harness worker bind W6-A --role work --target warp.work
pnpm harness worker bind W6-A --role review --target warp.review
pnpm harness run W6-A
pnpm harness jobs W6-A
pnpm harness retry W6-A --job <jobId>
pnpm harness cancel W6-A --attempt <attemptId>
pnpm harness reconcile W6-A --attempt <attemptId> --decision <sent|not-sent|abandon> [--reason "..."]
pnpm harness step W6-A --takeover --reason "人工接管原因"
```

`run` performs:

```text
next → dispatch → wait for worker completion → check → advance
```

It stops on:

- target ambiguity or adapter failure
- `dispatch-uncertain` pending reconciliation
- needs-input or permission request
- timeout
- gate failure
- manual delivery acceptance
- commit checkpoint
- operator cancellation

`step` remains available for manual operation and does not require a worker.

## 15. State and Storage

Product V3 introduces `schemaVersion: 4` for `status.json`. This is an internal storage version, not the product version.

New optional state:

```json
{
  "schemaVersion": 4,
  "stateRevision": 42,
  "stageRevision": 12,
  "execution": {
    "mode": "manual",
    "activeJobId": null,
    "activeAttemptId": null,
    "activeLeaseToken": null,
    "lockEpoch": 7,
    "lastJobId": null
  }
}
```

Runtime files:

```text
runs/<taskId>/jobs/<jobId>.json
runs/<taskId>/attempts/<attemptId>.json
runs/<taskId>/events/worker.jsonl
runs/<taskId>/leases/<binding>.json
runs/<taskId>/receipts/inbox/<attemptId>/<eventId>.json
runs/<taskId>/receipts/processed/<attemptId>/<eventId>.json
runs/<taskId>/receipts/rejected/<attemptId>/<eventId>.json
runs/<taskId>/bindings/<bindingId>.json
```

Job and event writes use temporary-file-plus-rename or append-plus-fsync semantics. `status.json` stores references and summaries, not the full event log.

Migration from schema 3 to 4 initializes `stateRevision`, `stageRevision`, `lockEpoch`, and empty execution references, then defaults to `execution.mode = "manual"`. It preserves V2.4 behavior until the operator explicitly enables a worker.

## 16. Failure and Recovery Rules

- **Harness restarts:** reconstruct active job state from job, lease, and event files.
- **Worker restarts:** resume watching an unexpired lease and inspect the receipt inbox; any attempt left in `dispatching` becomes `dispatch-uncertain` and is never re-sent automatically.
- **Crash after possible UI send:** enter `dispatch-uncertain`; never auto-retry; require explicit `sent`, `not-sent`, or `abandon` adjudication.
- **Warp closes:** emit `job.failed` with `target-unavailable`.
- **Claude requests approval:** emit `job.needs-input`; do not auto-approve.
- **Completion hook missing:** timeout with a diagnostic; do not infer success from output alone.
- **Report changed after completion:** existing freshness and acceptance integrity checks apply.
- **Duplicate completion event:** ignore by `eventId` and terminal job state.
- **Late receipt:** retain under `rejected` with `stale-attempt` or `fenced-token`; never apply it to the active attempt.
- **Stale lease:** fence it by incrementing the epoch; require explicit retry or operator-confirmed takeover.
- **Concurrent manual command:** fail with `active-job-conflict` unless explicit `--takeover --reason` succeeds.
- **Stale or duplicate cancel:** return `stale-attempt` or the existing terminal result; do not send an interrupt to the target.
- **Stage cursor changed:** fail CAS and require a fresh check; do not partially advance.

## 17. Security and Permission Boundaries

- Adapter dispatch grants no new filesystem, shell, network, Git, or review authority.
- Prompt content is loaded only from Harness-generated absolute paths with verified hashes.
- Target selectors come from checked configuration; prompt text cannot select a different window.
- Target identity requires a live wrapper nonce and challenge-bound Accessibility fingerprint; tab title is insufficient.
- Revoked lease tokens and superseded attempts are permanently fenced from state mutation.
- Secrets, clipboard contents, and terminal transcripts are not stored in worker events.
- Automatic command approval is prohibited.
- Delivery acceptance and commit confirmation remain explicit user actions.

## 18. Implementation Phases

### Phase 1 — Protocol skeleton

- Extract core command results from process-exit behavior.
- Add task lock, `stateRevision`, `stageRevision`, stage cursor CAS, job/attempt/event/lease models, and fencing tokens.
- Implement fake and manual adapters.
- Add schema 3 → 4 migration behind manual default mode.

### Phase 2 — Supervisor

- Implement `doctor`, `run`, `jobs`, `retry`, `cancel`, and takeover rules.
- Add receipt inbox processing, restart recovery, uncertain-send adjudication, timeout, idempotency, fencing, CAS, attempt-scoped cancel, and one-target lease tests.
- Verify the full loop with the fake adapter.

### Phase 3 — Claude completion integration

- Implement wrapper/attach handshake.
- Implement session nonce, challenge-bound identity, and correlated completion/needs-input receipts.
- Test missing, duplicate, late, and mismatched events.

### Phase 4 — Warp macOS adapter spike

- Prove unique target discovery for `work` and `review`.
- Prove reliable prompt submission without clipboard use.
- Prove failure-closed behavior for ambiguous/missing targets.
- Keep the spike outside core until contract tests pass.

### Phase 5 — W6 pilot

- Enable worker mode for one non-delivery stage.
- Run implementation and review roles sequentially.
- Exercise interruption, gate failure, retry, and restart recovery.
- Keep manual mode as immediate fallback.

## 19. Acceptance Criteria

1. Fake-adapter end-to-end tests cover dispatch through conditional stage advancement.
2. The same core test suite runs with no Warp dependency.
3. `work` jobs cannot dispatch to `review`, and vice versa.
4. Missing or duplicate targets fail without submitting input.
5. Recovery may retry only failures proven to occur before `dispatching`; attempts at or beyond `dispatching` are never re-submitted automatically.
6. A completion event without fresh output cannot advance.
7. Fresh output without a completion event cannot advance.
8. Needs-input stops automation and identifies the target/job.
9. Delivery still requires report-bound manual acceptance.
10. Commit checkpoint still requires `--confirm-committed`.
11. Manual V2.4 commands remain functional under schema 4.
12. Warp adapter implementation can be removed without changing core workflow code.
13. An active job blocks `next`, `step`, `advance`, and other state-changing manual commands.
14. `--takeover --reason` fences the old attempt, records history, and revalidates the manual command without bypassing gates.
15. A stale `attemptId` or `leaseToken` cannot apply a receipt, check result, or advancement.
16. A crash after possible input submission enters `dispatch-uncertain` and never causes automatic resend.
17. Attempts that reached `dispatching` are never automatically re-sent; restart and ambiguous-send tests require explicit `sent`, `not-sent`, or `abandon` adjudication.
18. Multiple attempts, multiple events, and late receipts coexist without overwrite; stale receipts remain auditable.
19. Completion, freshness, check evidence, and advance must share the same attempt, fencing token, cursor, and primary artifact hash.
20. Stage advancement fails atomically when subtask, stage, round, revision, or active attempt differs.
21. A title-matched Warp target without a valid wrapper nonce/challenge binding cannot receive a job.
22. Binding becomes invalid when wrapper heartbeat, session nonce, role, cwd policy, or Accessibility fingerprint changes.
23. Authoritative needs-input events are attempt-scoped; missing hook capability produces degraded-mode diagnostics and never automatic success.
24. `cancel` requires `jobId`, `attemptId`, and `leaseToken`; a stale attempt cancel returns `stale-attempt` without sending any interrupt to the active target.

## 20. Open Decisions Before Implementation

1. Whether the macOS adapter should use Accessibility through a native helper or an external automation process. The protocol does not depend on this choice.
2. The exact Claude Code hook payload and session correlation mechanism supported by the installed Claude Code version.
3. Whether V3.0 ships `warp-macos` as experimental or waits until a multi-day W6 pilot has zero cross-target dispatches.

These decisions require a local capability spike. They do not block approval of the core worker/adapter architecture.
