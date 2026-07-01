# UI 接入 nanobot 与 Markdown 渲染设计

> 历史资料：本文记录早期 UI 去 mock 并接入 nanobot backend 的设计。code-lite 当前新功能应优先围绕统一 `AgentEvent`、多 Agent Adapter 和远程同步观看设计展开。

本文设计“去掉前端 mock 数据，接入 nanobot Python 后台”的实现方案，并明确 Markdown 渲染采用 `D:\project\doc-pilot\hermes-api-webui` 当前使用的 `streamdown` 库。

当前文档只做设计，不包含实现代码改动。

## 1. 设计目标

本阶段目标：

1. 移除 UI 中的固定 mock 会话、mock 消息和 mock 工具执行流。
2. 由 Python 后台承载 nanobot SDK，UI 通过 Tauri 与后台通信。
3. UI 能实时展示 nanobot 的文本流、reasoning、工具调用、工具结果、错误和 token usage。
4. 高风险工具调用必须进入审批流程，用户确认后才能继续。
5. Markdown 渲染使用 `streamdown`，支持流式 Markdown 渲染。
6. 保留现有简洁桌面布局和左侧全局会话列表。
7. 所有配置中的 API Key 只通过环境变量或本地忽略配置提供，不写入仓库。

非目标：

1. 本阶段不实现真实驱动下载安装。
2. 本阶段不直接执行高风险系统命令。
3. 本阶段不完整实现 Rust Execution Gateway，只预留审批和执行网关协议。
4. 本阶段不引入多 SDK 运行时切换 UI，只优先打通 nanobot。

## 2. 关键依赖结论

### 2.1 nanobot SDK

根据 `docs/NANOBOT_SDK_RESEARCH.md`，nanobot 已确认支持：

1. `Nanobot.from_config(...)` 创建实例。
2. `bot.run_streamed(...)` 发起流式执行。
3. `run.stream_events()` 获取结构化流式事件。
4. `text.delta` 实时文本输出。
5. `reasoning.delta` / `reasoning.completed` 推理过程事件。
6. `tool.started` / `tool.completed` / `tool.failed` 工具调用事件。
7. `RunStream.cancel()` 取消当前运行。
8. `AgentHook.before_execute_tools(...)` 在工具执行前做审批。
9. 自定义 Tool 通过 `nanobot.tools` entry point 注册。
10. Workspace Skill 通过 `<workspace>/skills/<skill-name>/SKILL.md` 自动发现。

审批注意点：

1. 审批 Hook 必须继承 `AgentHook` 并设置 `reraise=True`。
2. 用户拒绝时推荐中断整个 turn，不依赖“只删除某一个工具调用”。
3. nanobot 内置 `exec` 安全机制不能替代产品级 Execution Gateway。

### 2.2 Markdown 渲染库

`D:\project\doc-pilot\hermes-api-webui` 当前使用：

```json
{
  "streamdown": "^2.5.0"
}
```

组件使用方式：

```tsx
import { Streamdown } from "streamdown";

<Streamdown
  animated
  className="streamdown-body"
  isAnimating={message.streaming}
  mode={message.streaming ? "streaming" : "static"}
>
  {message.content}
</Streamdown>
```

`streamdown` 适合 AI 流式 Markdown 场景，并包含 GFM、代码块、基础安全处理等能力。PC Repair Agent UI 应复用这一技术选择。

## 3. 目标运行时架构

```text
Tauri WebView UI
  |
  | Tauri invoke / event listen
  v
src-tauri Rust 层
  |
  | 管理 sidecar 生命周期
  | 转发 JSON-RPC / NDJSON 消息
  | 后续承载 Execution Gateway
  v
Python backend sidecar
  |
  | Nanobot.from_config(...)
  | bot.run_streamed(...)
  | ApprovalHook.before_execute_tools(...)
  v
nanobot SDK
  |
  | Tool / Skill / Model Provider
  v
DeepSeek 或其他 OpenAI-compatible 模型
```

推荐通信方式沿用架构文档中的 MVP 结论：Tauri 管理 Python sidecar，使用 stdio JSON-RPC 或换行 JSON 传输。

为了更快落地，可分两步：

1. 开发期：Python backend 以本地进程启动，Tauri 通过 stdio 管理。
2. 打包期：Python backend 打包为 sidecar executable，由 Tauri 自动拉起。

## 4. 模块拆分

### 4.1 前端 UI

建议新增结构：

```text
ui/src/
  components/
    MessageRenderer.tsx
    ToolCallList.tsx
    ApprovalPanel.tsx
  services/
    agentClient.ts
    conversationStore.ts
  state/
    chatReducer.ts
  types.ts
```

职责：

1. `agentClient.ts`：封装 Tauri invoke 和事件订阅。
2. `conversationStore.ts`：封装会话列表、消息持久化和恢复。
3. `chatReducer.ts`：把后端事件规约到前端状态。
4. `MessageRenderer.tsx`：使用 `Streamdown` 渲染 assistant Markdown。
5. `ToolCallList.tsx`：展示工具调用、参数、结果和错误。
6. `ApprovalPanel.tsx`：展示待审批操作并提交允许或拒绝。

当前 `ui/src/mockData.ts` 在实现阶段应删除，`App.tsx` 中不再直接生成 mock assistant 回复。

### 4.2 Tauri / Rust

建议新增结构：

```text
src-tauri/src/
  commands/
    agent.rs
  sidecar/
    backend_process.rs
    protocol.rs
  gateway/
    approvals.rs
    risk_classifier.rs
```

MVP 职责：

1. 启动 Python sidecar。
2. 为 UI 提供 `agent_start_turn`、`agent_cancel_turn`、`agent_approve_tool` 等 Tauri command。
3. 监听 Python sidecar 输出事件，并转发到 WebView。
4. 保存 sidecar 进程状态和活动 turn。
5. 为后续 Execution Gateway 保留风险分级和审批入口。

### 4.3 Python backend

建议新增结构：

```text
backend/
  pyproject.toml
  pc_agent_backend/
    __init__.py
    main.py
    protocol/
      messages.py
      stdio_server.py
    runtime/
      nanobot_runtime.py
      approval_hook.py
      event_mapper.py
    tools/
      pending_action.py
    storage/
      sessions.py
```

MVP 职责：

1. 读取本地 nanobot 配置。
2. 创建并持有 `Nanobot` 实例。
3. 接收 UI 发来的用户消息。
4. 调用 `bot.run_streamed(...)`。
5. 将 nanobot `StreamEvent` 转成产品事件。
6. 在 `ApprovalHook` 中向 UI 请求审批，并等待结果。
7. 支持取消当前 turn。

## 5. 前后端协议设计

### 5.1 UI 到后台请求

```ts
type UiRequest =
  | StartTurnRequest
  | CancelTurnRequest
  | ApprovalDecisionRequest
  | CreateConversationRequest
  | ListConversationsRequest
  | LoadConversationRequest;
```

启动一轮 Agent：

```json
{
  "type": "agent.turn.start",
  "requestId": "req-001",
  "conversationId": "conv-001",
  "input": "帮我检查显卡驱动崩溃问题",
  "modelPreset": "deepseekFlash"
}
```

取消一轮 Agent：

```json
{
  "type": "agent.turn.cancel",
  "requestId": "req-002",
  "conversationId": "conv-001",
  "turnId": "turn-001"
}
```

审批决策：

```json
{
  "type": "approval.decision",
  "requestId": "req-003",
  "approvalId": "approval-001",
  "decision": "allow",
  "remember": false
}
```

### 5.2 后台到 UI 事件

```ts
type AgentEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | TextCompletedEvent
  | ReasoningDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ApprovalRequiredEvent
  | RunCompletedEvent
  | RunFailedEvent;
```

文本增量：

```json
{
  "type": "agent.text.delta",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "messageId": "msg-assistant-001",
  "delta": "我会先进行只读检查..."
}
```

工具开始：

```json
{
  "type": "agent.tool.started",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "toolCallId": "call-001",
  "name": "hardware_scan",
  "arguments": {
    "scope": "gpu"
  },
  "risk": "low"
}
```

审批请求：

```json
{
  "type": "approval.required",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "approvalId": "approval-001",
  "toolCallId": "call-002",
  "name": "execution_gateway_request",
  "risk": "high",
  "purpose": "安装官方显卡驱动",
  "impact": "会修改显卡驱动和相关系统组件",
  "risks": [
    "安装失败可能导致显示异常",
    "需要确认安装包来源和签名"
  ],
  "rollback": "可通过设备管理器回滚驱动，或使用系统还原点恢复"
}
```

运行完成：

```json
{
  "type": "agent.run.completed",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "messageId": "msg-assistant-001",
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 420,
    "totalTokens": 1620
  }
}
```

## 6. nanobot 事件映射

| nanobot 事件 | 产品事件 | UI 行为 |
| --- | --- | --- |
| `run.started` | `agent.run.started` | 创建 streaming assistant message |
| `text.delta` | `agent.text.delta` | 追加到 assistant message.content |
| `text.completed` | `agent.text.completed` | 保持消息，等待工具或最终完成 |
| `reasoning.delta` | `agent.reasoning.delta` | 追加到 message.reasoning |
| `reasoning.completed` | `agent.reasoning.completed` | 折叠展示思考过程 |
| `tool.started` | `agent.tool.started` | 在消息下方追加工具调用卡片 |
| `tool.completed` | `agent.tool.completed` | 工具卡片标记完成，展示摘要 |
| `tool.failed` | `agent.tool.failed` | 工具卡片标记失败，展示错误 |
| `run.completed` | `agent.run.completed` | 关闭 streaming 状态，展示 usage |
| `run.failed` | `agent.run.failed` | 关闭 streaming 状态，展示错误 |

注意：`tool.started` 是可观察事件，不等于审批通过。真正审批应由 `ApprovalHook` 发出 `approval.required`，UI 收到后显示审批 UI，并通过 `approval.decision` 返回。

## 7. 前端状态模型

建议替换当前 `Session` / `ChatMessage` 类型：

```ts
export type SessionStatus = "idle" | "running" | "approval" | "error";

export interface Session {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  reasoning?: string;
  streaming?: boolean;
  error?: string;
  toolCalls: ToolCallItem[];
  usage?: UsageStats;
}

export interface ToolCallItem {
  id: string;
  name: string;
  argumentsText: string;
  resultText?: string;
  status: "pending" | "running" | "complete" | "error" | "approval";
  risk?: "low" | "medium" | "high" | "blocked";
  createdAt: number;
  updatedAt: number;
}
```

参考 `hermes-api-webui`，assistant 消息中应允许工具卡片按 `anchorOffset` 插入到流式文本附近。MVP 可以先把工具卡片展示在消息末尾，后续再支持精确锚点。

## 8. Markdown 渲染方案

### 8.1 依赖

在 `ui/package.json` 增加：

```json
{
  "dependencies": {
    "streamdown": "^2.5.0"
  }
}
```

如果使用 `streamdown` 样式，需要在 `ui/src/main.tsx` 或全局样式入口引入：

```ts
import "streamdown/styles.css";
```

如果样式与当前应用风格冲突，可以只使用组件能力，并在 `styles.css` 中覆写 `.streamdown-body`、`pre`、`code`、`table` 等样式。

### 8.2 消息渲染

建议新增 `MessageRenderer.tsx`：

```tsx
import { Streamdown } from "streamdown";

export function MessageRenderer({ content, streaming }: Props) {
  return (
    <div className="streamdown-shell">
      <Streamdown
        animated
        className="streamdown-body"
        isAnimating={streaming}
        mode={streaming ? "streaming" : "static"}
      >
        {content || (streaming ? "..." : "")}
      </Streamdown>
    </div>
  );
}
```

用户消息仍可使用纯文本 `white-space: pre-wrap`，assistant 消息使用 `Streamdown`。

### 8.3 安全注意

1. 不允许 Agent 输出直接触发本地命令。
2. Markdown 链接点击应由 UI 明确处理，后续可接入“打开外部链接确认”。
3. 代码块只展示，不提供一键执行。
4. 工具调用参数和命令必须放在审批卡片或工具卡片中，不混在普通 Markdown 中执行。

## 9. 去 mock 数据策略

当前 UI 依赖：

```text
ui/src/mockData.ts
mockSessions
mockMessages
mockToolEvents
```

实现阶段建议：

1. 删除 `ui/src/mockData.ts`。
2. `loadInitialState()` 不再回退到 mock，而是显示无 id 的空白草稿页。
3. 新建会话只创建空的本地会话，不自动插入模拟 Agent 欢迎消息。
4. 发送消息后：
   - 立即追加 user message。
   - 创建空 assistant message，`streaming=true`。
   - 调用 `agentClient.startTurn(...)`。
   - 后续完全由后端事件驱动 assistant message 内容。
5. 工具执行流从固定 `mockToolEvents` 改为 message.toolCalls 或 turn events。
6. 如果 backend 未连接，展示明确的离线状态和重试按钮，而不是假回复。

空状态建议文案：

```text
描述电脑问题，Agent 会先生成只读检查计划。
涉及下载、安装、删除、移动、环境变量或注册表修改时，会先说明用途和风险，再等待确认。
```

## 10. 会话持久化设计

当前会话持久化由 Python backend 负责，UI 不保存会话和消息：

1. UI 只读取会话列表和加载会话内容。
2. UI 新建对话时只打开无 id 的空白草稿页。
3. UI 发送用户输入后，通过 `/api/turns/stream` 接收 `conversation.turn.started` 和后续 Agent 事件；无 `conversationId` 时由 backend 创建真实会话 id。
4. backend 在 stream 过程中维护 user message、assistant message、工具调用、审批、错误和完成状态，并在一轮结束后写入 `messages.json`。
4. 浏览器 `localStorage` 不保存主消息记录。

前端服务接口：

```ts
interface ConversationStore {
  list(): Promise<Session[]>;
  load(id: string): Promise<{ session: Session; messages: ChatMessage[] }>;
}
```

## 11. 审批流程设计

### 11.1 Python ApprovalHook

Python 后台中：

```text
ApprovalHook.before_execute_tools(context)
  -> 遍历 context.tool_calls
  -> 生成 approval.required 事件
  -> 等待 UI 返回 approval.decision
  -> allow: 返回，nanobot 继续执行
  -> deny: 抛出 ToolApprovalRejected，中断当前 turn
```

### 11.2 UI 展示

UI 可先做内联审批面板，后续再升级为模态弹窗：

1. 工具名。
2. 风险等级。
3. 参数 JSON。
4. 用途说明。
5. 风险点。
6. 回滚建议。
7. 允许按钮。
8. 拒绝按钮。

高风险操作必须用户显式点击允许，不能默认允许。

### 11.3 与 Execution Gateway 的关系

本阶段审批 Hook 主要控制 nanobot 工具是否继续执行。后续真实系统修改还要经过 Rust Execution Gateway：

```text
nanobot ApprovalHook
  -> UI 初次审批
  -> Tool 返回 PendingAction
  -> Rust Execution Gateway 风险复核
  -> UI 最终审批
  -> 执行
```

为了避免双重审批造成体验混乱，MVP 阶段建议：

1. nanobot 工具只做只读工具和 `create_pending_action`。
2. 真正高风险操作由 `create_pending_action` 生成，不直接执行。
3. 用户看到的是“待执行操作审批”，不是“原始工具调用审批”。

## 12. 错误与取消

UI 需要支持：

1. 当前 turn 正在运行时，发送按钮切换为停止按钮。
2. 用户点击停止时调用 `agent_cancel_turn`。
3. 后台调用 `RunStream.cancel()`。
4. 收到 `agent.run.failed` 或取消事件后，assistant message 结束 streaming。
5. 错误信息显示在消息下方，不吞掉已输出文本。

后台需要处理：

1. 模型 API 错误。
2. 配置缺失。
3. API Key 缺失。
4. 工具执行异常。
5. 用户拒绝审批。
6. sidecar 进程被关闭。

## 13. 配置方案

当前 backend 配置由运行时 data 目录管理，不再维护仓库内 `backend/config` 模板。

开发环境由 `REPAIR_AGENTS_ENV=DEV` 选择项目 data 目录：

```text
data/config/nanobot_config.json
```

普通本机环境使用用户目录：

```text
~/.repair-agent/config/nanobot_config.json
```

当配置文件不存在时，backend 会自动创建最小配置，内容保留环境变量占位：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "${DEEPSEEK_API_KEY}",
      "apiBase": "https://api.deepseek.com"
    }
  },
  "modelPresets": {
    "deepseekFlash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    }
  }
}
```

真实密钥不写入配置文件或仓库文件：

```text
.env
```

API Key 不进入 UI localStorage。当前通过环境变量读取，后续可放入系统凭据存储或 Tauri 安全配置。

## 14. 分阶段实现计划

### 阶段 1：前端消息模型与 Markdown

1. 安装 `streamdown`。
2. 新增 `MessageRenderer`。
3. 调整 `ChatMessage` / `ToolCallItem` 类型。
4. 删除固定 mock 工具流展示。
5. 将 assistant 内容改为 Markdown 渲染。
6. 会话消息由 backend stream 事件创建和保存。

验收：

1. `npm run ui:build` 通过。
2. 手工发送一条消息时，UI 能展示 backend 返回的 user message 和 assistant message。

### 阶段 2：Tauri 与 Python sidecar 协议

1. 新增 backend 最小 stdio server。
2. 新增 Tauri sidecar 管理模块。
3. UI 可触发 `agent.turn.start`。
4. Python 返回模拟协议事件，用于验证链路。

验收：

1. 不依赖 mockData。
2. UI 消息由协议事件驱动更新。
3. sidecar 崩溃时 UI 显示离线状态。

### 阶段 3：接入 nanobot run_streamed

1. backend 使用 `Nanobot.from_config(...)`。
2. `agent.turn.start` 调用 `bot.run_streamed(...)`。
3. 转发 `text.delta`、`tool.started` 等事件。
4. 支持取消当前 run。

验收：

1. DeepSeek 配置正确时，UI 能看到真实流式输出。
2. 工具调用事件能进入工具卡片。
3. 错误能展示在 assistant message 中。

### 阶段 4：审批闭环

1. 实现 `ApprovalHook`。
2. 后台向 UI 发出 `approval.required`。
3. UI 展示审批面板。
4. 用户允许后 nanobot 继续。
5. 用户拒绝后当前 turn 中断。

验收：

1. 高风险工具调用前 UI 必须出现审批。
2. 拒绝审批不会执行工具。
3. 拒绝结果会写入当前消息状态。

### 阶段 5：Skill 与自定义 Tool

1. 迁移 demo 天气 Tool 验证方式到 backend。
2. 新增只读硬件扫描 Tool 占位。
3. 新增 `safe-command-review` always Skill。
4. 新增 `driver-auto-install`、`laptop-oem-driver`、`runtime-completion` 普通 Skill。

验收：

1. nanobot 能发现自定义 Tool。
2. nanobot 能发现 workspace Skill。
3. UI 能展示工具调用和 Skill 推荐状态。

## 15. 需要更新的文档

实现开始后应同步更新：

1. `docs/UI_DEVELOPMENT.md`：去掉“当前不对接 Python 后台”的表述。
2. `docs/PROJECT_STRUCTURE.md`：补充实际 `backend/`、`ui/src/components`、`ui/src/services` 结构。
3. `docs/NANOBOT_SDK_RESEARCH.md`：记录 UI 接入后的实测行为。
4. `AGENTS.md`：加入 backend 和 nanobot UI 集成的简要启动入口。

## 16. 风险与待确认问题

1. Tauri sidecar stdio JSON-RPC 是否足够支撑长时间流式输出和审批等待。
2. Python backend 打包后，`nanobot.tools` entry point 是否仍能稳定发现自定义 Tool。
3. `streamdown` 样式是否与当前 UI 风格冲突，可能需要局部 CSS 覆写。
4. DeepSeek `deepseek-v4-flash` 与 nanobot 工具调用格式的兼容性需要在 UI 链路中再次验证。
5. 审批等待期间如果用户关闭窗口，需要定义 backend 如何取消或拒绝。
6. 多会话并发是否允许。MVP 建议同一时间只运行一个 active turn，降低复杂度。

## 17. 推荐实现顺序

推荐先做一条最短真实链路：

```text
UI sendMessage
  -> Tauri command
  -> Python backend
  -> nanobot run_streamed
  -> text.delta
  -> UI Streamdown 渲染
```

打通后再加入：

1. 工具卡片。
2. 审批面板。
3. 取消按钮。
4. 会话持久化迁移。
5. Skill 和自定义 Tool。

这样可以避免同时调 UI、Tauri、Python、nanobot、审批和 Markdown，降低排错难度。
