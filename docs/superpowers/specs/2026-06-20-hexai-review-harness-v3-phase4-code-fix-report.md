# HEXAI Review Harness V3 Phase 4 Code Fix 报告

Date: 2026-06-20

## 修复结论

Phase 4 Code Review 提出的 4 个 P1 finding 已按最小范围修复，可以重新提交 Fix Review。

本轮仍严格保持 Phase 4 边界：未实现 real W6 pilot、真实项目 production `run --adapter warp-macos`、clipboard/frontmost fallback、automatic approval、screen-text/sleep/fresh-output completion inference 或 Phase 5 production enablement。

## 修复清单

| 编号 | 严重度 | Review 问题 | 处理状态 | 修改文件 |
|------|--------|-------------|----------|----------|
| V3-PH4-CODE-P1-01 | P1 | target discovery/binding 未做 two-scan 稳定性和 missing/duplicate/changed/title-only fail-closed | 已修复 | `scripts/warp-macos-adapter.js`, `scripts/harness.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` |
| V3-PH4-CODE-P1-02 | P1 | active attempt 期间可改写 target binding，dispatch/cancel 未重新校验当前 binding/target/capability | 已修复 | `scripts/harness.js`, `scripts/warp-macos-adapter.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` |
| V3-PH4-CODE-P1-03 | P1 | `warp-macos --production-test` run 未强制 Phase 3 hook completion 与 needs-input capability | 已修复 | `scripts/harness.js`, `tests/harness.test.js` |
| V3-PH4-CODE-P1-04 | P1 | SubmitResult 未验证 candidate fingerprint 与 durable helper evidence | 已修复 | `scripts/warp-macos-adapter.js`, `scripts/execution-store.js`, `tests/warp-macos-adapter.test.js` |

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-PH4-CODE-P1-01 | fixed | `scripts/warp-macos-adapter.js`, `scripts/harness.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` | `discoverStableTarget` 执行两次 scan 并要求唯一、稳定、非 title/frontmost-only fingerprint；CLI 覆盖 zero/duplicate/changed/title-only fail-closed。 |
| V3-PH4-CODE-P1-02 | fixed | `scripts/harness.js`, `scripts/warp-macos-adapter.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` | `warp-bind-target` 进入 execution lock 且 active related attempt 时拒绝；dispatch/cancel side effect 前重新校验当前 binding、secret hash、heartbeat、targetBinding、capability evidence 与 attempt-captured adapterIdentity。 |
| V3-PH4-CODE-P1-03 | fixed | `scripts/harness.js`, `tests/harness.test.js` | `run --adapter warp-macos --production-test` 在 prepare 前要求 Phase 3 hook completion 与 needs-input capability 均 available；缺失/ completion-only 均返回 capability unavailable 且不创建 active attempt。 |
| V3-PH4-CODE-P1-04 | fixed | `scripts/warp-macos-adapter.js`, `scripts/execution-store.js`, `tests/warp-macos-adapter.test.js` | SubmitResult 映射验证 expected target fingerprint 与 durable transport evidence；missing/mismatch evidence 不再算 submitted 或 safe retry。 |

## 关键修复说明

### target discovery/binding two-scan 稳定性

- 原问题：`warp-bind-target` 接受任意 `--candidate` 并本地合成 fingerprint，无法证明目标唯一、稳定，也无法拒绝 title-only/frontmost-only。
- 修复方式：新增 `discoverStableTarget`，通过 helper 执行两次 scan，要求同 role/candidate 精确唯一，且两次 target fingerprint hash 完全一致；fingerprint 若只来自 title/tab/frontmost 则 fail-closed。
- 为什么这样修：Phase 4 只能做 fixture/shadow spike，但仍需要把 target discovery 的安全契约固定为可测试协议。
- 行为影响：`warp-bind-target` 在 zero/duplicate/changed/title-only/frontmost-only 场景拒绝绑定，不写 verified target binding。

### active attempt 与 adapterIdentity fencing

- 原问题：active attempt 期间仍可改写 target binding；dispatch/cancel 只依赖 helper health scan，未重新读取当前 binding/target/capability。
- 修复方式：`warp-bind-target` 纳入 task execution lock，并在相关 active attempt 存在时拒绝；`WarpMacosAdapter.dispatch/cancel` 在 side effect 前重新读取当前 binding、secret、heartbeat、targetBinding 和 warp capability evidence，逐字段比对 captured `adapterIdentity`。
- 为什么这样修：target binding 是 attempt fencing 的一部分，不能在 active attempt 中静默漂移，也不能让 stale helper snapshot 执行 submit/interrupt。
- 行为影响：binding/session/target/capability 任一字段漂移或 heartbeat stale，dispatch/cancel 均 fail-closed，不产生 helper side effect。

### warp production-test hook capability gate

- 原问题：`run --adapter warp-macos --production-test` 只看 warp capability evidence，未要求 authoritative completion 与 needs-input capability。
- 修复方式：warp production-test run 在 `cmdNext`/prepare 前读取 Phase 3 hook evidence，要求 `completionReceiptCapability=available` 且 `needsInputCapability=available`。
- 为什么这样修：批准计划禁止 completion-only degraded production path，scratch production-test 也必须具备完成和 needs-input 双能力。
- 行为影响：缺 hook、completion-only、needs-input missing 均返回 `capability-unavailable`，且不 prepare job、不设置 active refs。

### SubmitResult durable evidence 验证

- 原问题：wrong candidate 的 `submitted/none` 结果或缺失 evidence 的结果可被接受为 submitted / safe before side effect。
- 修复方式：新增 transport evidence 写读方法；fixture helper 为 submit result 写 durable evidence；`assertSideEffectMapping` 验证 candidate fingerprint、operation、AttemptRef、sideEffectState、usedClipboard 与 evidence 完全匹配。
- 为什么这样修：`none`/`submitted` 都是安全关键状态，必须有 durable helper evidence 支撑；否则只能进入 uncertain。
- 行为影响：wrong fingerprint、missing evidence、evidence mismatch 均映射为 `dispatch-uncertain`，不会被当成安全 retry 或已提交。

## 修改文件

- `scripts/execution-store.js`
- `scripts/harness.js`
- `scripts/warp-macos-adapter.js`
- `tests/harness.test.js`
- `tests/warp-macos-adapter.test.js`
- `docs/superpowers/specs/2026-06-20-hexai-review-harness-v3-phase4-code-fix-report.md`

## 验证结果

- `node --test tests/warp-macos-adapter.test.js tests/harness.test.js`: 166/166 pass，0 fail/cancel/skip。
- `pnpm test`: 228/228 pass，0 fail/cancel/skip。
- `node --check scripts/harness.js`: 通过。
- `node --check scripts/warp-macos-adapter.js`: 通过。
- `node --check scripts/execution-supervisor.js`: 通过。
- `node --check scripts/execution-store.js`: 通过。
- `node --check scripts/execution-protocol.js`: 通过。
- `node --check scripts/workflow-core.js`: 通过。
- `schemas/status.schema.json` parse: 通过。
- `git diff --check`: 通过。

## 未处理事项

无。

## 下一步建议

可以重新提交 Phase 4 Code Fix Review。当前不自动 commit/push，等待用户明确指令。
