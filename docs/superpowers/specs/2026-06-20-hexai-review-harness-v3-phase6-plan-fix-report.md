# HEXAI Review Harness V3 Phase 6 实施方案修订报告

## 修订结论

已按 Phase 6 Plan Review 的 4 个 P1、1 个 P2 finding，以及 Phase 6 Plan Fix Review 的 1 个 P1 finding 修订主计划。当前修订只涉及计划文档，不进入实现，不启用真实 W6 pilot。

修订后的 Phase 6 方案将 real wrapper/helper 能力收敛为可验证证据链：target binding 必须通过扫描到的具体 Warp target/pane 的 target-local challenge；hook receipt sequence 必须由 per-attempt durable ledger 分配；helper submit/interrupt side-effect CLI 只能接收完整 fenced `--request <path|json>`，result 必须逐字段镜像 request；本地 JSON hook payload 只能作为 fixture/shadow diagnostic；raw nonce 继续沿用现有 `ExecutionStore` secret path。

## Review 问题处理表

| 编号 | 严重度 | Review 问题 | 处理状态 | 修订位置 |
| --- | --- | --- | --- | --- |
| V3-PH6-PLAN-P1-01 | P1 | target challenge 未证明响应来自被扫描到的具体 Warp target/pane，直接本地 HMAC 不足以写入 targetBinding | 已修复 | Phase 6 plan §3.4、§3.5、§6、§10、§11、§12 |
| V3-PH6-PLAN-P1-02 | P1 | hook publisher 依赖 `HARNESS_RECEIPT_SEQUENCE`，缺 durable per-attempt receipt sequence allocator/ledger 和重放/并发规则 | 已修复 | Phase 6 plan §4.2、§10、§11、§12 |
| V3-PH6-PLAN-P1-03 | P1 | helper submit/interrupt request 缺完整 fencing，helper side effect 前校验和 result mirror 不完整 | 已修复 | Phase 6 plan §5.2、§5.3、§9、§10、§11、§12 |
| V3-PH6-PLAN-P1-04 | P1 | `worker-hook-probe --payload` 允许任意本地 JSON 可能误授权 real pilot | 已修复 | Phase 6 plan §3.1、§6、§7、§10、§11、§12 |
| V3-PH6-PLAN-P2-01 | P2 | raw nonce path 新增了并行 secret store，未沿用现有 `ExecutionStore` 路径 | 已修复 | Phase 6 plan §3.2、§10、§11、§12 |
| V3-PH6-PLAN-FIX-P1-01 | P1 | helper side-effect CLI 仍允许拆散参数，`SubmitResult` 未逐字段镜像 request，`InterruptResult` mirror 规则不完整 | 已修复 | Phase 6 plan §5、§5.2、§5.3、§9、§10、§11、§12 |

## 关键修订说明

### V3-PH6-PLAN-P1-01 — target-local challenge

- 原问题：计划只要求 target challenge HMAC-bound，但未证明 challenge/response 真正经过扫描到的 Warp target/pane；本地 wrapper 直接 HMAC 仍可能写入错误 targetBinding。
- 修订方式：新增 §3.5 target-local challenge protocol。`warp-bind-target --real` 必须两次稳定扫描候选 target，通过 helper 向该具体 candidate 发送非 clipboard challenge，并要求响应经 wrapper-launched hook publisher 或可证明绑定到同一 target-local TTY/process session 的本地控制端点返回。
- 为什么这样修：targetBinding 的安全边界不只是 wrapper secret，还必须证明“这个 wrapper session 位于这个扫描到的 target/pane”。没有 target-local response channel 时必须 fail-closed。
- 对范围/契约/实现的影响：计划新增 wrong pane、wrong wrapper、stale target、stale wrapper、replay challenge、direct HMAC without target-local evidence 等负向测试；不允许 `warp-bind-target --real` fallback 到 fixture。

### V3-PH6-PLAN-P1-02 — durable receipt sequence ledger

- 原问题：hook publisher 从环境变量读取 `HARNESS_RECEIPT_SEQUENCE`，crash/restart、重复 hook、payload collision、needs-input 后 completion、并发 publisher 都可能破坏 receipt sequence 单调性或幂等性。
- 修订方式：删除 `HARNESS_RECEIPT_SEQUENCE`，要求每个 attempt 使用 `runs/<taskId>/attempts/<attemptId>/receipt-sequence-ledger.json` durable ledger 分配 sequence。ledger 在 task execution lock 或等价 atomic compare-and-rename 下更新，记录 `nextSequence`、`eventId -> payloadHash` 和 receipt path。
- 为什么这样修：sequence 是 Supervisor receipt ordering 的持久状态，不能由外部 hook 环境自报。
- 对范围/契约/实现的影响：计划新增 crash/restart、duplicate hook payload、eventId hash collision、hook replay、needs-input then completion、parallel publisher serialization 等测试。

### V3-PH6-PLAN-P1-03 — helper submit/interrupt fencing

- 原问题：helper `submit-text` / `interrupt` 只传了部分 attempt 信息，缺 operationId、lockEpoch、binding/session identity、target challenge、capability evidence、allowlist hash、input snapshot 等 side-effect fencing。
- 修订方式：新增 §5.2 `SubmitRequest` / `InterruptRequest` schema，要求 side effect 前校验完整 fencing 字段；新增 §5.3 要求 `SubmitResult` / `InterruptResult` 逐字段镜像 request 并由 adapter 校验。
- 为什么这样修：helper 一旦 focus、写入输入或发送 interrupt 就进入副作用边界，必须在副作用前确认请求仍对应当前 attempt、target、capability、allowlist 和 input snapshot。
- 对范围/契约/实现的影响：计划新增缺字段、wrong operationId、wrong leaseToken、stale lockEpoch、wrong targetChallengeId、wrong targetFingerprintHash、capability drift、allowlist drift、input hash mismatch、result mirror mismatch、renamed `targetFingerprintHash` 等负向测试。

### V3-PH6-PLAN-FIX-P1-01 — helper side-effect CLI 与 result mirror 收口

- 原问题：上一轮修订虽然定义了完整 `SubmitRequest` / `InterruptRequest`，但 helper 具体 side-effect CLI 仍是 `submit-text --target --input-file --attempt-ref` / `interrupt --target --attempt-ref`，允许 helper 从 ambient state 补齐字段；`SubmitResult` 使用 `candidateFingerprintHash`，未用 request 的 `targetFingerprintHash`；逐字段 mirror 规则只显式覆盖 `InterruptResult`。
- 修订方式：将 helper side-effect CLI 改为只接受 `--request <path|json>`；明确拒绝 `--target`、`--input-file`、`--attempt-ref` 等拆散参数；`InterruptRequest` 补充 `inputSnapshot`；`SubmitResult` 改为 `targetFingerprintHash`；新增 `InterruptResult` schema；要求 `SubmitResult` 和 `InterruptResult` 都逐字段镜像 request 的 `operationId`、`attemptRef`、`lockEpoch`、binding、`targetFingerprintHash`、`targetChallengeId`、`capabilityEvidenceId`、`pilotAuthorization`、`inputSnapshot`。
- 为什么这样修：只有完整 request 作为 helper side-effect 的唯一输入，才能保证 side effect 前校验不可被 ambient/current state 绕过；result 字段名一致才能让 adapter 做机械化 mirror 校验。
- 对范围/契约/实现的影响：测试矩阵新增 split CLI rejection、`candidateFingerprintHash` result rejection、InterruptRequest/InterruptResult 缺 inputSnapshot rejection、SubmitResult/InterruptResult mirror mismatch rejection。

### V3-PH6-PLAN-P1-04 — fixture hook payload 不授权 real pilot

- 原问题：`worker-hook-probe W6-A --payload <payload.json>` 接收任意本地 JSON，如果可写真实 capability evidence，会绕过 wrapper-launched Claude hook publisher 的来源证明。
- 修订方式：明确 `worker-hook-probe --payload` 只能写 `runs/<taskId>/diagnostics/hook-fixtures/` 下的 fixture/shadow diagnostic artifact，不能创建或更新 `runs/<taskId>/capabilities/claude-hook.json`，不能设置 completion/needs-input capability，不能让 `pilot-doctor` eligible。
- 为什么这样修：real pilot 授权必须来自 wrapper-launched hook publisher，并带 wrapper session proof/source provenance；任意本地 JSON 只能用于诊断和测试。
- 对范围/契约/实现的影响：计划新增 arbitrary JSON cannot authorize pilot-doctor、fixture hook remains unavailable、real wrapper hook proof required 等测试；Shadow Validation 也改为 real hook publisher 才能满足 hook capability。

### V3-PH6-PLAN-P2-01 — raw nonce secret path

- 原问题：计划写成 `runs/<taskId>/secrets/<bindingId>.secret`，与现有 `ExecutionStore` 的 `runs/<taskId>/bindings/.secrets/<bindingId>.nonce` 并行，容易造成双 secret store。
- 修订方式：§3.2 改为沿用现有 `ExecutionStore` 路径，并明确禁止新增 `runs/<taskId>/secrets/<bindingId>.secret`。
- 为什么这样修：Phase 6 应复用 Phase 3 已实现并测试过的 nonce secret 存储边界，避免实现和审计路径分裂。
- 对范围/契约/实现的影响：计划新增 secret path 和 permissions 测试，要求文件 mode `0600`，`.secrets` 目录不可 group/world writable。

## 修订后的实施范围

### 本轮做

- 修订 Phase 6 主计划。
- 明确 target-local challenge 传递/响应路径和 fail-closed 条件。
- 明确 hook publisher durable receipt sequence ledger、eventId 幂等和并发规则。
- 明确 helper submit/interrupt side-effect CLI 只能接收完整 `--request <path|json>`。
- 明确 helper submit/interrupt request/result fencing schema 和逐字段 mirror 规则。
- 明确 fixture hook payload 不授权 real pilot。
- 明确 raw nonce 沿用现有 `ExecutionStore` secret path。

### 本轮不做

- 不写实现代码。
- 不运行真实 W6 pilot。
- 不自动 approval、delivery acceptance、commit、push 或 tag。
- 不改 `/Users/admin/project/ai/work/HEXAI` 业务代码。
- 不放宽 Phase 2-5 既有 fencing、allowlist 或 pilot gate。

## 修订后的关键方案

- Target binding：`warp-bind-target --real` 必须通过 helper 向两次稳定扫描到的 candidate 发送 challenge，并要求 target-local response channel 返回响应；直接本地 HMAC 不可写 targetBinding。
- Hook publisher：sequence 由 per-attempt durable ledger 分配；duplicate eventId 同 hash 幂等返回，different hash fail-closed；并发 publisher 必须串行化。
- Helper request：`submit-text` / `interrupt` side-effect CLI 只接受完整 `--request <path|json>`；`SubmitRequest` / `InterruptRequest` 必须包含 operationId、AttemptRef、lockEpoch、binding/session identity、targetFingerprintHash、targetChallengeId、capabilityEvidenceId、pilotAuthorization、input snapshot hash/path。
- Helper result：`SubmitResult` / `InterruptResult` 必须用相同字段名逐字段镜像 request fencing 字段；adapter 校验后才可映射 submitted/cancelled，否则 uncertain/fail-closed。
- Hook capability：本地 payload probe 只生成 fixture/shadow diagnostic；real capability 必须由 wrapper-launched publisher 产生并验证 wrapper provenance。
- Secret storage：raw nonce 只在 `runs/<taskId>/bindings/.secrets/<bindingId>.nonce` 和 wrapper env 中出现。

## 异常路径与边界条件

| 场景 | 处理策略 | 是否本轮覆盖 |
| --- | --- | --- |
| target-local response channel 不可用 | `warp-bind-target --real` fail-closed，不更新 targetBinding | 是 |
| wrong pane / wrong wrapper | challenge response 校验失败，不更新 targetBinding | 是 |
| stale target / stale wrapper / stale helper capability | fail-closed | 是 |
| replay challenge 或 challenge payload 变更 | fail-closed | 是 |
| duplicate hook payload | 返回既有 receipt，不分配新 sequence | 是 |
| eventId hash collision | fail-closed，不写 receipt | 是 |
| needs-input 后 completion | completion 分配更大的 sequence | 是 |
| parallel hook publisher | 通过 ledger 串行化，session mismatch fail-closed | 是 |
| helper request 缺字段或 stale fencing | side effect 前拒绝 | 是 |
| helper side-effect CLI 使用拆散参数 | 拒绝，只允许 `--request <path|json>` | 是 |
| helper result mirror mismatch | uncertain/fail-closed，不接受为 submitted/cancelled | 是 |
| SubmitResult 使用 `candidateFingerprintHash` | 拒绝，必须逐字段镜像 `targetFingerprintHash` | 是 |
| InterruptRequest/InterruptResult 缺 inputSnapshot | 拒绝 | 是 |
| arbitrary local hook JSON | 只作为 fixture/shadow diagnostic，不授权 pilot | 是 |
| raw nonce secret path 漂移 | 测试拒绝并行 secret store，检查权限 | 是 |

## 验收方式

- `git diff --check`
- Phase 6 Plan Fix Review 复审 Fix Mapping
- 后续实现阶段必须按主计划新增 unit/CLI/fixture/crash-restart/parallel publisher/negative fencing 测试。

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH6-PLAN-P1-01 | fixed | 新增 target-local challenge protocol；要求 helper 向具体扫描 candidate 发送 challenge，响应必须经 approved target-local response channel 返回；无安全 channel 时 `warp-bind-target --real` fail-closed；补 wrong pane/wrong wrapper/stale/replay/direct-HMAC 负向测试。 | 证明 targetBinding 绑定的是具体 Warp target/pane，而不是仅由本地 wrapper HMAC 自证。 |
| V3-PH6-PLAN-P1-02 | fixed | 删除对 `HARNESS_RECEIPT_SEQUENCE` 的信任；新增 per-attempt durable receipt sequence ledger、eventId 幂等、payload hash collision、hook replay、needs-input 到 completion、parallel publisher 规则和测试。 | receipt sequence 必须是 durable Supervisor-side ordering 状态，不能由 hook 环境自报。 |
| V3-PH6-PLAN-P1-03 | fixed | 新增 `SubmitRequest` / `InterruptRequest` 完整 fencing schema；要求 helper side effect 前校验；`SubmitResult` / `InterruptResult` 逐字段镜像 request 并由 adapter 校验；补缺字段、wrong operationId、wrong leaseToken、stale lockEpoch、wrong targetChallengeId、capability drift 等测试。 | 防止 stale/错误 attempt、target、capability、allowlist 或 input snapshot 触发真实 helper side effect。 |
| V3-PH6-PLAN-P1-04 | fixed | 明确 `worker-hook-probe --payload` 只能写 fixture/shadow diagnostic，不能创建 real hook capability 或授权 `pilot-doctor`；real hook capability 必须由 wrapper-launched publisher 产生并带 wrapper provenance。 | 任意本地 JSON payload 不应成为真实 pilot 授权证据。 |
| V3-PH6-PLAN-P2-01 | fixed | 将 raw nonce path 改为现有 `runs/<taskId>/bindings/.secrets/<bindingId>.nonce`，禁止新增 `runs/<taskId>/secrets/<bindingId>.secret`，补 secret path 和 permissions 测试。 | 复用现有 `ExecutionStore` secret 边界，避免并行 secret store。 |
| V3-PH6-PLAN-FIX-P1-01 | fixed | 将 helper side-effect CLI 改为只接受完整 `--request <path|json>`；拒绝拆散参数；`InterruptRequest`/`InterruptResult` 补齐 `inputSnapshot`；`SubmitResult` 改为 request-mirrored `targetFingerprintHash`；要求 Submit/Interrupt result 逐字段镜像 request，并补 split CLI、renamed fingerprint、missing inputSnapshot、mirror mismatch 测试。 | 关闭 helper 从 ambient state 补字段和 result 字段名不一致导致 adapter 无法可靠校验的风险。 |

## 仍需用户确认

无。

## 下一步建议

可以重新提交 Phase 6 Plan Fix Review。获批前仍不得进入 Phase 6 实现或真实 W6 pilot。
