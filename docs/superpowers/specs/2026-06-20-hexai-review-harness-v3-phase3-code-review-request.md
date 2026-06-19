# HEXAI Review Harness V3 Phase 3 Code Fix Review Request

Date: 2026-06-20

## Scope

Phase 3 implementation is limited to the approved wrapper/attach protocol skeleton, binding/session identity, receipt publisher, needs-input integration, hook capability evidence, and fake/shadow CLI verification.

Out of scope and not implemented: Warp Accessibility, Warp pane discovery/selection/input injection, automatic permission approval, real W6 pilot, Wrapper identity beyond local binding/session records, and completion inferred from terminal UI/sleep/fresh-output alone.

## Current diff under review

Base commit: `997c646 feat: execution supervisor v3 phase2 — lock/CAS operation lifecycle, fault-injection tests`

Current working tree additionally changes:

- `scripts/harness.js`
  - wires command-first Phase 3 CLI commands into dispatcher: `worker-attach`, `worker-bindings`, `worker-challenge`, `worker-receipt`;
  - loads workflow config for those commands;
  - serializes non-dry-run `worker-attach` under task execution lock;
  - keeps `worker-attach --dry-run` status read-only;
  - stops foreground `run` on `needs-input`;
  - implements challenge issue/verify with HMAC proof, stale binding checks, replay rejection, and bad proof rejection;
  - validates hook capability evidence schema, freshness, version drift, completion phase, injection proof, and needs-input category source.
- `scripts/execution-supervisor.js`
  - rejects `job.needs-input` receipts unless `details.category` is one of the approved authoritative categories;
  - validates wrapper-backed receipts against current binding record, binding state, heartbeat freshness, attempt-captured identity, local secret hash, and HMAC proof.
- `tests/execution-supervisor.test.js`
  - covers valid needs-input category and missing-category rejection;
  - covers stale binding heartbeat rejection for completion and needs-input receipts;
  - covers the approved needs-input category enum and shorthand rejection.
- `tests/harness.test.js`
  - covers worker attach dry-run read-only behavior;
  - verifies raw nonce is excluded from binding JSON, command output, and diagnostics;
  - verifies binding replacement is rejected while an active attempt exists;
  - verifies `worker-receipt` can publish needs-input and foreground `run` stops without clearing active refs/lease;
  - verifies hook capability evidence is recorded and reported by `doctor` without modifying status;
  - verifies challenge issue/verify, bad proof rejection, challenge replay rejection, and stale binding rejection;
  - verifies missing/stale/drifted/incomplete hook capability evidence stays unavailable.

The current `HEAD` already contains the earlier Phase 3 foundation: binding store, nonce hash/proof helpers, attempt-captured binding identity, receipt proof verification, capability record helpers, and supervisor unit tests for proof replay.

## Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-PH3-CODE-P1-01 | fixed | `scripts/execution-supervisor.js`, `tests/execution-supervisor.test.js` | Stale wrapper heartbeat completion/needs-input receipts are rejected as `binding-stale` without workflow/status advancement. |
| V3-PH3-CODE-P1-02 | fixed | `scripts/harness.js`, `tests/harness.test.js` | `worker-challenge` now issues one-time challenge records and verifies HMAC proof; bad proof, replay, stale binding, and missing secret paths fail closed. |
| V3-PH3-CODE-P1-03 | fixed | `scripts/harness.js`, `tests/harness.test.js` | Hook capability evidence requires source/version/freshness/completion phase/injection proof/needs-input source; missing/stale/drifted/incomplete evidence remains unavailable. |
| V3-PH3-CODE-P2-01 | fixed | `scripts/execution-supervisor.js`, `scripts/harness.js`, `tests/execution-supervisor.test.js`, `tests/harness.test.js` | Needs-input categories now match plan enum: `permission-request`, `agent-question`, `authentication-required`, `external-intervention`; shorthand is rejected. |

## Verification

- `pnpm test`: 217/217 pass, 0 fail/cancel/skip.
- `node --check`: `scripts/harness.js`, `scripts/execution-supervisor.js`, `scripts/execution-store.js`, `scripts/execution-protocol.js`, `scripts/workflow-core.js` pass.
- `schemas/status.schema.json` parses successfully.
- `git diff --check` passes.

## Review request

Please perform V3 Phase 3 Code Fix Review against the approved Phase 3 plan and prior Code Review findings. Focus areas:

1. nonce/proof storage and leakage boundaries;
2. binding generation / active replacement fencing;
3. needs-input state machine and run/cancel/takeover interactions;
4. receipt category/profile validation and replay safety;
5. command-first CLI compatibility and read/write boundaries;
6. confirmation that no Phase 4 / Warp Accessibility functionality was introduced.
