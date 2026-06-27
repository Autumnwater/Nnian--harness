# 实施方案编写 — {{subtaskId}} {{subtaskTitle}}

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

## 边界规则

1. 你以 `{{ownerProfile}}` 身份工作，cwd 为 `/Users/admin/project/ai/plan`。
2. 你可以读取 `{{codeRepo}}` 用于方案分析，但本阶段不得修改业务代码。
3. 你有权写入 `{{reportDir}}` 下的实施记录和验证证据。
4. 你有权写入 `{{runDir}}` 当前阶段输出副本。
5. **禁止**读取或修改 `.claude/settings.json`、API key、token、cookie。
6. **你不可批准自己的方案或代码。** 方案和代码必须经过 C/review 评审。
7. **不可**修改 reviewer 的 review finding 文档。
8. **不可**执行 destructive git、commit、push，除非用户明确要求。

## 任务要求

请为 `{{subtaskId}} {{subtaskTitle}}` 撰写详细的实施方案。

实施方案必须包含：

1. **Fabric 官方能力核查**（⚠️ 必需章节，缺失则不允许进入代码实现）
   - Fabric 是否已有官方 API / controls / events / serialization 能力覆盖本任务需求。
   - 本任务会使用哪些 Fabric 官方能力（列出具体 API / class / method）。
   - 哪些逻辑必须自定义，以及为什么 Fabric 官方能力不能直接满足。
   - 自定义逻辑是否只做业务桥接，不重复实现 Fabric 内部几何算法。
2. **需求理解** — 对子任务需求的理解和分析
3. **技术方案** — 具体的实现方案，包括涉及的文件、组件、逻辑变更
4. **风险分析** — 潜在风险和边界条件
5. **测试计划** — 验证方案和测试要点
6. **实施步骤** — 分解为可执行的步骤
7. **依赖关系** — 与其他子任务的依赖和交互

## 产物要求

1. 如果 `{{reportDir}}` 目录不存在，请先创建。
2. 将正式实施方案写入：`{{primaryReportPath}}`
3. 不要写入 `{{mirrorOutputPath}}`；Harness 会在 check 通过后自动同步 mirror。

## 中断交接

如果你因为 token 不足、上下文不足或外部中断无法完成本阶段，请不要伪造完成状态。请写入 handoff：

**primary handoff:** `{{handoffPath}}`
**mirror handoff:** `{{mirrorHandoffPath}}`

handoff 必须包含：
- taskId、subtaskId、stage、ownerProfile、requiredSkill
- 当前完成了什么
- 尚未完成什么
- 已读取的文件
- 已修改的文件
- 已生成的文档
- 已运行的命令和结果
- open findings 或待处理问题
- 下一步应该从哪里继续
- 不要重复做什么
