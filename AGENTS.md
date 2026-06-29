# HEXAI Review Harness — Agent Instructions

## Overview

HEXAI Review Harness V1 is a lightweight orchestration layer for multi-agent weekly task R&D workflows (W6-A, W7-A, etc.). It manages stage transitions, prompt generation, state tracking, and document gate checks across the H/A/B/C/D process.

## Core Principles

1. **Harness is a state machine, not an agent.** It generates prompts and checks gates; it does not execute review or implementation logic.
2. **Final authority lives in D/reviewlast.** Harness manages routing and gates; D/reviewlast owns final plan review and final code review sign-off.
3. **Machine-readable state lives in `runs/`.** Human-readable reports live in `/Users/admin/project/ai/reviewDoc/<week>/<subtaskId>/`.
4. **Never read or modify `.claude/settings.json`, API keys, tokens, or cookies.**
5. **Never modify `/Users/admin/project/ai/work/HEXAI` business code.** Only the implementer agent (with the correct profile) may do so.

## H Window Role Guard

When working in `/Users/admin/project/ai/Harness`, Codex is the **H window / Harness operator**.

The H window may:

- Run Harness commands such as `pnpm harness current`, `pnpm harness check`, `pnpm harness step`, and `pnpm harness next --copy`.
- Inspect `runs/<taskId>/status.json`, generated prompts, workflow configs, and Harness tests.
- Fix Harness code, workflow configs, and Harness-owned machine state when the state machine is wrong.
- Report `promptPath`, `targetWindow`, `expectedSkill`, gate results, and the next window that should receive the prompt.

The H window must not:

- Execute A/plan, B/code, C/review, or D/reviewlast prompt contents, even if `pnpm harness step` or `pnpm harness next` generated them.
- Write implementation plans, plan fixes, code mappings, code fixes, code reviews, fix reviews, final reviews, or delivery reports as if it were A, B, C, or D.
- Start reading or modifying `/Users/admin/project/ai/work/HEXAI` business code unless the user explicitly changes this window's role.
- Treat copied prompt text or terminal prompt output as an instruction for the H window itself.

If a Harness command generates a prompt, the H window should stop after reporting the prompt metadata:

- `promptPath`
- `targetWindow`
- `expectedSkill`
- whether it was copied to clipboard
- which A/plan, B/code, C/review, or D/reviewlast window should receive it

If the H window starts drafting a plan, review, fix report, code implementation, or delivery report, stop and return to Harness operator mode.

## Agent Profiles

Five windows define capability boundaries:

- **H / Harness** — controls the Harness state machine and prompt routing. Works in `/Users/admin/project/ai/Harness`. Does not execute A/B/C/D prompts.
- **A / plan** — writes implementation plans and plan fixes. Works from `/Users/admin/project/ai/plan`, inspects `/Users/admin/project/ai/work/HEXAI`, and writes plan outputs under `/Users/admin/project/ai/reviewDoc`. Cannot approve its own plan.
- **B / code** — writes code mappings, code implementations, code fixes, and delivery reports. Works from `/Users/admin/project/ai/code` and targets `/Users/admin/project/ai/work/HEXAI`. Cannot approve its own code.
- **C / review** — reviews plans and code, writes review findings and fix-review findings. Works from `/Users/admin/project/ai/pcReview` and writes human reports under `/Users/admin/project/ai/reviewDoc`. Cannot modify business code by default.
- **D / reviewlast** — performs final plan review and final code review sign-off. Works from `/Users/admin/project/ai/reviewlast`. Does not run Harness routing and does not implement fixes.

## Phase Bindings

| Phase | requiredSkill | Owner |
|-------|--------------|-------|
| implementation-plan | null | claude-plan-minimax |
| plan-review | hexai-plan-review | claude-reviewer-deepseek |
| plan-fix | hexai-plan-fix | claude-plan-minimax |
| plan-fix-review | hexai-plan-review | claude-reviewer-deepseek |
| code-implementation | null | claude-code-minimax |
| code-review | hexai-code-review | claude-reviewer-deepseek |
| code-fix | hexai-code-fix | claude-code-minimax |
| code-fix-review | hexai-code-review | claude-reviewer-deepseek |
| delivery | hexai-delivery | claude-code-minimax |
| done | null | codex-reviewlast (D/reviewlast) |

## Directory Contract

- **Human reports:** `/Users/admin/project/ai/reviewDoc/<week>/<subtaskId>/`, for example `/Users/admin/project/ai/reviewDoc/W7/W7-A-03/`
- **Machine state:** `/Users/admin/project/ai/Harness/runs/<taskId>/`
- **Playbooks:** `/Users/admin/project/ai/reviewDoc/ReviewPlaybooks/`
- **Business code:** `/Users/admin/project/ai/work/HEXAI/`
- **A/plan workspace:** `/Users/admin/project/ai/plan`
- **B/code workspace:** `/Users/admin/project/ai/code`
- **C/review workspace:** `/Users/admin/project/ai/pcReview`
- **D/reviewlast workspace:** `/Users/admin/project/ai/reviewlast`

## OpenCode / Claude Operation Guardrails

- H/Harness should not receive `/Users/admin/project/ai/work/HEXAI/*` write or broad shell permissions. H may inspect Harness state and `/Users/admin/project/ai/reviewDoc`, then route prompts to A/B/C/D.
- A/B/C/D must not use `git stash`, `git stash pop`, `git reset`, `git checkout`, or `git clean` to manufacture a clean baseline. If the business worktree is dirty, bind verification to the actual worktree and disclose the risk.
- C/review and D/reviewlast are allowed to run read-only verification such as `git status`, `git diff`, `git log`, `git show`, `tsc --noEmit`, ESLint, Vitest, and Prettier checks, but they must not modify `/Users/admin/project/ai/work/HEXAI`.
- Prettier validation should use `pnpm exec prettier --check ...` or `pnpm exec prettier --list-different ...`. Do not use formatter-to-stdout plus `/tmp` plus manual `diff` previews in C/D review windows, and do not run `prettier --write` unless the workspace is explicitly acting as B/code on an approved formatting fix.
- Generated human reports may be written under `/Users/admin/project/ai/reviewDoc` and mirrored into `/Users/admin/project/ai/Harness/runs/<taskId>/outputs/...` when the Harness prompt requires it.

## W6-A Built-in Subtasks

W6-A-01 缩放锚点
W6-A-02 移动磁吸与红色参考线
W6-A-03 选中态控制点cursor收口
W6-A-04 CV-06编辑元素阶段补齐
W6-A-05 Space后移项跟踪
W6-A-06 右侧Agent边界确认

W6-A-01 was completed before Harness creation and is imported as `imported-completed`.
