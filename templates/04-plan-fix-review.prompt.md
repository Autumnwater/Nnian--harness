请使用 `<hexai-plan-review>` 技能执行本阶段任务。

# 方案修订 Review — {{subtaskId}} {{subtaskTitle}}

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
- **planToReview:** {{planToReview}}
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

1. `/Users/admin/project/ai/review/ReviewPlaybooks/plan-review-playbook.md`
2. `/Users/admin/project/ai/review/ReviewPlaybooks/canvas-stage-review-playbook.md`

## Review 输入

请 review 以下修订后的方案和 fix report：

- 方案：`{{planToReview}}`
- 修订报告：`{{fixReportToReview}}`
- 上轮 Review findings：`{{previousReviewFindings}}`

## Review 要求

### Fabric-first 核查（必需）

复审时必须再次确认 **"Fabric 官方能力核查"** 章节仍然完整有效：
1. 方案修订未删除或削弱 Fabric 能力核查内容。
2. 新增的自定义逻辑仍有充分理由（不做 Fabric 内部算法重复实现）。
3. 业务桥接代码仍然是薄层适配。

**缺少该章节或核查不通过 → P0 finding，不允许进入代码实现。**

### 通用复审

1. 逐条验证上轮 findings 是否得到妥善处理
2. 对修订后的方案进行完整 review
3. 如发现新问题，产出新的 findings
4. 更新 finding 状态（open → fixed / accepted / deferred）
5. 判断方案是否可以进入代码实施阶段

报告必须包含 `Decision: pass` 或 `Decision: changes-required`。所有既有和新增 finding 都必须使用以下机器可读格式；禁止使用 `### P1#1`、`### NEW P1#1` 等旧格式：

```markdown
### Finding {{subtaskId}}-P{n}-{序号}

Priority: P0/P1/P2
Status: verified/accepted/deferred/false-positive/open/reopened
Owner: claude-implementer-minimax
Module: {模块名}
Files:
- {文件路径}

Issue:
{问题描述}

Expected:
{期望状态}

Acceptance:
{验收标准}
```

只要存在 `open` 或 `reopened` finding，必须使用 `Decision: changes-required`；Harness 会自动回到下一轮 plan-fix。

## 产物要求

1. 将复审意见写入：`{{primaryReportPath}}`
2. 将机器可读副本写入：`{{mirrorOutputPath}}`

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`
