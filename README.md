# HEXAI Review Harness V1

轻量级多 Agent 周任务研发流程编排工具。

## 快速开始

```bash
cd /Users/admin/project/ai/Harness

# 初始化 W6-A（默认从 W6-A-02 implementation-plan 开始）
pnpm harness init W6-A

# 生成当前阶段 prompt
pnpm harness next W6-A

# 检查当前阶段是否通过 gate
pnpm harness check W6-A

# 推进到下一阶段
pnpm harness advance W6-A

# 查看状态
pnpm harness status W6-A

# 查看摘要
pnpm harness summary W6-A

# 运行测试
pnpm test
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `harness init <taskId>` | 初始化新 run，默认从 W6-A-02 开始 |
| `harness init <taskId> --from <subtask> --stage <stage>` | 从指定子任务/阶段开始 |
| `harness next <taskId>` | 生成当前阶段 prompt |
| `harness check <taskId>` | Gate 检查 |
| `harness advance <taskId>` | 推进到下一阶段 |
| `harness status <taskId>` | 查看当前状态 |
| `harness summary <taskId>` | 查看完整摘要 |
| `harness import <taskId> --completed <subtask>` | 导入已完成子任务 |
| `harness resume <taskId> --from <subtask> --stage <stage>` | 续跑已有 run |
| `harness set-current <taskId> <subtask> <stage>` | 人工设置当前位置 |
| `harness interrupt <taskId> --reason "..."` | 标记当前阶段中断 |
| `harness resume-current <taskId>` | 生成 continuation prompt |

## 阶段状态机

```
implementation-plan → plan-review → plan-fix → plan-fix-review
→ code-implementation → code-review → code-fix → code-fix-review
→ delivery → done
```

## 目录结构

```
Harness/
├── AGENTS.md              # Agent 指令
├── README.md              # 本文件
├── package.json           # pnpm scripts
├── docs/superpowers/specs/ # 设计文档
├── workflows/             # 工作流定义
├── profiles/              # Agent profile 定义
├── schemas/               # JSON Schema
├── templates/             # Prompt 模板
├── scripts/harness.js     # CLI 实现
├── tests/harness.test.js  # 测试
└── runs/                  # 运行时状态（机器可读）
```
