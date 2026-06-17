# 代码实施 — {{subtaskId}} {{subtaskTitle}}

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
- **implementationPlan:** {{implementationPlan}}

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `{{codeRepo}}`。
2. 你有权读写 `{{codeRepo}}` 中任务相关的业务代码。
3. 你有权写入 `{{reportDir}}` 下的实施记录和验证证据。
4. 你有权写入 `{{runDir}}` 当前阶段输出副本。
5. **禁止**读取或修改 `.claude/settings.json`、API key、token、cookie。
6. **你不可批准自己的代码。** 代码必须经过 reviewer 评审。
7. **不可**修改 reviewer 的 review finding 文档。
8. **不可**执行 destructive git、commit、push，除非用户明确要求。

## 任务要求

请根据已获批的实施方案进行代码实施：

实施方案：`{{implementationPlan}}`

实施要求：
1. 严格按照实施方案执行
2. 保持最小变更原则 — 只改必要的代码
3. 确保代码风格与现有代码一致
4. 每个修改点都要有清晰的注释说明目的

## 产物要求

1. 将任务到代码映射写入：`{{primaryReportPath}}`
2. 将机器可读副本写入：`{{mirrorOutputPath}}`

任务到代码映射格式：

```markdown
# {{subtaskId}} 任务到代码映射

## 变更概览

| 文件 | 变更类型 | 变更说明 |
| --- | --- | --- |

## 详细变更

### {文件路径}
- 变更说明
- 代码片段（如有必要）
```

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`

handoff 必须包含：
- taskId、subtaskId、stage、ownerProfile、requiredSkill
- 当前完成了什么（已修改的文件、已实现的功能）
- 尚未完成什么（待实现的功能）
- 已读取的文件
- 已修改的文件
- 已生成的文档
- 已运行的命令和结果
- open findings 或待处理问题
- 下一步应该从哪里继续
- 不要重复做什么
