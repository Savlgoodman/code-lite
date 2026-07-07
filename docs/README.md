# code-lite 文档中心

更新时间：2026-07-06

当前技术路线已经收敛为：

```text
Codex / Claude Code / opencode
  -> ACP server wrapper
  -> code-lite 通用 AcpAgentAdapter
  -> 统一 AgentEvent、审批、会话存储和远程同步
```

`nanobot` 只作为历史原型和 legacy adapter 保留，不再作为 coding agent 主线。后续新增 coding agent runtime 优先通过 ACP 接入。

## 目录结构

```text
docs/
  README.md
  architecture/   # 架构文档
  design/         # 功能设计和实施设计
  refactor/       # 重构、迁移和优化方案
  guides/         # 产品说明、开发说明、发布说明
  development/    # 开发规范和协作流程
  research/       # 调研、探针和技术验证记录
```

## 文档索引

### 必读入口

| 文档 | 用途 |
| --- | --- |
| `guides/PRD.md` | 产品定位、MVP 范围和路线图 |
| `architecture/ARCHITECTURE.md` | 当前总体架构、事件协议、权限和数据边界 |
| `architecture/PROJECT_STRUCTURE.md` | 目标目录结构、模块职责和迁移策略 |
| `guides/UI_DEVELOPMENT.md` | UI、Tauri、backend 的本地开发和调试入口 |
| `development/DEVELOPMENT_WORKFLOW.md` | 分支、合并、版本升级和提交规范 |

### ACP 主线

| 文档 | 类型 | 用途 |
| --- | --- | --- |
| `design/0703-AGENT-ACP-IMPLEMENTATION.md` | 设计 | ACP adapter 实施设计，后续开发优先读它 |
| `design/0703-AGENT-UNIFIED-ACP.md` | 设计 | 统一前端会话能力、模型、模式和事件格式 |
| `research/0702-AGENT-ACP-RESEARCH.md` | 调研 | ACP 协议、runtime 分发、认证、权限和配置调研 |
| `research/0703-BACKEND-ACP-RESEARCH.md` | 调研 | Python backend 侧 ACP client 设计推导和 demo 记录 |
| `research/0703-VIBEX-ACP-RESEARCH.md` | 调研 | VibeX ACP runtime 生命周期、会话存储和 code-lite 改进方案 |
| `research/0706-AGENT-INTERACTION-TOOLS-RESEARCH.md` | 调研 | Codex / Claude Code 交互工具、Plan 模式、用户选择和前端展示边界 |
| `research/0707-AGENT-MULTIMODAL-INPUT-RESEARCH.md` | 调研 | Agent 多模态图片输入、ACP ContentBlock、附件存储和 runtime 能力协商 |

### 配套专项

| 文档 | 类型 | 用途 |
| --- | --- | --- |
| `design/0703-RUNTIME-MODEL-PROVIDER.md` | 设计 | runtime 原生配置、产品模型配置和 legacy LLM provider 配置边界 |
| `design/0706-BILLING-DAILY-USAGE.md` | 设计 | 日统计、项目总计和费用总览的数据结构与落盘方案 |
| `design/0706-AGENT-SPECIAL-EVENTS-PLAN-UI.md` | 设计 | ACP 特殊事件、raw 记录、Codex / Claude 计划事件和计划面板展示说明 |
| `design/0707-AGENT-MULTIMODAL-COMPOSER.md` | 设计 | 多模态输入框、草稿图片生命周期、图片压缩限制和 AttachmentStore 落盘策略 |
| `design/0702-REMOTE-SYNC.md` | 设计 | 远程只读观看、事件补偿、权限和审计 |
| `refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md` | 重构 | Agent adapter 归位、结构化日志、诊断错误和设置页日志查看 |
| `refactor/0703-RUNTIME-DATA-CHAT-UI.md` | 重构 | 运行时数据目录、会话事件存储和聊天 UI 优化 |
| `guides/BUILD_AND_RELEASE.md` | 说明 | Windows 编译、打包和发布产物整理 |
| `guides/RELEASE_AND_UPDATE.md` | 说明 | 发布与后续自动更新规划 |

## 分类规则

1. `architecture/`：系统边界、模块职责、长期结构、跨模块协议和目录结构。此类文档应少而稳定。
2. `design/`：某个功能、模块或实施阶段的设计方案。包含目标、非目标、数据结构、接口、阶段计划和验收标准。
3. `refactor/`：重构、迁移、清理、性能优化和 UI 优化方案。重点说明现状问题、迁移步骤、兼容策略和风险。
4. `guides/`：给开发者或使用者看的说明文档，例如启动、构建、发布、产品范围和排错说明。
5. `development/`：协作规范、分支流程、提交规范、发布合并流程和 AI Agent 工作要求。
6. `research/`：技术调研、SDK 探针、外部资料对比、实验记录和待验证结论。

## 命名规则

所有新增文档使用 UTF-8 编码，不使用 emoji，不写入 API Key、Token、账号密码、私钥或真实用户数据。

`design/` 文档必须使用：

```text
MMDD-MODULE-CONTENT.md
```

示例：

```text
0703-AGENT-CODEX-ACP.md
0703-RUNTIME-MODEL-PROVIDER.md
0704-REMOTE-VIEWER-SYNC.md
```

`research/` 文档必须使用：

```text
MMDD-SUBJECT-RESEARCH.md
```

示例：

```text
0703-CLAUDE-CODE-ACP-RESEARCH.md
0703-OPENCODE-ACP-RESEARCH.md
0704-CODEX-USAGE-RESEARCH.md
```

`refactor/` 文档建议使用：

```text
MMDD-MODULE-CHANGE.md
```

`architecture/`、`guides/`、`development/` 下的稳定入口文档可以使用语义化大写文件名，例如 `architecture/ARCHITECTURE.md`、`guides/PRD.md`、`development/DEVELOPMENT_WORKFLOW.md`。

## 编写规则

1. 新文档先判断分类，不确定时优先更新现有文档，而不是新增相近主题文档。
2. 设计文档必须写清楚：背景、目标、非目标、当前现状、方案、数据或接口、实施阶段、风险、验收标准。
3. 调研文档必须写清楚：调研日期、验证环境、命令或资料来源、确认结论、未验证项、对 code-lite 的影响。
4. 重构文档必须写清楚：当前问题、目标结构、迁移步骤、兼容策略、回滚点和验证方式。
5. 架构文档只记录稳定决策和长期边界，不沉淀临时试验细节。
6. 说明文档面向实际使用，优先给可执行命令和排错入口。
7. 文档引用必须使用当前路径，例如 `design/0703-AGENT-ACP-IMPLEMENTATION.md`。
8. 清理旧文档时必须同步更新 `docs/README.md`、`AGENTS.md` 和相关文档内引用。
9. 日期使用文档创建或定稿日期的 `MMDD`，不要因为小修反复改文件名。
10. ACP、Codex、Claude Code、opencode 是当前 coding agent 主线；nanobot 只能以 legacy 兼容身份出现。

## 已清理的旧路线

以下旧文档已经从 `docs/` 移除，避免继续误导主线开发：

1. `AGENT_ADAPTER_REDESIGN.md`：旧的 native SDK 多 adapter 路线。
2. `AGENT_SDK_CAPABILITY_RESEARCH.md`：旧的 Codex / Claude / nanobot SDK 横向调研。
3. `NANOBOT_SDK_RESEARCH.md`：早期 nanobot SDK 调研。
4. `NANOBOT_COMMAND_PERMISSION_DESIGN.md`：早期 nanobot 权限设计。
5. `UI_NANOBOT_INTEGRATION_DESIGN.md`：早期 UI 接入 nanobot 方案。

如需追溯这些资料，请从 git 历史中查看；新开发不要再以它们作为设计依据。
