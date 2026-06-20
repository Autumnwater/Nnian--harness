# HEXAI Review Harness V3 Phase 5 Code Fix 报告

Date: 2026-06-20

## 修复结论

Phase 5 Code Review 提出的 2 个 P1 finding 已按最小范围修复，可以重新提交 Fix Review。

本轮仍保持 Phase 5 边界：不启用 broad production rollout，不做 automatic approval、automatic delivery、commit、push、tag，也不绕过 Phase 3/4 capability、binding、target fencing。

## 修复清单

| 编号 | 严重度 | Review 问题 | 处理状态 | 修改文件 |
|------|--------|-------------|----------|----------|
| V3-PH5-CODE-P1-01 | P1 | `run --adapter warp-macos --phase5-pilot` 仍复用 Phase 4 fixture helper/evidence，fixture 可伪装 real W6 pilot | 已修复 | `scripts/harness.js`, `scripts/warp-macos-adapter.js`, `tests/harness.test.js` |
| V3-PH5-CODE-P1-02 | P1 | Phase 5 preconditions 与 `pilotAuthorization` 在 `prepare` task lock 事务外生成，allowlist/target/capability 漂移后仍可能创建 dispatchable attempt | 已修复 | `scripts/harness.js`, `scripts/execution-supervisor.js`, `tests/harness.test.js` |

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-PH5-CODE-P1-01 | fixed | `scripts/harness.js`, `scripts/warp-macos-adapter.js`, `tests/harness.test.js` | Phase 5 capability gate 区分 fixture `production-test` 与 real pilot；fixture evidence 的 `phase5ProductionCandidate` 不再可用；真实 Phase 5 未启用 test helper 时无 real helper 即 fail-closed；新增 W6 + fixture-only evidence + `--phase5-pilot` 拒绝且无 active refs 测试。 |
| V3-PH5-CODE-P1-02 | fixed | `scripts/harness.js`, `scripts/execution-supervisor.js`, `tests/harness.test.js` | `ExecutionSupervisor.prepare()` 在 task lock transaction 内重新读取 status、resolve target、capture pilotAuthorization；capture 回调在写 operation/job/attempt/lease 前重读 allowlist、hook capability、warp capability、binding/target identity 并生成 snapshot；新增 after-next allowlist expiration/capability drift 测试，断言无 active refs、无 attempt record。 |

## 关键修复说明

### Phase 5 real pilot 不再使用 fixture evidence 伪装

- 原问题：`--phase5-pilot` 被映射成 `productionTest + scratchTask`，导致 Phase 4 fixture evidence/helper 可以进入 W6 pilot dispatch。
- 修复方式：`deriveWarpCapabilities()` 新增 `requirePhase5Pilot` 语义；Phase 5 production candidate 必须来自 non-fixture evidence。`cmdWorkerRun()` 不再把 `phase5Pilot` 强行映射为 `productionTest/scratchTask`。fixture helper 仅在 `--production-test` scratch/test 路径或测试显式开关下启用；真实 Phase 5 没有 real helper 时 fail-closed。
- 为什么这样修：Phase 5 的批准边界是 real W6 pilot / real adapter path。fixture 只能验证协议，不能成为真实 W6 pilot 的授权证据。
- 行为影响：W6 即使带 `--phase5-pilot`、allowlist、hook capability、verified target，只要 warp evidence 是 fixture-only，就返回 capability unavailable，且不创建 active attempt/job。

### pilotAuthorization 移入 prepare 锁内生成

- 原问题：CLI 在锁外做 preflight，并在 `cmdNext` 后、`prepare` 前生成 `pilotAuthorization`；allowlist/capability/binding/target 在窗口内漂移时，可能先创建 operation/job/attempt/lease 和 active refs，再到 dispatch/recovery 才失败。
- 修复方式：`ExecutionSupervisor.prepare()` 改为在 task execution lock transaction 内执行 recovery、重读 status、resolve target、capture pilotAuthorization，再写 operation/job/attempt/lease/status。Harness runtime 提供 `capturePilotAuthorization` 回调，在锁内重读 allowlist、hook capability、warp capability、binding/target identity 并生成 snapshot。
- 为什么这样修：批准计划要求所有 real W6 pilot preconditions 在 task lock 内成立，否则不得创建 dispatchable attempt。
- 行为影响：preflight 与 prepare 之间发生 allowlist 过期、allowlist hash 漂移、capability stale/drift、target/binding identity mismatch，均在写 operation/job/attempt/lease 前 fail-closed。

## 修改文件

- `scripts/execution-supervisor.js`
- `scripts/harness.js`
- `scripts/warp-macos-adapter.js`
- `tests/harness.test.js`
- `docs/superpowers/specs/2026-06-20-hexai-review-harness-v3-phase5-code-fix-report.md`

## 验证结果

- `node --test tests/harness.test.js tests/warp-macos-adapter.test.js`: 175/175 pass，0 fail/cancel/skip。
- `pnpm test`: 237/237 pass，0 fail/cancel/skip。
- `node --check scripts/harness.js`: 通过。
- `node --check scripts/execution-supervisor.js`: 通过。
- `node --check scripts/warp-macos-adapter.js`: 通过。
- `node --check scripts/execution-store.js`: 通过。
- `node --check scripts/execution-protocol.js`: 通过。
- `node --check scripts/workflow-core.js`: 通过。
- `schemas/status.schema.json` parse: 通过。
- `git diff --check`: 通过。

## 未处理事项

无。

## 下一步建议

可以重新提交 Phase 5 Code Fix Review。当前不自动 commit/push，等待用户明确指令。
