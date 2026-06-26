# W7-A Harness 最小泛化 · Code Review 意见

> **Review 类型**：code-review（代码实现审查）
> **Review 窗口**：B — claude-reviewer-deepseek
> **日期**：2026-06-24
> **审查对象**：
> - `scripts/harness.js`（2749 行，+44/-10）
> - `tests/harness.test.js`（2553 行，+218 行新增 describe 块）
> - `workflows/weekly-canvas-task.json`（174 行，+3 行 `firstRunDefaults`）
> - `workflows/weekly-canvas-task-W7-A.json`（新建，164 行）
> - `Harness-W7A最小泛化代码实施报告-20260624.md`
> **测试结果**：156 tests, 0 failed（W6-A 140 + W7-A 16）
> **不修改文件，不 commit/push**

---

## Decision: pass

> P0=0, P1=1, P2=5。无阻塞级问题。代码实现与方案 v2 一致，W6-A 隔离成立，W7-A 闭环可运行。
> P1 项为未知 taskId fallback 行为，pre-existing 且在本轮 HARD SCOPE OUT 范围内，建议后续规划修复。

---

## 1. 逐项 Review

### 1.1 `loadWorkflowConfig` — cacheKey 隔离 + taskTitle 必填

| 检查项 | 结论 | 代码证据 |
|--------|------|---------|
| cacheKey 是否含 taskId | ✅ | L45: `` const cacheKey = `${HARNESS_ROOT}::${taskId}` `` |
| 缓存命中逻辑 | ✅ | L48: `_workflowConfig && _workflowConfigCacheKey === cacheKey && _workflowConfig._loaded` |
| taskId-specific 文件查找 | ✅ | L53-55: `weekly-canvas-task-${taskId}.json` 优先，找不到回退 default |
| JSON 解析 try/catch | ✅ | L61-74: 分两步 try/catch（readFileSync + JSON.parse），错误消息含 taskId 和路径 |
| taskTitle 必填 throw | ✅ | L86-91: `throw new Error(...)`；不存在任何 fallback |
| 模块级引用替换 | ✅ | L77-78: `_workflowConfig = parsed; _workflowConfigCacheKey = cacheKey` 原子替换 |
| W6-A 走 fallback 分支 | ✅ | W6-A 没有 `weekly-canvas-task-W6-A.json`，自动走 default `weekly-canvas-task.json` |

**Verdict**：实现与方案 v2 §8.3 伪代码完全一致。✅

### 1.2 `cmdInit` — fromSubtask / firstRunDefaults / taskTitle

| 检查项 | 结论 | 代码证据 |
|--------|------|---------|
| fromSubtask 默认值通用化 | ✅ | L888-899: 遍历 subtasks，跳过 `importedCompleted` 集合中的 ID，取第一个不在集合中的 |
| W6-A 默认 from 仍为 W6-A-02 | ✅ | W6-A JSON `firstRunDefaults.importedCompleted: ["W6-A-01"]` → 跳过 W6-A-01，取 W6-A-02 |
| W7-A 默认 from 为 W7-A | ✅ | W7-A JSON 无 `firstRunDefaults` → `_importedCompleted` 为空 → 取第一个 subtask W7-A |
| taskTitle 直接取自 config | ✅ | L910: `taskTitle: getWorkflowConfig().taskTitle` — 无 fallback，依赖 `loadWorkflowConfig` 已 throw |
| W6-A first-run 逻辑通用化 | ✅ | L924-925: `isFirstRun = !from && !stage`；`firstRunDefaults = ...` |
| residual risk 通用化 | ✅ | L1014-1021: 遍历 `firstRunDefaults.importedCompleted`，修改对应 risk 文案 |
| console.log 通用化 | ✅ | L1038-1042: 遍历 `firstRunDefaults.importedCompleted`，打印 imported-completed 提示 |
| 所有 subtask 在 importedCompleted 中的退化 | ✅ | L893-898 IIFE fallback: 返回 `getSubtasksForTask()[0].id` |

**Verdict**：实现正确。W6-A first-run 行为等价保留（`firstRunDefaults.importedCompleted` 显式注入），W7-A 无 first-run 特殊行为。✅

### 1.3 `main()` dispatch — `loadWorkflowConfig` 调用时机

| 检查项 | 结论 | 代码证据 |
|--------|------|---------|
| 是否在所有 cmd 前调用 `loadWorkflowConfig(taskId)` | ✅ | L2649-2654: 15 个命令全部在 switch 前经过 `loadWorkflowConfig(taskId)` |
| `cmdStep` 内部是否重读 config | ✅ 无需重读 | `cmdStep` 在同一进程内调用 `cmdCheck` → `cmdAdvance` → `cmdNext`，全程使用同一个缓存的 config；taskId 不变 |

**Verdict**：dispatch 正确。✅

### 1.4 `weekly-canvas-task-W7-A.json` — 新配置文件

| 检查项 | 结论 | 证据 |
|--------|------|------|
| taskId | ✅ | `"W7-A"` |
| taskTitle | ✅ | `"W7-A 画布可演示交互闭环"`（非空，满足 throw 要求） |
| reportRoot | ✅ | `"/Users/admin/project/ai/review/W7"`（与 W6-A 不同，隔离正确） |
| subtasks | ✅ | 1 个：`{ id: "W7-A", title: "画布可演示交互闭环", ... }` |
| 无 `firstRunDefaults` | ✅ | 不包含该字段 → `loadWorkflowConfig` 中 `|| {}` 正确降级 |
| stages 序列 | ✅ | 10 阶段，与 W6-A 一致 |
| fileNaming | ✅ | 复用 W6-A 模板，`{taskTheme}` / `{reportDir}` / `{subtaskId}` 参数化 |
| requiredPlaybooks | ✅ | 路径与 W6-A 一致 |

**Verdict**：配置文件正确。✅

### 1.5 `weekly-canvas-task.json` — W6-A 增量修改

| 检查项 | 结论 | 证据 |
|--------|------|------|
| 仅新增 `firstRunDefaults` | ✅ | L12-14: 3 行新增，`stages` / `subtasks` / `fileNaming` / `taskTitle` / `taskId` 全部不变 |
| `importedCompleted` 值正确 | ✅ | `["W6-A-01"]` — W6-A-01 是 pre-Harness 完成的 subtask |

**Verdict**：W6-A 回归风险为零。✅

### 1.6 测试 — W7-A describe 块

| 检查项 | 结论 | 证据 |
|--------|------|---------|
| 不修改现有 describe 块 | ✅ | 新增 `describe('W7-A minimal generalization')` 在 L2260，位于文件末尾 |
| init 测试 | ✅ | #1-#3: 创建 status.json + config 加载 + fromSubtask 默认值 |
| current 测试 | ✅ | #4 + #16: 输出含 W7-A 字段 |
| next 测试 | ✅ | #5-#6: prompt 含 taskId-specific 路径 + prompt 文件写入 |
| check 测试 | ✅ | #7-#8: Fabric-first gate 失败/通过 |
| advance 测试 | ✅ | #8: implementation-plan → plan-review |
| step 全链路 | ✅ | #15: init → check → step → plan-review |
| cacheKey 隔离 | ✅ | #9-#11: 独立文件 + mtime 不变 + 多次切换 |
| taskTitle throw | ✅ | #12: 缺少 taskTitle → throw + 恢复原始 config |
| JSON parse throw | ✅ | #13: 无效 JSON → throw + 恢复原始 config |
| W6-A 隔离 | ✅ | #14: mtime + 内容 deepEqual |
| before/after 清理 | ✅ | L2261-2327: 动态创建 W7-A config；L2329-2333: 删除 |

**Verdict**：16 个测试覆盖完整，包括 happy path + error path + 隔离 + 全链路。✅

### 1.7 W6-A/W7-A 隔离

| 隔离维度 | 状态 | 机制 |
|----------|------|------|
| status.json 路径 | ✅ | `statusPath(taskId)` → `runs/{taskId}/status.json` |
| prompts 路径 | ✅ | `runs/{taskId}/prompts/` |
| outputs 路径 | ✅ | `runs/{taskId}/outputs/` |
| handoffs 路径 | ✅ | `runs/{taskId}/handoffs/` |
| 配置文件 | ✅ | `weekly-canvas-task.json` (W6-A) vs `weekly-canvas-task-W7-A.json` (W7-A) |
| cacheKey | ✅ | `${HARNESS_ROOT}::${taskId}` — 不同 taskId 必然 cache miss |
| W6-A JSON 结构 | ✅ | 仅 +3 行 `firstRunDefaults`，不动其他字段 |

**Verdict**：6 层隔离全部成立。✅

---

## 2. Findings

### Finding HW7A-CR-P1-001

Priority: P1
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js` (L53-55)

Issue:
当 `pnpm harness init W8-A`（或其他不存在 taskId-specific config 的 taskId）时，`loadWorkflowConfig` 按以下逻辑执行：

```js
const taskConfigPath = path.join(HARNESS_ROOT, 'workflows', `weekly-canvas-task-${taskId}.json`);
const defaultConfigPath = path.join(HARNESS_ROOT, 'workflows', 'weekly-canvas-task.json');
const jsonPath = fs.existsSync(taskConfigPath) ? taskConfigPath : defaultConfigPath;
```

由于 `weekly-canvas-task-W8-A.json` 不存在，回退到 `weekly-canvas-task.json`（W6-A config）。结果：

1. `config.taskId = "W6-A"` → 不等于 `"W8-A"` → L82 触发 warning（仅 console.error，不阻止）
2. `config.subtasks` = W6-A-01..06（不是 W8-A 的 subtask）
3. `config.reportRoot` = `/Users/admin/project/ai/review/W6`（不是 W8）
4. `config.taskTitle` = `"W6-A 画布本体UIUX收口"`（不是 W8-A）
5. **init 仍然成功**，创建一个 taskId=W8-A 但 subtasks 全是 W6-A 的 status.json

这是 pre-existing 行为（v1 代码同样会 fallback），但在本轮改动后变得更显眼——因为 W7-A 有专属 config 成功运行，而 W8-A 会静默使用 W6-A config。

Expected:
当 `taskId-specific config` 不存在且 `defaultConfigPath` 的 `config.taskId !== taskId` 时，**throw 而非仅 warning**：

```js
if (jsonPath === defaultConfigPath && parsed.taskId !== taskId) {
  throw new Error(
    `No task-specific config found for ${taskId} (expected: ${taskConfigPath}). ` +
    `Default config is for ${parsed.taskId}. ` +
    `Create workflows/weekly-canvas-task-${taskId}.json first.`
  );
}
```

或者至少将 warning 改为 `console.error` 并在最后 `process.exit(1)`（当前仅 warning 后继续执行）。

Acceptance:
`pnpm harness init W8-A`（W8-A 无专属 config）→ exit 1 + 错误消息含 "No task-specific config found" 或 "Create workflows/weekly-canvas-task-W8-A.json"。

**注**：本轮 HARD SCOPE OUT 明确排除了 W8-A/W9-A 适配。此 finding 不是要求实现 W8-A 支持，而是要求**对不支持的 taskId 明确拒绝**（而非静默使用 W6-A config）。这是防御性编程，1-2 行代码改动。

---

### Finding HW7A-CR-P2-001

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: documentation（实施报告）
Files:
- `Harness-W7A最小泛化代码实施报告-20260624.md` §8

Issue:
实施报告 §8 "W7-A step 链路验证" 包含以下 cp 命令：

```bash
cp /Users/admin/project/ai/review/W7/W7-A/W7-A画布可演示交互闭环实施计划-20260624.md \
   /Users/admin/project/ai/review/W7/W7-A/W7-A画布可演示交互闭环实施计划-20260624.md
```

source 和 dest 是同一路径（cp 是 no-op）。该命令的注释写的是"接入已落地方案（Harness 期望路径 == 已落地路径，无需 cp）"——注释说"无需 cp"但命令本身仍然展示了 cp。这是方案 v2 §6.3 已修正的问题（情形 A/B 分流），但实施报告 §8 又回归了原错误。

Expected:
实施报告 §8 改为与方案 v2 §6.3 一致的表述：
- 情形 A（路径已对齐）：直接 `pnpm harness check W7-A`，不展示 cp 命令
- 或直接写 `# 路径已对齐，无需 cp；直接 check` 而不展示 cp 行

Acceptance:
实施报告 §8 不包含 source=dest 的 no-op cp 命令。

### Finding HW7A-CR-P2-002

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: tests
Files:
- `tests/harness.test.js` (L2261-2327)
- `workflows/weekly-canvas-task-W7-A.json`

Issue:
测试 `before()` 钩子动态创建一个**独立于生产文件的** W7-A config（L2268-2326），而不是从生产 `workflows/weekly-canvas-task-W7-A.json` 复制。这意味着：

1. 如果生产 W7-A JSON 被误改（如缺少 taskTitle、错误的 reportRoot、subtask 数组空），测试**不会发现**——因为测试用的是自己的 config
2. 测试中的 config 包含 `"firstRunDefaults": {}`（L2276），而生产文件没有此字段——虽然功能等价，但存在结构不一致

Expected:
Option A（推荐）：`before()` 中从 `srcHarness/workflows/weekly-canvas-task-W7-A.json` 复制生产 config，仅修改路径为 `TEST_ROOT` 下的相对路径（`reportRoot`、`reviewRoot`、`codeRepo`、`requiredPlaybooks` 路径）。

Option B：在测试文件中新增一个测试用例，验证生产 W7-A JSON 的基本结构（taskId、taskTitle 必填且非空、subtasks 非空、stages 含 10 个阶段）。

Acceptance:
至少有一项测试验证生产 `workflows/weekly-canvas-task-W7-A.json` 的内容正确性，或测试 config 从生产文件派生。

### Finding HW7A-CR-P2-003

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js` (L888-925)

Issue:
`cmdInit` 函数中存在两个命名相似的变量，容易混淆：

| 变量 | 行号 | 用途 |
|------|------|------|
| `_firstRunDefaultsForInit` | L891 | 用于 `fromSubtask` 默认值计算（IIFE 闭包） |
| `firstRunDefaults` | L925 | 用于 residual risk 和 console.log 输出 |

两者都从 `getWorkflowConfig().firstRunDefaults` 读取，但用途不同、作用域不同。`_firstRunDefaultsForInit` 的 underscore 前缀暗示 module-level private，但实际是 `cmdInit` 内的局部变量。

Expected:
在 L891 上方添加一行注释说明 `_firstRunDefaultsForInit` 的用途（"用于 fromSubtask 默认值计算，与 L925 的 firstRunDefaults 独立"），或重命名为 `_initFromDefaults` 以区分。

Acceptance:
两个变量的注释或命名能清晰区分用途。

### Finding HW7A-CR-P2-004

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js` (L891-898)

Issue:
`_defaultFromSubtask` 计算逻辑（L893-898）在 subtasks 数组为空时的行为未定义保护：

```js
const _defaultFromSubtask = (() => {
  for (const s of getSubtasksForTask()) {
    if (!_importedCompleted.has(s.id)) return s.id;
  }
  return getSubtasksForTask()[0].id;  // ← 如果 subtasks 为空，.id 抛 TypeError
})();
```

如果 config 中 `subtasks` 为空数组（配置错误），`getSubtasksForTask()[0]` 返回 `undefined`，访问 `.id` 抛出 `TypeError: Cannot read properties of undefined`。这个错误消息不直观，开发者难以定位是 config 问题。

Expected:
在 IIFE 末尾增加防御：
```js
const first = getSubtasksForTask()[0];
if (!first) throw new Error(`No subtasks defined in workflow config for ${taskId}`);
return first.id;
```

Acceptance:
subtasks 为空数组时，init 抛出的错误消息含 "No subtasks defined" 而非 `TypeError: Cannot read properties of undefined`。

### Finding HW7A-CR-P2-005

Priority: P2
Status: open
Owner: claude-implementer-minimax
Module: harness.js
Files:
- `scripts/harness.js` (L43-94)

Issue:
`loadWorkflowConfig` 中 taskId-specific 文件查找路径使用硬编码模板 `` `weekly-canvas-task-${taskId}.json` ``。这意味着未来 W8-A 的 config 文件**必须**命名为 `weekly-canvas-task-W8-A.json`（而非 `w8-canvas-task.json` 等变体）。虽然这个命名约定已在方案中明确，但代码中没有注释说明命名规则。

Expected:
L53 上方增加注释说明命名约定：
```js
// Config naming convention: workflows/weekly-canvas-task-{taskId}.json
// e.g., weekly-canvas-task-W7-A.json, weekly-canvas-task-W8-A.json
```

Acceptance:
L53 附近有注释说明 config 文件的命名约定。

---

## 3. Findings 分级复核

| 级别 | 数量 | 列表 |
|------|------|------|
| P0 | 0 | — |
| P1 | 1 | HW7A-CR-P1-001（未知 taskId fallback 到 W6-A config，应 throw 而非 warning） |
| P2 | 5 | HW7A-CR-P2-001（实施报告 no-op cp 回归）、HW7A-CR-P2-002（测试不验证生产 config）、HW7A-CR-P2-003（cmdInit 相似变量名）、HW7A-CR-P2-004（空 subtasks 无防御）、HW7A-CR-P2-005（config 命名约定无注释） |

---

## 4. 与方案 v2 的一致性

| 方案 v2 要求 | 代码实现 | 一致 |
|-------------|---------|------|
| cacheKey = `${HARNESS_ROOT}::${taskId}` | L45 | ✅ |
| taskId-specific 文件优先 + fallback | L53-55 | ✅ |
| JSON 解析 try/catch | L61-74 | ✅ |
| taskTitle 必填 throw（方案 A） | L86-91 | ✅ |
| `_workflowConfig` 完整替换 + cacheKey 同步 | L77-78 | ✅ |
| fromSubtask 跳过 `importedCompleted` | L888-899 | ✅ |
| cmdInit taskTitle 无 fallback | L910 | ✅ |
| firstRunDefaults 通用化 | L924-925, L1014-1021, L1038-1042 | ✅ |
| W6-A JSON 仅新增 `firstRunDefaults` | L12-14 | ✅ |
| 测试不修改 W6-A describe 块 | 末尾追加 | ✅ |
| 14 个 cmd 函数经 `getWorkflowConfig()` 访问 | L2649-2654 dispatch | ✅ |

**一致性结论**：代码实现与方案 v2 完全一致。✅

---

## 5. 验收 checklist 复核

| # | 验收项 | 状态 |
|---|--------|------|
| 1 | `pnpm harness init W7-A` 可用 | ✅ L2653 → L2659 dispatch；测试 #1-#3 |
| 2 | `pnpm harness current W7-A` 可用 | ✅ L2679 dispatch；测试 #4/#16 |
| 3 | `pnpm harness next W7-A [--copy]` 可用 | ✅ L2669 dispatch；测试 #5/#6 |
| 4 | `pnpm harness check W7-A` Fabric-first gate | ✅ L2684 dispatch；测试 #7/#8 |
| 5 | `pnpm harness advance W7-A` 可用 | ✅ L2689 dispatch；测试 #8/#15 |
| 6 | `pnpm harness step W7-A` 全链路 | ✅ L2674 → cmdStep → check+advance+next；测试 #15 |
| 7 | W6-A status.json mtime + 内容不变 | ✅ 测试 #10/#14 |
| 8 | W6-A outputs/prompts/handoffs 不变 | ✅ 测试 #14 |
| 9 | W6-A JSON 仅新增 `firstRunDefaults` | ✅ diff 验证 |
| 10 | W6-A tests 140 个全通过 | ✅ |
| 11 | W7-A tests 16 个全通过 | ✅ |
| 12 | `pnpm test` exit 0 | ✅ 156/0 |

---

## 6. 最强结论

1. **代码实现质量高，与方案 v2 完全一致。** `loadWorkflowConfig` 的 cacheKey 隔离、taskTitle throw、firstRunDefaults 通用化、fromSubtask 默认值——全部正确落地。W6-A 回归零风险（156 tests / 0 failed），W7-A 16 个新测试覆盖完整闭环。

2. **唯一 P1 是未知 taskId 的 fallback 行为。** `pnpm harness init W8-A`（无专属 config）会静默使用 W6-A config 并创建错误的 status.json。虽然这是 pre-existing 行为且 W8-A 在本轮 HARD SCOPE OUT，但 1-2 行 throw 即可防御。建议在 code-fix 中修复。

---

**Code Review 完成。建议在 code-fix 中处理 HW7A-CR-P1-001（未知 taskId throw），P2 项可接受降级后移。**
