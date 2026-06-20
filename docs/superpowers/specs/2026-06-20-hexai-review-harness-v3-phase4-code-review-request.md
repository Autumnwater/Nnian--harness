# HEXAI Review Harness V3 Phase 4 Code Review Request

Date: 2026-06-20

## Scope

Phase 4 implementation is limited to the approved `warp-macos` adapter capability spike, fixture-backed target discovery/binding, target-side challenge protocol, side-effect classification, and diagnostic/shadow CLI surface.

Out of scope and not implemented: real W6 pilot, real project production `run --adapter warp-macos`, clipboard/frontmost fallback, automatic permission approval, screen-text/sleep/fresh-output completion inference, and Phase 5 production enablement.

## Current diff under review

Base commit: `148e2e1 feat: execution supervisor v3 phase4 — warp adapter and implementation plan`

Current working tree additionally changes:

- `scripts/warp-macos-adapter.js`
  - keeps fixture capability evidence usable for diagnostics while requiring explicit Phase 4 production-test evidence for dispatch;
  - preserves fail-closed submit side-effect mapping: only durable `sideEffectState=none` can map to `failed-before-side-effect`; partial/unknown input maps to `dispatch-uncertain`; clipboard use is rejected.
- `scripts/execution-store.js`
  - allows the same target challenge payload to advance from `issued` to `verified` without false conflict, while still rejecting conflicting payload identity.
- `scripts/harness.js`
  - wires command-first Phase 4 CLI commands: `warp-doctor`, `warp-targets`, `warp-bind-target`, `warp-shadow-send`;
  - blocks real W6 / real project `run --adapter warp-macos` with `warp-macos-production-disabled`;
  - supports `warp-doctor --probe-fixture` as diagnostic capability evidence without writing workflow status;
  - implements target challenge issue/fixture-response verification and stores verified target binding metadata on the existing wrapper binding record;
  - lists redacted bound targets without raw nonce leakage;
  - runs `warp-shadow-send` as diagnostic-only shadow dispatch without mutating workflow status.
- `tests/warp-macos-adapter.test.js`
  - covers capability derivation, diagnostic vs Phase 4 run enablement, submit side-effect mapping, clipboard rejection, target challenge response verification, replay rejection, and raw nonce non-persistence in binding records.
- `tests/harness.test.js`
  - covers default `warp-macos` unavailable diagnostics and real W6 run blocking;
  - covers fixture target challenge issue/verify/replay behavior and status read-only boundary;
  - covers shadow send uncertain mapping, clipboard rejection, and status read-only boundary.

The current `HEAD` already contains the earlier Phase 4 plan/fix report, adapter identity capture/fencing, target challenge store helpers, and partial `warp-macos` adapter skeleton.

## Review focus

Please perform V3 Phase 4 Code Review against the approved Phase 4 plan. Focus areas:

1. Phase 4 boundary enforcement: no real W6 production run, no Phase 5 production enablement, no clipboard/frontmost fallback, no automatic approval.
2. Capability gating: diagnostic eligibility vs Phase 4 run enablement remain separated; fixture evidence does not silently enable real production run.
3. Target challenge protocol: challenge payload/response identity, one-time/replay behavior, proof validation, and target binding metadata persistence.
4. Adapter identity and fencing: `adapterIdentity` metadata remains opaque and compatible with Phase 2/3 AttemptRef/lease/lockEpoch fencing.
5. Side-effect mapping: only durable `none` maps to safe pre-side-effect failure; `input-mutated`, `unknown`, timeout-like results, or clipboard use fail closed/uncertain.
6. Read/write boundaries: diagnostic commands and shadow send do not mutate workflow `status.json` or active refs.

## Verification

- `node --test tests/warp-macos-adapter.test.js tests/harness.test.js`: 161/161 pass, 0 fail/cancel/skip.
- `pnpm test`: 223/223 pass, 0 fail/cancel/skip.
- `node --check`: `scripts/harness.js`, `scripts/execution-supervisor.js`, `scripts/execution-store.js`, `scripts/execution-protocol.js`, `scripts/workflow-core.js`, `scripts/warp-macos-adapter.js` pass.
- `schemas/status.schema.json` parses successfully.
- `git diff --check` passes.

## Review request

Please review the current Phase 4 implementation and return Approved or Changes Required with P0/P1/P2 findings. The intended review boundary is Phase 4 only; do not require Phase 5 real Warp production pilot behavior in this review.
