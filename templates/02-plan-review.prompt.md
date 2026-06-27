请使用 `<hexai-plan-review>` 技能执行本阶段任务。

# 方案 Review — {{subtaskId}} {{subtaskTitle}}

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
- **mirrorOutputPath（Harness 自动生成，只读）:** {{mirrorOutputPath}}
- **planToReview:** {{planToReview}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `/Users/admin/project/ai/pcReview`。
2. 你可以读取 `{{codeRepo}}` 中的业务代码。
3. 你可以写入 `{{reportDir}}` 中对应 review 输出。
4. **默认不能写** `{{codeRepo}}` 业务代码。
5. 你可以标记 finding 状态和复审结论。
6. **不做最终准入**（最终准入由 Codex 负责）。
7. **禁止**读取或修改 `.claude/settings.json`。

## 前置要求

在开始 review 之前，**必须**完整读取以下 Playbook：

1. `/Users/admin/project/ai/reviewDoc/ReviewPlaybooks/plan-review-playbook.md`
2. `/Users/admin/project/ai/reviewDoc/ReviewPlaybooks/canvas-stage-review-playbook.md`

## Review 输入

请 review 以下实施方案：
`{{planToReview}}`

## Review 要求

### Fabric-first 核查（必需）

必须先核查实施方案是否包含 **"Fabric 官方能力核查"** 章节，并验证：
1. Fabric 官方 API / controls / events / serialization 能力是否被正确识别。
2. 自定义逻辑是否有充分理由（不能重复实现 Fabric 内部几何算法）。
3. 业务桥接代码是否只做薄层适配。

**缺少该章节 → P0 finding，方案不可进入代码实现。**

### 通用评审

请按照 playbook 标准，对实施方案进行严格评审。产出结构化 findings：

报告必须包含独占一行的 `Decision: pass` 或 `Decision: changes-required`。

```markdown
### Finding {{subtaskId}}-P{n}-{序号}

Priority: P0/P1/P2
Status: open
Owner: claude-plan-minimax
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

## Gate 规则
- P0: 阻塞，方案不可进入实现
- P1: 高优先级，强烈建议修复后进入实现
- P2: 建议改善，默认阻塞除非明确接受降级或后移

## 产物要求

1. 如果 `{{reportDir}}` 目录不存在，请先创建。
2. 将 Review 意见写入：`{{primaryReportPath}}`
3. 不要写入 `{{mirrorOutputPath}}`；Harness 会在 check 通过后自动同步 mirror。

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`

handoff 必须包含：
- taskId、subtaskId、stage、ownerProfile、requiredSkill
- 当前完成了什么（已 review 的章节、已产出的 findings）
- 尚未完成什么（待 review 的章节）
- 已读取的文件
- 已生成的文档
- open findings 或待处理问题
- 下一步应该从哪里继续
- 不要重复做什么
