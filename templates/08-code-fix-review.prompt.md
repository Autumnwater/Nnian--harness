请使用 `<hexai-code-review>` 技能执行本阶段任务。

# Code Fix 复审 — {{subtaskId}} {{subtaskTitle}}

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

## 产物路径

- **primaryReportPath:** {{primaryReportPath}}
- **mirrorOutputPath:** {{mirrorOutputPath}}
- **codeMappingToReview:** {{codeMappingToReview}}
- **fixReportToReview:** {{fixReportToReview}}
- **previousReviewFindings:** {{previousReviewFindings}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `{{reviewRoot}}`。
2. 你可以读取 `{{codeRepo}}` 中的业务代码。
3. 你可以写入 `{{reportDir}}` 中对应 review 输出。
4. **默认不能写** `{{codeRepo}}` 业务代码。
5. 你可以标记 finding 状态和复审结论。
6. **不做最终准入**（最终准入由 Codex 负责）。
7. **禁止**读取或修改 `.claude/settings.json`。

## 前置要求

在开始 review 之前，**必须**完整读取以下 Playbook：

1. `/Users/admin/project/ai/review/ReviewPlaybooks/code-review-playbook.md`
2. `/Users/admin/project/ai/review/ReviewPlaybooks/canvas-stage-review-playbook.md`

## Review 输入

请复审以下代码修复：

- 代码映射：`{{codeMappingToReview}}`
- 修复报告：`{{fixReportToReview}}`
- 上轮 Review findings：`{{previousReviewFindings}}`

## Review 要求

1. 逐条验证上轮 findings 是否得到正确修复
2. 检查修复是否引入了新问题
3. 更新 finding 状态（open → fixed / accepted / deferred）
4. 如发现新问题，产出新的 findings
5. 判断代码是否可以进入交付阶段

## 产物要求

1. 将复审意见写入：`{{primaryReportPath}}`
2. 将机器可读副本写入：`{{mirrorOutputPath}}`

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`
