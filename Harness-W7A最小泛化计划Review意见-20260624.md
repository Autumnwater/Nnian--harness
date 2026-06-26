# Harness 最小泛化实施计划 · Plan Review 意见

> **Review 日期**：2026-06-24
> **Review 窗口**：B — claude-reviewer-deepseek
> **审查对象**：`Harness-W7A最小泛化实施计划-20260624.md`（A 计划，32,404 字节）
> **参照**：H 自产对比计划 `Harness-最小泛化实施计划-20260624.md`
> **W6-A baseline SHA-256**：`72c6cc57d38e94221ed5472ef9b6112922143b100406d4450d7a67f12bbf7259`

---

## Decision: pass

> P0=0, P1=3, P2=6。无阻塞级问题。所有 12 项验收标准在当前范围内可达。
> P1 项需在进入 `code-review` 阶段前修复；可在本计划修复或后续阶段单独处理。

---

## 1. 核心技术点 Review（H 指定的必查项）

### 1.1 `loadWorkflowConfig` cacheKey 隔离（A 计划 §1.1 / §8.3）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| A 计划识别的"单例缓存 bug"是否准确 | ✅ **准确** | L41 检查 `_workflowConfig.taskId === taskId` 在 taskId 变化时会触发重读，但 L44 始终读 `weekly-canvas-task.json`，所以 W7-A 仍然拿到 W6-A 的 subtasks。A 计划诊断完全正确。 |
| A 计划修复方向（cacheKey + taskId-specific file lookup）是否正确 | ✅ **正确** | 新增 `_workflowConfigCacheKey = ${HARNESS_ROOT}::${taskId}` 实现 taskId 级别缓存隔离，同时 `weekly-canvas-task-${taskId}.json` 优先 → `weekly-canvas-task.json` 回退。W6-A 走 fallback 分支，零影响。 |
| 是否还有其他缓存相关 bug | ⚠️ **发现 1 项** | `_workflowConfigCacheKey` 与 `_workflowConfig` 是分离的两个 module-level 变量，如果 `_workflowConfig` 在其他位置被重新赋值（测试中 `before()` 重设 `HARNESS_ROOT`），cacheKey 可能不同步。详见 **HW7A-P1-002**。 |
| 是否存在 H/A 双方都漏掉的缓存问题 | ✅ **无** | 除上述 cacheKey 同步风险外，缓存逻辑改动面极小且完整。 |

**Verdict**：A 计划的缓存隔离方案是正确且最小的。`_workflowConfigCacheKey` 同步风险是实施细节，P1 级别，不阻塞方案通过。

### 1.2 W6-A 隔离机制（A 计划 §5）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| `statusPath / promptFilePath / outputsDir / handoffsDir` 是否已 taskId 化 | ✅ **已 taskId 化** | L247-257 全部使用 `runs/${taskId}/...` 路径。无需改动。 |
| W6-A status.json 是否真不会被 W7-A 操作触碰 | ✅ **物理隔离成立** | `statusPath(taskId)` 按 `runs/${taskId}/status.json` 派生；W7-A → `runs/W7-A/status.json`，W6-A → `runs/W6-A/status.json`。无交叉引用。 |
| `cmdInit` 的 `archive-existing` 是否会误归档 W6-A | ✅ **不会** | L835-842 使用 `archiveName = ${taskId}-${timestamp}` 创建 taskId 级别子目录。`archiveDir(taskId)` 函数签名的 taskId 参数虽未被使用（L259-261），但实际归档行为是安全的——见 **HW7A-P2-005**。 |
| W6-A 测试用例是否真不被修改 | ✅ **不被修改** | 测试文件末尾 L2256 为最后一行。A 计划明确"在末尾新增 describe 块，不修改现有 describe 块"。验证通过。 |

**Verdict**：W6-A 隔离机制在代码层面已经成立（路径已 taskId 化），A 计划识别准确。唯一瑕疵是 `archiveDir(taskId)` 函数签名有误导性（P2）。

### 1.3 改动面最小化（A 计划 §4 / §9）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| A 计划改动面是否真的"最小" | ✅ **是必要的最小** | A 计划改动面 = `loadWorkflowConfig` cache 隔离 + `cmdInit` 2 处硬编码 + 新建 W7-A JSON + 18 测试。共约 10 行核心代码改动。H 计划改动面更小（3 行 harness.js + 2 schema 正则），但缺少 cache 隔离——当 W6-A 和 W7-A 命令交替执行时，H 方案会因为 L41 的 `taskId` 检查每次都重新读文件（无缓存复用），虽功能正确但有性能退化。**A 计划的 cacheKey 方案更完整。** |
| 是否触碰了不应触碰的文件 | ✅ **遵守** | A 计划 §10 HARD SCOPE OUT 明确列出 11 项不触碰内容。与代码核实：`weekly-canvas-task.json` 不修改、W6-A tests 不修改、schema 不修改、templates 不修改、reviewPlaybooks 不修改。 |
| 是否修改了 W6-A JSON / YAML | ✅ **不修改** | A 计划 §3.1 明确"不动 `workflows/weekly-canvas-task.json`"。YAML 建议保留为只读快照（见 §1.5 YAML 决策）。 |

**Verdict**：改动面是最小必要集，且严格遵守 HARD SCOPE OUT。A 计划比 H 计划多出的 `_workflowConfigCacheKey` 不是过度设计——它解决了跨 taskId 调用时的缓存正确性问题。

### 1.4 18 个 W7-A 测试用例（A 计划 §7.2）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| 测试覆盖是否齐全（init/current/next/check/advance/step） | ✅ **齐全** | #1-3: init; #4: current; #5-7: next; #8-9: check; #10: advance; #11: step; #12: fromSubtask default; #13: status path。6 个核心命令 + 默认值 + 路径正确性 = 覆盖完整。 |
| W6-A 隔离断言（#14/#15）是否充分 | ✅ **充分** | #14: mtime 不变 + subtasks 内容不变（双层断言）；#15: 目录 mtime + 文件清单不变。足以检测意外写入。 |
| mock 策略（§7.4）是否合理 | ✅ **合理** | `mockW7AReport()` 写入 TEST_ROOT 路径，沿用现有 `before()` 的 `cp` 隔离机制。不依赖外部副作用。 |
| 测试 #18 是否合理 | ✅ **合理** | W7-A 只有一个 subtask `W7-A`（与 taskId 同名），不存在 W7-A-01..06。断言 subtasks 列表不含不存在的 ID 是合理的防御性测试。 |

**Verdict**：18 个测试用例覆盖了全部 6 个核心命令、W6-A 隔离、默认值正确性和文件路径正确性。测试密度合理。
⚠️ 测试 #8 "check fails without Fabric section" 的 mock 内容需要明确不含 Fabric 章节时的预期输出——见 **HW7A-P2-004**。

### 1.5 YAML 处理决策（A 计划 §1.3）

**B 窗口明确表态：Option B — 保留 `weekly-canvas-task.yaml` 为 W6-A 只读快照，W7-A 不创建 YAML。**

理由：
1. `loadWorkflowConfig` 只读 JSON（L44-48 事实），YAML 不参与任何代码路径。
2. 删除 YAML 会破坏 W6-A 历史 review 时的可读性对照。
3. 与 JSON 同步维护（Option C）增加双写负担，且 YAML 未被任何自动化引用。
4. 不创建 W7-A YAML 避免了"内容漂移"风险——当未来 W7-A JSON 更新时，不存在过期的 YAML 镜像。
5. 如果未来需要 YAML，可以从 JSON 自动生成（`yq` 或脚本），不应手工维护。

### 1.6 子任务粒度（A 计划 §2.2）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| 决策是否合理（不强拆 W7-A-01..0X） | ✅ **合理** | W7-A 范围（占位治理 + F-05 MVP + Space QA 收敛）= 0.5~1d，拆分到 6 个子任务得不偿失。单 subtask 模型简洁。 |
| 未来扩展位 | ✅ **存在** | `subtasks` 是数组，随时可追加。 |
| 与 W6-A 的 6-subtask 模式是否需一致 | ✅ **不需要一致** | 不同 task 粒度不同。Harness 的 subtask 数组已支持 1~N 个条目。 |

**注意**：H 计划使用 `W7-A-01` 作为 subtask ID（带 `-01` 后缀），A 计划使用 `W7-A`（与 taskId 同名）。两种方式在功能上等价，但 A 计划的 `W7-A` 方案在 status 显示中 `currentSubtask=W7-A` 与 `taskId=W7-A` 相同，可能造成混淆——见 **HW7A-P2-003**。

---

## 2. 通用评审

### 2.1 Fabric-first 核查

本计划是 Harness 工具层改动，不涉及 Fabric 官方能力。W7-A 阶段的 Fabric-first gate 由 W7-A 实施方案（已落地 794 行，含 Fabric 官方能力核查章节）独立满足。Harness 改动不影响该 gate 的触发逻辑（`cmdCheck` 中的 Fabric 关键词检测是 taskId 中性的）。

**通过条件**：✅ W7-A 阶段的 Fabric-first gate 仍能正确触发。

### 2.2 范围守恒

| 检查项 | 结论 |
|--------|------|
| 是否触碰 HEXAI 业务代码 | ✅ 不触碰（明确 HARD SCOPE OUT） |
| 是否触碰 W6-A status / outputs / prompts | ✅ 不触碰（路径隔离已成立） |
| 是否触碰 W6-A workflow JSON | ✅ 不触碰（`weekly-canvas-task.json` 内容不变） |
| 是否触碰 W6-A 现有测试 | ✅ 不触碰（仅末尾新增 describe 块） |

### 2.3 风险与回滚（A 计划 §8）

| 检查项 | 结论 | 证据 |
|--------|------|------|
| §8.1 失败模式覆盖 | ✅ **覆盖充分** | 覆盖 init 失败（Unknown subtask/Unknown stage/Config mismatch）、check 失败（primaryReportPath missing）、stage 错误（set-current 修复）。 |
| §8.4 完全回滚步骤 | ✅ **5 步可逆** | 恢复 cache 单例 → 删 W7-A JSON → 恢复 fromSubtask 硬编码 → 恢复 W6-A first-run → 删 W7-A 测试块。步骤完整。 |
| 实施过程中断 | ⚠️ **部分覆盖** | A 计划未显式讨论中断场景（用户取消 / token 耗尽），但 §9 的顺序设计（S1→S2→S3→S4→S5）是增量的，每步可独立回滚。建议在实施时沿用 W6-A 的 handoff 机制。见 **HW7A-P2-006**。 |

### 2.4 验收 checklist（A 计划 §11）

| 检查项 | 结论 |
|--------|------|
| 12 项验收是否覆盖 H 给出的 5 项目标 | ✅ 1-1 对应：H#1=验收#1-2，H#2=验收#3，H#3=验收#4，H#4=验收#5-6，H#5=验收#7-8。H#6-7（W6-A 测试回归 + 新测试通过）= 验收#11-12。 |
| 验收方式是否可执行 | ✅ 每项均有明确命令或测试断言 |
| W6-A 隔离验收（#7/#8）是否够强 | ✅ mtime + 内容 + 路径三层断言 |

---

## 3. 与 W6-A 主计划的关系

- A 计划 §11.3 明确声明"不输出与 W6-A 主计划冲突的范围声明"，经核实：Harness 泛化属于工具层改动，W6-A 主计划属于任务产物层，抽象层不同，无冲突。
- **通过条件**：✅ 两层无冲突。

---

## 4. A 计划自检结果复核

| A 自检项 | B 复核结论 |
|----------|------------|
| ✅ P0 范围四项（最小改造 / W6-A 隔离 / 命令支持 / 测试覆盖）每项都有技术方案小节 | ✅ **准确**。§1/§5/§4/§7 分别对应，内容充分。 |
| ✅ Harness 触发面已最小化 | ✅ **准确**。仅改 `loadWorkflowConfig` + `cmdInit` + 新建 JSON + 18 测试。 |
| ⚠️ 1 项需 PM 介入确认（YAML 处理方式） | ✅ **准确**。B 窗口明确表态 Option B（保留 YAML 为只读快照）。 |

---

## 5. Findings

### Finding HW7A-P1-001

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: schemas
Files:
- `schemas/status.schema.json`
- `schemas/finding.schema.json`

Issue:
A 计划未涉及 schema 正则泛化。当前状态：
- `status.schema.json:48` `patternProperties` = `^W6-A-\\d{2}$` → W7-A 的 subtask ID `W7-A` 不匹配此模式，不会被 schema 校验（静默跳过）
- `finding.schema.json:12` `pattern` = `^W6-A-\\d{2}-P[012]-\\d{3}$` → W7-A finding ID（如 `W7-A-P0-001`）不匹配，会在 `code-review` 阶段的 `check` gate 中被拒绝

Expected:
方案应至少补充以下内容：
1. 明确声明 schema 正则泛化的触发点：在进入 W7-A 的 `code-review` 阶段前完成
2. 给出正则改写方案（参考 H 计划：`^[Ww]\\d+-A-\\d{2}$` 和 `^[Ww]\\d+-A-\\d{2}-P[012]-\\d{3}$`）
3. 或明确将 schema 改动纳入本计划的改动清单（而非留到后续阶段）

Acceptance:
方案中增加一节 "Schema 正则泛化（code-review 前触发）"，写清：
- 触发条件：W7-A 首次进入 `code-review` 阶段前
- 责任人：claude-implementer-minimax
- 正则改写范围：`status.schema.json:48` + `finding.schema.json:12`
- 或在 §9 步骤列表中增加 S4.5 "schema 正则泛化"

### Finding HW7A-P1-002

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js`

Issue:
A 计划 §8.3 伪代码引入 module-level 变量 `_workflowConfigCacheKey`，与 `_workflowConfig` 分离管理。如果 `_workflowConfig` 在测试中被重新赋值（如测试 `before()` 中重新 cp Harness 到 TEST_ROOT，改变了 `HARNESS_ROOT`），`_workflowConfigCacheKey` 可能与 `_workflowConfig` 的实际来源不同步。

具体场景：测试中 `before()` 调用 `harness('init W6-A --force')` → `loadWorkflowConfig('W6-A')` 设置了 `_workflowConfigCacheKey = "OLD_ROOT::W6-A"`。之后 HARNESS_ROOT 被重置，但 `_workflowConfigCacheKey` 仍然是旧值。

Expected:
在实施方案中补充一项：
- `_workflowConfig` 被重新赋值时，同步重置 `_workflowConfigCacheKey = null`
- 或在 `loadWorkflowConfig` 入口处增加 HARNESS_ROOT 一致性校验
- 或在测试的 `before()` 中显式重置两个变量

Acceptance:
方案 §8.3 伪代码附近增加注释说明 cacheKey 同步策略；或在 §7.3 测试隔离中补充说明。

### Finding HW7A-P1-003

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js`

Issue:
A 计划 §4.1 覆盖了 `cmdInit` 的 `fromSubtask` 默认值（L849）和 `isW6AFirstRun` 分支（L874），但未覆盖 L860 的 taskTitle fallback：
```javascript
taskTitle: getWorkflowConfig().taskTitle || `${taskId} 画布本体UIUX收口`,
```
如果 W7-A 的 JSON config 被误删或 `getWorkflowConfig()` 返回了 fallback 默认 config（`weekly-canvas-task.json`），则 W7-A 的 status.json 中 taskTitle 会变成 `W7-A 画布本体UIUX收口`，语义错误。

Expected:
将 fallback 改为 taskId 中性表述，例如：
```javascript
taskTitle: getWorkflowConfig().taskTitle || `${taskId} 任务`,
```
或 `taskTitle: getWorkflowConfig().taskTitle || taskId`。

Acceptance:
方案 §4 或 §9 中增加 L860 改动项；或在 HARD SCOPE OUT 中明确说明不修改 L860 的理由（如"W7-A 有独立 config，fallback 永不触发"）。

---

### Finding HW7A-P2-001

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: documentation
Files:
- （A 计划 §6.3）

Issue:
§6.3 中的 cp 命令 source 和 dest 是同一路径：
```bash
cp .../W7-A画布可演示交互闭环实施计划-20260624.md \
   .../W7-A画布可演示交互闭环实施计划-20260624.md
```
两条路径完全相同，cp 是空操作。实际情况更简单：已落地方案 **已经在** Harness 期望路径上（`reportDir` = `/Users/admin/project/ai/review/W7`，`taskTheme` = `W7-A画布可演示交互闭环`，日期 = `20260624`，产物路径完全匹配）。

Expected:
修正 §6.3 为：已落地方案已在 Harness 期望路径上，无需 cp。直接执行 `pnpm harness init W7-A && pnpm harness check W7-A && pnpm harness step W7-A` 即可。

Acceptance:
§6.3 修正或删除误导性的 cp 命令。

### Finding HW7A-P2-002

Priority: P2
Status: open
Owner: PM (H)
Module: documentation
Files:
- `workflows/weekly-canvas-task.yaml`

Issue:
A 计划 §1.3 标记为"需 PM 介入确认"。B 窗口推荐 Option B：保留 YAML 为 W6-A 只读快照。

Expected:
H 窗口确认 YAML 处理方式，并在方案中记录决策。

Acceptance:
方案 §1.3 更新为已确认的决策（Option A / B / C）。

### Finding HW7A-P2-003

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: documentation
Files:
- （A 计划 §9.1 S3）

Issue:
§9.1 S3 的措辞："如不需要 W7-A 等价分支则直接删；如需要保留 W6-A first-run 行为，把 imported-completed 列表抽到 W6-A JSON 的 firstRunDefaults.importedCompleted 字段"。这是一个实施时的决策点，不是确定的方案。

Expected:
明确 S3 的具体操作（删除或重构），而非保留"如...则..."的二分。

Acceptance:
S3 改为确定性的步骤描述。建议：
- **推荐做法**：保留 W6-A first-run 分支不做改动（H 计划方案），因为 W7-A 不传 `--from` 时走的是 W7-A JSON 的第一个 subtask，不会触发 `isW6AFirstRun`（条件 `taskId === 'W6-A'` 对 W7-A 为 false）
- 如果选择删除/重构，需写清重构后的等价行为

### Finding HW7A-P2-004

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: tests
Files:
- `tests/harness.test.js`

Issue:
测试 #8 "W7-A check fails without Fabric section" 和 #9 "W7-A check passes with Fabric section + 已落地方案" 需要明确的 mock 文件内容。A 计划 §7.4 给出了 `mockW7AReport(content)` 函数，但未说明 #8 和 #9 各自的 `content` 参数。

Expected:
测试用例表中补充：
- #8 mock 内容：`"# W7-A Test\n\nNo Fabric section here."`（不含"Fabric 官方能力核查"）
- #9 mock 内容：使用真实已落地 794 行方案（或其精简版但保留 Fabric 章节标题）

Acceptance:
§7.2 测试表或 §7.4 mock 策略中补充 #8/#9 的 mock 内容说明。

### Finding HW7A-P2-005

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js` (L259-261)

Issue:
`archiveDir(taskId)` 函数签名接受 `taskId` 参数但完全不使用（L259-261 始终返回 `path.join(HARNESS_ROOT, 'runs', 'archive')`）。A 计划 §5.1（以及 §8.2）中"archive 函数（`archiveDir(taskId)`）按 taskId 隔离目录"的表述与代码事实不符。实际隔离是由 L838 `archiveName = ${taskId}-${timestamp}` 实现的，而非 `archiveDir` 函数本身。

Expected:
A 计划中更正对 `archiveDir(taskId)` 的描述：明确说明实际的隔离机制是 `archiveName` 的 taskId 前缀，而非 `archiveDir` 函数返回值。
可选：在本次改动中将 `archiveDir` 改为真正使用 taskId（如返回 `runs/archive/${taskId}`），但这超出了"最小泛化"范围。

Acceptance:
§5.1 / §8.2 中关于 `archiveDir` 隔离的表述更新为准确描述。非阻塞——实际归档行为已经是安全的。

### Finding HW7A-P2-006

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: documentation
Files:
- （A 计划 §8）

Issue:
§8 回滚方案未覆盖以下场景：
1. `runs/W7-A/` 目录的清理——完全回滚时应删除
2. 实施过程中断（用户取消 / token 耗尽）后的恢复步骤
3. 测试中途失败时的 TEST_ROOT 清理

Expected:
§8 补充：
- 完全回滚步骤增加 "删除 `runs/W7-A/` 目录"
- 增加一节 "实施中断恢复"，引用现有 handoff 机制
- 或明确声明"中断恢复沿用 W6-A handoff 机制（`generateHandoffPath`），无需新增"

Acceptance:
§8 中补充上述内容，或明确声明非阻塞（中断恢复机制已存在）。

---

## 6. Findings 分级复核

| 级别 | 数量 | 状态 |
|------|------|------|
| P0 | 0 | — |
| P1 | 3 | HW7A-P1-001（schema 正则未覆盖）、HW7A-P1-002（cacheKey 同步风险）、HW7A-P1-003（taskTitle fallback 硬编码） |
| P2 | 6 | HW7A-P2-001（cp 命令错误）、HW7A-P2-002（YAML 决策待确认）、HW7A-P2-003（S3 实施决策未定）、HW7A-P2-004（测试 mock 内容未明确）、HW7A-P2-005（archiveDir 描述不准确）、HW7A-P2-006（回滚步骤不完整） |

---

## 7. 准入复核

| 准入门禁 | 状态 |
|----------|------|
| Fabric 官方能力核查章节存在 | ✅ 本计划为 Harness 工具层，不涉及 Fabric。W7-A 实施方案独立满足。 |
| P0 全部关闭 | ✅ 无 P0 |
| P1 全部关闭或由 PM 接受降级/后移 | ⚠️ 3 项 P1 待处理（建议在实现前或 code-review 前处理） |
| 验收标准可执行 | ✅ 12 项均有命令或测试断言 |
| 文件变更范围清楚 | ✅ §9.3 + §10 + 附录 B 明确定义 |
| 静态与动态验证计划清楚 | ✅ §7 测试计划 + §11 验收 checklist |
| 前序模块契约未被破坏 | ✅ W6-A 隔离成立，`weekly-canvas-task.json` 不修改 |

**准入结论**：`可进入实现`（P1 项建议实现前处理，但不强制阻塞 init → plan-review 路径）

---

## 8. 最强结论

1. **A 计划是正确且最小的 Harness 泛化方案。** 与 H 计划相比，A 计划的 `_workflowConfigCacheKey` 不是过度设计——它解决了跨 taskId 调用时的缓存正确性问题，而 H 计划省略此项会导致每次 taskId 切换时重复读文件（功能正确但无缓存）。

2. **唯一实质差距是 schema 正则泛化未纳入本轮范围（HW7A-P1-001）。** 这不阻塞 `init → plan-review` 核心路径，但必须在 W7-A 进入 `code-review` 阶段前修复。建议 A 计划在 §9 或 §11 中增加触发点说明，或直接将 schema 改动纳入步骤列表。其余 P1/P2 均为文档和实施细节问题，不阻塞方案通过。

---

## 9. 完成告知

1. **Decision**：`pass`
2. **P0 / P1 / P2 数量**：P0=0, P1=3, P2=6
3. **所有 P1 是否有可验证的 Acceptance 标准**：✅ 是（每项 P1 均有明确的 Expected + Acceptance）
4. **YAML 处理选项的明确倾向**：**Option B** — 保留 `weekly-canvas-task.yaml` 为 W6-A 只读快照，W7-A 不创建 YAML
5. **最强结论（1-2 句）**：A 计划是 Harness 最小泛化的正确方案，`loadWorkflowConfig` cacheKey 隔离 + taskId-specific 文件查找是核心正确性保证。3 项 P1 中 schema 正则泛化需在 code-review 前补上，其余为实施细节问题——整体方案可通过，建议实现前处理 P1 项。

---

**Review 完成。H 窗口可决定是否批准进入代码实施。**
