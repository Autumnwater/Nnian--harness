请使用 `<hexai-plan-fix>` 技能执行本阶段任务。

# 方案修订 — {{subtaskId}} {{subtaskTitle}}

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
- **mirrorOutputPath:** {{mirrorOutputPath}}
- **reviewFindings:** {{reviewFindingsPath}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `{{codeRepo}}`。
2. 你有权读写 `{{codeRepo}}` 中任务相关的业务代码。
3. 你有权写入 `{{reportDir}}` 下的修订记录和验证证据。
4. **只修方案，不写代码。** 本阶段修订的是实施方案文档，不是业务代码。
5. **你不可批准自己的方案。** 修订后的方案仍须经过 reviewer 评审。
6. **禁止**读取或修改 `.claude/settings.json`、API key、token、cookie。
7. **不可**执行 destructive git、commit、push，除非用户明确要求。

## 任务要求

请根据以下 Review findings，修订实施方案：

`{{reviewFindingsPath}}`

修订要求：
1. 逐条回应每个 finding（P0 必须处理，P1 强烈建议处理，P2 评估处理）
2. 对方案的修订必须明确标注修改了什么、为什么这样修改
3. 如果决定不采纳某个 finding，必须给出充分理由
4. 修订后的方案仍需保持完整性和可执行性

## 产物要求

1. 将修订报告写入：`{{primaryReportPath}}`
2. 将机器可读副本写入：`{{mirrorOutputPath}}`

修订报告应包含 finding 回应映射：

```markdown
### Fix Mapping

| Finding | Status | 修订内容 | 理由 |
| --- | --- | --- | --- |
| {{subtaskId}}-P{n}-{id} | fixed/deferred/accepted | ... | ... |
```

## ⚠️ Fix Mapping 强制要求

1. **必须使用精确标题 `### Fix Mapping`** — 不得使用 `## Fix Mapping` 或其他级别。
2. **必须覆盖上一轮 review 中的所有 open/reopened P0/P1/P2 findings。** 不得遗漏。
3. **Finding ID 必须从 review 报告中原样复制。** 不得补零（如 P1-001 → P1-01 是错误的），不得重命名，不得改编号。
4. **Fix Mapping 表格至少包含以下列：**
   | Finding | Status | 修复内容/文件 | 验证 |
5. **Status 推荐使用：**
   - `fixed` — 已修复
   - `deferred` — 推迟到后续处理（需说明理由）
   - `false-positive` — 误报（需说明理由）
   - `accepted` — 接受建议并已修改
6. **不满足以上要求将导致 check 失败，无法 advance。**

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`

handoff 必须包含：
- taskId、subtaskId、stage、ownerProfile、requiredSkill
- 当前完成了什么（已回应的 findings）
- 尚未完成什么（待回应的 findings）
- 已读取的文件
- 已修改的文件
- 已生成的文档
- open findings 或待处理问题
- 下一步应该从哪里继续
- 不要重复做什么
