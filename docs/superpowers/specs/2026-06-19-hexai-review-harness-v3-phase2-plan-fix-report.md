# HEXAI Review Harness V3 Phase 2 Supervisor 实施方案修订报告

## 修订结论

第二轮 Fix 已修复 reopened 的 V3-PH2-PLAN-P1-01/P1-03：transport timeout 现在要求底层 abort/settle barrier，未 quiesced 时禁止任何替代发送；worker completion 与 workflow completion 已分离，并明确抽取无副作用 check evaluator/advance transition，以单次 status CAS 提交 workflow effect。上一轮已关闭的 P1-02、P1-04、P2-01 保持不变。计划可重新提交 Review，当前未进入代码实现。

## Review 问题处理表

| 编号 | 严重度 | Review 问题 | 处理状态 | 修订位置 |
| --- | --- | --- | --- | --- |
| V3-PH2-PLAN-P1-01 | P1 | timeout 后底层 dispatch 可能继续并迟到产生 side effect | 已修复 | 主计划 §3.2、§3.3、§5、§9 |
| V3-PH2-PLAN-P1-02 | P1 | Job/Attempt/Lease/status 跨文件写入无 durable commit/recovery | 已修复 | 主计划 §4、§8、§9 |
| V3-PH2-PLAN-P1-03 | P1 | cmdCheck/cmdAdvance 独立保存导致部分状态和 revision 漂移 | 已修复 | 主计划 §2、§7、§8、§9 |
| V3-PH2-PLAN-P1-04 | P1 | not-sent 证据不足且 takeover 可绕过 uncertain 裁决 | 已修复 | 主计划 §5、§9 |
| V3-PH2-PLAN-P2-01 | P2 | receipt profile/sequence 与 fake target fail-closed 不完整 | 已修复 | 主计划 §5、§6、§9 |

## 关键修订说明

### Supervisor pump 与锁边界

- 原问题：Promise timeout 只停止调用方等待，底层 dispatch 仍可能迟到提交输入。
- 修订方式：adapter 必须实现 AbortSignal + settleDispatch；timeout 后持久化 transport-in-flight/abort-requested，保留 lease/tombstone。只有底层明确 settled/quiesced 才允许 not-sent/retry；迟到返回按 operationId/AttemptRef fencing。
- 为什么这样修：把“调用方超时”与“transport 已停止”分开，未确认 quiesced 时任何路径都不能产生替代派发。
- 影响：fake adapter 增加 deferred transport 测试；真实 adapter 后续也必须满足 capability，否则 fail-closed。

### Durable prepare/commit/recovery

- 原问题：多个原子文件写不等于一个原子 transaction。
- 修订方式：以 operation record 协调 Job、Attempt、pending Lease 和 status；status history/CAS 为逻辑提交点，恢复按提交点完成或 scoped rollback。
- 为什么这样修：任何崩溃边界都能判定唯一归宿，不遗留占用 lease 或重复 Job。
- 影响：新增 operation runtime 文件与 fault injection，不修改 Phase 3 identity。

### Receipt application ledger

- 原问题：现有 cmdCheck/cmdAdvance 会分别保存 status，失败 check 也 bump revision，无法实现计划宣称的单次 CAS。
- 修订方式：新增无持久化副作用的 evaluateStageCheck/deriveAdvanceTransition；手工 CLI 使用兼容 committer，Supervisor 使用同一 snapshot 在一次 CAS 中提交 check evidence + workflow transition。completion receipt 先落为 worker-completed-awaiting-check 并稳定 finalize。
- 为什么这样修：output 晚到或 gate 失败时可基于持久化 completion evidence 重评，不重复 receipt、不保存失败 check、不产生 cursor/revision 漂移。
- 影响：新增 crash-between-check-and-advance、completion 先到/output 后到、gate failure 与 terminal cleanup 测试；V2.4 手工行为保持兼容。

### uncertain-send 裁决

- 原问题：not-sent 只有自由文本，takeover 可绕开裁决。
- 修订方式：not-sent 强制 target quiescent、Prompt not visible、Prompt not running 三项布尔确认，以及 reason/residual-risk；uncertain takeover 统一 `reconcile-required`。
- 为什么这样修：替代派发前必须留下可审计事实，通用人工接管不能绕过重复发送风险。
- 影响：迟到 receipt 永久 stale，只有显式 retry 可在 not-sent 后新建 attempt。

### Receipt 与 fake target profile

- 原问题：关键字段、sequence 与 role/binding 唯一解析没有可执行规则。
- 修订方式：本阶段要求 protocolVersion/kind/sequence/occurredAt，sequence 连续递增；定义 collision/gap/stale 行为；fake target 必须 role+binding 唯一匹配。
- 为什么这样修：Phase 2 能先验证 Supervisor 协议，而 sessionNonce 仍明确延后 Phase 3。
- 影响：不宣称 fake target 具有生产 identity。

## 修订后的实施范围

### 本轮做

- Supervisor run/pump、短锁状态机和重启恢复。
- operation record 与 receipt application ledger。
- doctor/run/pump/jobs/retry/cancel/reconcile/takeover 契约。
- fake/manual adapter 与 receipt/target fail-closed 测试。

### 本轮不做

- Claude Code Hook、Wrapper attach/sessionNonce/identity。
- authoritative needs-input integration。
- Warp/macOS Accessibility、UI selector 或生产输入注入。
- 自动批准、自动 delivery acceptance 或自动 commit。

## 异常路径与边界条件

| 场景 | 处理策略 | 是否本轮覆盖 |
| --- | --- | --- |
| prepare 任一文件写后崩溃 | operation 恢复后完成提交或 scoped rollback | 是 |
| dispatching 崩溃/超时 | dispatch-uncertain，禁止自动重发 | 是 |
| timeout 后 transport 未停止 | 保持 transport-in-flight 与 lease/tombstone，禁止 not-sent/retry | 是 |
| dispatch 迟到 resolve/reject | operationId/AttemptRef fencing，只补 settle evidence | 是 |
| receipt apply 中途崩溃 | ledger phase 重放，effect 最多一次 | 是 |
| completion 已接受但 output 未 fresh | receipt processed，Job awaiting-check，active refs 保留 | 是 |
| check/gate 重放失败 | 不保存 status、不递增 revision，后续 pump 可重评 | 是 |
| sequence gap/collision | pending 或稳定 rejected，不越过缺口 | 是 |
| uncertain takeover | `reconcile-required` | 是 |
| missing/duplicate/wrong-role target | dispatch 前 fail-closed | 是 |
| sessionNonce 缺失 | Phase 2 不作为 identity；生产能力 unavailable | 后移 Phase 3 |
| Warp target 操作 | 不实现 | 后移 Phase 4 |

## 验收方式

- operation/receipt 每个 durable 边界的 fault-injection 单测。
- run 等待期间 cancel/reconcile/takeover 和双 pump 并发测试。
- timeout 后 transport 继续、迟到 resolve/reject、settle 永不确认及 concurrent cancel/reconcile/retry 测试。
- pure evaluator/transition、单次 CAS、失败重评 revision 不漂移、completion/output 乱序与 terminal cleanup 测试。
- protocolVersion/kind/occurredAt/sequence、collision/gap/stale 负向测试。
- fake work/review、missing/duplicate/binding mismatch/role mismatch 测试。
- `pnpm test`、五个脚本 `node --check`（含新增 workflow-core）、schema parse、`git diff --check`。

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH2-PLAN-P1-01 | fixed | 定义 abort/settle barrier、transport-in-flight/tombstone 与 late-return fencing | 未确认底层 quiesced 时禁止 not-sent、retry 或替代 attempt |
| V3-PH2-PLAN-P1-02 | fixed | 定义 operation coordinator、pending lease、逻辑提交点和逐边界恢复 | 使跨文件 transaction 可判定完成或回滚 |
| V3-PH2-PLAN-P1-03 | fixed | 抽取 pure check/advance；分离 worker/workflow completion；单次 CAS 提交 transition | 避免部分 check/advance、revision 漂移和过早 cleanup |
| V3-PH2-PLAN-P1-04 | fixed | not-sent 五项强制证据；uncertain 禁止 takeover | 防止绕过人工裁决产生替代派发 |
| V3-PH2-PLAN-P2-01 | fixed | 补齐 receipt profile/sequence 和 fake target 唯一解析测试 | Phase 2 先落实可验证协议，sessionNonce 延后 Phase 3 |

## 仍需用户确认

无。

## 下一步建议

重新提交 Phase 2 Plan Review。Review Approved 前不进入实现。
