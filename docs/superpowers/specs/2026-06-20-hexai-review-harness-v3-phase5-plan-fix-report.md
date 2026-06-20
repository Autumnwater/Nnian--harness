# HEXAI Review Harness V3 Phase 5 实施方案修订报告

## 修订结论

已按 Phase 5 Plan Review 的 3 个 P1 和 1 个 P2 修订计划。当前修订仍只涉及文档，不进入实现，不启用真实 W6 pilot。

方案已收敛为：一个 canonical work/review stage pair 的受控 pilot，`work` 与 `review` completion 都必须走现有 Phase 2 workflow CAS；allowlist 授权快照必须捕获并在 dispatch/restart/retry/cancel/reconcile/takeover 前 fencing；attempt budget 区分 prepared、dispatch、submitted；阶段风险分类必须从 canonical workflow/status metadata 派生，不能信任 allowlist 自声明。

## Review 问题处理表

| 编号 | 严重度 | Review 问题 | 处理状态 | 修订位置 |
|------|--------|-------------|----------|----------|
| V3-PH5-PLAN-P1-01 | P1 | `work`/`review` 与 workflow CAS 关系不清，可能跳过 review 或形成第二套 workflow | 已修复 | Phase 5 plan §5、§6、§6.1、§10、§12 |
| V3-PH5-PLAN-P1-02 | P1 | allowlist 未捕获授权快照，prepare 后过期/漂移/restart 可能继续 dispatch | 已修复 | Phase 5 plan §3、§4、§4.1、§10、§12 |
| V3-PH5-PLAN-P1-03 | P1 | `maxAttemptsPerRole: 1` 与 safe retry / not-sent retry 冲突 | 已修复 | Phase 5 plan §4、§4.1、§6.2、§10、§12 |
| V3-PH5-PLAN-P2-01 | P2 | allowlist 示例的 `delivery:false` 等字段可能被错误信任 | 已修复 | Phase 5 plan §4、§5、§10、§11、§12 |

## 关键修订说明

### V3-PH5-PLAN-P1-01 — 顺序角色与 workflow CAS

- 原问题：计划把 `work`/`review` 放在同一个 `stageId` 下，但又要求复用现有 Supervisor workflow CAS；`work` completion 可能直接 advance，导致 review 无法执行，或者 role artifact 变成第二套 workflow。
- 修订方式：将 Phase 5 pilot unit 定义为现有 canonical workflow 中的一对 stage：`workStageId -> reviewStageId -> next canonical stage/manual gate`。`work` completion 只能通过一次 CAS 从 `workStageId` 推进到 `reviewStageId`；`review` completion 才能通过一次 CAS 推进到后续 stage/gate。
- 为什么这样修：workflow cursor 仍是唯一 source of truth；role progress 只作为 audit/sequencing artifact，不拥有 advance 权限。
- 对范围/契约/实现的影响：实现必须新增 role progress rebuild，但不得新增第二套 workflow state machine。测试必须覆盖 work 不跳过 review、review drift fail-closed、review completion 才满足后续 gate。

### V3-PH5-PLAN-P1-02 — allowlist 授权快照与 fencing

- 原问题：allowlist 只在 prepare 前检查，prepare 后过期、hash 漂移、stage/cursor 漂移或 crash/restart 都可能继续基于旧授权 dispatch。
- 修订方式：新增 `allowlistId`、`allowlistHash`、`pilotAuthorization` 快照，捕获到 operation/job/attempt/lease；dispatch、restart recovery、retry、cancel、reconcile、takeover 均需重算当前状态并 fencing。
- 为什么这样修：Phase 5 pilot 授权是 side-effect 边界的一部分，必须和 AttemptRef/leaseToken/lockEpoch 一样进入 durable fencing。
- 对范围/契约/实现的影响：实现需新增 stale/expired/drifted allowlist 的负向测试，特别是 crash-after-prepare-then-expired 与 restart-pre-dispatch-with-stale-allowlist。

### V3-PH5-PLAN-P1-03 — attempt budget 语义

- 原问题：`maxAttemptsPerRole: 1` 同时允许 safe retry/not-sent retry，语义冲突，可能误阻断安全 retry 或绕过预算造成多次真实提交。
- 修订方式：拆分预算为 `maxPreparedAttemptsPerRole`、`maxDispatchAttemptsPerRole`、`maxSubmittedAttemptsPerRole`、`maxSafeRetryAttemptsPerRole`、`maxNotSentRetryAttemptsPerRole`；定义 `submitted` 只由 durable submitted evidence 或 reconcile sent 消耗。
- 为什么这样修：Phase 5 的关键安全边界是“每 role 最多一次 side-effectful submitted attempt”，而不是“最多一个 record”。
- 对范围/契约/实现的影响：safe-before-side-effect 和 not-sent retry 不消耗 submitted budget，但受独立上限；dispatch-uncertain 在 reconcile 前不能 retry。

### V3-PH5-PLAN-P2-01 — canonical stage classification

- 原问题：allowlist 示例中的 `delivery:false` / `commitCheckpoint:false` 像是 operator-controlled 字段，可能绕过不可逆阶段拒绝。
- 修订方式：明确 `pilot-allow` 必须从 canonical workflow/status metadata 派生 stage classification 与 hash；operator-provided false flags 被忽略。
- 为什么这样修：风险分类必须来自系统已知 workflow，不可由授权请求自证。
- 对范围/契约/实现的影响：测试必须覆盖 operator-provided false flags 不可绕过 delivery/acceptance/commit/push/tag 拒绝。

## 修订后的实施范围

### 本轮做

- 修订 Phase 5 计划。
- 明确 work/review stage pair、workflow CAS 边界、role progress 的非权威属性。
- 明确 allowlist 授权快照与 fencing。
- 明确 attempt budget 与 retry 计数。
- 明确 canonical stage classification。

### 本轮不做

- 不写实现代码。
- 不启用真实 W6 pilot。
- 不实现自动 permission approval、delivery acceptance、commit/push/tag。
- 不放宽 Phase 2/3/4 fencing。

## 异常路径与边界条件

| 场景 | 处理策略 | 是否本轮覆盖 |
|------|----------|--------------|
| work completion 后 crash，role progress 未写 | 从 status history + terminal job/attempt 重建 role progress，不重复 advance | 是 |
| role progress 完成但 status 未 advance | role progress 视为不完整证据，必须 replay receipt/pump，不 dispatch review | 是 |
| allowlist prepare 后过期 | pre-dispatch/restart/retry fail-closed，不 dispatch | 是 |
| allowlist hash/classification drift | fail-closed，记录 operator-required | 是 |
| operator 把 delivery 标成 false | 忽略 operator flags，使用 canonical classification 拒绝 | 是 |
| safe-before-side-effect retry | 不消耗 submitted budget，消耗 safe retry budget | 是 |
| second submitted attempt | 拒绝 | 是 |
| dispatch-uncertain retry | reconcile 前拒绝 | 是 |

## 验收方式

- `git diff --check`
- Phase 5 plan review 复审
- 后续实现阶段必须新增计划中列出的 unit/CLI multi-process/fixture/crash-restart 负向测试。

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH5-PLAN-P1-01 | fixed | 将 pilot 从单 stage 改为 canonical `workStageId -> reviewStageId` stage pair；定义 work/review completion 的 workflow CAS、role progress rebuild 和负向测试。 | 防止 work 跳过 review，避免第二套 workflow。 |
| V3-PH5-PLAN-P1-02 | fixed | 新增 allowlistId/hash、pilotAuthorization 快照，要求 prepare/dispatch/restart/retry/cancel/reconcile/takeover 全链路 fencing。 | 防止 prepare 后授权过期/漂移仍产生 side effect。 |
| V3-PH5-PLAN-P1-03 | fixed | 拆分 prepared/dispatch/submitted/safeRetry/notSentRetry 预算，定义 submitted 单调计数和 retry 规则。 | 保留安全 retry，同时保证每 role 最多一次 side-effectful submitted attempt。 |
| V3-PH5-PLAN-P2-01 | fixed | 明确 stage classification 必须从 canonical workflow/status metadata 派生，operator-provided false flags 不可信。 | 防止 allowlist 自声明绕过 delivery/acceptance/commit/push/tag 拒绝。 |

## 仍需用户确认

无。

## 下一步建议

可以重新提交 Phase 5 Plan Fix Review。获批前仍不得进入 Phase 5 实现或真实 W6 pilot。
