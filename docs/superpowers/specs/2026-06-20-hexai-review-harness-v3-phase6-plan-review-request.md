# HEXAI Review Harness V3 Phase 6 Plan Review Request

Date: 2026-06-20

## Review Target

Please review:

- `docs/superpowers/specs/2026-06-20-hexai-review-harness-v3-phase6-real-wrapper-helper-plan.md`

## Context

Phase 5 implementation and code fixes are approved and committed at `3d8a044`. A manual Claude Code health check in Warp has passed, and Phase 5 allowlist preparation exists for the current `W6-A-04 implementation-plan -> plan-review` pilot unit.

Current `pilot-doctor W6-A` remains correctly fail-closed because:

- hook capability evidence is missing;
- wrapper bindings are missing;
- real `warp-macos` capability evidence is missing;
- target bindings are missing.

This Phase 6 plan proposes the missing real wrapper/helper/capability evidence producers. It does not request permission to run the real W6 pilot.

## Intended Boundary

Allowed in Phase 6:

- real Claude Code wrapper/session proof;
- real hook capability capture and receipt publisher;
- real macOS/Warp helper process boundary;
- non-fixture `warp-macos` capability evidence;
- strict target scan/bind/challenge;
- shadow/dry-run validation;
- diagnostics that allow `pilot-doctor` to report readiness.

Not allowed in Phase 6:

- broad production rollout;
- automatic permission approval;
- automatic delivery acceptance;
- automatic commit/push/tag;
- clipboard, frontmost-only, or title-only fallback;
- screen-text/sleep/fresh-output completion inference;
- running real W6 pilot before Phase 6 Code Review approval and explicit operator decision.

## Review Questions

Please focus on P0/P1/P2 issues in:

1. wrapper/session nonce and heartbeat proof model;
2. hook capability evidence and receipt publisher boundaries;
3. real helper `scan-targets` / `submit-text` / `interrupt` protocol;
4. target fingerprint and challenge binding;
5. submit side-effect state mapping and uncertain handling;
6. crash/restart/fencing with existing Phase 2-5 contracts;
7. privacy constraints and evidence redaction;
8. whether any part accidentally authorizes real W6 pilot too early.

Please return `Approved` or `Changes Required` with structured findings.
