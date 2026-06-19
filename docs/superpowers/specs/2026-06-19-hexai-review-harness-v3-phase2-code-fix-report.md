# HEXAI Review Harness V3 Phase 2 Code Fix 报告

基线：`0d5630d`。本轮仅修复 Phase 2 Supervisor Code Review findings，不实现 Hook、Wrapper identity/sessionNonce、authoritative needs-input 或 Warp Accessibility。

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-PH2-CODE-P1-01 | fixed | `scripts/workflow-core.js`、`scripts/harness.js`、`scripts/execution-supervisor.js`、`tests/harness.test.js`、`tests/workflow-core.test.js` | 已接入真实 task lock/StatusStore/CAS，增加 doctor/run/pump/jobs/retry/cancel/reconcile/takeover；fake CLI E2E 覆盖 freshness、delivery acceptance、commit checkpoint、stale cancel；manual run 在创建 operation 前稳定返回 manual-required |
| V3-PH2-CODE-P1-02 | fixed | `scripts/execution-supervisor.js`、`scripts/execution-store.js`、`tests/execution-supervisor.test.js` | operation intent/payloadHash/expected revisions 驱动 prepare/retry roll-forward 或 scoped rollback；fault injection 覆盖 operation/job/attempt/lease/status 边界和 orphan lease |
| V3-PH2-CODE-P1-03 | fixed | `scripts/execution-supervisor.js`、`scripts/execution-protocol.js`、`tests/execution-supervisor.test.js` | dispatch 在短锁内唯一 claim；AbortSignal + settle barrier 在锁外等待；late resolve/reject、restart settle、cancel/reconcile/retry/takeover 全部按 operationId/AttemptRef/lease/lockEpoch fencing |
| V3-PH2-CODE-P1-04 | fixed | `scripts/execution-supervisor.js`、`scripts/execution-store.js`、`tests/execution-supervisor.test.js` | receipt application 以 durable phase ledger 重放，event journal 按 eventId 去重；覆盖 attempt/job 部分提交、malformed/profile/clock-skew/gap/duplicate/stale/collision 的稳定归类 |
| V3-PH2-CODE-P1-05 | fixed | `scripts/workflow-core.js`、`scripts/harness.js`、`scripts/execution-supervisor.js`、`tests/workflow-core.test.js`、`tests/execution-supervisor.test.js`、`tests/harness.test.js` | pure check/advance 复用真实 gate；cursor、AttemptRef、primary SHA/size 绑定；单次 status CAS 提交；workflow/terminal CAS 后崩溃可由 status history marker 补齐 Job/Attempt/Lease，且不重复 advance |
| V3-PH2-CODE-P1-06 | fixed | `scripts/execution-protocol.js`、`tests/execution-protocol.test.js` | `createEvent` 与 Supervisor 统一输出/校验 protocolVersion、kind、sequence、occurredAt、AttemptRef；createEvent→publish→pump 契约通过 |
| V3-PH2-CODE-P2-01 | fixed | `docs/superpowers/specs/2026-06-19-hexai-review-harness-v3-phase2-implementation-plan.md` | 已清理 trailing whitespace；`git diff 0d5630d --check` 通过 |
| V3-PH2-CODE-P1-07 | fixed | `scripts/execution-protocol.js`、`scripts/execution-store.js`、`scripts/harness.js`、`tests/harness.test.js` | fake adapter transport evidence 已持久化到 `runs/<task>/transports/<bindingId>.json`；跨 CLI 重启缺失 durable evidence 时返回 unsettled/ambiguous，不再把内存 miss 当作 aborted-before-side-effect；真实多进程 run→cancel/takeover/delivery 测试覆盖 |

## 关键修复

- `state-cas-conflict`：真实 StatusStore 的 load/CAS 比较使用纯读取迁移，禁止 CAS 前的隐式 status 写回；写入口始终在 task execution lock 内重读并比较 stateRevision。
- Supervisor pump：每个持久化转换短持锁，dispatch/settle 等待不持锁；restart 首先恢复 operation coordinator，再消费 receipt 或 completion evidence。
- 控制面：cancel 使用完整 AttemptRef；uncertain 只能通过 sent/not-sent/abandon 裁决；not-sent 强制三项事实确认、reason 和 residual risk；retry 仅接受 pre-dispatch failure 或已 quiesced 的 reconciled-not-sent；通用 takeover 不得绕过 uncertain 或 transport-in-flight。
- workflow 提交：completion receipt 与 workflow completion 分离。gate/freshness 未通过时保留 active refs；通过后以一次 status CAS 写入 transition/history/active-ref cleanup，再幂等完成 terminal records。
- delivery：active worker 等待期间允许在同一 task lock 内记录人工验收证据，但不改变 stageRevision；Supervisor 仍执行真实 acceptance/freshness gate，并停在人工 commit checkpoint。
- foreground run：`run` 不再 dispatch 后立即退出；提交后循环执行有界短锁 pump tick，等待期间不持 task lock，并在 terminal、dispatch-uncertain、gate/commit checkpoint 或 operator action 后退出。真实多进程测试覆盖 cancel、takeover、delivery accept 并发进入。
- failed-before-dispatch：仅 adapter 明确证明 side effect 前失败（同步 safe throw、safe rejected Promise、显式 `failed-before-side-effect`）才持久化为 `failed-before-dispatch` 并允许 retry；模糊异常仍进入 dispatch-uncertain。
- receipt lifecycle：pump 扫描全部 inbox，不只 active attempt；superseded/fenced/bad lease/AttemptRef mismatch receipt 稳定 rejected，不阻塞其他事件；`job.failed` 走 terminal CAS 并释放匹配 lease。
- lockEpoch fencing：receipt evidence、workflow evaluate/derive/CAS 前均校验 operationId、AttemptRef、active lease 与 `status.execution.lockEpoch`；stale recovery 后的旧 completion receipt 不得推进 workflow。
- init reset：`init --force`/`--archive-existing` 在写入新 status 前清理旧 run 目录，避免 schema4 多文件 execution artifacts 残留影响新 run。

## 验证结果

- `pnpm test`：205/205 pass，0 fail/cancel/skip。
- `node --check`：`scripts/harness.js`、`scripts/execution-supervisor.js`、`scripts/execution-store.js`、`scripts/workflow-core.js` 通过。
- `schemas/status.schema.json`：JSON parse 通过。
- `git diff --check`：通过。
- `git diff 0d5630d --check`：通过。

当前未 commit/push，等待独立 Fix Review。
