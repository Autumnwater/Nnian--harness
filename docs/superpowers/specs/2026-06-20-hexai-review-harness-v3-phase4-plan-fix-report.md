# HEXAI Review Harness V3 Phase 4 实施方案修订报告

## 修订结论

已按 Phase 4 Plan Review 的 3 个 P1 和 1 个 P2 finding 修订计划。当前仍只修订文档，不进入实现。

修订后的方案将 Phase 4 明确限定为 Warp macOS adapter capability spike：允许 fixture、production-test、scratch 路径验证协议，不允许 real W6 pilot 或真实任务 production `run --adapter warp-macos`。target challenge、attempt-captured target identity、helper side-effect evidence 均已收敛为可测试契约。

## Review 问题处理表

| 编号 | 严重度 | Review 问题 | 处理状态 | 修订位置 |
| --- | --- | --- | --- | --- |
| V3-PH4-PLAN-P1-01 | P1 | Phase 4 边界与 production run enablement 冲突 | 已修复 | Phase 4 plan §1、§2、§4、§9、§12、§13、§14 |
| V3-PH4-PLAN-P1-02 | P1 | target-to-wrapper challenge 未收敛为安全可实现契约 | 已修复 | Phase 4 plan §6、§11、§14 |
| V3-PH4-PLAN-P1-03 | P1 | target identity 未明确进入 job/attempt/lease 与 fencing | 已修复 | Phase 4 plan §6.1、§7、§10、§11、§14 |
| V3-PH4-PLAN-P2-01 | P2 | helper side-effect settle barrier 不够可测试 | 已修复 | Phase 4 plan §8、§10、§11、§13、§14 |

## 关键修订说明

### Phase 4 不启用真实生产 run

- 原问题：计划一边声明 Phase 4 不是 W6 pilot，一边允许 fresh evidence 后进入 `run --adapter warp-macos`。
- 修订方式：明确 `run W6-A --adapter warp-macos` 在 Phase 4 必须失败；真实项目任务也禁用。`productionEligible` 拆为 `diagnosticEligible`、`phase4RunEnabled`、`phase5ProductionCandidate`。
- 为什么这样修：capability spike 不能等同于真实任务授权，否则会绕过 Phase 5 pilot gate。
- 对范围/契约/实现的影响：Phase 4 只允许 fixture/production-test/scratch 路径，production run 留到 Phase 5。

### Target challenge 定案

- 原问题：shadow challenge 的 payload、response、TTL、one-time 语义、proof 与 artifact path 都未定义。
- 修订方式：新增 `target.challenge` 和 `target.challenge-response` schema；规定 pending/inbox/processed/rejected artifact path、两分钟 TTL、一次性 replay 拒绝、HMAC proof、失败分类。
- 为什么这样修：让 target-to-wrapper identity 成为可实现、可审计、可测试的契约。
- 对范围/契约/实现的影响：shadow challenge 只证明 target binding capability，不授权真实生产派发；没有非-agent 控制通道时，Phase 5 production dispatch 仍需单独 review。

### Target identity 与 fencing 结合

- 原问题：计划声称 late receipt 会因 target identity mismatch 被拒绝，但 Phase 3 receipt 没有 target proof 字段。
- 修订方式：新增 job/attempt/lease `adapterIdentity` 捕获字段，并明确 prepare/dispatch/cancel/recovery/receipt 的验证位置；删除 receipt target fingerprint mismatch 承诺。
- 为什么这样修：target identity 应参与 adapter dispatch/cancel/recovery fencing，但不能要求现有 receipt 承载未定义 proof。
- 对范围/契约/实现的影响：workflow receipt 继续由 AttemptRef、leaseToken、lockEpoch、binding/session identity、HMAC proof fencing。

### Helper side-effect evidence

- 原问题：`submitText` 未区分输入框被改写、已提交、未知部分输入，`failed-before-side-effect` 缺少 durable evidence 条件。
- 修订方式：定义 `SubmitResult` schema，包含 `sideEffectState`、`settled`、`transportEvidenceId`、`usedClipboard:false`、`candidateFingerprintHash`、AttemptRef 字段。
- 为什么这样修：Accessibility key event 的副作用边界必须可审计，否则 retry/not-sent 会不安全。
- 对范围/契约/实现的影响：只有 durable `sideEffectState=none` 能映射 safe pre-side-effect failure；`input-mutated`、`unknown`、timeout、crash-after-focus 全部进入 uncertain 或 fail-closed。

## 修订后的实施范围

### 本轮做

- Warp macOS adapter fixture/helper boundary。
- Capability evidence 与 diagnostic gate。
- Target descriptor/fingerprint/two-scan stability。
- Target challenge artifact protocol。
- Attempt-captured `adapterIdentity`。
- Helper side-effect evidence 与 uncertain mapping。
- Command-first Phase 4 CLI 计划。

### 本轮不做

- real W6 pilot。
- 真实任务 production `run --adapter warp-macos`。
- completion-only degraded production run。
- 自动批准 Claude Code permission。
- 自动 commit/push/tag。
- clipboard dispatch。
- frontmost-window fallback。

## 异常路径与边界条件

| 场景 | 处理策略 | 是否本轮覆盖 |
| --- | --- | --- |
| 缺少 capability evidence | `doctor --adapter warp-macos` unavailable | 是 |
| duplicate/missing target | fail closed，不选择 frontmost fallback | 是 |
| target challenge 过期/重放/bad proof | rejected，不更新 targetBinding | 是 |
| target fingerprint 变化 | dispatch/cancel/recovery fail closed | 是 |
| helper input-mutated/unknown | `dispatch-uncertain` | 是 |
| helper durable none evidence | 可映射 safe pre-side-effect failure | 是 |
| real W6 run | `warp-macos-production-disabled` | 是 |

## 验收方式

- `git diff --check`
- Plan Review 复核 Fix Mapping
- 后续实现阶段按计划补 fixture helper contract tests、supervisor integration tests、opt-in local spike

### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| V3-PH4-PLAN-P1-01 | fixed | Phase 4 禁止 real W6 / real project production run；拆分 diagnostic eligibility 与 Phase 5 production candidate；删除 completion-only degraded production run。 | 消除 capability spike 与生产运行授权混淆。 |
| V3-PH4-PLAN-P1-02 | fixed | 定义 target challenge payload/response、TTL、one-time/replay、proof、artifact path 与失败分类。 | 让 target-to-wrapper challenge 可实现、可测试且不授权生产派发。 |
| V3-PH4-PLAN-P1-03 | fixed | 增加 job/attempt/lease `adapterIdentity` 与 prepare/dispatch/cancel/recovery/receipt 验证位置；删除 receipt target mismatch 承诺。 | 与 Phase 2/3 fencing 对齐，避免未定义 receipt target proof。 |
| V3-PH4-PLAN-P2-01 | fixed | 定义 helper `SubmitResult` 和 `sideEffectState` 映射规则；safe retry 必须有 durable `none` evidence。 | 明确 side-effect 边界，防止未知/部分输入被误判为可重试。 |

## 仍需用户确认

无。

## 下一步建议

可以重新提交 Phase 4 Plan Fix Review。获批前不要进入 Phase 4 实现。
