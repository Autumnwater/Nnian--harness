请使用 `<hexai-delivery>` 技能执行本阶段任务。

# 交付物整理 — {{subtaskId}} {{subtaskTitle}}

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
- **implementationPlan:** {{implementationPlan}}
- **codeMapping:** {{codeMapping}}
- **allReviewFindings:** {{allReviewFindings}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `{{reviewRoot}}`。
2. 你可以读取 `{{codeRepo}}` 并在其中运行非破坏性的验证命令。
3. **禁止写入或修改** `{{codeRepo}}` 业务代码。
4. 你只能写入 `{{primaryReportPath}}`；mirror 由 Harness 自动生成。
5. **你不可批准自己的交付物。** 最终准入由 Codex 负责。
6. **禁止**读取或修改 `.claude/settings.json`、API key、token、cookie。
7. **不可**执行 destructive git、commit、push，除非用户明确要求。

## 任务要求

整理 `{{subtaskId}}` 的完整交付物，包括：

1. **交付摘要** — 子任务完成情况概述
2. **验证证据** — 功能验证、测试结果、截图等
3. **Finding 状态汇总** — 所有 review findings 的最终状态
4. **人工验收摘要** — 供 Codex 最终准入使用的人工验收清单

## 产物要求

1. 将交付物报告写入：`{{primaryReportPath}}`
2. 不要写入 `{{mirrorOutputPath}}`；Harness 会在 check 通过后自动同步 mirror。

交付物报告格式：

```markdown
# {{subtaskId}} {{subtaskTitle}} 交付物报告

## 交付摘要

## 代码变更清单

| 文件 | 变更类型 | 关联 Finding |
| --- | --- | --- |

## Finding 状态汇总

| Finding | Priority | 最终状态 | 备注 |
| --- | --- | --- | --- |

## 验证证据

### 功能验证
### 测试结果
### 手动验收

## 人工验收摘要

| 验收项 | 状态 | 备注 |
| --- | --- | --- |

## 残留风险和待处理项
```

## ⚠️ Delivery 强制要求

1. **必须包含「残留风险」(Residual Risk) section。**
2. **必须包含本轮变更文件列表。**
3. **必须包含验证命令和结果。** 说明验证了什么、怎么验证的、结果如何。
4. **必须明确是否建议 commit。** 给出明确的 commit 建议。
5. **⚠️ Harness 不会自动 commit。** Commit 由用户手动执行。Delivery 通过后会进入 commit checkpoint 状态，用户需手动 commit 后再执行 `pnpm harness advance <taskId> --confirm-committed` 继续。

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`
