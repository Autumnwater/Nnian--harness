# HEXAI Review Harness V3 实施方案修订报告

## 修订结论

本报告已继续处理 Fix Review 重新打开的 V3-P1-02 和新增的 V3-P2-02。当前累计 5 个 P1、2 个 P2 均标记为 `fixed`，并已写入主设计的数据契约、异常路径、实施分期和验收标准。

方案当前可以重新提交 plan review，但在 reviewer 明确批准前仍不得进入 Phase 1 实现。

修订后的主方案：`docs/superpowers/specs/2026-06-18-hexai-review-harness-v3-worker-adapter-design.md`

## Review 问题处理表

| 编号 | 严重度 | Review 问题 | 处理状态 | 修订位置 |
|------|--------|-------------|----------|----------|
| V3-P1-01 | P1 | 活动 Job 与人工命令缺少互斥和阶段 CAS | 已修复 | 主方案 §7、§14、§15、§19 |
| V3-P1-02 | P1 | Wrapper/Hook 无法在 Claude 处理前实现目标侧去重，原方案机制不可执行 | 已修复 | 主方案 §8、§12、§16、§19 |
| V3-P1-03 | P1 | 单一 job receipt 文件无法承载多 attempt、多事件和迟到回执 | 已修复 | 主方案 §9、§15、§16、§19 |
| V3-P1-04 | P1 | Completion、freshness、advance 未绑定同一 active attempt | 已修复 | 主方案 §7、§10、§19 |
| V3-P1-05 | P1 | Wrapper 会话与 Warp Accessibility 目标缺少可验证身份链 | 已修复 | 主方案 §11、§12、§17、§19 |
| V3-P2-01 | P2 | needs-input 信号来源和降级行为未定义 | 已修复 | 主方案 §13、§16、§19 |
| V3-P2-02 | P2 | cancel 仅携带 jobId，旧 Attempt cancel 可能中断新 Attempt | 已修复 | 主方案 §6、§7、§16、§19 |

## 关键修订说明

### 活动 Job 互斥、人工接管和阶段 CAS

- 原问题：`next/step/advance` 可与活动 Job 并发修改状态，旧 check 结果可能推进新阶段。
- 修订方式：新增 task 级执行锁、全局 `stateRevision`、工作流 `stageRevision`、stage cursor CAS、active attempt 检查和 fencing token。
- 人工接管：冲突命令默认返回 `active-job-conflict`。只有显式 `--takeover --reason` 才能围栏旧 attempt；接管后必须重新读取状态和验证正常门禁。
- 为什么这样修：锁解决并发写，stage CAS 解决“锁释放后状态已变化”的逻辑竞争；两者缺一不可。
- 对范围/契约/实现的影响：Phase 1 必须先完成锁、revision、CAS 和负向测试，不能先做 Warp 注入。

### Warp 派发崩溃窗口和人工裁决

- 原问题：UI 已提交输入但本地回执尚未落盘时崩溃，重试可能重复执行任务。
- 修订方式：删除 Wrapper/Hook 在 Claude 处理前写 ledger 的承诺。状态改为 `prepared → dispatching → dispatch-submitted`；一旦进入 `dispatching`，任何崩溃或模糊结果都进入 `dispatch-uncertain`。
- 不确定窗口：只允许人工选择 `sent`、`not-sent` 或 `abandon`。`not-sent` 要求人工确认目标已静止且 Prompt 未显示、未运行；不能证明时只能选择 `sent` 或 `abandon`。系统不得自动重发。
- 为什么这样修：当前 Wrapper 仅启动 Claude、设置环境和 Hook，无法拦截 Accessibility 直接提交给 Claude 的 stdin。方案不再虚构目标侧 exactly-once，而是失败关闭。
- 对范围/契约/实现的影响：Warp adapter 上线前必须通过 crash-window 人工裁决测试；目标侧预处理去重不属于已批准能力。

### Attempt-scoped Cancel

- 原问题：`cancel(jobId, target)` 无法区分同一 Job 的新旧 Attempt，迟到 cancel 可能向新 Attempt 发送中断。
- 修订方式：接口改为 `cancel(attempt: AttemptRef, target)`，其中 `AttemptRef` 必须包含 `jobId`、`attemptId` 和 `leaseToken`。
- 执行规则：Adapter 在发送 Ctrl-C、关闭 pane 或其他中断前，必须确认 AttemptRef 与目标当前 active attempt 完全一致；否则返回 `stale-attempt` 且不产生目标侧动作。
- 为什么这样修：Job 级身份不足以作为有副作用操作的 fencing 条件。

### Attempt/Event 级 Receipt Inbox

- 原问题：`receipts/<jobId>.json` 会覆盖多个 attempt 或多个事件，迟到回执可能污染当前状态。
- 修订方式：改为 `inbox/processed/rejected/<attemptId>/<eventId>.json` 的不可变事件文件；临时文件加原子 rename，拒绝覆盖。
- 校验规则：Supervisor 单写 JSONL journal；每个 receipt 校验 schema、attempt、lease token、session nonce 和 sequence。
- 迟到回执：保留到 rejected 目录并记录原因，不允许改变 active attempt。
- 对范围/契约/实现的影响：receipt ingestion 和 fencing 测试进入 Phase 2 前置范围。

### 同一 Attempt 的完成、Freshness、Check 和 Advance

- 原问题：不同 attempt 的 completion 和输出变化可能被组合成一次合法 advance。
- 修订方式：completion receipt、freshness evidence、`checkEvidence` 和 advance CAS 必须共享 `attemptId`、`leaseToken`、stage cursor、baseline hash 和 primary hash。
- Advance：在 task lock 内重新计算 primary SHA，并对 subtask/stage/round/stageRevision/activeAttempt 做 CAS。
- 为什么这样修：路径相同不代表执行尝试相同；所有证据必须形成一条不可拼接的证据链。

### Wrapper 与 Warp Target 身份链

- 原问题：tab title 和逻辑 paneId 不能证明 Accessibility 当前选中的目标就是对应 Wrapper/Claude 会话。
- 修订方式：Wrapper 生成随机 `sessionNonce`，注册 binding、PID、TTY、cwd、Claude session 信息和 heartbeat；首次绑定由 Warp candidate 接收 challenge，再通过 receipt inbox 返回 nonce。
- 持久关系：保存 `bindingId ↔ sessionNonce ↔ wrapper identity ↔ Accessibility fingerprint`。
- 失效条件：heartbeat、nonce、role、cwd policy 或 target fingerprint 任一变化即要求 rebind。
- 为什么这样修：标题只能用于候选发现，不能作为派发授权依据。

### needs-input 权威信号与降级

- 原问题：方案没有说明如何判断 permission、agent question 或登录阻塞。
- 修订方式：权威事件仅来自带 attempt fencing 和身份字段的 Claude Code integration；Warp notification/UI text 只能产生 advisory `attention-unknown`。
- 降级行为：缺少 hook capability 时，doctor 明确报告 unavailable；显式 degraded mode 只允许 spike，静默最终为 timeout/attention-unknown，绝不自动成功或自动批准。
- 对范围/契约/实现的影响：production enablement 必须具备权威 needs-input 能力。

## 修订后的实施范围

### 本轮做

- 修订 Worker/Adapter 协议和状态契约。
- 定义 task lock、revision、stage CAS、attempt fencing 和 takeover。
- 定义不确定派发、人工 reconcile 和禁止自动重发。
- 定义 attempt-scoped cancel 和旧 Attempt fencing。
- 定义 attempt/event receipt inbox 与迟到回执处理。
- 定义同 attempt 证据链和条件推进。
- 定义 Wrapper session nonce 与 Warp target challenge 身份链。
- 定义 needs-input 信号来源和 degraded mode。
- 将上述能力加入实施分期和验收标准。

### 本轮不做

- 不实现任何代码。
- 不执行 Warp Accessibility capability spike。
- 不修改 Harness V2.4 行为。
- 不自动审批、人工验收、commit、push 或 tag。
- 不把 Oz cloud API 纳入 V3.0 首发范围。

## 修订后的关键方案

### 状态与并发

- `stateRevision`：所有持久化状态变更递增，用于审计和通用乐观并发。
- `stageRevision`：仅在 workflow cursor、active attempt、baseline 或 gate evidence 变化时递增，用于阶段 CAS。
- task lock：所有状态写命令串行化。
- active attempt：manual 与 worker 命令共享同一冲突检查。

### 派发与回执

- 每次尝试拥有独立 `attemptId` 和 `leaseToken`。
- `dispatch-submitted` 只表示本地 Accessibility 调用正常返回，不代表 Claude 已处理。
- 可能发送进入 `dispatch-uncertain`，禁止自动 retry，必须人工裁决。
- 多事件按 eventId 形成不可变 receipt 文件。
- Cancel 必须携带并校验 jobId、attemptId 和 leaseToken。

### 条件推进

- Check 输出 attempt-scoped `checkEvidence`。
- Advance 在锁内重新校验当前文件 hash 和 stage cursor。
- 任一 attempt、token、round、revision 或 hash 不一致均原子失败。

### 目标身份

- Tab title 只用于候选发现。
- Wrapper session nonce 和 challenge response 用于授权绑定。
- Accessibility fingerprint 只使用 capability spike 实际可读取的稳定字段，不预设 Warp 暴露 Tab Config paneId。

## 异常路径与边界条件

| 场景 | 处理策略 | 是否本轮覆盖 |
|------|----------|--------------|
| 活动 Job 期间人工 next/step/advance | 返回 active-job-conflict | 是 |
| 人工强制接管 | fencing 旧 attempt，记录 reason，重新验证命令 | 是 |
| UI 发送后本地崩溃 | dispatch-uncertain，人工判定 sent/not-sent/abandon，禁止自动重发 | 是 |
| 旧 Attempt 的迟到 cancel | 返回 stale-attempt，不向当前 target 发送中断 | 是 |
| 多 attempt 同时产生 receipt | 按 attempt/event 分文件，旧 attempt 被 fencing | 是 |
| 迟到 completion | 移入 rejected，保留审计，不推进 | 是 |
| 输出来自新 attempt、completion 来自旧 attempt | checkEvidence 构造失败 | 是 |
| Stage/round/revision 被人工改变 | advance CAS 失败 | 是 |
| 同名 Warp tab 多个 | target ambiguity，失败关闭 | 是 |
| Wrapper nonce 与 target 不匹配 | binding invalid，要求 rebind | 是 |
| needs-input hook 可用 | 产生权威 attempt-scoped needs-input | 是 |
| needs-input hook 不可用 | degraded mode/timeout，不自动成功 | 是 |

## 验收方式

- Fake adapter 并发测试：活动 Job 阻塞所有状态写命令。
- Takeover 测试：旧 lease receipt 无法改变状态，且接管不绕过 gate。
- Crash injection：分别在 prepared 前、dispatching 后、Accessibility 返回前后终止进程，验证进入人工裁决且无自动重发。
- Receipt 测试：多 attempt、多 event、duplicate、late、malformed、revoked token。
- Evidence mixing 测试：交叉组合不同 attempt 的 completion/freshness/check，全部拒绝。
- CAS 测试：修改 stage、round、stageRevision、active attempt 或 primary hash，advance 原子失败。
- Identity 测试：同名 target、过期 heartbeat、nonce mismatch、role mismatch、fingerprint change。
- needs-input 测试：permission/question/auth/unknown、hook unavailable、degraded timeout。
- Cancel fencing 测试：旧 attempt、错误 lease token、重复 cancel 均不得影响新 attempt。
- V2.4 回归：manual mode 全量测试保持通过。

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-P1-01 | fixed | 增加 task lock、state/stage revision、stage CAS、active job 冲突和 takeover fencing | 防止人工命令与 worker 错误组合推进 |
| V3-P1-02 | fixed | 删除不可实现的目标侧预处理去重；所有不确定发送进入人工裁决且禁止自动重发 | Wrapper/Hook 无法在 Claude 处理前拦截 Accessibility 输入 |
| V3-P1-03 | fixed | 改为 attempt/event 级 immutable receipt inbox，并隔离 rejected/late receipt | 支持多 attempt、多事件且不覆盖 |
| V3-P1-04 | fixed | Completion、freshness、checkEvidence、advance 绑定相同 attempt/token/cursor/hash | 禁止跨尝试拼接证据 |
| V3-P1-05 | fixed | 增加 Wrapper session nonce、challenge 和 Accessibility fingerprint 身份链 | tab title/pane 名称不再作为授权身份 |
| V3-P2-01 | fixed | 定义 needs-input 权威来源、advisory 信号和 degraded mode | 缺失 hook 时失败关闭，不误判成功 |
| V3-P2-02 | fixed | cancel 改为 AttemptRef(jobId/attemptId/leaseToken)，旧 Attempt 返回 stale-attempt 且不发送中断 | 防止迟到 cancel 影响同 Job 的新 Attempt |

## 仍需用户确认

无。具体 macOS Accessibility 字段和 Claude Code hook payload 仍需在后续 capability spike 中实测，但主方案已明确：实测能力不足时不得降级为不安全的生产路径。

## 下一步建议

将修订后的主设计和本报告重新提交 plan review。只有 reviewer 确认 reopened 的 V3-P1-02 和 open 的 V3-P2-02 已关闭后，才可生成详细实施计划并进入 Phase 1。
