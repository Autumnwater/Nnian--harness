# HEXAI Review Harness V1 — Design Specification

**Date:** 2026-06-16
**Version:** 1.0
**Status:** Implemented

## Problem Statement

HEXAI's multi-agent weekly task R&D process involves repeated A/B round-trips between implementer (Claude A) and reviewer (Claude B). Without a harness, each round-trip requires manual context reconstruction, prompt authoring, and gate checking. This leads to:

- Inconsistent prompt quality across rounds
- Missing or incomplete handoff documentation
- Unclear stage transitions and gate criteria
- Difficulty resuming after token exhaustion or interruption

## Design Goals

1. **Lightweight** — No external dependencies, single-file Node.js implementation
2. **Stateful** — Machine-readable JSON state tracks every stage transition
3. **Prompt-first** — Generates structured, complete prompts for each stage
4. **Gate-enforcing** — Checks deliverables before allowing stage advancement
5. **Interruption-resilient** — Supports interrupt/resume with handoff tracking

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Codex (Final Sign-off)            │
└─────────────────────────────────────────────────────┘
                         ▲
                         │ delivery / done
                         │
┌─────────────────────────────────────────────────────┐
│                  Review Harness V1                   │
│                                                     │
│  init → next → check → advance → (repeat)           │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ Claude A │◄──►│ Harness   │◄──►│ Claude B │      │
│  │(implem.) │    │ (state)   │    │(reviewer)│      │
│  └──────────┘    └──────────┘    └──────────┘      │
└─────────────────────────────────────────────────────┘
```

## State Model

Each run is stored as `runs/<taskId>/status.json`:

```json
{
  "taskId": "W6-A",
  "taskTitle": "W6-A 画布本体UIUX收口",
  "createdAt": "2026-06-16T...",
  "updatedAt": "2026-06-16T...",
  "currentSubtask": "W6-A-02",
  "currentStage": "implementation-plan",
  "subtasks": {
    "W6-A-01": { ... },
    "W6-A-02": { ... }
  },
  "history": [ ... ]
}
```

## Stage State Machine

Each subtask progresses through 10 stages. Each stage has a `stageStatus`:

- `pending` — not yet started
- `active` — currently being worked on
- `interrupted` — paused mid-work (token exhaustion, context limit, external)
- `completed` — gate passed, deliverables present
- `blocked` — cannot proceed (P0/P1 open, missing dependency)
- `skipped` — intentionally skipped
- `imported-completed` — completed before Harness existed
- `assumed-completed` — manually marked complete with residual risk

## Product Path Contract

All human-readable reports go to: `/Users/admin/project/ai/review/W6/<subtaskId>/`
Machine-readable copies go to: `Harness/runs/<taskId>/outputs/<subtaskId>/`
Handoff documents go to both locations.

## Gate Rules

1. `primaryReportPath` must exist and be non-empty
2. `mirrorOutputPath` should exist (warning if not)
3. No open P0/P1 findings
4. P2 findings default-block unless explicitly deferred
5. Implementer and reviewer must be different profiles
6. `delivery` stage requires delivery summary and evidence paths
7. `interrupted` stages cannot advance without handoff + primary report

## Built-in W6-A Subtasks

1. W6-A-01 缩放锚点 (imported-completed)
2. W6-A-02 移动磁吸与红色参考线
3. W6-A-03 选中态控制点cursor收口
4. W6-A-04 CV-06编辑元素阶段补齐
5. W6-A-05 Space后移项跟踪
6. W6-A-06 右侧Agent边界确认
