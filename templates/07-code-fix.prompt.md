请使用 `<hexai-code-fix>` 技能执行本阶段任务。

# 代码修复 — {{subtaskId}} {{subtaskTitle}}

## 任务信息

- **taskId:** {{taskId}}
- **subtaskId:** {{subtaskId}}
- **subtaskTitle:** {{subtaskTitle}}
- **stage:** {{stage}}
- **stageStatus:** {{stageStatus}}
- **ownerProfile:** {{ownerProfile}}
- **requiredSkill:** {{requiredSkill}}

## 工作区

- **codeRepo:** {{codeRepo}}
- **reviewRoot:** {{reviewRoot}}
- **reportDir:** {{reportDir}}
- **runDir:** {{runDir}}
- **evidenceDir:** {{evidenceDir}}

## 产物路径

- **primaryReportPath:** {{primaryReportPath}}
- **mirrorOutputPath（Harness 自动生成，只读）:** {{mirrorOutputPath}}
- **reviewFindings:** {{reviewFindingsPath}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `/Users/admin/project/ai/code`。
2. 你有权读写 `{{codeRepo}}` 中任务相关的业务代码。
3. 你有权写入 `{{reportDir}}` 下的修复记录和验证证据。
4. **按 CodeReview findings 做最小代码修复。** 只修 finding 指出的问题，不做额外变更。
5. **你不可批准自己的修复。** 修复后的代码必须经过 C/review 复审。
6. **禁止**读取或修改 `.claude/settings.json`、API key、token、cookie。
7. **不可**执行 destructive git、commit、push，除非用户明确要求。

## 任务要求

请根据以下 Code Review findings 进行代码修复：

`{{reviewFindingsPath}}`

修复要求：
1. 逐条处理每个 finding（P0 必须修复，P1 强烈建议修复，P2 评估修复）
2. 每个修复应是最小变更 — 只修问题，不做不相关的重构
3. 确保代码风格与现有代码一致
4. 如果决定不修复某个 finding，必须给出充分理由

## 产物要求

1. 将修复报告写入：`{{primaryReportPath}}`
2. 不要写入 `{{mirrorOutputPath}}`；Harness 会在 check 通过后自动同步 mirror。

修复报告格式：

```markdown
# {{subtaskId}} {{subtaskTitle}} CodeFix报告

## 修复概览

### Fix Mapping

| Finding | Status | 修复内容/文件 | 验证 |
| --- | --- | --- | --- |

## 详细修复

### {{subtaskId}}-P{n}-{id}
- **修复文件:** {路径}
- **修复内容:** {说明}
- **验证方式:** {如何验证}
```

## ⚠️ Fix Mapping 强制要求

1. **必须使用精确标题 `### Fix Mapping`** — 不得使用 `## Fix Mapping` 或其他级别。标题必须独占一行。
2. **必须覆盖上一轮 Code Review 中的所有 open/reopened P0/P1/P2 findings。** 不得遗漏。
3. **Finding ID 必须从 Code Review 报告中原样复制。** 不得补零（如 P1-001 → P1-01 是错误的），不得重命名，不得改编号。
4. **Fix Mapping 表格至少包含以下列：**
   | Finding | Status | 修复内容/文件 | 验证 |
5. **Status 推荐使用（FixReport 阶段均为提议，最终状态由 fix-review 确认）：**
   - `fixed` — 已修复
   - `deferred` — 推迟处理（FixReport 提出，需 fix-review 确认）
   - `false-positive` — 误报（FixReport 提出，需 fix-review 确认）
   - `accepted` — 接受建议并已修改
6. **⚠️ deferred / false-positive 只是提议。** 最终关闭必须由 fix-review 阶段确认 verified / accepted / deferred / false-positive。FixReport 不得自行将 finding 标记为最终关闭。
7. **不满足以上要求将导致 check 失败，无法 advance。**

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`
