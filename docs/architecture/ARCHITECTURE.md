# code-lite 架构设计

## 1. 架构目标

code-lite 采用桌面优先、远程可观看的多 Agent 架构。应用需要把 Codex、Claude Code、opencode 等 runtime 通过 ACP 接入到统一工作台，并对会话、事件、权限、审批、远程同步和审计形成稳定边界。

架构目标：

1. UI 保持轻量、清晰，用户打开后即可选择 workspace 和 agent 开始任务。
2. 不把业务层绑定到某一个 SDK 或 CLI，coding agent 统一通过 `AcpAgentAdapter` 和 runtime descriptor 接入。
3. 流式事件协议统一，支持消息、工具调用、命令、文件变更、审批、错误和 token usage。
4. 远程观看依赖同一套事件流，避免为远端另建一套状态模型。
5. 本地敏感信息默认不上传；远程连接默认只读、可撤销、可审计。
6. 对 runtime 原生安全能力保持诚实描述，不把无法前置拦截的行为包装成强审批能力。

## 2. 总体架构

```text
code-lite
  |
  |-- ui/
  |     React + Vite 桌面工作台，展示会话、工具调用、审批和远程观看状态。
  |
  |-- src-tauri/
  |     Tauri 桌面壳，管理窗口、sidecar、系统集成和本地权限边界。
  |
  |-- backend/
  |     Python Agent Hub，提供 HTTP/NDJSON 或 WebSocket 流式接口。
  |
  |-- packages/
  |     共享协议、事件 schema 和生成类型。
  |
  |-- docs/
  |     产品、架构、目录结构和专项设计文档。
```

运行时进程模型：

```text
Tauri Desktop Process
  - 承载 WebView UI。
  - 启动并监控 Python backend sidecar。
  - 管理本地窗口、文件选择、系统通知和后续桌面权限能力。

Python Backend Sidecar
  - 暴露本地 API。
  - 管理会话和事件总线。
  - 加载 Agent Adapter。
  - 读写本地运行时数据。
  - 为远程连接提供同步入口。

Agent Runtime
  - codex-acp -> Codex runtime。
  - claude-agent-acp -> Claude Code runtime。
  - opencode acp -> opencode runtime。
  - nanobot legacy 兼容 adapter。

Remote Client
  - 通过连接码或令牌连接本机。
  - 默认只读订阅会话事件。
  - 获得授权后可发送消息、取消任务或处理审批。
```

## 3. 分层职责

### 3.1 UI 层

位置：`ui/`

职责：

1. 展示 Agent 工作台和会话历史。
2. 展示 runtime 选择、模型选择和 workspace 状态。
3. 渲染流式 assistant Markdown、工具调用、命令输出和文件变更摘要。
4. 展示审批请求和用户决策入口。
5. 展示远程连接状态、观看者列表和授权入口。
6. 展示 adapter 可用性、依赖缺失和实验性提示。

UI 不直接执行 shell 命令，不直接读写敏感配置。UI 通过 Tauri 或 backend API 表达用户意图，并展示 backend 发出的统一事件。

### 3.2 Tauri / Rust 层

位置：`src-tauri/`

职责：

1. 打包桌面应用。
2. 启动、停止和监控 Python backend sidecar。
3. 提供 UI 所需的 Tauri command。
4. 管理应用窗口、托盘、系统通知和文件选择。
5. 在后续阶段承载更强的本地权限边界和系统级执行网关。
6. 注入安装态版本、资源路径和运行时环境变量。

Tauri 层不是 Agent SDK 适配层。它只负责桌面壳、安全边界和本地生命周期，具体 agent 会话由 Python backend 管理。

### 3.3 Python Backend / Agent Hub

位置：`backend/`

职责：

1. 暴露本地 HTTP/NDJSON 或 WebSocket API。
2. 管理会话、turn、消息和事件日志。
3. 加载并选择 Agent Adapter。
4. 将 runtime 私有事件映射为统一 `AgentEvent`。
5. 处理中断、取消、错误归一化和运行状态。
6. 管理模型与 runtime 配置。
7. 为远程连接提供只读同步和授权控制。
8. 写入本地审计日志。

Backend 应避免把某个 runtime 的私有概念直接扩散到 UI 和协议层。不同 runtime 的差异通过 descriptor、capabilities 和 events 显示。

### 3.4 Agent Adapter 层

位置：`backend/code_lite_backend/agents/`。

目标接口：

```text
AgentAdapter
  - describe() -> AgentAdapterDescriptor
  - prepare(runtime_config, workspace) -> AdapterStatus
  - stream_turn(request) -> AsyncIterator[AgentEvent]
  - cancel(turn_id) -> CancelResult
  - list_models() -> ModelListResult
```

Adapter 负责：

1. 启动或连接 runtime。
2. 转换输入请求。
3. 读取 runtime 流式输出。
4. 映射消息、工具调用、命令、文件变更、审批和错误。
5. 暴露 runtime 能力边界。
6. 把依赖缺失、配置缺失、权限受限等问题转成统一错误。

当前 adapter 策略：

| Adapter | 状态 | 说明 |
| --- | --- | --- |
| `acp` | 主线 | 通用 ACP adapter，使用官方 Python SDK 作为 ACP client |
| `codex` | 优先原型 | 通过 `codex-acp` 和 Codex descriptor 运行 |
| `claude_code` | 实验入口 | 通过 `claude-agent-acp` 和 Claude Code descriptor 运行 |
| `opencode` | 规划入口 | 通过 `opencode acp` 和 opencode descriptor 运行 |
| `nanobot` | legacy | 仅保留早期原型兼容，不再作为 coding agent 主线 |

新的 coding agent runtime 不应再新增完整独立 adapter 类；优先新增 `RuntimeDescriptor`、安装/预检逻辑和必要的 mapper caveat。只有 runtime 不支持 ACP 且有明确产品价值时，才考虑 legacy adapter。

### 3.5 远程同步层

远程同步不应复制业务逻辑，而是订阅会话事件总线。

建议模型：

```text
Agent Adapter -> AgentEvent -> Event Bus -> Local UI
                                      |-> Session Store
                                      |-> Remote Sync Gateway -> Remote Client
```

职责：

1. 为每个会话分配递增事件序号。
2. 新远端连接后先发送快照，再发送增量事件。
3. 断线重连时按最后事件序号补齐。
4. 维护观看者身份、权限和连接状态。
5. 支持主设备撤销令牌。
6. 记录远端参与行为。

MVP 可以先实现局域网直连或本机调试链路。跨公网中继、端到端加密和设备信任列表作为后续增强。

## 4. 统一事件协议

所有 runtime 输出统一映射为 `AgentEvent`。协议应可被本地 UI、远端观看和审计日志共同使用。

建议事件类型：

```text
session.created
turn.started
message.delta
message.completed
reasoning.delta
tool.started
tool.delta
tool.completed
command.started
command.output
command.completed
file.changed
approval.required
approval.resolved
usage.updated
error
turn.completed
turn.cancelled
remote.viewer_joined
remote.viewer_left
```

事件基础字段：

```json
{
  "eventId": "evt_...",
  "sequence": 42,
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "runtime": "codex",
  "type": "message.delta",
  "createdAt": "2026-07-01T12:00:00Z",
  "payload": {}
}
```

设计原则：

1. payload 可以随事件类型扩展，但基础字段保持稳定。
2. runtime 私有字段放入 `payload.runtimeRaw` 或调试日志，不作为 UI 主路径依赖。
3. 远程同步只发送必要事件和脱敏摘要。
4. 大块命令输出、diff 和附件可拆成引用，避免事件过大。

## 5. 权限与审批模型

### 5.1 权限模式

code-lite 需要同时表达产品级权限和 runtime 原生权限。

产品级模式：

| 模式 | 含义 |
| --- | --- |
| `readonly` | 只读观察和分析，尽量不写文件 |
| `workspace_write` | 允许在当前 workspace 内修改文件 |
| `approval_required` | 高风险动作需要用户确认 |
| `full_access` | 用户显式授权的高权限模式，仍需要记录审计 |

Runtime 原生权限由 adapter 单独映射，例如 Codex sandbox、Claude Code CLI 参数或 opencode 配置。UI 必须显示当前 runtime 能力限制，不承诺超出 runtime 可拦截范围的安全语义。

### 5.2 审批对象

审批请求应使用结构化对象：

```json
{
  "approvalId": "appr_...",
  "runtime": "codex",
  "kind": "command",
  "title": "运行测试命令",
  "summary": "即将执行 npm run ui:build",
  "riskLevel": "medium",
  "workspace": "H:\\code-lite",
  "details": {
    "command": "npm run ui:build"
  }
}
```

审批结果：

```json
{
  "approvalId": "appr_...",
  "decision": "allow",
  "decidedBy": "local-user",
  "decidedAt": "2026-07-01T12:00:00Z"
}
```

### 5.3 远程权限

远程连接权限分级：

| 权限 | 能力 |
| --- | --- |
| `viewer` | 只读观看会话事件 |
| `commenter` | 可发送消息，但不能审批或取消 |
| `operator` | 可取消任务和处理低中风险审批 |
| `owner` | 主设备用户，拥有撤销连接和授权能力 |

MVP 默认只开放 `viewer`。其他权限必须由主设备显式授权。

## 6. 数据存储

本地运行时数据建议：

```text
data/
  config/
    app_config.json
    agent_runtimes.json
    nanobot_config.json       # legacy 兼容
  record/                     # 当前会话 JSON 存储
  events/
  runtimes/
    acp/
  logs/
  remote/
  cache/
```

数据规则：

1. API Key 和 Token 不写入仓库。
2. 本地配置和会话数据不默认上传。
3. 远程同步令牌必须可撤销，长期存储时只保存哈希或加密值。
4. 导出记录应默认脱敏。
5. 大型日志和缓存不提交到 git。

当前会话目录仍使用 `record/`，后续如迁移到 `conversations/` 需要兼容读取。`nanobot_config.json` 和 legacy adapter 只作为早期原型兼容路径，不再承载新功能主配置。

## 7. 通信协议

### 7.1 本地 UI 与 backend

当前推荐继续使用本地 HTTP + NDJSON 流式接口，原因：

1. 已有原型基础。
2. 调试方便。
3. 易于扩展到 WebSocket 或远程同步。
4. 能自然承载长任务事件流。

后续可以引入 WebSocket 作为远程观看和实时控制通道。

### 7.2 backend 与 runtime

不同 adapter 可使用不同方式：

| Runtime | 连接方式 | 说明 |
| --- | --- | --- |
| Codex | `codex-acp` + ACP stdio | 当前第一优先级，已开始接入通用 ACP adapter |
| Claude Code | `claude-agent-acp` + ACP stdio | 实验接入，重点验证 session/new、权限和 skills 加载行为 |
| opencode | `opencode acp` + ACP stdio | 规划接入，优先验证 system command 模式 |
| nanobot | Python SDK | legacy 兼容路径，不再扩展主线能力 |

### 7.3 远程客户端

远程同步建议使用 WebSocket 或 SSE：

1. WebSocket 适合后续双向控制。
2. SSE 适合 MVP 只读观看。
3. 局域网直连优先，跨公网中继后续设计。

## 8. MVP 技术范围

MVP 应优先打通端到端链路：

1. 统一 Agent Adapter descriptor。
2. 统一 `AgentEvent` schema。
3. 通用 ACP adapter。
4. Codex ACP 原型。
5. Claude Code 和 opencode descriptor、预检与实验入口。
6. 会话事件持久化。
7. 本地 UI 订阅同一事件流。
8. 远程只读同步原型。
9. 运行时配置和模型配置入口。
10. 审批事件展示和记录。

## 9. 迁移策略

当前仓库从早期本地维修 agent 原型演进而来，存在历史命名和专项文档。迁移时遵循：

1. 先改产品和架构文档，统一后续方向。
2. 再改 UI 文案、包名、可执行文件名和运行时目录。
3. 最后迁移 Python 包名、Rust crate 名和脚本产物名。
4. 每次迁移保持可构建、可回滚，不做无关重构。
5. nanobot 相关实现先保留为兼容 adapter，不作为产品主叙事。

## 10. 待确认架构决策

1. 远程同步 MVP 使用 SSE、WebSocket，还是同时保留二者？
2. Claude Code ACP 和 opencode ACP 的首轮 smoke 范围。
3. code-lite 托管 Node 与 ACP npm 包的安装、升级和回滚策略。
4. opencode 先支持 system command，还是同时探索托管分发。
5. 远程连接是否只做局域网，还是立即预留中继协议？
6. 产品级审批边界由 backend 承载，还是未来下沉到 Tauri/Rust 网关？
7. nanobot legacy adapter 何时冻结、隐藏或移除。
