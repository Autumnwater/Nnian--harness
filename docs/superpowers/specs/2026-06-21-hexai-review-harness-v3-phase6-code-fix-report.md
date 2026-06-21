# HEXAI Review Harness V3 Phase 6 Code Fix 报告

Date: 2026-06-21

## 修复结论

Phase 6 Code Review 提出的 1 个 P1 finding 和 1 个 P2 finding 已按最小范围修复，可以重新提交 Code Fix Review。

本轮仍保持 Phase 6 边界：不启用真实 Warp side effect，不使用剪贴板提交，不自动 approval，不自动 commit/push。

## 修复清单

| 编号 | 严重度 | Review 问题 | 处理状态 | 修改文件 |
|------|--------|-------------|----------|----------|
| V3-PH6-CODE-P1-01 | P1 | Warp capability production eligibility 接受缺失 `fixture:false` 或缺 helper provenance 的非 schema evidence | 已修复 | `scripts/warp-macos-adapter.js`, `scripts/harness.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` |
| V3-PH6-CODE-P2-01 | P2 | helper side-effect CLI 不是严格 `--request` only，未知参数会被忽略 | 已修复 | `scripts/warp-macos-helper.js`, `tests/warp-macos-adapter.test.js` |

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-PH6-CODE-P1-01 | fixed | `scripts/warp-macos-adapter.js`, `scripts/harness.js`, `tests/warp-macos-adapter.test.js`, `tests/harness.test.js` | `deriveWarpCapabilities()` 的 Phase 5 production candidate 必须满足 strict real helper evidence；`warp-doctor --probe-real` 写 capability 前调用同一校验；新增 missing fixture、missing helper provenance、wrong kind、wrong protocol、malformed capability pilot 拒绝测试。 |
| V3-PH6-CODE-P2-01 | fixed | `scripts/warp-macos-helper.js`, `tests/warp-macos-adapter.test.js` | `submit-text` / `interrupt` side-effect 命令只允许 `--request` 和 `--json`；新增 unknown option rejection 测试。 |

## 关键修复说明

### Phase 5 eligibility 严格依赖 real helper evidence

- 原问题：`deriveWarpCapabilities()` 使用 `evidence.fixture !== true` 判断 non-fixture，缺失 `fixture` 字段也可进入 Phase 5 production candidate；`warp-doctor --probe-real` 只拒绝 `fixture === true`，没有校验 helper provenance。
- 修复方式：新增 `assertRealWarpCapabilityEvidence()` 和 shared validation reasons，要求 `protocolVersion: 1`、`kind: 'warp-macos.capability'`、`fixture === false`、`helper.kind === 'warp-macos-helper'`、有效 helper version 和 `sha256:<64 hex>` pathHash。Phase 5 candidate 必须通过该 strict real schema；`warp-doctor --probe-real` 写入前也使用同一校验。
- 为什么这样修：Phase 6 批准计划要求 real W6 pilot 只能由真实 non-fixture helper capability evidence 授权，不能由缺字段、错误 kind/protocol 或无 provenance 的 JSON 误授权。
- 行为影响：fixture Phase 4 diagnostic / production-test 仍按原边界工作；Phase 5 pilot 对缺失 `fixture:false`、缺 helper provenance、错误 kind/protocol 的 evidence 均 fail-closed。

### helper side-effect CLI 改为严格白名单

- 原问题：`warp-macos-helper.js` 只拒绝已知 split args，但会忽略 `--foo bar` 这类未知参数。
- 修复方式：`submit-text` 和 `interrupt` 先执行 side-effect option 白名单校验，只允许 `request` 和 `json`；已知 split args 继续返回更精确的 `split-side-effect-argument-forbidden`。
- 为什么这样修：side-effect CLI 契约是完整 fenced request 的单入口，未知参数不应被静默接受，避免后续扩展时形成 ambient state 或参数绕路。
- 行为影响：合法 `--request <path|json> --json` 不变；任何未知 side-effect option 都 fail-closed。

## 修改文件

- `scripts/harness.js`
- `scripts/warp-macos-adapter.js`
- `scripts/warp-macos-helper.js`
- `tests/harness.test.js`
- `tests/warp-macos-adapter.test.js`
- `docs/superpowers/specs/2026-06-21-hexai-review-harness-v3-phase6-code-fix-report.md`

## 验证结果

- `node --check scripts/warp-macos-helper.js`: 通过
- `node --check scripts/warp-macos-adapter.js`: 通过
- `node --check scripts/harness.js`: 通过
- `git diff --check`: 通过
- `node --test tests/warp-macos-adapter.test.js`: 通过
- `node --test --test-name-pattern 'V3 Phase 4|V3 Phase 5' tests/harness.test.js`: 通过
- `pnpm exec node --test --test-reporter=dot tests/*.test.js`: 通过

## 未处理事项

无。

## 下一步建议

可以重新提交 Phase 6 Code Fix Review。当前不自动 commit/push，等待用户明确指令。
