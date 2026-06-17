# HEXAI Review Harness — Agent Instructions

## Overview

HEXAI Review Harness V1 is a lightweight orchestration layer for multi-agent weekly task R&D workflows (W6-A, W7-A, etc.). It manages stage transitions, prompt generation, state tracking, and document gate checks across the A/B往复 (implementer ↔ reviewer round-trip) process.

## Core Principles

1. **Harness is a state machine, not an agent.** It generates prompts and checks gates; it does not execute review or implementation logic.
2. **Codex retains final authority.** Harness manages the middle A/B round-trip; Codex owns overall planning and final sign-off.
3. **Machine-readable state lives in `runs/`.** Human-readable reports live in `/Users/admin/project/ai/review/W6/<subtaskId>/`.
4. **Never read or modify `.claude/settings.json`, API keys, tokens, or cookies.**
5. **Never modify `/Users/admin/project/ai/work/HEXAI` business code.** Only the implementer agent (with the correct profile) may do so.

## Agent Profiles

Three profiles define capability boundaries:

- **claude-implementer-minimax** — writes implementation plans, plan fixes, code, code fixes, and delivery reports. Works in `/Users/admin/project/ai/work/HEXAI`. Cannot approve its own work.
- **claude-reviewer-deepseek** — reviews plans and code, writes review findings. Works in `/Users/admin/project/ai/review`. Cannot modify business code by default.
- **codex-overall-reviewer** — final sign-off and overall planning. Harness does not substitute for this role.

## Phase Bindings

| Phase | requiredSkill | Owner |
|-------|--------------|-------|
| implementation-plan | null | claude-implementer-minimax |
| plan-review | hexai-plan-review | claude-reviewer-deepseek |
| plan-fix | hexai-plan-fix | claude-implementer-minimax |
| plan-fix-review | hexai-plan-review | claude-reviewer-deepseek |
| code-implementation | null | claude-implementer-minimax |
| code-review | hexai-code-review | claude-reviewer-deepseek |
| code-fix | hexai-code-fix | claude-implementer-minimax |
| code-fix-review | hexai-code-review | claude-reviewer-deepseek |
| delivery | hexai-delivery | claude-implementer-minimax |
| done | null | codex-overall-reviewer |

## Directory Contract

- **Human reports:** `/Users/admin/project/ai/review/W6/<subtaskId>/`
- **Machine state:** `/Users/admin/project/ai/review/Harness/runs/<taskId>/`
- **Playbooks:** `/Users/admin/project/ai/review/ReviewPlaybooks/`
- **Business code:** `/Users/admin/project/ai/work/HEXAI/`

## W6-A Built-in Subtasks

W6-A-01 缩放锚点
W6-A-02 移动磁吸与红色参考线
W6-A-03 选中态控制点cursor收口
W6-A-04 CV-06编辑元素阶段补齐
W6-A-05 Space后移项跟踪
W6-A-06 右侧Agent边界确认

W6-A-01 was completed before Harness creation and is imported as `imported-completed`.
