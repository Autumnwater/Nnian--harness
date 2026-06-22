# HEXAI Review Harness File Mailbox Phase A Architecture

**Status:** Phase A architecture draft
**Date:** 2026-06-21
**Scope:** file mailbox protocol, status v5 schema draft, CLI contract, recovery tables, and test plan
**Out of scope:** code implementation, daemon automation, Warp UI/API integration, changes to existing `hexai-xxx` skills

## 1. Decision Summary

The File Mailbox architecture is a V2-based alternate execution path for HEXAI Review Harness. It replaces Warp/UI-driven dispatch with file-system communication and operator-assisted Claude Code polling.

The core decision is conservative:

- Harness remains the workflow state machine.
- Claude Code work is handed off through files under `runs/<taskId>/mailbox/`.
- The first implementation is operator-assisted, not a daemon that automatically executes prompts.
- Receipts are evidence only. They do not advance workflow.
- `advance` is always blocked while `status.mailbox.activeSessionId` is set.
- Workflow can advance only after an explicit, recoverable `mailbox-close`.
- Existing `hexai-xxx` skills are frozen. New mailbox-specific skills, if needed, must be created as `nNian-xxx`.

This design intentionally does not use:

- Warp APIs or UI automation.
- Clipboard.
- Frontmost window selection.
- Title-only target selection.
- Screenshot text, notifications, or sleep-based completion inference.
- Automatic approval, delivery, commit, push, or tag.

## 2. Repository Boundaries

Harness manages process and evidence, not business implementation.

Authoritative boundaries:

- Machine state: `/Users/admin/project/ai/review/Harness/runs/<taskId>/`
- Human reports: `/Users/admin/project/ai/review/<week>/<subtaskId>/`
- Business repo: `/Users/admin/project/ai/work/HEXAI`

Harness must not read or write:

- `.claude/settings.json`
- API keys, tokens, cookies, or other secrets outside mailbox nonce files
- Warp UI state

Harness must not directly modify business code. Business code changes happen only through the operator/Claude Code side when the current stage prompt explicitly calls for implementation work.

## 3. Relation to V2 and V3

### 3.1 V2 Assets Kept

The mailbox path keeps the V2 workflow surface:

- `next`
- `check`
- `advance`
- `step`
- `current`
- `summary`
- delivery acceptance and commit checkpoint

The current gate model remains authoritative:

- primary report freshness
- stage-specific report contracts
- finding/fix mapping validation
- delivery acceptance
- manual commit checkpoint

### 3.2 V3 Assets Not Used in Main Path

The mailbox path does not use the V3 worker supervisor main loop:

- no `ExecutionSupervisor` dispatch loop
- no V3 job/attempt/lease/operation/transport model
- no Warp target discovery
- no Warp target challenge
- no Warp helper submit/interrupt
- no Phase 5 pilot gate

Mailbox may reuse neutral helper logic only after extraction:

- canonical JSON/hash
- atomic JSON write with fsync
- HMAC proof helper
- eventId/payload collision rules

Mailbox must not write V3 top-level stores:

- `runs/<taskId>/bindings`
- `runs/<taskId>/receipts`
- `runs/<taskId>/events/worker.jsonl`
- `runs/<taskId>/jobs`
- `runs/<taskId>/attempts`
- `runs/<taskId>/leases`
- `runs/<taskId>/operations`
- `runs/<taskId>/transports`

## 4. Skill Boundary

Existing `hexai-xxx` skills are not modified by this architecture.

If the mailbox path needs skill-specific operator prompts, output templates, or execution instructions, create new skills named `nNian-xxx`, for example:

- `nNian-plan-review`
- `nNian-plan-fix`
- `nNian-code-review`
- `nNian-code-fix`
- `nNian-delivery`

`nNian-xxx` skills may reference the machine-readable output contracts used by existing HEXAI reports, but they must be separate assets. The mailbox envelope may include `expectedSkill: "nNian-code-fix"` as a recommendation. Harness must not edit, install, or mutate existing `hexai-xxx` skills as part of this path.

## 5. Storage Layout

Mailbox state is stored only under:

```text
runs/<taskId>/mailbox/
  bindings/
    <bindingId>.json
    replaced/<bindingId>.<generation>.json
    .secrets/<bindingId>.nonce
  publish-ledger/
    <sessionId>.json
  publish-committed/
    <sessionId>.json
  close-ledger/
    <sessionId>.json
  inbox/
    <sessionId>.json
  claimed/
    <bindingId>/<sessionId>.json
  done/
    <sessionId>.json
  rejected/
    <sessionId>.json
  sessions/
    <sessionId>.json
  receipts/
    inbox/<attemptId>/<eventId>.json
    processed/<attemptId>/<eventId>.json
    rejected/<attemptId>/<eventId>.json
  receipt-ledger/
    <attemptId>.json
  events/
    mailbox.jsonl
```

All JSON writes must use:

1. temp file in same directory
2. file fsync
3. atomic rename
4. directory fsync

Append-only JSONL events must recover partial trailing lines before read or append.

## 6. Status v5 Schema Draft

Status schema version 5 adds an independent mailbox namespace.

```json
{
  "schemaVersion": 5,
  "stateRevision": 0,
  "stageRevision": 0,
  "execution": {
    "mode": "manual",
    "activeJobId": null,
    "activeAttemptId": null,
    "activeLeaseToken": null,
    "lockEpoch": 0,
    "lastJobId": null
  },
  "mailbox": {
    "mode": "manual",
    "activeSessionId": null,
    "activeAttemptId": null,
    "activeCursorHash": null,
    "lastSessionId": null
  }
}
```

Migration rules:

- schemaVersion `< 5` gets a default `mailbox` object.
- Existing `execution` semantics are preserved.
- Mailbox attempt ids are not mirrored into `execution.activeAttemptId`.
- `execution` remains reserved for the V3/legacy worker path.
- Unknown mailbox fields fail schema validation once status v5 is active.

The workflow blocker predicate becomes:

```text
hasActiveWorkflowBlocker(status) =
  status.execution.activeJobId != null ||
  status.execution.activeAttemptId != null ||
  status.mailbox.activeSessionId != null
```

Error messages must distinguish execution blockers from mailbox blockers.

## 7. Command Allow Matrix

When `status.mailbox.activeSessionId` is set:

| Command | Policy |
| --- | --- |
| `next` | reject with `active-mailbox-conflict` |
| `step` | reject with `active-mailbox-conflict` |
| `advance` | reject with `active-mailbox-conflict` |
| `accept` | reject with `active-mailbox-conflict` |
| `advance --confirm-committed` | reject with `active-mailbox-conflict` |
| `check` | allowed, but does not persist mailbox evidence to status |
| `mailbox-peek` | allowed only for committed/status-active sessions |
| `mailbox-claim` | allowed only for committed/status-active sessions |
| `mailbox-start` | allowed only for committed/status-active sessions |
| `mailbox-complete` | allowed only for committed/status-active sessions |
| `mailbox-failed` | allowed only for committed/status-active sessions |
| `mailbox-needs-input` | allowed only for committed/status-active sessions |
| `mailbox-pump` | allowed only for current active session |
| `mailbox-reconcile` | allowed, explicit outcome and reason required |
| `mailbox-takeover` | allowed, explicit reason required |
| `mailbox-close` | allowed only for terminal-safe states or close recovery |

`advance` never closes mailbox state. This is a deliberate close-before-advance design.

### 7.1 CLI Contract

The CLI contract below is the Phase C skeleton contract. Commands must fail closed before writing any side effect when a precondition is not met. All commands accept `--json`; JSON output must include `ok`, `code`, `sessionId`, `attemptId`, and `activeCursorHash` when applicable.

Common validation for mailbox commands:

- `taskId` must resolve to an existing Harness run.
- task execution lock must be acquired for mutating commands.
- for session-scoped worker/operator commands after publish, session id, attempt id, cursor hash, and publish committed marker must match before side effects.
- mutating operator commands write an append-only event.
- binding-aware commands verify binding id, binding generation, binding role, nonce proof, and stage role.

| Command | Required Args | Preconditions | File Side Effects | State/Receipt Effects |
| --- | --- | --- | --- | --- |
| `mailbox-bind <taskId> --role work|review --binding <id> [--replace]` | `taskId`, `role`, `binding` | binding id path-safe; existing live binding rejected unless `--replace`; role is allowed for current stage family | writes binding JSON and raw nonce `0600`; replace writes old binding `state=replaced` and increments generation | emits `binding.created` or `binding.replaced` event |
| `mailbox-publish <taskId>` | `taskId` | no active workflow blocker; stage is worker/reviewer eligible; output parent can be created inside allowlist | writes publish ledger, prompt, session, envelope, status mailbox active, committed marker | session `published`; emits publish phase events |
| `mailbox-peek <taskId> [--role <role>] [--include-recovering]` | `taskId` | default view requires committed marker, status active, cursor hash match; recovering view is diagnostic only | none | no claim, no receipt, no event unless `--json --audit-peek` is later added |
| `mailbox-claim <taskId> --session <id> --binding <id> --reason <text>` | session, binding, non-empty reason | publish committed; status active; cursor match; binding live; binding role matches session role; session `published` | session update and event append | session `claimed`; receipt `session.claimed` |
| `mailbox-start <taskId> --session <id> --binding <id>` | session, binding | session `claimed`; binding id/generation/role still match | session update and event append | session `running`; receipt `session.running` |
| `mailbox-complete <taskId> --session <id> --binding <id> --summary <text>` | session, binding, non-empty summary | session `running|claimed`; prompt hash still matches; output parent exists; output realpath allowlisted; binding proof valid | output snapshot event; receipt file via MailboxStore | session remains receipt-pending until pump; receipt `session.completed` |
| `mailbox-failed <taskId> --session <id> --binding <id> --reason <text>` | session, binding, non-empty reason | committed/status-active/cursor match; binding proof valid | event append; receipt file | session remains receipt-pending until pump; receipt `session.failed` |
| `mailbox-needs-input <taskId> --session <id> --binding <id> --reason <text>` | session, binding, non-empty reason | committed/status-active/cursor match; binding proof valid | event append; receipt file | session remains receipt-pending until pump; receipt `session.needs-input` |
| `mailbox-pump <taskId> [--session <id>]` | taskId; optional session | receipts validate eventId, sequence, proof, cursor, role, and committed marker | moves/marks consumed receipts; appends pump events | applies receipt to session: `receipt-seen`, `output-detected`, `failed`, or `needs-input`; never writes status evidence |
| `mailbox-close <taskId> --session <id> --reason <text> [--after-check]` | session, reason | terminal-safe state, or `--after-check` can first transition to `check-passed`; close recovery states allowed | close ledger, close events, session update, status mailbox clear, close-committed ledger phase/event | session `closed`; status mailbox active fields null |
| `mailbox-reconcile <taskId> --session <id> --outcome activate|reject|commit-marker|abandon|clear-stale --reason <text>` | outcome, reason | only for documented recovery states; never unconditional clear | recovery event; exact outcome-specific ledger/status/session update | no workflow advance; may make publish claimable only after committed/status-active/cursor match |
| `mailbox-takeover <taskId> --session <id> --reason <text>` | session, reason | committed/status-active/cursor match, or explicit reconcile state | session update and event append | session `taken-over`; no receipt required; close still required before advance |

## 8. Mailbox Cursor and Fence

Mailbox uses its own cursor:

```json
{
  "subtaskId": "W6-A-03",
  "stage": "code-fix-review",
  "round": 2,
  "stageRevision": 123,
  "activeSessionId": "uuid",
  "activeAttemptId": "uuid"
}
```

`activeCursorHash` is:

```text
sha256(canonicalJson(mailboxStageCursor))
```

The same cursor and hash must appear in:

- publish ledger
- envelope
- session
- receipts
- operator events
- close ledger
- close recovery events

Receipt, claim, start, complete, failed, needs-input, pump, close, and reconcile must verify session id, attempt id, and active cursor hash before applying effects.

## 9. Schema Drafts

### 9.1 Binding

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.binding",
  "taskId": "W6-A",
  "bindingId": "claude.work.local",
  "role": "work",
  "bindingGeneration": 1,
  "sessionId": "uuid",
  "sessionNonceHash": "sha256:...",
  "createdAt": "ISO",
  "heartbeatAt": "ISO",
  "state": "live",
  "metadata": {
    "cwd": "/Users/admin/project/ai/work/HEXAI",
    "pollerVersion": 1
  }
}
```

The raw nonce is stored only at:

```text
runs/<taskId>/mailbox/bindings/.secrets/<bindingId>.nonce
```

Secret files must be written with mode `0600`.

Binding CLI contract:

```text
harness mailbox-bind <taskId> --role work|review --binding <id> [--replace]
```

Binding ids are path components, not paths. They must match:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
```

Rejected binding ids include empty strings, `.`/`..`, slash, backslash, path separators, shell metacharacter-only ids, and ids that would change after Unicode normalization. Binding files and nonce files are addressed only by joining the sanitized id under the mailbox binding directories and then validating the realpath remains inside that directory.

Binding rules:

- creating a binding writes binding JSON first and raw nonce second using temp-write plus rename; the final nonce file mode must be `0600`
- existing live binding id is rejected unless `--replace` is provided
- `--replace` marks the old binding `state=replaced`, creates a new nonce, and increments `bindingGeneration`
- `bindingGeneration` starts at `1` and is strictly incremented per binding id
- receipt payloads must include the generation observed at claim/start/complete time
- stale generation, missing nonce, unreadable nonce, or mismatched nonce hash rejects proof verification
- stage role is derived from workflow stage; work stages accept only `role=work`, review stages accept only `role=review`
- `claim`, `start`, `complete`, `failed`, and `needs-input` reject bindings whose role does not match the envelope/session role
- replay with an older generation is rejected even if the HMAC validates with an old nonce retained for audit

Binding recovery rule:

- if crash leaves `state=live` binding JSON but the nonce file is missing or hash-mismatched, normal `mailbox-bind` rejects the existing live binding
- operator recovery is `mailbox-bind --replace`, which creates a new nonce and increments `bindingGeneration`
- the old generation remains unusable for receipt proof even if a stale receipt later appears

`mailbox-bind` is an operator setup command. It does not claim a session, does not write receipts, and does not make a task claimable.

### 9.2 Envelope

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.task",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "createdAt": "ISO",
  "role": "work",
  "expectedSkill": "nNian-code-fix",
  "stageCursor": {},
  "activeCursorHash": "sha256:...",
  "prompt": {
    "path": "/Users/admin/project/ai/review/Harness/runs/W6-A/prompts/W6-A-03-code-fix.md",
    "sha256": "sha256:..."
  },
  "expectedOutput": {
    "primaryReportPath": "/Users/admin/project/ai/review/W6/W6-A-03/report.md",
    "baseline": {
      "exists": false,
      "size": 0,
      "mtimeMs": 0,
      "sha256": ""
    }
  },
  "constraints": {
    "noAutoApprove": true,
    "noAutoDelivery": true,
    "noCommit": true,
    "noPush": true,
    "noClipboard": true,
    "noWarp": true
  }
}
```

### 9.3 Session

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.session",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "state": "published",
  "stageCursor": {},
  "activeCursorHash": "sha256:...",
  "bindingId": null,
  "promptPath": "...",
  "promptSha256": "sha256:...",
  "primaryReportPath": "...",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "closedAt": null,
  "lastEventId": null
}
```

Allowed states:

```text
published
claimed
running
receipt-seen
output-detected
check-passed
needs-input
failed
abandoned
rejected
taken-over
closed
```

Only these states are terminal-safe for close:

```text
check-passed
abandoned
rejected
taken-over
closed during close recovery only
```

### 9.4 Receipt

Receipts are published by MailboxStore. External or operator-supplied sequence values are not trusted.

```json
{
  "protocolVersion": 1,
  "kind": "session.completed",
  "eventId": "uuid",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "sequence": 3,
  "source": "claude-code-operator",
  "occurredAt": "ISO",
  "binding": {
    "bindingId": "claude.work.local",
    "role": "work",
    "bindingGeneration": 1,
    "sessionId": "uuid",
    "sessionNonceHash": "sha256:..."
  },
  "stageCursor": {},
  "activeCursorHash": "sha256:...",
  "outputSnapshot": {
    "path": "...",
    "realpath": "...",
    "exists": true,
    "size": 1234,
    "sha256": "sha256:..."
  },
  "details": {
    "summary": "report written"
  },
  "proof": "hmac-sha256:..."
}
```

Allowed receipt kinds:

- `session.claimed`
- `session.running`
- `session.completed`
- `session.failed`
- `session.needs-input`
- `session.heartbeat`

Proof uses HMAC over canonical receipt payload without `proof`.

## 10. Path Safety Contract

All paths are checked at publish and complete.

Prompt path:

- realpath must be under `/Users/admin/project/ai/review/Harness/runs/<taskId>/prompts/`
- prompt sha256 must match the envelope
- symlink escape is rejected

Output path:

- expected output root is `/Users/admin/project/ai/review/<week>/<subtaskId>/`
- `mailbox-publish` may create the missing output parent only under that root
- after creation, parent realpath must still be inside the allowed root
- `mailbox-complete` must not create output parent directories
- parent symlink escape is rejected
- output snapshot is accepted only for the same realpath

Envelope paths must not point to:

- `.claude`
- token/key/cookie files
- business repo files as report output
- locations outside the allowlisted roots

## 11. Publish State Machine

Publish phase ledger:

```text
intent -> prompt-written -> session-written -> envelope-published -> status-active -> committed
```

Ledger path:

```text
runs/<taskId>/mailbox/publish-ledger/<sessionId>.json
```

Committed marker path:

```text
runs/<taskId>/mailbox/publish-committed/<sessionId>.json
```

The committed marker is an independent JSON marker, not just `phase=committed`. Worker/operator commands require both:

- publish ledger `phase="committed"`
- committed marker exists and its `operationHash`, `publishContentHash`, `sessionId`, `attemptId`, and `activeCursorHash` match the ledger

Publish ledger schema:

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.publish-ledger",
  "taskId": "W6-A",
  "publishOperationId": "uuid",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "stageCursor": {},
  "activeCursorHash": "sha256:...",
  "phase": "intent",
  "promptHash": null,
  "envelopeHash": null,
  "expectedOutputPathHash": null,
  "publishContentHash": null,
  "statusRevisionBefore": 12,
  "statusRevisionAfter": null,
  "statusCasToken": "opaque-or-null",
  "operationHash": "sha256:...",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "committedAt": null,
  "recoveryEvents": []
}
```

Publish uses two hashes with different jobs:

- `operationHash` is stable from `intent` through `committed`; it identifies the publish operation for resume/collision checks.
- `publishContentHash` is created only after prompt and envelope hashes are known; it proves the committed task artifacts.

`operationHash` is `sha256(canonicalJson(operationForHash))`. `operationForHash` includes only fields known at `intent`:

- `protocolVersion`
- `kind`
- `taskId`
- `publishOperationId`
- `sessionId`
- `attemptId`
- `stageCursor`
- `activeCursorHash`
- `statusRevisionBefore`

`operationForHash` excludes mutable and later artifact fields:

- `phase`
- `promptHash`
- `envelopeHash`
- `publishContentHash`
- `updatedAt`
- `statusRevisionAfter`
- `statusCasToken`
- `committedAt`
- `recoveryEvents`

`publishContentHash` is `sha256(canonicalJson(contentForHash))`. `contentForHash` includes:

- `taskId`
- `publishOperationId`
- `sessionId`
- `attemptId`
- `activeCursorHash`
- `promptHash`
- `envelopeHash`
- expected output path hash

`expectedOutputPathHash` is `sha256(realpath-normalized expectedOutput.primaryReportPath)`. `publishContentHash` is null before `promptHash`, `envelopeHash`, and `expectedOutputPathHash` are present. Once set, it must not change for the same publish operation. If a later resume observes a different prompt hash, envelope hash, or expected output path hash, it rejects as `publish-content-collision`.

Publish phase writes:

| Phase | Required Write | Event | Retry Rule |
| --- | --- | --- | --- |
| `intent` | create ledger with operation id, session id, attempt id, cursor hash, operationHash | `mailbox.publish-intent` | same operationHash resumes; different operationHash rejects |
| `prompt-written` | write prompt, set `promptHash` | `mailbox.publish-prompt-written` | verify prompt hash before resume |
| `session-written` | write session JSON | `mailbox.publish-session-written` | verify session cursor/hash before resume |
| `envelope-published` | write envelope, set `envelopeHash` and `expectedOutputPathHash`, compute `publishContentHash` | `mailbox.publish-envelope-published` | verify envelope hash, expected output path hash, and content hash before resume |
| `status-active` | CAS status mailbox active and record `statusRevisionAfter` | `mailbox.publish-status-active` | if status active matches ledger, resume; if inactive, reconcile only |
| `committed` | write committed marker and set `committedAt` | `mailbox.publish-committed` | marker match is idempotent success |

Committed marker schema:

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.publish-committed",
  "taskId": "W6-A",
  "publishOperationId": "uuid",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "activeCursorHash": "sha256:...",
  "operationHash": "sha256:...",
  "expectedOutputPathHash": "sha256:...",
  "publishContentHash": "sha256:...",
  "committedAt": "ISO"
}
```

Recovery table:

| Visible State | Claimable | Recovery |
| --- | --- | --- |
| `intent` only | no | reject or resume publish by explicit reconcile |
| `prompt-written`, no session | no | verify prompt hash, then resume or reject |
| `session-written`, no envelope | no | resume envelope publish or reject |
| envelope exists, status inactive | no | `mailbox-reconcile --outcome activate|reject` |
| status active, no committed marker | no | `mailbox-reconcile --outcome commit-marker|reject`; commit-marker may write the marker only when ledger `phase=status-active`, status active matches, operationHash matches, and publishContentHash verifies current prompt/envelope/output path |
| committed, status active, cursor hash match | yes | normal flow |

Command fencing:

| Command | Requires committed ledger | Requires status active | Requires cursor hash match |
| --- | --- | --- | --- |
| `mailbox-peek` | yes | yes | yes |
| `mailbox-claim` | yes | yes | yes |
| `mailbox-start` | yes | yes | yes |
| `mailbox-complete` | yes | yes | yes |
| `mailbox-failed` | yes | yes | yes |
| `mailbox-needs-input` | yes | yes | yes |
| `mailbox-pump` | yes | yes | yes |

`mailbox-peek --include-recovering` may show uncommitted records for diagnostics only. It must mark them `claimable=false`.

## 12. Operator Flow

Standard path:

```text
harness mailbox-bind W6-A --role work --binding claude.work.local
harness mailbox-publish W6-A
harness mailbox-peek W6-A --role work
harness mailbox-claim W6-A --session <id> --binding claude.work.local --reason "start current stage"
harness mailbox-start W6-A --session <id> --binding claude.work.local
# Operator runs Claude Code work using nNian-xxx skill and writes primary report.
harness mailbox-complete W6-A --session <id> --binding claude.work.local --summary "report written"
harness mailbox-pump W6-A
harness mailbox-close W6-A --session <id> --after-check --reason "gate passed"
harness advance W6-A
```

No command in this flow uses Warp, clipboard, UI automation, or a daemon.

## 13. Close State Machine

Close is a multi-file operation. It has its own ledger so it can be retried safely.

Ledger path:

```text
runs/<taskId>/mailbox/close-ledger/<sessionId>.json
```

Close phases:

```text
close-intent -> close-event-written -> session-closed -> status-cleared -> close-committed
```

Ledger schema:

```json
{
  "protocolVersion": 1,
  "kind": "hexai.mailbox.close-ledger",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "closeOperationId": "uuid",
  "activeCursorHash": "sha256:...",
  "phase": "close-intent",
  "terminalPreconditionState": "check-passed",
  "statusWasActive": true,
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "committedAt": null,
  "payloadHash": "sha256:...",
  "recovered": false,
  "recoveryEvents": []
}
```

Normal close:

1. acquire task execution lock
2. read status, session, and close ledger
3. create `close-intent` ledger if missing
4. validate active session id, attempt id, and cursor hash
5. validate terminal-safe session state
6. write close operator event, ledger to `close-event-written`
7. update session to `closed`, ledger to `session-closed`
8. clear status mailbox fields, ledger to `status-cleared`
9. write close-committed event and advance ledger to `close-committed`

Status clear writes:

```json
{
  "mailbox": {
    "mode": "manual",
    "activeSessionId": null,
    "activeAttemptId": null,
    "activeCursorHash": null,
    "lastSessionId": "<sessionId>"
  }
}
```

If `mailbox-close --after-check` is used, it first runs `cmdCheck({ persist: false })`. If check fails, close does not change session terminal state and does not clear status.

`mailbox-close --after-check` success transaction:

1. acquire the task execution lock
2. verify publish ledger is committed, committed marker matches, status mailbox is active, and session cursor/hash matches
3. verify session is `receipt-seen` or `output-detected`; if already `check-passed`, continue idempotently
4. re-read the primary output snapshot and verify realpath, expected output path, prompt hash, receipt refs, and active cursor hash
5. run `cmdCheck({ persist: false })`
6. if check passes, write `mailbox.check-passed` audit event with check result hash, primary snapshot hash, receipt refs, and cursor hash
7. transition session to `check-passed`
8. enter normal close at `close-intent`

Crash handling for this transaction:

- if crash occurs after `mailbox.check-passed` event but before session update, retry re-runs the check and may write a recovery event before setting `check-passed`
- if crash occurs after session becomes `check-passed` but before close ledger exists, retry treats `check-passed` as terminal-safe and starts close
- if crash occurs after close ledger exists, the close recovery table applies
- if retry observes `check-passed` with a mismatched primary snapshot, receipt refs, cursor hash, or check result hash, it rejects and requires `mailbox-reconcile`

## 14. Close Recovery Table

`mailbox-close` must be idempotent. If a close ledger already exists, recovery uses the original `closeOperationId` and original `payloadHash`. New CLI argv and reason are recorded only in the recovery event; they must not create a second incompatible close operation.

| Visible State | Retry Close | Recovery |
| --- | --- | --- |
| ledger `close-intent`, session terminal-safe, status active match | yes | continue close event |
| ledger `close-event-written`, session terminal-safe, status active match | yes | continue session close, write recovery event |
| session `closed`, status active match, ledger `session-closed` | yes | clear status, advance ledger to `status-cleared`, then commit |
| status cleared, session `closed`, ledger `session-closed`, close-committed event missing | yes | write recovery event, advance ledger to `status-cleared -> close-committed`, do not modify already-cleared status |
| status cleared, session `closed`, ledger `status-cleared`, close-committed event missing | yes | write close-committed event |
| status cleared, session not closed, ledger shows close started | yes, recovery only | mark session `closed` with `closeReason=recovered-after-status-clear`, then commit |
| status active points to another session | no | write rejected recovery event; require reconcile |
| session attempt/cursor hash mismatch | no | write rejected recovery event; require reconcile |
| close ledger payloadHash incompatible | no | fail closed; write collision/security event |
| no ledger, session `closed`, status active match | yes | create recovery ledger, clear status, commit |
| no ledger, session `closed`, status cleared | yes | idempotent success; may write close-committed event |

The fourth row explicitly covers this crash point:

```text
status.mailbox.activeSessionId = null
session.state = closed
close ledger phase = session-closed
close-committed event missing
```

This is a recoverable successful close path. Retry must not treat it as mismatch and must not modify status again.

## 15. Events

All operator actions write append-only events to:

```text
runs/<taskId>/mailbox/events/mailbox.jsonl
```

Operator action event:

```json
{
  "protocolVersion": 1,
  "kind": "mailbox.operator-action",
  "eventId": "uuid",
  "action": "claim|start|complete|failed|needs-input|reconcile|takeover|close|check-passed",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "operator": "admin",
  "reason": "non-empty where required",
  "stageCursor": {},
  "activeCursorHash": "sha256:...",
  "sessionBefore": {},
  "sessionAfter": {},
  "statusBefore": {},
  "statusAfter": {},
  "primarySnapshot": {},
  "receiptRefs": [],
  "argv": [],
  "occurredAt": "ISO"
}
```

Check-passed event:

```json
{
  "protocolVersion": 1,
  "kind": "mailbox.check-passed",
  "eventId": "uuid",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "activeCursorHash": "sha256:...",
  "checkResultHash": "sha256:...",
  "primarySnapshotHash": "sha256:...",
  "receiptRefs": [
    {
      "eventId": "uuid",
      "sequence": 3,
      "kind": "session.completed",
      "payloadHash": "sha256:..."
    }
  ],
  "sessionBefore": {},
  "sessionAfter": {},
  "statusBefore": {},
  "statusAfter": {},
  "recovered": false,
  "closeOperationId": null,
  "occurredAt": "ISO"
}
```

If crash recovery writes this event after observing a prior successful check-passed event, `recovered` is `true` and `closeOperationId` is set when a close ledger already exists. Recovery must compare `checkResultHash`, `primarySnapshotHash`, `receiptRefs`, and `activeCursorHash` before trusting the prior event.

Close recovery event:

```json
{
  "protocolVersion": 1,
  "kind": "mailbox.close-recovery",
  "eventId": "uuid",
  "taskId": "W6-A",
  "sessionId": "uuid",
  "attemptId": "uuid",
  "closeOperationId": "uuid",
  "recoveryAction": "continue-status-clear|commit-marker|recovered-close|reject-mismatch",
  "closePhaseBefore": "session-closed",
  "closePhaseAfter": "status-cleared",
  "statusBefore": {},
  "statusAfter": {},
  "sessionBefore": {},
  "sessionAfter": {},
  "reason": "non-empty",
  "occurredAt": "ISO"
}
```

Required non-empty reason:

- claim
- failed
- needs-input
- reconcile
- takeover
- close

Complete requires non-empty `summary`.

## 16. Receipt Processing

Receipt sequence allocation is owned by MailboxStore:

1. CLI builds receipt payload without sequence and proof.
2. MailboxStore allocates the next sequence from `receipt-ledger/<attemptId>.json`.
3. MailboxStore computes payload hash.
4. MailboxStore signs canonical payload with binding raw nonce.
5. MailboxStore publishes receipt by temp write and rename.

Collision rules:

- same eventId and same payloadHash: duplicate success
- same eventId and different payloadHash: reject collision
- corrupt JSON: reject and record corrupt event
- stale cursor: reject
- invalid proof: reject

`mailbox-pump` applies receipts only to the current active session. It writes session/event store only. It does not write mailbox evidence into status and does not bump `stageRevision`.

## 17. Reconcile and Takeover

`mailbox-reconcile` is for states that cannot be resolved by deterministic retry:

- status active points to another session
- session/cursor/hash mismatch
- ledger operation/content hash collision
- session file missing while status active exists
- corrupt status or schema invalid
- output exists with no valid receipt

`mailbox-reconcile` requires:

- explicit outcome
- non-empty reason or note
- append-only recovery event

It must not unconditionally clear active mailbox state.

`mailbox-takeover` marks the session `taken-over` and records operator intent. It does not advance workflow.

## 18. Testing Plan

Phase A must publish this test plan. Phase B/C must implement it before feature completion.

### 18.1 Status and Guard

- migrate status v4 to v5 with default mailbox object
- unknown mailbox fields fail schema validation
- active mailbox blocks `next`
- active mailbox blocks `step`
- active mailbox blocks `advance`
- active mailbox blocks `accept`
- active mailbox blocks `advance --confirm-committed`
- close clears active mailbox before advance can run

### 18.2 Publish Fencing

- publish creates ledger, session, envelope, and status active
- publish ledger validates required schema fields
- publish ledger operationHash covers only intent-time identity/fence fields and remains stable across phases
- publishContentHash is null until prompt/envelope hashes are known, then remains immutable
- committed marker is a separate JSON marker and must match ledger operationHash/publishContentHash/session/attempt/cursor
- prompt or envelope replacement after publishContentHash is set is rejected as publish-content-collision
- `reconcile --outcome commit-marker` succeeds only when operationHash and publishContentHash both verify current artifacts
- crash after `intent` cannot be claimed
- crash after `prompt-written` cannot be claimed
- crash after `session-written` cannot be claimed
- crash after `envelope-published` with status inactive: peek default does not show
- same state: claim/start/complete/failed/needs-input all fail
- `peek --include-recovering` shows diagnostic with `claimable=false`
- `reconcile --outcome activate` makes task claimable only after committed/status-active/cursor match
- status active with no committed marker cannot be claimed
- cursor hash mismatch cannot be claimed

### 18.3 Peek and Claim

- peek does not move files
- peek does not write receipt
- peek does not claim
- claim requires non-empty reason
- claim conflict allows only one claimant
- claimed session cannot be closed directly
- running session cannot be closed directly

### 18.4 Receipt and Proof

- `mailbox-bind` creates binding JSON and raw nonce with mode `0600`
- invalid binding id path characters are rejected
- existing live binding is rejected unless `--replace`
- `--replace` increments `bindingGeneration` and rejects old-generation replay
- live binding with missing nonce is recoverable only by `mailbox-bind --replace`
- old generation from live-binding/missing-nonce crash is never accepted for receipt proof
- binding role must match stage role and session role
- sequence is allocated by MailboxStore, not trusted from input
- duplicate eventId with same payload is idempotent
- eventId collision with different payload is rejected
- missing proof rejected
- invalid proof rejected
- stale cursor rejected
- wrong role rejected
- corrupt JSON rejected

### 18.5 Path Safety

- prompt realpath must stay under `runs/<taskId>/prompts`
- prompt symlink escape rejected
- prompt changed after publish rejected
- output parent missing is created only by publish under allowlisted root
- output parent symlink escape rejected
- complete does not create missing parent
- output realpath escape rejected

### 18.6 Check and Close

- `mailbox-pump` does not write status evidence
- `cmdCheck` with mailbox evidence does not bump stageRevision just to persist mailbox data
- `mailbox-close --after-check` fails without clearing status when check fails
- `mailbox-close --after-check` check success transitions `receipt-seen|output-detected` to `check-passed` inside the task lock
- crash after check-passed event but before session update retries safely
- crash after check-passed event records/reuses `mailbox.check-passed` event schema fields for recovery comparison
- crash after session becomes `check-passed` but before close ledger retries into normal close
- check-passed retry with mismatched snapshot or receipt refs rejects and requires reconcile
- receipt-seen cannot close directly
- output-detected cannot close directly
- needs-input cannot close directly
- failed cannot close directly
- check-passed can close
- abandoned can close
- rejected can close
- taken-over can close
- close success clears status mailbox fields
- repeated close after success is idempotent

### 18.7 Close Crash Recovery

- crash after close event written: retry does not conflict and continues
- crash after session closed before status clear: retry clears status
- crash after status clear but ledger remains `session-closed`: retry writes recovery event, advances ledger to `status-cleared -> close-committed`, and does not modify already-cleared status
- crash after status clear and ledger `status-cleared`: retry writes close-committed event
- status cleared but session not closed and ledger shows close started: recovery closes session and commits
- close recovery never writes schema-unknown `abandoned-closed`; abnormal origin is recorded as `closeReason` or recovery event
- no ledger, session closed, status active match: recovery ledger is created and status is cleared
- no ledger, session closed, status already cleared: idempotent success
- session/status cursor mismatch: no automatic clear, rejected recovery event
- status active points to another session: no automatic clear, rejected recovery event
- close ledger payloadHash collision: fail closed and write security/collision event
- running close three times converges to session closed, status mailbox empty, ledger close-committed

### 18.8 No Side Effects

- mailbox flow does not invoke Warp helper
- mailbox flow does not call clipboard commands
- mailbox flow does not use frontmost window
- mailbox flow does not read `.claude/settings.json`
- mailbox flow does not read token/key/cookie paths
- mailbox flow does not auto approve, deliver, commit, push, or tag

## 19. Phase Plan

### Phase A

Deliver:

- formal architecture document
- status v5 schema draft
- mailbox schema draft
- CLI contract
- publish state machine and recovery table
- close state machine and recovery table
- test plan

No code implementation.

### Phase B

Deliver only after Phase A review passes:

- neutral file protocol helper module
- independent MailboxStore
- schema validation tests
- atomic write, collision, and recovery tests

### Phase C

Deliver only after Phase B review passes:

- mailbox CLI skeleton
- V2 guard integration
- operator-assisted flow tests

### Later Optional Phase

Daemon or loop mode may be considered only after operator-assisted mode is stable. It requires separate review and must not change the close-before-advance gate.

## 20. Acceptance Criteria for Phase A Review

Phase A is review-ready when this document is present and covers:

- status v5 mailbox schema
- independent mailbox store boundary
- skill boundary: do not modify `hexai-xxx`; use `nNian-xxx` for new skills
- command allow matrix
- mailbox cursor and active cursor hash
- path allowlist rules
- publish ledger recovery
- close ledger recovery, including status cleared while ledger remains `session-closed`
- receipt sequence/HMAC rules
- append-only operator and recovery events
- complete test plan

## 21. Fix Mapping

| Finding | Status | Plan Update | Rationale |
| --- | --- | --- | --- |
| MAILBOX-P1-01 | fixed | Added status v5, independent mailbox active guard, command matrix | Prevent mailbox fail-open and avoid V3 execution pollution |
| MAILBOX-P1-02 | fixed | Added mailbox cursor and activeCursorHash | Provides mailbox-specific fencing |
| MAILBOX-P1-03 | fixed | Store-owned receipt sequence and HMAC proof | Keeps receipts durable and auditable |
| MAILBOX-P1-04 | fixed | Peek-first operator flow with explicit claim/start/complete | Prevents accidental stale claimed sessions |
| MAILBOX-P1-05 | fixed | Added realpath allowlist, symlink rejection, prompt hash recheck | Defines safe file boundaries |
| MAILBOX-P1-06 | fixed | Defined independent MailboxStore layout | Avoids V3 store contamination |
| MAILBOX-P1-07 | fixed | Added publish phase ledger and recovery table | Makes publish crash states auditable |
| MAILBOX-P2-01 | fixed | Mailbox evidence stays in session/event store, not status | Avoids stageRevision drift |
| MAILBOX-P2-02 | fixed | Added append-only operator event schema | Makes manual gates auditable |
| MAILBOX-P2-03 | fixed | Operator-assisted complete does not require heartbeat freshness | Matches long manual execution |
| MAILBOX-P2-04 | fixed | Expanded schema/path/corrupt/recovery/no-side-effect tests | Provides regression coverage |
| MAILBOX-REV2-P1-01 | fixed | Chose close-before-advance; close only terminal-safe states | Avoids atomic advance complexity |
| MAILBOX-REV2-P1-02 | fixed | Commands require committed ledger, active status, cursor hash match | Prevents execution from crash middle states |
| MAILBOX-REV2-P2-01 | fixed | Publish creates missing output parent only inside allowlist | Handles missing report dirs safely |
| MAILBOX-REV2-P2-02 | fixed | Added close/advance and uncommitted publish tests | Covers state machine regressions |
| MAILBOX-REV3-P1-01 | fixed | Added close phase ledger and idempotent recovery matrix | Prevents unrecoverable active mailbox after close crash |
| MAILBOX-REV3-P2-01 | fixed | Added close crash recovery tests | Makes close recovery testable |
| MAILBOX-REV4-P2-01 | fixed | Explicitly covers status cleared while ledger remains `session-closed` | Closes final documented recovery gap |
| MAILBOX-PHASEA-P1-01 | fixed | Defined `mailbox-close --after-check` success transaction, `check-passed` transition, and crash retry rules | Makes the standard `complete -> pump -> close --after-check -> advance` flow reachable |
| MAILBOX-PHASEA-P1-02 | fixed | Added publish ledger schema, operationHash/publishContentHash rules, phase write rules, and independent committed marker schema | Makes committed/status-active/cursor fencing implementable and auditable |
| MAILBOX-PHASEA-P1-03 | fixed | Added `mailbox-bind` CLI contract, binding id safety, generation/replace rules, nonce `0600`, and role/generation replay checks | Closes the HMAC proof identity boundary |
| MAILBOX-PHASEA-P2-01 | fixed | Removed `abandoned-closed`; recovery uses `state=closed` plus `closeReason`/recovery event | Keeps session states aligned with schema |
| MAILBOX-PHASEA-P2-02 | fixed | Added per-command CLI contract with args, preconditions, side effects, transitions, receipt/event behavior | Gives Phase C skeleton and tests a concrete acceptance contract |
| MAILBOX-PHASEA-REV-P1-01 | fixed | Split publish hash contract into stable `operationHash` and post-artifact `publishContentHash`; updated committed marker, retry rules, reconcile commit-marker, and tests | Removes self-contradictory payloadHash semantics and makes publish resume/collision checks implementable |
| MAILBOX-PHASEA-REV-P2-01 | fixed | Added `mailbox.check-passed` event schema and crash recovery comparison requirements | Makes `--after-check` audit/recovery format testable |
| MAILBOX-PHASEA-REV-P2-02 | fixed | Added `publish-committed/<sessionId>.json` to storage layout and clarified close uses `close-committed` ledger phase/event rather than a publish-style marker | Keeps storage and terminology consistent |
| MAILBOX-PHASEA-REV-P2-03 | fixed | Added binding recovery rule and tests for live binding with missing nonce repaired by `mailbox-bind --replace` | Makes binding crash state recoverable without accepting stale proof |
