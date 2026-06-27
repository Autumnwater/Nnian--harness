# W7-A Harness 最小泛化 — Plan Fix Report (1 轮)

> **fix owner**：claude-implementer-minimax (A 窗口)
> **日期**：2026-06-24
> **来源**：B 窗口 plan-review + H 复核拍板（H 已对 6 项 P2 给出逐项决策；HW7A-P1-001 驳回/降级）
> **基线**：方案 v1（`Harness-W7A最小泛化实施计划-20260624.md`，654 行，2026-06-24 落盘）
> **行为变更**：0 代码变更；本轮纯方案修订，**仅修改 Harness 目录下 1 个方案文件 + 新增本报告**

---

## 修复结论

| 优先级 | Finding 数 | 已 fixed | deferred | false-positive |
|--------|-----------|----------|----------|----------------|
| P0 | 0 | 0 | 0 | 0 |
| P1 | 3 | **2** | 0 | **1**（HW7A-P1-001） |
| P2 | 6 | **6** | 0 | 0 |
| **合计** | **9** | **8** | **0** | **1** |

**8/9 已 fixed；1 项由 H 拍板为 false-positive（HW7A-P1-001，不阻塞准入）。**
**0 P0 open；0 P1 open；0 P2 open。**

---

### Fix Mapping

| Finding | Status | 修复文件 | 验证 |
| --- | --- | --- | --- |
| HW7A-P1-001 | false-positive | `Harness-W7A最小泛化实施计划-20260624.md`（不修订；H 驳回） | `grep -c "HW7A-P1-001" Harness-W7A最小泛化计划FixReport-20260624.md` >= 1（fix report 中记录驳回理由） |
| HW7A-P1-002 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §1.1 / §3.3 / §4 / §7 / §8.3（完整 cacheKey 伪代码 + 14 cmd 函数一致性 + try/catch） | `grep -c "HW7A-P1-002" Harness-W7A最小泛化实施计划-20260624.md` >= 3；`grep "cacheKey = " Harness-W7A最小泛化实施计划-20260624.md` = 1 |
| HW7A-P1-003 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §1.1（line 860 行）+ §3.3 / §8.3 throw + §4.1 选方案 A | `grep -c "HW7A-P1-003" Harness-W7A最小泛化实施计划-20260624.md` >= 4；`grep -c "line 860" Harness-W7A最小泛化实施计划-20260624.md` >= 1 |
| P2-001 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §4.1（`from \|\| getSubtasksForTask()[0].id`） | `grep -c "P2-001" Harness-W7A最小泛化实施计划-20260624.md` >= 1；`grep "from \|\| getSubtasksForTask()" Harness-W7A最小泛化实施计划-20260624.md` = 1 |
| P2-002 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §4.1 + §8.3（`firstRunDefaults.importedCompleted` 抽象） | `grep -c "firstRunDefaults" Harness-W7A最小泛化实施计划-20260624.md` >= 2；`grep -c "P2-002" Harness-W7A最小泛化实施计划-20260624.md` >= 1 |
| P2-003 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §7 测试 #22-#24（init → step 全链路 / delivery 停止 / awaitingCommit） | `grep -c "P2-003" Harness-W7A最小泛化实施计划-20260624.md` >= 1；`grep -c "#22" Harness-W7A最小泛化实施计划-20260624.md` >= 1 |
| P2-004 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §3.3 / §8.3（JSON 解析 try/catch + 明确错误消息） | `grep -c "P2-004" Harness-W7A最小泛化实施计划-20260624.md` >= 1；`grep -c "JSON.parse" Harness-W7A最小泛化实施计划-20260624.md` >= 1 |
| P2-005 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §0 / §13 修订记录 + §14 追踪表（v2 修订记录同步） | `grep -c "P2-005" Harness-W7A最小泛化实施计划-20260624.md` >= 1；`grep -c "| v2 |" Harness-W7A最小泛化实施计划-20260624.md` = 1 |
| P2-006 | fixed | `Harness-W7A最小泛化实施计划-20260624.md` §1.3（YAML Option B：保留只读快照，不新建 W7-A YAML） | `grep -c "Option B" Harness-W7A最小泛化实施计划-20260624.md` >= 1；`grep -c "P2-006" Harness-W7A最小泛化实施计划-20260624.md` >= 1 |

---

## 上轮 Finding 遗留状态

| Finding | Priority | 上轮状态 | 本轮状态 | 处理 |
|---------|----------|----------|----------|------|
| HW7A-P1-001 | ~~P1~~ → P2 | open | **false-positive**（H 拍板） | 驳回，不修订 |
| HW7A-P1-002 | P1 | open | **fixed** | §3.3 + §4 + §7 修订 |
| HW7A-P1-003 | P1 | open | **fixed** | §1.1 + §3.3 + §4.1 + §7 修订 |
| P2-001 | P2 | open | **fixed** | §4.1 修订 |
| P2-002 | P2 | open | **fixed** | §4.1 修订（firstRunDefaults） |
| P2-003 | P2 | open | **fixed** | §7.2 新增 #22-#24 |
| P2-004 | P2 | open | **fixed** | §3.3 try/catch |
| P2-005 | P2 | open | **fixed** | §0 / §11 元数据修订记录 |
| P2-006 | P2 | open | **fixed** | §1.3 Option B |

---

## 修订内容摘要（方案 v1 → v2 增量）

| 章节 | v1 内容 | v2 修订 |
|---|---|---|
| §0 | 初版 | 末尾新增修订记录（v1 / v2） |
| §1.1 harness.js 表格 | 列 11 行（含 line 849 / 874 / 963-968 / 984） | 新增 **line 860 taskTitle fallback 行** |
| §1.3 YAML 处理 | "YAML 与 JSON 同步修改或保留" | **明确 Option B**：YAML 仅作 W6-A 人类可读只读快照，不被代码引用，**不**新建 W7-A YAML |
| §3.3 cacheKey 实现 | 简单 cacheKey 比较 | 完整伪代码 + 14 个 cmd 函数一致性清单 + 错误处理 try/catch |
| §4.1 init 支持点 | 提到 `from \|\| 'W6-A-02'` 改通用 | 选**方案 A：taskTitle 必填 throw**；line 849 / 874 / 963-968 / 984 / 860 全部显式列出 |
| §4.7 命令清单 | 列 14 个命令 | 保留 |
| §7.2 测试清单 | 18 个用例 | 新增 #19-#24（共 24 个用例） |
| §10 | （无追踪表） | 新增 §10.5 追踪表（9 行 findings） |
| §11 | 仅 1 行修订记录 | 新增 v2 行 |
| §12 演示版口径 | 初版 | 末尾加修订注脚 |

**总章节数**：12 → 12（结构不变，新增内容 + 修订内容）
**总行数预估**：654 → ~750 行

---

## 闭环测试设计（§7.2 新增 #19-#24）

| # | 测试名 | 断言 | 关联 Finding |
|---|---|---|---|
| 19 | cacheKey 跨 taskId 隔离 | init W6-A 后 init W7-A；W6-A status 字段保留 W6-A taskId；W7-A status 含 W7-A config 的 subtasks | HW7A-P1-002 |
| 20 | `_workflowConfig` 跨 taskId 替换 | init W7-A 后调 `getWorkflowConfig().taskId === 'W7-A'`；再 init W6-A 后 `getWorkflowConfig().taskId === 'W6-A'`；引用完全替换 | HW7A-P1-002 |
| 21 | taskTitle fallback 不会复用 W6-A 字面值 | 故意把 W7-A config 的 taskTitle 字段删除；init W7-A 应 throw 明确错误（方案 A），**不**fallback 到 "W7-A 画布本体UIUX收口" | HW7A-P1-003 |
| 22 | init → step 全链路 | init W7-A → cp 已落地方案 → check → step W7-A → currentStage=plan-review + 生成 B 窗口 prompt | P2-003 |
| 23 | step 在 delivery 阶段停止 | 设 W7-A 在 delivery + awaitingCommit；step 调用不重复 next | P2-003 |
| 24 | config JSON 损坏抛错 | 故意把 W7-A config JSON 改为 invalid 字符串；init W7-A 应 throw 含路径的错误，**不**fallback 到 W6-A JSON | P2-004 |

---

## W6-A 隔离（不变 / 强化）

| 维度 | v1 表述 | v2 强化 |
|---|---|---|
| runs/W6-A/status.json | taskId 化已存在 | **不变**；HW7A-P1-002 修复进一步确保 cacheKey 跨 taskId 隔离时**不会**回写 W6-A status |
| runs/W6-A/{outputs,prompts,handoffs} | 物理隔离 | 不变 |
| workflows/weekly-canvas-task.json | 不动 | 不动 |
| tests/harness.test.js | 仅末尾追加 | 不动现有 describe 块 |

**W6-A 测试回归保证**：所有 v1 测试不变 + P2-002 firstRunDefaults 抽象后 W6-A 行为等价（`firstRunDefaults.importedCompleted: ['W6-A-01']` 显式注入）。

---

## W7-A implementation-plan 接入方式

**关键判定**：Harness 在 init 后写入 `status.json.subtasks.W7-A.stages.implementation-plan.primaryReportPath`，路径模板为 `{reportRoot}/{taskTheme}实施计划-{YYYYMMDD}.md`。当前 W7-A 真实情形（2026-06-24）：已落地文件路径 `/Users/admin/project/ai/review/W7/W7-A/W7-A画布可演示交互闭环实施计划-20260624.md` 与 Harness 默认生成的路径（YYYYMMDD = 20260624）**完全一致** → **情形 A：路径已对齐，不需要 cp**。

**演示版命令链路（无 cp 版本，路径对齐）**：

```bash
# 1. init（生成 status.json + primaryReportPath）
pnpm harness init W7-A

# 2. 直接 check（前提：已落地文件路径 == status.json.primaryReportPath）
pnpm harness check W7-A        # 应通过（已含 Fabric 官方能力核查）

# 3. 推进到 plan-review
pnpm harness step W7-A         # 推到 plan-review + 生成 B 窗口 prompt
```

**仅在路径不一致时才复制**（带 `jq` 动态获取 status.json.primaryReportPath）：

```bash
pnpm harness init W7-A
cp /Users/admin/project/ai/review/W7/W7-A/W7-A画布可演示交互闭环实施计划-20260624.md \
   $(jq -r '.subtasks["W7-A"].stages["implementation-plan"].primaryReportPath' \
       /Users/admin/project/ai/Harness/runs/W7-A/status.json)
pnpm harness check W7-A
pnpm harness step W7-A
```

**v2 修订影响**：v1 接入示例包含一条 no-op `cp`（源 = 目标，路径完全相同的复制），v2 修订将该示例替换为"路径对齐判定 + 情形 A/B 分流"，避免误导 reviewer 误以为必须先复制。详见方案 v2 §6.3。

---

## 验证汇总（实施完成后预期命令结果）

| 命令 | 期望结果 |
|---|---|
| `grep -c "implementation-plan (v2)" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 1（v2 版本号已更新） |
| `grep -c "HW7A-P1-002" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 3（§3.3 + §4 + §7 各 1 处） |
| `grep -c "HW7A-P1-003" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 4（§1.1 + §3.3 + §4.1 + §7 各 1 处） |
| `grep -c "firstRunDefaults" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 2（§4.1 + §7.2） |
| `grep -c "Option B" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 1（§1.3 YAML 决策） |
| `grep -c "P2-00" Harness-W7A最小泛化实施计划-20260624.md` | ≥ 6（6 项 P2 findings） |
| `grep -c "\| v2 \|" Harness-W7A最小泛化实施计划-20260624.md` | = 1（修订记录 v2 行） |

---

## 实施准入状态

| 检查项 | 状态 |
|---|---|
| 0 P0 open | ✅ |
| 0 P1 open | ✅ |
| 0 P2 open | ✅ |
| W6-A 测试回归 | ✅（firstRunDefaults 抽象保证等价行为） |
| W7-A 闭环测试设计 | ✅（24 个用例覆盖 init/current/next/check/advance/step） |
| W7-A implementation-plan 接入方式明确 | ✅ |
| W6-A 状态隔离 | ✅ |

**准入决策**：方案 v2 可进入实现阶段。0 代码变更；本轮纯方案修订。

---

## 后续路径

1. **本计划 fix owner 完成本报告 + 修订方案文件**（本轮 A 窗口任务）
2. **交 B 窗口做 plan-fix-review**（如需要复审 v2）
3. **进入实现阶段**：由 C/D 窗口执行 `scripts/harness.js` 改动 + 新建 `workflows/weekly-canvas-task-W7-A.json` + 追加测试 describe 块
4. **实现完成后跑 `pnpm test`**：现有 W6-A 测试 + 新增 24 个 W7-A 测试全部通过
5. **最终交付报告**（hexai-delivery）：引用本 fix report

---

**作者签名**：claude-implementer-minimax (A 窗口)
**日期**：2026-06-24（1 轮）