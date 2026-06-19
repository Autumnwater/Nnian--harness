# HEXAI Review Harness V3 Phase 2 Supervisor 实施计划

日期：2026-06-19
状态：Fix 后待 Review
前置版本：V3 Phase 1，commit `3e212c2`

## 1. 目标与边界

在不依赖 Claude Code Hook、Wrapper identity、Warp 或 macOS Accessibility 的前提下，实现可恢复、可审计、attempt-scoped 的 Supervisor，并使用 fake adapter 验证从任务派发到 workflow 条件推进的完整闭环。

本阶段必须保持以下边界：

- 默认仍为 `execution.mode = "manual"`；只有显式 worker 命令才启动 Job。
- 不实现 Wrapper/attach handshake、session nonce、authoritative needs-input Hook 或 Warp 输入注入。
- `dispatching` 之后的模糊结果一律进入 `dispatch-uncertain`，禁止自动重发。
- 所有状态变更复用 task execution lock，并通过 stage cursor、attemptId、leaseToken 和 lockEpoch fencing。
- delivery 人工验收和 commit checkpoint 不得被 Supervisor 绕过。
- fake adapter 只验证 Phase 2 协议，不宣称生产 target identity 已成立。

## 2. 代码结构与持久化布局

新增：

- `scripts/execution-store.js`：Job、Attempt、Lease、Event、operation record、receipt application ledger 与 inbox 的原子持久化。
- `scripts/execution-supervisor.js`：纯业务状态机；依赖注入 adapter、时钟、store 和 Core command functions。
- `scripts/workflow-core.js`：从现有 `cmdCheck/cmdAdvance` 抽取无持久化副作用的 `evaluateStageCheck` 与 `deriveAdvanceTransition`；只返回 evaluation/nextStatus，不写 status、不递增 revision。
- `tests/execution-store.test.js`：原子写、故障注入、重复事件、迟到/错误 receipt 和恢复测试。
- `tests/execution-supervisor.test.js`：pump、派发、完成、超时、重试、取消、接管和 CAS 测试。

修改：

- `scripts/harness.js`：增加 `doctor/run/pump/jobs/retry/cancel/reconcile` CLI；现有手工 `cmdCheck/cmdAdvance` 改为调用 workflow-core 后按原兼容语义分别持久化，CLI 输出和 V2.4 行为不变。
- `scripts/execution-protocol.js`：补充 Phase 2 receipt profile、transport settle contract、稳定枚举和校验器，不放置文件系统或 CLI 逻辑。
- `tests/harness.test.js`：CLI 集成和 V2.4/V3 回归。

持久化布局：

```text
runs/<taskId>/operations/<operationId>.json
runs/<taskId>/jobs/<jobId>.json
runs/<taskId>/attempts/<attemptId>.json
runs/<taskId>/events/worker.jsonl
runs/<taskId>/events/index/<eventId>.json
runs/<taskId>/leases/<bindingId>.json
runs/<taskId>/receipt-applications/<attemptId>/<eventId>.json
runs/<taskId>/receipts/inbox/<attemptId>/<eventId>.json
runs/<taskId>/receipts/processed/<attemptId>/<eventId>.json
runs/<taskId>/receipts/rejected/<attemptId>/<eventId>.json
```

所有 JSON record 使用同目录 temp + fsync + rename + directory fsync。JSONL 仅由持有 task lock 的 Supervisor 追加并 fsync；启动时若发现未换行的尾部记录，只允许依据 application ledger/index 验证后截断该不完整尾部。

## 3. Supervisor pump 与锁生命周期

### 3.1 明确入口

`run` 是阻塞式前台 orchestration：

```text
prepare/commit dispatch → bounded dispatch → pump → completion/check/advance 或 stop
```

`run` 在等待 receipt、timeout 或人工动作时不持有 task lock。它每次 pump tick 只执行一个有界 transaction：获取锁、重新读取 status/records、恢复未完成 operation、消费当前可处理 receipt、执行一次状态转换、CAS 保存、释放锁，然后短暂等待下一 tick。

`pump <taskId>` 是可恢复入口：原 `run` 进程退出或 Harness 重启后，操作员可启动 pump 接管同一 active attempt。多个 pump 可竞争，但 task lock、operationId 与 CAS 保证同一转换只提交一次；后获得锁者读取已提交结果并返回幂等状态。

### 3.2 Adapter transport settle contract

单纯 `Promise.race(timeout)` 不代表 transport 已停止。本阶段把可终止/可确认 settle 作为 adapter capability，协议扩展为等价接口：

```ts
dispatch(job, target, { operationId, signal }): Promise<DispatchTransportResult>
settleDispatch(attempt, target, { operationId }): Promise<TransportSettleResult>
```

`TransportSettleResult` 必须明确 `settled: true`，并给出 `outcome = submitted | aborted-before-side-effect | failed-before-side-effect | ambiguous`。fake adapter 使用受控 deferred operation 验证该契约；后续真实 adapter 只有在 AbortSignal 能终止底层操作（例如终止受控子进程/进程组并等待退出）且 `settleDispatch` 可确认后才允许启用。只取消 JS 等待、不等待底层退出不算 settled。adapter 不声明 `abortableDispatch + settleBarrier` 时，`run` 在 prepare 前 fail-closed。

dispatch transaction：

1. 锁内恢复 operation，验证 AttemptRef、lease、target 和 cursor，写 `dispatching`、`transportState=in-flight`、operationId。
2. 调用 adapter dispatch；正常 settle 后锁内记录结果。
3. 到达 `dispatchTimeoutMs` 时请求 AbortSignal，但不把 timeout 当作 settle。状态变为 `dispatch-uncertain + transport-in-flight/abort-requested`，释放 task lock，使其他命令能够读取该状态。
4. timeout transaction 释放锁后，run/pump 在锁外执行可取消、有限时长的 `settleDispatch` 等待/探测；durable transport-in-flight 状态在此期间阻止其他发送。取得 settle result 后重新获取 task lock并再次 fencing，只有 adapter 明确返回 settled 才写 `transportState=quiesced|submitted|ambiguous-settled`；无法确认时永久保持 transport-in-flight，不释放 target lease。
5. adapter 的迟到 resolve/reject 必须重新获取 task lock，并以 `operationId + AttemptRef + leaseToken` fencing。它只能补充原 operation 的 settle evidence，不能覆盖 reconcile/terminal 状态、不能清除新 attempt、不能触发重派。

`transport-in-flight` 期间：

- `not-sent`、`retry` 和会产生替代 attempt 的 takeover 全部返回 `transport-not-quiesced`。
- `cancel` 只能请求 abort 并进入 `cancel-pending-settle`；收到 settled evidence 前不得宣称 cancelled 或释放 lease。
- `reconcile sent` 可记录“同一 attempt 可能已发送”并继续等待，但不创建替代 attempt。
- `reconcile abandon` 在 transport-in-flight 时只能记录 `abandon-pending-settle`，不得清 active refs或交回可推进的人工 workflow；settle 后才可终结为 abandon。若永远无法 settle，则 task 保持失败关闭，且 binding lease/tombstone 永久阻止替代派发。
- 只有 `aborted-before-side-effect` 或 `failed-before-side-effect` 的 quiesced evidence，加上 §5 的全部人工 not-sent 证据，才允许 not-sent/retry。

锁不覆盖 receipt 等待。若底层 dispatch 尚未 settled，锁可释放，但 durable transport-in-flight 状态和 lease 会阻止所有替代发送。

### 3.3 并发与重启测试

- `run` 等待 receipt 时，`cancel` 可获取锁并终结 attempt，run 下个 tick 幂等退出。
- `dispatch-uncertain` 等待时，`reconcile` 可进入；通用 takeover 被拒绝。
- 非 uncertain active attempt 可被显式 takeover，run 下个 tick观察到 fencing 后退出。
- run 进程在 dispatch-submitted 后退出，`pump` 从相同 attempt/sequence 继续。
- 两个 pump 并发处理同一 receipt，只允许一个 application commit。
- adapter timeout 后 deferred dispatch 继续运行时，not-sent/retry/takeover 均被阻止；cancel 只进入 pending-settle。
- timeout 后迟到 resolve、迟到 reject、settle 永不确认三种情况均按 operation/attempt fencing，且不覆盖已记录裁决。

## 4. Durable prepare/commit/recovery 协议

跨 Job、Attempt、Lease 与 status 的创建不宣称文件系统原子性。`operations/<operationId>.json` 是 durable transaction coordinator，内含不可变 payload hash、expected status revision/cursor、目标文件、AttemptRef 和 phase。

### 4.1 Dispatch prepare transaction

顺序与提交点：

1. 写 `operation.phase = intent`，记录完整 Job/Attempt/pending Lease payload 和预期 cursor。
2. 写 Job=`preparing`。
3. 写 Attempt=`prepared`、`dispatchingPersisted=false`。
4. 写 Lease=`pending`；pending lease 不可被 adapter 使用，但阻止同 binding 的第二个 prepare。
5. CAS 写 status active refs；同一次 status 保存记录 `worker-dispatch-committed` history 与 `operationId`。
6. 将 operation 标记 `committed`，再把 Job/Attempt/Lease 幂等 materialize 为 active/prepared 状态。

第 5 步的 status CAS/history 是逻辑提交点。恢复总是先读取 operation 与最新 status：

| 崩溃位置 | 恢复归宿 |
| --- | --- |
| intent 前 | 无 durable effect，可重新 run |
| intent 后、status commit 前 | 若 status 无该 operationId/AttemptRef，则归档孤立 Job/Attempt，删除仅属于该 operation 的 pending lease，并标记 rolled-back |
| status commit 已完成、operation 未标 committed | 依据 status history 完成 operation commit 和 active materialization，不创建新 Job |
| committed 后、部分 materialize | 按 operation payload 幂等补齐，不覆盖其他 attempt/lease |
| capability preflight 返回 manual/unavailable | 发生在 intent 前，无 durable effect，不创建 Job/Attempt/Lease |
| prepare commit 后、dispatching 前出现可证明 pre-dispatch failure | 在同一 operation 中记 `failed-before-dispatch`，清除匹配 active refs，释放本 operation 的 pending/active lease；允许安全显式 retry |

删除或释放 lease 前必须同时匹配 `operationId + attemptId + leaseToken`；orphan recovery 不得移除新 owner lease。

### 4.2 Fault injection

在 operation intent、Job、Attempt、pending Lease、status commit、operation committed、active materialize 每个边界注入崩溃。每次重放必须满足：只有一个 logical Job、最多一个 active lease、status refs 不悬空、lockEpoch 不倒退。另测 orphan lease、manual-required、adapter pre-dispatch exception。

## 5. 命令契约

### `doctor <taskId>`

- 只读；不得修改 `status.json`、operation 或 receipt，也不得递增 revision。
- 报告 schema、mode、adapter capability、active refs、pending operations/receipts、lease 和 recovery diagnostics。
- 缺少 Phase 3/4 能力只报告 `unavailable`，不把 fake/manual 环境误报为生产可用。

### `run <taskId> [--adapter fake|manual] [--binding <id>]`

- 先执行第 4 节 prepare/commit，再执行第 3 节有界 dispatch，随后进入短锁 pump。
- target resolution 必须按当前 stage role 和配置 binding 得到且只得到一个 fake target；缺失、重复、binding mismatch 或 role mismatch 均在 `dispatching` 前 fail-closed。
- capability preflight 在 prepare 前执行；manual adapter 或缺少 `abortableDispatch + settleBarrier` 的 adapter 直接返回 `manual-required/capability-unavailable`，不创建 operation、Job 或 lease，也不调用 dispatch。
- stops：terminal result、`dispatch-uncertain`、needs-input capability unavailable、timeout、gate/acceptance/commit checkpoint 或 operator action。

### `pump <taskId>`

- 恢复 operation、处理 inbox、执行一次或持续多次短锁 tick；等待期间不持锁。
- 不创建替代 attempt，不自动裁决 uncertain，不自动处理人工 gate。

### `jobs <taskId> [--json]`

- 只读列出 active/last Job、attempt、lease、operation 和最近事件。
- 不消费 receipt、不执行恢复、不写 status。

### `retry <taskId> --job <jobId>`

- `failed-before-dispatch && dispatchingPersisted=false` 可显式 retry。
- 经结构化 `not-sent` 裁决且 `transportState=quiesced` 的 `reconciled-not-sent` 可由操作员显式 retry；这不是 automatic retry。
- `transport-in-flight`、`abort-requested` 或 `cancel-pending-settle` 一律返回 `transport-not-quiesced`。
- 其他 attempt 不得创建替代发送，旧 attempt 永久 fenced。
- 新 Attempt 使用当前 lockEpoch 和新 leaseToken，不覆盖历史文件。

### `cancel <taskId> --job <jobId> --attempt <attemptId> --lease-token <token>`

- 参数必须组成完整 AttemptRef；Supervisor 与 adapter side effect 前双层 fencing。
- stale/terminal cancel 幂等且无目标副作用。
- transport 已 settled 时，成功取消后写 operation/event、终结 attempt、释放匹配 lease并清理匹配 active refs。
- transport 尚在运行时只请求 abort 并写 `cancel-pending-settle`；必须等 settle barrier 确认后才能提交 cancelled。无法 settle 时 lease 和 tombstone 保留。

### `reconcile <taskId> --attempt <attemptId> --decision sent|not-sent|abandon ...`

- 仅 `dispatch-uncertain` 可裁决。
- `sent`：保持同一 fenced attempt，恢复 pump 等待 receipt，绝不重发。
- `not-sent` 必须同时提供：
  - `--confirm-target-quiescent`
  - `--confirm-prompt-not-visible`
  - `--confirm-prompt-not-running`
  - 非空 `--reason`
  - 非空 `--residual-risk`
- not-sent ledger 保存五项结构化证据、操作者、时间、AttemptRef；缺少任一项失败关闭。裁决后 fence 旧 attempt，迟到 receipt 归类 `superseded-attempt`，只有显式 retry 可创建新 attempt。
- not-sent 还要求 adapter 已给出 `aborted-before-side-effect|failed-before-side-effect` 的 settled evidence；仅人工确认而 transport 仍 in-flight 时返回 `transport-not-quiesced`。
- `abandon`：要求 reason。transport 已 settled 时 fence attempt、终结 Job、清理 active refs并保留审计，不派发替代 attempt；transport-in-flight 时只进入 `abandon-pending-settle`，不清 active refs、不允许人工推进。

### `--takeover --reason <text>`

- 通用 takeover 只适用于非 `dispatch-uncertain` active attempt。
- uncertain attempt 必须先执行 reconcile；takeover 返回稳定错误 `reconcile-required`，不得推进 workflow 或产生替代派发。
- 任何 transport-in-flight attempt 即使不是 uncertain，也不得由 takeover 释放 lease或产生替代 attempt；只允许先 cancel/settle，或 abandon 后保留 binding tombstone。
- 对允许接管的 attempt，在同一 task-lock transaction 中 fence、递增 lockEpoch、释放匹配 lease并记录审计，然后从最新 status 重新验证原命令。
- takeover 不跳过 freshness、acceptance、delivery 或 commit gate。

## 6. Phase 2 Receipt Profile

Phase 2 receipt 必须包含：

```json
{
  "protocolVersion": 1,
  "eventId": "event-uuid",
  "jobId": "job-id",
  "attemptId": "attempt-id",
  "leaseToken": "attempt:epoch:random",
  "kind": "job.completed",
  "sequence": 2,
  "occurredAt": "2026-06-19T00:00:00.000Z",
  "source": "fake-adapter",
  "details": {}
}
```

- `protocolVersion` 必须等于 1；未知版本 rejected。
- `kind` 只允许 Phase 2 集合：`job.running`、`job.completed`、`job.failed`。`job.needs-input` 在 Phase 3 authoritative Hook 完成前报告 capability unavailable，不作为成功/自动推进信号。
- `sequence` 是每 attempt 从 1 开始、连续递增的正整数。处理同一 attempt inbox 时先按 sequence 排序；存在 gap 时保留 pending，不越过缺口应用后续事件。
- 相同 `eventId + canonical payload hash` 是幂等重放；同 eventId 不同 payload 永久 rejected 为 `event-id-collision`。
- 不同 eventId 使用已占用 sequence rejected 为 `duplicate-sequence`；小于已提交 sequence rejected 为 `stale-sequence`。
- `occurredAt` 必须是有效 ISO-8601 时间且不得晚于处理时间的允许 clock-skew；超界 rejected 并记录原因。
- `sessionNonce` 明确延后 Phase 3。本阶段 profile 不接受其作为 identity 依据；fake adapter 的 binding/role 检查仅验证 Supervisor 目标解析契约。

## 7. Receipt application durable transaction

`receipt-applications/<attemptId>/<eventId>.json` 是每个 receipt 的幂等 ledger，保存 canonical payload hash、classification、preCursor、AttemptRef、sequence、phase 和预期 effects。classification 一旦提交不可因后续状态变化而改变。

### 7.0 Execution completion 与 workflow completion 分离

Job/Attempt 明确保存两个维度：

- `executionState`：`dispatching | running | worker-completed | failed | cancelled`，表示 adapter/worker 是否仍执行。
- `workflowState`：`pending | worker-completed-awaiting-check | check-blocked | workflow-completed | abandoned`，表示 Harness stage 是否已通过 gate 并推进。

收到合法 `job.completed` 只把 executionState 设为 `worker-completed`，持久化 immutable completion evidence，并把 workflowState 设为 `worker-completed-awaiting-check`。该 receipt 随后即可稳定 finalize 到 processed；它不等于 Job 整体 terminal，也不清除 status active refs。只有 `workflow-completed`、明确 failed/cancelled 或 operator abandon 才触发 terminal cleanup。

fresh output 尚未出现或 gate 失败时，pump 基于已持久化 completion evidence 重新评估，不重新消费 receipt。它只更新 Job 的 `lastCheckDiagnostic/check-blocked`，不保存 status、不递增 stateRevision/stageRevision、不清 active refs。操作员可修复产物后再次 pump；若需改为手工流程，必须通过正常 cancel/takeover，仍不能绕过 gate。

### 7.1 无副作用 check/advance 与 accepted receipt 流程

现有 `cmdCheck` 和 `cmdAdvance` 均会独立保存 status，失败 check 也会递增 stageRevision；Supervisor 不得直接串联调用它们。Phase 2 先抽取：

```ts
evaluateStageCheck(statusSnapshot, context): CheckEvaluation
deriveAdvanceTransition(statusSnapshot, checkEvaluation, context): TransitionPlan
```

- evaluator 可读取 primary artifact 并计算 findings/freshness/gate/check evidence，但不得写 status、复制 mirror 或递增 revision。
- transition 接收同一不可变 status snapshot/evaluation，返回完整 nextStatus、postCursor 和幂等 mirror-sync plan，不直接保存。
- 手工 `cmdCheck/cmdAdvance` 改用这两个函数后，由 manual compatibility committer 保持现有 CLI 行为与 revision 语义；Phase 2 不改变 V2.4 外部契约。
- Supervisor 只使用纯 evaluator/transition，在同一 task lock 内重读 status、验证 stateRevision/stage cursor/AttemptRef/primary hash，并以一次原子 CAS 保存 check evidence、条件分支/advance、revision、`worker-workflow-committed(eventId, operationId, preCursor, postCursor)` history，以及仅在 workflow 成功终结时清除匹配的 status active refs。
- Harness-owned mirror 在 CAS 前按 transition plan 幂等同步并验证 hash；若随后 crash，重放再次同步同内容是安全的，status 尚未提交时不视为 workflow advance。

每一步都在 task lock 内执行，崩溃后从 ledger phase 继续：

1. `validated`：校验 profile、eventId hash、AttemptRef、lease、cursor、kind 和 sequence；原子写 application ledger。
2. `journaled`：依据 `events/index/<eventId>.json` 与 JSONL 扫描去重；缺失才追加完整行并 fsync，再写 index。若崩溃留下半行，恢复截断半行后重试；完整 eventId 行存在则不重复追加。
3. `execution-evidence-committed`：幂等更新 Job/Attempt 的 `worker-completed-awaiting-check`、completionEventId、appliedEventIds/lastSequence；receipt effect 到此已 durable。
4. `receipt-committed/finalized`：更新 application ledger committed，并将 receipt 移到 processed。崩溃重放只补齐 ledger/finalize，不重复应用 completion。
5. 后续同 tick 或下一 pump tick 使用持久化 completion evidence 调用纯 evaluator。freshness/gate 不通过时记录 Job diagnostic 并停止，status 不变。
6. evaluator 通过时生成 transition plan，以一次 status CAS 提交 `workflow-committed`。该 status history marker 是 workflow effect 的逻辑提交点。
7. status 已提交后，幂等把 Job workflowState 置为 `workflow-completed` 并释放匹配 lease；active refs 已在第 6 步同一次 status CAS 中清除，不允许再次保存 status。这些 domain-record 收尾崩溃可由 history marker 恢复。

如果崩溃发生在 workflow status CAS 之后、Job/ledger 收尾之前，恢复通过 status history 中 eventId/operationId/postCursor 识别已提交 effect，禁止再次 evaluator/advance，只补齐 terminal records。若崩溃发生在 evaluator 之后、CAS 之前，status 没有 marker，重放可以重新纯评估，但不会产生 revision 漂移。

### 7.2 Rejected receipt 流程

先写 application ledger `classification=rejected` 和稳定 reason，再确保一次 rejected audit journal，最后移动到 rejected。即使 active cursor/attempt 后续改变，重放仍沿用原 classification。Malformed JSON 使用文件内容 hash 派生 application key，不覆盖其他坏文件。

### 7.3 Fault injection

分别在 validated 后、journal append/index 前后、execution evidence 更新后、receipt finalize 前、纯 check evaluation 后、workflow status CAS 后、Job terminal 收尾前注入崩溃。断言：

- workflow 最多推进一次；
- JSONL 每 eventId 最多一条完整记录；
- Job/Attempt effect 最多一次；
- processed/rejected 最终分类稳定；
- 两个并发 pump 处理同 receipt 结果一致。
- completion receipt 可先 finalize，output 后到时仍由同一 completion evidence 推进。
- check/gate 失败重放不修改 status revisions；check 与 advance 之间不存在独立 status commit。

## 8. 恢复规则

每个写命令/pump tick 在 task lock 内按顺序恢复：

1. 恢复第 4 节未完成 prepare operation。
2. active refs 指向无法由 operation 补齐的缺失/冲突记录时失败关闭 `execution-corrupt`。
3. attempt 遗留 `dispatching/transport-in-flight` 时转为或保持 `dispatch-uncertain`，调用 settle barrier 而不重新 dispatch；未 quiesced 前保留 lease/tombstone。
4. lease 过期但 transport 未 settled 时只标记 expired-pending-settle，不得释放或 retry；settled 后才按 fencing 终结。
5. 按 attempt/sequence 处理 inbox 和第 7 节未完成 application；坏事件不阻止其他 attempt，但同 attempt sequence gap 不越过。
6. 只有 workflowState=`workflow-completed|abandoned` 或明确 failed/cancelled 的整体 terminal Job 才清理匹配 active refs；`worker-completed-awaiting-check/check-blocked` 不清理。

恢复动作必须 owner/operation/AttemptRef scoped；不得按路径无条件删除 lease、operation 或 receipt。

## 9. TDD 顺序

### Step 1 — Store 与 transaction 负向测试

先写失败测试：原子 record、每个 prepare 边界 crash、orphan lease、manual-required、JSONL 半写恢复、application ledger 每个 phase crash、多 attempt/event 不覆盖。

### Step 2 — Supervisor pump 与状态机测试

先写失败测试：短锁 pump、run 等待期间 cancel/reconcile/takeover、双 pump、重启恢复、可 abort/settle dispatch、自动 retry 白名单、uncertain reconcile 五项证据、takeover uncertain 拒绝、迟到 receipt。覆盖 timeout 后底层仍运行、迟到 resolve/reject、settle 永不确认、期间 cancel/reconcile/retry；未 quiesced 时不得释放 lease或新建 attempt。

### Step 3 — Receipt profile 与目标解析测试

先写失败测试：protocolVersion/kind/sequence/occurredAt；eventId collision；乱序排序、gap pending、duplicate/stale sequence；work/review role；missing/duplicate target、binding/role mismatch 均不得进入 dispatching。

### Step 4 — CLI 与 gate 测试

先写失败测试：抽取 pure check evaluator/advance transition；manual cmdCheck/cmdAdvance 回归行为不变；doctor/jobs 字节级只读；所有写命令使用 task lock；takeover 重新校验；completion/freshness/cursor/hash 同 attempt；delivery acceptance 和 commit checkpoint 仍阻止自动推进。

### Step 5 — Fake adapter E2E

覆盖 run → dispatch → pump → receipt → pure check/transition → 单次 CAS advance，以及 cancel、restart、uncertain adjudication、duplicate/late receipt、CAS conflict。必须覆盖 crash-between-check-and-advance、失败 check 重放 revision 不漂移、completion 先到/output 后到、gate failure 保持 active、terminal cleanup 时序。E2E 不使用 Hook、Wrapper 或 Warp。

## 10. 验证门槛

```bash
pnpm test
node --check scripts/harness.js
node --check scripts/execution-protocol.js
node --check scripts/execution-store.js
node --check scripts/execution-supervisor.js
node --check scripts/workflow-core.js
node -e "JSON.parse(require('fs').readFileSync('schemas/status.schema.json','utf8'))"
git diff --check
```

另外人工核对：

- Phase 1 的 167 个测试全部回归通过。
- 工作树没有测试产生的运行状态。
- schema 3 → 4 仍默认 manual。
- 代码/测试不存在 Warp、AppleScript、Accessibility selector、Wrapper identity 或 clipboard 派发。
- Phase 2 Code Review 通过前不 commit/push，不进入 Phase 3。

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH2-PLAN-P1-01 | fixed | 增加 AbortSignal + settle barrier、transport-in-flight/tombstone、late return fencing 及超时并发测试 | Promise timeout 不再被误认为底层 transport 已停止；未 quiesced 时禁止替代发送 |
| V3-PH2-PLAN-P1-02 | fixed | 增加 operation record、status 逻辑提交点、pending lease、逐边界恢复表与 fault injection | 跨文件写入通过 durable coordinator 可完成提交或 scoped rollback |
| V3-PH2-PLAN-P1-03 | fixed | 抽取 pure check evaluator/advance transition；分离 worker-completed-awaiting-check 与 workflow-completed；单次 status CAS 提交 workflow effect | receipt 可先稳定 finalize，失败重评不产生 revision 漂移或部分 advance |
| V3-PH2-PLAN-P1-04 | fixed | not-sent 强制三项结构化事实确认、reason、residual risk；uncertain takeover 返回 reconcile-required | 不允许自由文本或通用 takeover 绕过不确定派发裁决 |
| V3-PH2-PLAN-P2-01 | fixed | 定义 Phase 2 receipt profile、连续 sequence 与 collision 规则；补充 role/binding/target fail-closed 测试 | sessionNonce 延后 Phase 3，但其余 receipt 与 fake target 契约本阶段生效 |

## 11. Review checkpoint

本计划可重新提交 Plan Review。获批前只允许继续修订文档，不开始 Phase 2 实现；获批后严格按上述 TDD 顺序实施，不进入 Phase 3 或 Phase 4。
