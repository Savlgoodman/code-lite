# code-lite 文档索引

更新时间：2026-07-03

当前技术路线已经收敛为：

```text
Codex / Claude Code / opencode
  -> ACP server wrapper
  -> code-lite 通用 AcpAgentAdapter
  -> 统一 AgentEvent、审批、会话存储和远程同步
```

`nanobot` 只作为历史原型和兼容 adapter 保留，不再作为 coding agent 主线。后续新增 agent runtime 优先通过 ACP 接入；只有明确不支持 ACP 且产品价值足够高时，才考虑独立 legacy adapter。

## 必读入口

| 文档 | 用途 |
| --- | --- |
| `PRD.md` | 产品定位、MVP 范围和路线图 |
| `ARCHITECTURE.md` | 当前总体架构、事件协议、权限和数据边界 |
| `PROJECT_STRUCTURE.md` | 目标目录结构、模块职责和迁移策略 |
| `UI_DEVELOPMENT.md` | UI、Tauri、backend 的本地开发和调试入口 |
| `DEVELOPMENT_WORKFLOW.md` | 分支、合并、版本升级和提交规范 |

## ACP 主线文档

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| `ACP_AGENT_ADAPTER_IMPLEMENTATION_DESIGN.md` | 主入口 | ACP adapter 实施设计，后续开发优先读它 |
| `UNIFIED_ACP_ADAPTER_DESIGN.md` | 主入口 | 统一前端会话能力、模型、模式和事件格式 |
| `ACP_ADAPTER_DESIGN.md` | 调研保留 | ACP 协议、runtime 分发、认证、权限和配置调研 |
| `PYTHON_BACKEND_ACP_ADAPTER_DESIGN.md` | 调研保留 | Python backend 侧 ACP client 设计推导和 demo 记录 |

## 配套专项

| 文档 | 用途 |
| --- | --- |
| `MODEL_PROVIDER_CONFIGURATION_DESIGN.md` | runtime 原生配置、产品模型配置和 legacy LLM provider 配置的边界 |
| `REMOTE_SYNC_DESIGN.md` | 远程只读观看、事件补偿、权限和审计 |
| `RUNTIME_DATA_AND_CHAT_UI_OPTIMIZATION_DESIGN.md` | 运行时数据目录、会话事件存储和聊天 UI 优化 |
| `BUILD_AND_RELEASE.md` | Windows 编译、打包和发布产物整理 |
| `RELEASE_AND_UPDATE.md` | 发布与后续自动更新规划 |

## 已清理的旧路线

以下旧文档已经从 `docs/` 移除，避免继续误导主线开发：

1. `AGENT_ADAPTER_REDESIGN.md`：旧的 native SDK 多 adapter 路线。
2. `AGENT_SDK_CAPABILITY_RESEARCH.md`：旧的 Codex / Claude / nanobot SDK 横向调研。
3. `NANOBOT_SDK_RESEARCH.md`：早期 nanobot SDK 调研。
4. `NANOBOT_COMMAND_PERMISSION_DESIGN.md`：早期 nanobot 权限设计。
5. `UI_NANOBOT_INTEGRATION_DESIGN.md`：早期 UI 接入 nanobot 方案。

如需追溯这些资料，请从 git 历史中查看；新开发不要再以它们作为设计依据。
