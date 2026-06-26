# Harness 最小泛化实施计划 · Plan Fix Review 意见

> **Review 类型**：plan-fix-review（方案修订复审）
> **Review 窗口**：B — claude-reviewer-deepseek
> **日期**：2026-06-24
> **审查对象**：
> - 方案 v2：`Harness-W7A最小泛化实施计划-20260624.md`（798 行）
> - FixReport v1：`Harness-W7A最小泛化计划FixReport-20260624.md`（176 行）
> - 上轮 Review：`Harness-W7A最小泛化计划Review意见-20260624.md`（P0=0, P1=3, P2=6）
> **不修改文件，不写代码，不 commit/push**

---

## Decision: pass

> P0=0, P1=2, P2=5。计划 v2 实体内容可进入 code-implementation。
> P1 项均为 FixReport 层面的 traceability 问题，不阻塞方案实施。

---

## 1. 逐 Finding 复核

### 1.1 P1 Finding 复核

| Finding | 原状态 | 本轮状态 | 复核结论 |
|---------|--------|----------|----------|
| **HW7A-P1-001** (schema 正则) | open | **false-positive（H 拍板）** | ✅ 合理。W7-A subtask ID `W7-A` 不匹配 `^W6-A-\d{2}$` → patternProperties 静默跳过，不阻塞。Finding schema 影响 code-review 阶段，不在本轮 `init→plan-review` 范围。但方案正文未记录此延期风险——见 P2-003。 |
| **HW7A-P1-002** (cacheKey 同步) | open | **fixed** | ✅ 已修复。§8.3 完整伪代码（L506-561）：`_workflowConfig = parsed; _workflowConfigCacheKey = cacheKey` 原子替换；14 个 cmd 函数一致性清单；测试 #19/#20 覆盖跨 taskId 隔离。 |
| **HW7A-P1-003** (taskTitle fallback) | open | **fixed** | ✅ 已修复。§1.1 新增 line 860 行；§8.3 L552-557 throw on missing taskTitle（方案 A）；测试 #21 验证不 fallback 到 W6-A 字面值。 |

**P1 结论**：3/3 处理完毕。HW7A-P1-001 false-positive 合理（见 P2-003 补充建议）。HW7A-P1-002/003 修复充分。

### 1.2 P2 Finding 复核

**关键发现：FixReport 的 P2 编号体系与上轮 Review 不一致。** 上轮 Review 使用 `HW7A-P2-001` 至 `HW7A-P2-006`，FixReport 使用 `P2-001` 至 `P2-006`，但映射关系不同——FixReport 实质上重新分配了 P2 编号。详见 HW7A-FR-P1-001。

以下按**上轮 Review 原编号**逐项复核：

| 原 Finding | 内容 | 本轮状态 | 复核结论 |
|------------|------|----------|----------|
| **P2-001** | §6.3 cp 命令 source=dest | **fixed** | ✅ §6.3 彻底重写：情形 A（路径对齐，无 cp）+ 情形 B（路径不对齐，`cp ... $(jq -r ...)`）。no-op cp 已删除。 |
| **P2-002** | S3 实施决策"如...则..."模糊 | **partial** | ⚠️ §8.3 给出了确定性的 firstRunDefaults 设计（L580-593），但 §9.1 S3 步骤描述**仍保留**"如不需要...如需要..."的旧措辞，未同步更新。设计已定但步骤描述滞后。 |
| **P2-003** | YAML 决策待 PM 确认 | **fixed** | ✅ §1.3 明确 Option B：保留 W6-A YAML 只读快照，不新建 W7-A YAML。H 已拍板。 |
| **P2-004** | 测试 #8/#9 mock 内容未明确 | **unfixed** | ❌ §7.2 测试表未补充 #8/#9 的 mock 内容说明（#8 不含 Fabric → 应失败；#9 含 Fabric → 应通过）。§7.4 `mockW7AReport(content)` 仍为通用签名。FixReport 将此编号重映射为"JSON 解析 try/catch"（非原 P2-004 内容）。 |
| **P2-005** | `archiveDir(taskId)` 描述不准确 | **unfixed** | ❌ §5.1 和 §8.2 措辞与 v1 基本一致，未更正"archive 函数按 taskId 隔离目录"的不准确表述。实际隔离靠 `archiveName` 前缀，非 `archiveDir` 函数。 |
| **P2-006** | 回滚步骤缺少 `runs/W7-A/` 清理 | **unfixed** | ❌ §8.4 仍为 5 步，未增加 `runs/W7-A/` 目录删除、中断恢复步骤或 TEST_ROOT 清理说明。 |

**P2 结论**：3/6 已修复（P2-001/P2-002/P2-003）；3/6 **未修复**（P2-004/P2-005/P2-006）。未修复项均为文档/清晰度级别，不阻塞代码实施。

---

## 2. 新增 Findings

### Finding HW7A-FR-P1-001

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: FixReport
Files:
- `Harness-W7A最小泛化计划FixReport-20260624.md`

Issue:
FixReport 的 P2 编号体系与上轮 Review 不一致。上轮 Review 使用 `HW7A-P2-001` 至 `HW7A-P2-006`（6 个具体 finding），FixReport 使用 `P2-001` 至 `P2-006`，但映射关系不同：

| FixReport P2 | FixReport 声称修复内容 | 对应上轮原 Finding |
|-------------|----------------------|-------------------|
| P2-001 | `from \|\| getSubtasksForTask()[0].id` | **无直接对应**（这是 v1 已有设计，非 review finding） |
| P2-002 | firstRunDefaults 抽象 | P2-002（partial match） |
| P2-003 | 测试 #22-#24 | **无直接对应**（新增测试，非 review finding 修复） |
| P2-004 | JSON 解析 try/catch | **无直接对应**（新 concern，非 review finding） |
| P2-005 | 修订记录 + 追踪表 | **无直接对应**（元数据） |
| P2-006 | YAML Option B | P2-003 |

这使得从"上轮 Review finding → FixReport → 方案修订"的追溯链断裂。后续 reviewer（如 code-fix-review）无法判断某个 finding 是否真正被修复。

Expected:
FixReport 使用与上轮 Review **完全一致的 Finding ID**（`HW7A-P2-001` 至 `HW7A-P2-006`），逐项列出修复状态（fixed / deferred / unfixed / accepted-unfixed），修复文件，验证方法。

Acceptance:
FixReport 的 fix mapping 表增加一列"上轮 Finding ID"，或在每条记录中使用 `HW7A-P2-00X` 前缀。或：在 FixReport 开头增加"编号对照表"说明映射关系。

### Finding HW7A-FR-P1-002

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: documentation / plan
Files:
- `Harness-W7A最小泛化实施计划-20260624.md`
- `Harness-W7A最小泛化计划FixReport-20260624.md`

Issue:
FixReport 声称"6/6 P2 fixed"，但按上轮 Review 原编号逐项复核，实际只有 2.5/6 已修复（P2-001 完全修复 + P2-002 设计已定但步骤未同步 + P2-003 完全修复）。以下 3 项原始 P2 finding **未在方案 v2 中修复**：

1. **P2-004**（测试 #8/#9 mock 内容未明确）：§7.2 未补充 mock 内容说明；`mockW7AReport(content)` 仍为通用签名。
2. **P2-005**（`archiveDir(taskId)` 描述不准确）：§5.1 / §8.2 措辞未更正。
3. **P2-006**（回滚步骤缺 `runs/W7-A/` 清理）：§8.4 仍为 5 步。

Expected:
FixReport 对上述 3 项明确标注真实状态：
- **Option A**（推荐）：标注为 `accepted-unfixed`（P2 级别，文档问题，不阻塞），并简述理由
- **Option B**：在方案 v2 中实际修复这 3 项

Acceptance:
FixReport 的"上轮 Finding 遗留状态"表中，P2-004/P2-005/P2-006 的状态从 `fixed` 改为 `accepted-unfixed` 或实际修复后标注 `fixed`。

---

### Finding HW7A-FR-P2-001

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: plan
Files:
- `Harness-W7A最小泛化实施计划-20260624.md`

Issue:
方案 v2 在多处仍引用"18 个测试"，但 §7.2 已扩展为 24 个用例（#1-#18 v1 原有 + #19-#24 v2 新增）。不一致位置：

| 位置 | 当前文本 |
|------|---------|
| §9.1 S5 | `§7.2 的 18 个用例` |
| §11.1 #12 | `新增 18 个 W7-A 测试全部通过` |
| §12.1 | `新增 18 个 W7-A 集成测试` |
| 附录 D | `§7 18 个 W7-A 测试用例清单` |
| §12 末尾 A 窗口报告 | `新增 18 个 W7-A 测试` |

Expected:
统一改为 "24 个" 或保持 "18+6 个" 的明确拆分。

Acceptance:
grep `"18 个"` 在方案中仅出现在"v1 原有 18 个"的上下文，而非"本轮共 18 个"。

### Finding HW7A-FR-P2-002

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: plan
Files:
- `Harness-W7A最小泛化实施计划-20260624.md` §6.3

Issue:
§6.3 情形 B 的 cp 命令使用 `jq -r '.subtasks["W7-A"]...'` 从 status.json 提取 primaryReportPath。`jq` 是外部依赖，并非所有环境预装（特别是 CI 或最小化 Node 环境）。

Expected:
补充说明：`jq` 为 macOS `brew install jq` 或 Linux `apt install jq` 可获取；或提供纯 Node 替代方案（`node -e "console.log(require('./runs/W7-A/status.json').subtasks['W7-A'].stages['implementation-plan'].primaryReportPath)"`）。

Acceptance:
§6.3 情形 B 附近增加 `jq` 依赖说明或 Node 替代命令。

### Finding HW7A-FR-P2-003

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: plan
Files:
- `Harness-W7A最小泛化实施计划-20260624.md`

Issue:
HW7A-P1-001（schema 正则泛化）被 H 拍板为 false-positive，理由是"不阻塞 init→plan-review"。这个判断本身合理。但方案正文（§0 / §11.2 / §12.2）未记录这一延期风险。只有 §14 追踪表标注了 false-positive。

Expected:
在 §11.2 "不在演示版口径内的事项"中增加一条：
> - Schema 正则泛化（`status.schema.json` / `finding.schema.json`）：本轮不纳入；将在 W7-A 首次进入 `code-review` 阶段前作为独立改动完成（owner: claude-implementer-minimax）

Acceptance:
§11.2 中可见 schema 正则泛化的延期说明。

### Finding HW7A-FR-P2-004

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: plan
Files:
- `Harness-W7A最小泛化实施计划-20260624.md` §9.1

Issue:
§9.1 S3 步骤描述保留了 v1 的模糊措辞：
> 移除 `cmdInit` 中 `isW6AFirstRun` 硬编码分支（如不需要 W7-A 等价分支则直接删；如需要保留 W6-A first-run 行为，把 imported-completed 列表抽到 W6-A JSON 的 `firstRunDefaults.importedCompleted` 字段）

但 §8.3 L580-593 已给出**确定性的** `firstRunDefaults` 设计——不再有"如...则..."的二分。S3 的描述应与 §8.3 一致。

Expected:
S3 改为：
> 改 `scripts/harness.js`：`cmdInit` 中 `isW6AFirstRun` 硬编码分支替换为通用 `firstRunDefaults` 逻辑（见 §8.3 L580-593）；W6-A JSON 新增 `"firstRunDefaults": { "importedCompleted": ["W6-A-01"] }`

Acceptance:
§9.1 S3 描述不包含"如不需要...如需要..."的二分措辞。

### Finding HW7A-FR-P2-005

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: tests
Files:
- `tests/harness.test.js`（计划 §7.2 测试 #21, #24）

Issue:
测试 #21（删除 W7-A config 的 taskTitle）和 #24（W7-A config JSON 改为 invalid）在 TEST_ROOT 中修改了 W7-A config 文件。测试清理后，后续测试可能读取到被修改的 config。

Expected:
在 §7.3 测试环境隔离中补充说明：修改 config 的测试应在 `beforeEach` 中从 srcHarness 重新 cp 原始 W7-A config，或在测试结束后恢复原始内容。`before()` 的 `srcHarness cp` 已确保每个 describe 块有干净的 TEST_ROOT 副本，但同一 describe 块内的 `it()` 之间可能需要额外保护。

Acceptance:
§7.3 或 §7.4 中补充 config-mutating 测试的恢复策略说明。

---

## 3. 方案 v2 实体质量评估（独立于 FixReport）

对方案 v2 正文的技术评审：

| 维度 | 评估 | 备注 |
|------|------|------|
| `loadWorkflowConfig` cacheKey 隔离 | ✅ 正确 | §8.3 完整伪代码：cacheKey、原子替换、14 cmd 一致性、try/catch |
| taskTitle 必填 throw | ✅ 正确 | 方案 A，杜绝 W6-A 字面值污染 |
| firstRunDefaults 抽象 | ✅ 正确 | §8.3 L580-593 设计清晰，W6-A/W7-A 行为等价 |
| YAML Option B | ✅ 正确 | §1.3 H 已决策，W6-A 只读快照 |
| §6.3 接入方式 | ✅ 正确 | 情形 A/B 分流，no-op cp 已删除 |
| W6-A 隔离 | ✅ 成立 | 路径隔离 + cacheKey 隔离 + JSON 不修改 |
| 测试覆盖 | ✅ 充分 | 24 个用例，6 核心命令 + 隔离 + 异常 + 全链路 |
| 验收标准 | ✅ 可执行 | 16 项均有命令或测试断言 |
| 回滚方案 | ✅ 基本完整 | 5 步可逆；缺 `runs/W7-A/` 清理（P2） |
| HARD SCOPE OUT | ✅ 完整 | 11 项不做事项，与代码核实一致 |
| W8-A/W9-A 复用路径 | ✅ 明确 | "复制 JSON + 改 4 个字段"模式已定义 |

**方案 v2 实体质量结论**：技术方案正确、W6-A 隔离成立、验收可执行。可进入 code-implementation。

---

## 4. Findings 分级复核

| 级别 | 数量 | 列表 |
|------|------|------|
| P0 | 0 | — |
| P1 | 2 | HW7A-FR-P1-001（FixReport P2 编号与上轮不一致）、HW7A-FR-P1-002（3 项原始 P2 未修复但 FixReport 称已修复） |
| P2 | 5 | HW7A-FR-P2-001（"18 个"→"24 个"未更新）、HW7A-FR-P2-002（`jq` 依赖未说明）、HW7A-FR-P2-003（schema 延期风险未记录）、HW7A-FR-P2-004（§9.1 S3 措辞未同步）、HW7A-FR-P2-005（config-mutating 测试恢复策略） |

---

## 5. 准入复核

| 准入门禁 | 状态 |
|----------|------|
| P0 全部关闭 | ✅ 无 P0 |
| P1 全部关闭或由 PM 接受降级/后移 | ⚠️ 2 项 FixReport 层面 P1（traceability）。方案实体 0 P1。 |
| 验收标准可执行 | ✅ 16 项均可执行 |
| 文件变更范围清楚 | ✅ §9.3 + §10 + 附录 B |
| W6-A 隔离成立 | ✅ 路径 + cacheKey + JSON 三层隔离 |
| W6-A 测试回归保证 | ✅ firstRunDefaults 等价行为 + 不修改现有 describe 块 |
| 前序模块契约未破坏 | ✅ |

**准入结论**：**方案 v2 可进入 code-implementation**。P1 项为 FixReport traceability 问题，建议修复后重新生成 FixReport，但不强制阻塞代码实施。

---

## 6. 最强结论

1. **方案 v2 实体质量合格**：cacheKey 隔离、taskTitle throw、firstRunDefaults 抽象、YAML Option B、§6.3 接入方式——全部技术决策正确且可落地。24 个测试用例覆盖了从 init 到 step 全链路及 W6-A 隔离。

2. **FixReport 存在 traceability 问题**：P2 编号与上轮 Review 不一致，3 项原始 P2（mock 内容/archiveDir 描述/回滚清理）实质上未修复但被标记为 fixed。这属于 FixReport 撰写质量问题，不阻塞方案进入实现——3 项均为 P2 文档级别，可在 code-implementation 阶段顺手修复。

---

**Plan Fix Review 完成。H 窗口可决定是否批准进入 code-implementation。**
