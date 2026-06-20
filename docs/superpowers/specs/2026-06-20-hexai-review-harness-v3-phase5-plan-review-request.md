# HEXAI Review Harness V3 Phase 5 Plan Review Request

**Date:** 2026-06-20  
**Plan under review:** `docs/superpowers/specs/2026-06-20-hexai-review-harness-v3-phase5-implementation-plan.md`  
**Baseline:** Phase 4 commit `0bc55e6`

Please review the Phase 5 plan and return `Approved` or `Changes Required` with P0/P1/P2 findings.

## Intended Scope

Phase 5 is a controlled W6 pilot enablement phase:

- one low-risk non-delivery W6 work/review stage pair;
- sequential `workStageId` then `reviewStageId` roles using existing workflow CAS;
- real `warp-macos` adapter path only behind explicit Phase 5 pilot gate;
- existing Supervisor run loop, task lock, CAS, AttemptRef, leaseToken, lockEpoch, wrapper/session HMAC proof, and target fingerprint fencing remain mandatory;
- manual fallback remains immediate.

## Out of Scope

Please treat the following as intentionally out of scope:

- broad production rollout;
- parallel work/review workers;
- automatic permission approval;
- automatic delivery acceptance;
- automatic commit/push/tag;
- clipboard/frontmost fallback;
- screen-text, sleep, notification, or fresh-output-only completion inference;
- enabling real W6 production run without allowlist, fresh capability evidence, verified bindings, and explicit operator confirmations.

## Review Focus

Please focus on:

1. Whether the Phase 5 pilot gate is strong enough to prevent accidental real W6 dispatch.
2. Whether the allowlist model safely excludes delivery, acceptance, commit checkpoint, push, tag, and irreversible stages.
3. Whether sequential `work`/`review` role progress can be implemented without creating a second workflow state machine.
4. Whether Phase 2/3/4 fencing remains intact for dispatch, cancel, receipt application, retry, reconcile, takeover, and restart recovery.
5. Whether crash/restart and late receipt paths are covered before implementation.
6. Whether manual fallback and `dispatch-uncertain` adjudication remain safe.
7. Whether allowlist authorization snapshot, canonical classification hash, and attempt budget semantics close the Plan Review findings.

## Current Verification

- Working tree was clean after user commit/push before this plan.
- This request only adds Phase 5 planning documents.
- The plan has been revised after the first Phase 5 Plan Review; see the companion fix report.
- No implementation has been started.
