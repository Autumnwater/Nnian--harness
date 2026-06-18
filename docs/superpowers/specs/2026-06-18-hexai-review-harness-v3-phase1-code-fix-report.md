# HEXAI Review Harness V3 Phase 1 Code Fix 报告

## 修复结论

本轮 Code Review 的 1 个 P1 与 1 个 P2 finding 均已修复。stale lock 现在具备失败关闭的恢复、fencing audit 与 owner-scoped release；协议模型和 schema 4 迁移已拒绝非法数值及字段类型。可以重新提交 Code Review。

## 修复清单

| 编号 | 严重度 | Review 问题 | 处理状态 | 修改文件 |
| --- | --- | --- | --- | --- |
| V3-CODE-P1-01 | P1 | 崩溃遗留锁无法恢复，release 可能删除其他 owner 的锁 | 已修复 | `scripts/execution-lock.js`、`scripts/harness.js`、`tests/execution-lock.test.js`、`tests/harness.test.js` |
| V3-CODE-P2-01 | P2 | 协议数值和 schema 4 字段类型校验不足 | 已修复 | `scripts/execution-protocol.js`、`tests/execution-protocol.test.js` |
| V3-CODE-P1-02 | P1 | legacy read command 无锁迁移写回可覆盖持锁写命令的新状态 | 已修复 | `scripts/harness.js`、`tests/harness.test.js` |

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| V3-CODE-P1-01 | fixed | `scripts/execution-lock.js`、`scripts/harness.js`、`tests/execution-lock.test.js`、`tests/harness.test.js` | `pnpm test`：167/167 通过；覆盖 link 后 crash、canonical create/update 半写、双恢复竞争、多 orphan marker 独立 epoch/audit、owner-safe release |
| V3-CODE-P2-01 | fixed | `scripts/execution-protocol.js`、`tests/execution-protocol.test.js` | `pnpm test`：167/167 通过；覆盖 NaN、Infinity、负数、小数、未来/非法/缺字段 schema 4 及 execution 字段 |
| V3-CODE-P1-02 | fixed | `scripts/harness.js`、`tests/harness.test.js` | legacy read → locked next → current/status/summary/brief 重放后状态字节不变，baseline/stageRevision/execution refs 保持 |

## 关键修复说明

### stale-lock 恢复与 owner fencing

- 原问题：`execution.lock` 在 SIGKILL 后永久残留，且 release 按路径无条件删除。
- 修复方式：拆分原子锁模块；仅在 heartbeat 超时且 PID 已确认不存在时，通过确定性 hard-link marker 原子 claim stale lock。marker 与 canonical 为同 inode 时可幂等完成中断的 unlink；inode 不同则绝不触碰 canonical。所有 acquire 会逐个重放 durable recovery marker；每个 `recoveryId` 独立递增 `execution.lockEpoch` 并写入 audit，全部持久化成功后才 finalize 对应 marker。canonical create 使用完整 temp + fsync + hard-link 发布，update 使用完整 temp + fsync + atomic rename，损坏 canonical 明确 fail-closed。release 只删除当前 owner 的锁。
- 为什么这样修：既允许崩溃恢复，又对活进程、损坏记录和无法确认的 PID 保持 fail-closed。
- 行为影响：正常命令无变化；崩溃遗留锁默认超过 60 秒且 owner 已死亡后可安全恢复。恢复者在 audit 前再次崩溃时，下一进程继续同一 `recoveryId`，epoch 不会重复递增。

### 协议模型与 schema 4 输入校验

- 原问题：`Number()` 可把非法输入带入 cursor、job 和 lease；迁移可能接受不符合 schema 的 execution 状态。
- 修复方式：共享正整数/非负整数校验器；round、revision、lockEpoch、timeoutMs、ttlMs 按语义严格校验。仅 legacy schema 允许补 V4 默认值；schema 4 缺失 revisions/execution/required execution 字段，或包含非法 mode/lockEpoch/active refs 时均拒绝。
- 为什么这样修：协议和持久化边界 fail-fast，避免 NaN 序列化为 null 或错误 fencing 值进入状态。
- 行为影响：合法 V2.4/schema 3 状态仍迁移为 schema 4 manual；非法状态给出稳定错误。

### legacy 读命令迁移写回隔离

- 原问题：`current/status/summary/brief` 不取 execution lock，但 `loadStatus()` 会持久化 legacy migration，可能用旧快照覆盖并发写入。
- 修复方式：`loadStatus` 增加 `persistMigration` 边界；四个读命令只做内存迁移，永不写回。写命令仍在 execution lock 内重新读取并持久化迁移。
- 为什么这样修：保持读命令真正只读，同时确保迁移写回与 baseline、CAS、execution refs 使用同一写锁序列。
- 行为影响：legacy 状态可被读命令正常展示；首次写命令会完成持久化迁移。schema 4 读命令不递增 `stateRevision`。

## 修改文件

- `scripts/execution-lock.js`
- `scripts/execution-protocol.js`
- `scripts/harness.js`
- `tests/execution-lock.test.js`
- `tests/execution-protocol.test.js`
- `tests/harness.test.js`
- `docs/superpowers/specs/2026-06-18-hexai-review-harness-v3-phase1-code-fix-report.md`

## 验证结果

- `pnpm test`：通过，167 tests / 167 pass / 0 fail。
- `node --check scripts/harness.js`：通过。
- `node --check scripts/execution-lock.js`：通过。
- `node --check scripts/execution-protocol.js`：通过。
- `git diff --check`：通过。

## 未处理事项

无。本轮未实现 Warp Accessibility、Hook、Supervisor 命令或 Phase 2 receipt inbox。

## 下一步建议

可以重新提交 Code Review；在复审通过前不 commit、不进入 Phase 2。
