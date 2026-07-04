# 统一 Agent 协议架构设计

设计日期：2026-07-05  
作者：Kevin & Claude

---

## 1. 背景与动机

### 1.1 当前架构面临的问题

code-lite 需要在**同一套 UI** 上适配多个 agent runtime：

- **Codex (Cx)**：GPT-5.5/GPT-6，bracket 格式模型 id（`gpt-5.5[xhigh]`）
- **Claude Code (Cl)**：Haiku/Sonnet/Opus/Fable，plain 模型 id（`claude-sonnet-4-5`）
- **opencode (Op)**：待接入
- **Nanobot (Nb)**：产品级模型适配器

当前实现存在的问题：

1. **前端缺乏统一协议**：每个 agent 的模型命名、配置选项、权限模式都不同，前端需要为每个 agent 写不同的渲染逻辑。
2. **后端转换逻辑分散**：Codex 的 `reasoning_effort` vs Claude Code 的 `effort`，转换代码分散在各处。
3. **连接池未统一**：理论上所有 ACP agent 应该共享 `AcpRuntimeManager`，但实际路由和创建逻辑不够清晰。
4. **会话隔离不彻底**：之前尝试共享连接 + 多路复用，导致事件串流、会话 id 冲突等严重问题（已修复为 per-conversation 隔离）。
5. **数据边界不清晰**：前端发送什么？后端返回什么？ACP init 返回什么？没有统一的文档。

### 1.2 设计目标

1. **统一前端协议**：前端只需理解 3 个数据结构（`TurnRequest` / `AgentEvent` / `SessionCapabilities`），不感知各 runtime 差异。
2. **集中后端转换**：所有 runtime 差异转换集中在 adapter 层，不分散到各处。
3. **连接池统一管理**：所有 ACP agent 共享 `AcpRuntimeManager`，per-conversation 隔离保证不串流。
4. **清晰的数据边界**：明确定义前端 → 后端、后端 → 前端、ACP init → 后端的数据格式。
5. **易于扩展**：新增 agent runtime（如 opencode）只需实现 adapter，前端无需改动。

---

## 2. 核心架构

### 2.1 整体分层

```text
┌──────────────────────────────────────────────────────────────┐
│                         前端 (React)                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ChatPage / ChatComposer                               │  │
│  │   - 选择模型 / 权限 / 思考强度                          │  │
│  │   - 发送 TurnRequest                                    │  │
│  │   - 接收 AgentEvent stream                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                          ▲                                    │
│                          │ 统一协议                          │
│                          ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  agentClient.ts                                        │  │
│  │   - initializeSession() → SessionCapabilities          │  │
│  │   - streamAgentTurn() → NDJSON stream                 │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                          │ HTTP/NDJSON
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                      后端 (FastAPI)                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  /api/turns/stream                                     │  │
│  │   - 解析 TurnRequest                                    │  │
│  │   - 路由到 AgentRouterAdapter                           │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │                                      │
│                        ▼                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AgentRouterAdapter                                    │  │
│  │   - 决策：产品模型 or runtime 原生模型                  │  │
│  │   - 懒加载 ACP adapter                                  │  │
│  └─────────┬──────────────────────┬───────────────────────┘  │
│            │                      │                          │
│            ▼                      ▼                          │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │ AcpAgentAdapter │    │     NanobotAdapter          │    │
│  │ (Codex/Claude/  │    │   (产品级模型)              │    │
│  │  opencode)      │    └─────────────────────────────┘    │
│  │                 │                                         │
│  │  _resolve_mode  │  ← runtime-specific 转换逻辑           │
│  │  _resolve_model │                                         │
│  │  _configure     │                                         │
│  └────────┬────────┘                                         │
│           │                                                   │
│           ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AcpRuntimeManager (连接池)                            │  │
│  │   - connections: {ConnectionKey → AcpRuntimeConnection}│  │
│  │   - session_bindings: {conv_id → AcpSessionBinding}    │  │
│  │   - turn_locks: {conv_id → asyncio.Lock}               │  │
│  │                                                         │  │
│  │   ensure_connection(conv_id) → AcpRuntimeConnection    │  │
│  │   ensure_session(conv_id) → AcpSessionBinding          │  │
│  └────────┬───────────────────────────────────────────────┘  │
│           │                                                   │
│           ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AcpRuntimeConnection (per-conversation)               │  │
│  │   - process: ACP 子进程 (stdio)                        │  │
│  │   - sdk_connection: ClientSideConnection               │  │
│  │   - handler: AcpClientHandler                          │  │
│  │   - sessions: {conv_id → native_session_id}            │  │
│  └────────┬───────────────────────────────────────────────┘  │
│           │                                                   │
│           ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AcpClientHandler (per-conversation)                   │  │
│  │   - session_update() → map to AgentEvent               │  │
│  │   - request_permission() → approval flow               │  │
│  │   - output_queue → event stream                        │  │
│  └────────┬───────────────────────────────────────────────┘  │
│           │                                                   │
│           ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AcpEventMapper                                        │  │
│  │   - map ACP update → AgentEvent                        │  │
│  │   - 文本去重 (TextDedupState)                          │  │
│  │   - 提取 usage                                          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                          │ JSON-RPC over stdio
                          ▼
┌──────────────────────────────────────────────────────────────┐
│              ACP Server (常驻子进程)                          │
│   codex-acp / claude-code acp / opencode acp                 │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策 | 说明 | 理由 |
|------|------|------|
| **Per-conversation 连接隔离** | 每个会话一个独立 ACP 连接 | 彻底避免事件串流，物理隔离比多路复用更可靠 |
| **统一前端协议** | 前端只理解 3 个结构 | 新增 runtime 无需改前端 |
| **Runtime 原生 id 透传** | 模型 id 不做产品层映射 | 避免维护映射表，减少转换错误 |
| **Adapter 集中转换** | runtime 差异转换在 adapter | 不分散到各处，易于维护 |
| **连接池统一管理** | 所有 ACP adapter 共享 manager | 避免重复 spawn，资源复用 |

---

## 3. 统一协议定义

### 3.1 前端 → 后端：TurnRequest

前端通过 `POST /api/turns/stream` 发送对话请求。

```typescript
interface TurnRequest {
  // ─── 会话标识 ───
  conversationId?: string;  // 可选，如为空后端生成新 id
  turnId: string;           // 前端生成的 turn uuid

  // ─── 用户输入 ───
  input: string;            // 用户消息内容

  // ─── 模型与配置（用户选择的"显示值"）───
  modelId?: string | null;        // 模型 id（runtime 原生）
  accessMode?: string | null;     // 权限模式 id
  reasoningEffort?: string | null; // 思考强度（产品层统一名称）
  selectedConfig?: Record<string, string | number | boolean>; // 其他配置
}
```

**示例 1：Codex 请求**

```json
{
  "conversationId": "conv-abc123",
  "turnId": "turn-def456",
  "input": "请分析这个项目的架构",
  "modelId": "gpt-5.5[xhigh]",
  "accessMode": "code",
  "reasoningEffort": "high",
  "selectedConfig": {}
}
```

**示例 2：Claude Code 请求**

```json
{
  "conversationId": "conv-xyz789",
  "turnId": "turn-uvw012",
  "input": "帮我写一个快速排序",
  "modelId": "claude-sonnet-4-5",
  "accessMode": "default",
  "reasoningEffort": "medium",
  "selectedConfig": {
    "fast": true
  }
}
```

**关键点**：

- `modelId` 是 runtime 原生 id（Codex 的 bracket 格式 / Claude Code 的 plain id），前端不需要知道格式差异。
- `reasoningEffort` 是产品层统一名称（`low`/`medium`/`high`/`xhigh`/`max`），后端负责转换为各 runtime 的 config id。
- `selectedConfig` 兜底传递 runtime 特有配置（如 Claude Code 的 `fast` boolean）。

### 3.2 后端 → 前端：AgentEvent

后端返回 `application/x-ndjson` 流式事件，每行一个 JSON 对象。

```typescript
type AgentEvent =
  | ConversationTurnStartedEvent
  | AgentTextDeltaEvent
  | AgentReasoningDeltaEvent
  | AgentToolDeltaEvent
  | AgentToolApprovalEvent
  | AgentContextUpdatedEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent;
```

#### 3.2.1 通用字段

```typescript
interface BaseAgentEvent {
  type: string;              // 事件类型
  conversationId: string;    // 会话 id（前端路由必需）
  turnId: string;            // turn id
  metadata?: {
    runtime: string;         // runtime 标识 ("codex"/"claude_code")
    nativeSessionId?: string; // ACP 原生 session id（调试用）
  };
}
```

#### 3.2.2 对话开始事件

```typescript
interface ConversationTurnStartedEvent extends BaseAgentEvent {
  type: "conversation.turn.started";
  session: Session;              // 会话信息（含 agent 绑定）
  userMessage: ChatMessage;      // 用户消息
  assistantMessage: ChatMessage; // 助手消息（初始状态）
}
```

**示例**：

```json
{
  "type": "conversation.turn.started",
  "conversationId": "conv-abc123",
  "turnId": "turn-def456",
  "session": {
    "id": "conv-abc123",
    "title": "架构分析",
    "agent": {
      "id": "codex",
      "label": "Codex (Cx)"
    },
    "status": "running"
  },
  "userMessage": {
    "id": "msg-user-001",
    "role": "user",
    "content": "请分析这个项目的架构",
    "createdAt": 1720180800000
  },
  "assistantMessage": {
    "id": "msg-asst-001",
    "role": "assistant",
    "content": "",
    "streaming": true,
    "createdAt": 1720180801000
  },
  "metadata": {
    "runtime": "codex",
    "nativeSessionId": "native-xyz"
  }
}
```

#### 3.2.3 文本流式输出

```typescript
interface AgentTextDeltaEvent extends BaseAgentEvent {
  type: "agent.text.delta";
  delta: string;  // 增量文本（已去重）
}
```

**示例**：

```json
{"type":"agent.text.delta","conversationId":"conv-abc123","turnId":"turn-def456","delta":"这个项目","metadata":{"runtime":"codex"}}
{"type":"agent.text.delta","conversationId":"conv-abc123","turnId":"turn-def456","delta":"采用了","metadata":{"runtime":"codex"}}
{"type":"agent.text.delta","conversationId":"conv-abc123","turnId":"turn-def456","delta":"分层架构","metadata":{"runtime":"codex"}}
```

#### 3.2.4 思考过程流式输出

```typescript
interface AgentReasoningDeltaEvent extends BaseAgentEvent {
  type: "agent.reasoning.delta";
  delta: string;  // 思考增量
}
```

#### 3.2.5 上下文窗口占用更新（新增）

```typescript
interface AgentContextUpdatedEvent extends BaseAgentEvent {
  type: "agent.context.updated";
  context: {
    contextUsedTokens: number;    // 已用 token
    contextWindowTokens: number;  // 总窗口大小
  };
}
```

**示例**：

```json
{
  "type": "agent.context.updated",
  "conversationId": "conv-abc123",
  "turnId": "turn-def456",
  "context": {
    "contextUsedTokens": 1234,
    "contextWindowTokens": 100000
  },
  "metadata": {
    "runtime": "codex"
  }
}
```

**说明**：每次 ACP `usage_update` 触发时实时推送，供前端 Context Ring 实时更新。

#### 3.2.6 工具调用事件

```typescript
interface AgentToolDeltaEvent extends BaseAgentEvent {
  type: "agent.tool.delta";
  toolCallId: string;
  name: string;
  status: "pending" | "running" | "complete" | "error";
  argumentsText?: string;
  resultText?: string;
  risk?: "low" | "medium" | "high" | "blocked";
}

interface AgentToolApprovalEvent extends BaseAgentEvent {
  type: "agent.tool.approval";
  approvalId: string;
  toolCallId: string;
  name: string;
  argumentsText: string;
  risk: "low" | "medium" | "high" | "blocked";
  purpose: string;
  impact: string;
  risks: string[];
  rollback: string;
}
```

#### 3.2.7 对话完成事件

```typescript
interface AgentRunCompletedEvent extends BaseAgentEvent {
  type: "agent.run.completed";
  usage?: UsageStats;  // token 使用统计
  session?: Session;   // 更新后的会话信息
}

interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;      // 已用上下文
  contextWindowTokens?: number;    // 总上下文窗口
  source?: string;                 // 数据来源标识
}
```

**示例**：

```json
{
  "type": "agent.run.completed",
  "conversationId": "conv-abc123",
  "turnId": "turn-def456",
  "usage": {
    "promptTokens": 150,
    "completionTokens": 80,
    "totalTokens": 230,
    "contextUsedTokens": 1234,
    "contextWindowTokens": 100000,
    "source": "codex-acp"
  },
  "metadata": {
    "runtime": "codex",
    "nativeSessionId": "native-xyz"
  }
}
```

#### 3.2.8 对话失败事件

```typescript
interface AgentRunFailedEvent extends BaseAgentEvent {
  type: "agent.run.failed";
  error: string;  // 错误消息
}
```

### 3.3 初始化：SessionCapabilities

前端进入会话时调用 `POST /api/sessions/{conversationId}/initialize`，后端返回该会话绑定的 agent 的能力描述。

```typescript
interface SessionCapabilities {
  agent: SessionAgentInfo;
  modes: SessionMode[];
  models: SessionModel[];
  configOptions: SessionConfigOption[];
}

interface SessionAgentInfo {
  id: string;          // agent id ("codex"/"claude_code")
  label: string;       // 显示名称 ("Codex (Cx)"/"Claude Code (Cl)")
  adapterKind: "acp" | "nanobot";
  status: "available" | "experimental" | "missing_dependency" | string;
}

interface SessionMode {
  id: string;          // mode id ("code"/"plan"/"default")
  label: string;       // 显示名称 ("Code"/"Plan"/"Default")
  isDefault: boolean;
}

interface SessionModel {
  id: string;           // 模型 id（runtime 原生 id）
  label: string;        // 显示名称（从 ACP 获取）
  description?: string; // 模型描述
  isCurrent: boolean;   // 是否为当前默认模型
}

interface SessionConfigOption {
  id: string;       // 配置项 id ("reasoning_effort"/"fast")
  label: string;    // 显示名称
  type: "enum" | "boolean" | "number";
  values?: string[];  // 枚举值列表（type=enum 时）
  currentValue?: string | number | boolean;  // 当前值
  valueLabels?: Record<string, string>;  // 枚举值显示名称映射
}
```

#### 3.3.1 Codex SessionCapabilities 示例

```json
{
  "agent": {
    "id": "codex",
    "label": "Codex (Cx)",
    "adapterKind": "acp",
    "status": "available"
  },
  "modes": [
    { "id": "code", "label": "Code", "isDefault": true },
    { "id": "plan", "label": "Plan", "isDefault": false },
    { "id": "ask", "label": "Ask", "isDefault": false }
  ],
  "models": [
    { "id": "gpt-5.5[high]", "label": "GPT-5.5 (high)", "isCurrent": false },
    { "id": "gpt-5.5[xhigh]", "label": "GPT-5.5 (xhigh)", "isCurrent": true },
    { "id": "gpt-6[medium]", "label": "GPT-6 (medium)", "isCurrent": false }
  ],
  "configOptions": [
    {
      "id": "reasoning_effort",
      "label": "Reasoning Effort",
      "type": "enum",
      "values": ["low", "medium", "high", "xhigh"],
      "currentValue": "xhigh",
      "valueLabels": {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "XHigh"
      }
    }
  ]
}
```

#### 3.3.2 Claude Code SessionCapabilities 示例

```json
{
  "agent": {
    "id": "claude_code",
    "label": "Claude Code (Cl)",
    "adapterKind": "acp",
    "status": "available"
  },
  "modes": [
    { "id": "default", "label": "Default", "isDefault": true },
    { "id": "plan", "label": "Plan", "isDefault": false },
    { "id": "acceptEdits", "label": "Accept Edits", "isDefault": false }
  ],
  "models": [
    { "id": "claude-haiku-4-5", "label": "Haiku", "isCurrent": false },
    { "id": "claude-sonnet-4-5", "label": "Sonnet", "isCurrent": false },
    { "id": "claude-opus-4-8", "label": "Opus", "isCurrent": true },
    { "id": "claude-fable-5", "label": "Fable", "isCurrent": false }
  ],
  "configOptions": [
    {
      "id": "effort",
      "label": "Reasoning Effort",
      "type": "enum",
      "values": ["low", "medium", "high", "xhigh", "max"],
      "currentValue": "high",
      "valueLabels": {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "XHigh",
        "max": "Max"
      }
    },
    {
      "id": "fast",
      "label": "Fast Mode",
      "type": "boolean",
      "currentValue": false
    }
  ]
}
```

#### 3.3.3 关键差异对比

| 项目 | Codex | Claude Code |
|------|-------|-------------|
| **模型 id 格式** | bracket 格式（`gpt-5.5[xhigh]`） | plain id（`claude-opus-4-8`） |
| **Modes** | code / plan / ask | default / plan / acceptEdits |
| **Effort config id** | `reasoning_effort` | `effort` |
| **额外配置** | 无 | `fast` boolean |
| **模型数量** | 通常较少（按 effort 区分） | 较多（haiku/sonnet/opus/fable） |

**前端处理**：前端用统一的 `SessionCapabilities` 结构渲染下拉框、按钮等 UI，不需要知道这些差异。后端负责转换。

---

## 4. 后端架构详解

### 4.1 AgentRouterAdapter：路由决策层

**职责**：决定使用产品级模型还是 runtime 原生模型。

```python
class AgentRouterAdapter:
    def __init__(self, runtime_manager: AcpRuntimeManager, ...):
        self._adapters: dict[str, Any] = {}  # 懒加载的 adapter 实例
        self._runtime_manager = runtime_manager
    
    async def stream_turn(self, request: AgentRunRequest):
        adapter_name = request.agent_id or "nanobot"
        
        # 懒加载 adapter
        if adapter_name not in self._adapters:
            self._adapters[adapter_name] = self._get_or_create_adapter(adapter_name)
        
        adapter = self._adapters[adapter_name]
        async for event in adapter.stream_turn(request):
            yield event
    
    def _get_or_create_adapter(self, adapter_name: str):
        if adapter_name == "codex":
            descriptor = CODEX_DESCRIPTOR
        elif adapter_name == "claude_code":
            descriptor = get_descriptor("claude_code")
        elif adapter_name == "opencode":
            descriptor = get_descriptor("opencode")
        elif adapter_name == "nanobot":
            return NanobotAdapter(...)
        else:
            raise ValueError(f"Unknown adapter: {adapter_name}")
        
        # 所有 ACP adapter 共享 runtime_manager
        return AcpAgentAdapter(
            name=adapter_name,
            descriptor=descriptor,
            runtime_manager=self._runtime_manager,
            ...
        )
```

**关键点**：

- 所有 ACP adapter 共享同一个 `AcpRuntimeManager` 实例
- 懒加载：只有实际使用时才创建 adapter
- Nanobot 是产品级模型 adapter，不走 ACP 连接池

### 4.2 AcpAgentAdapter：ACP 统一适配层

**职责**：处理所有 ACP runtime 的共性逻辑，runtime 差异通过 `if self.name == "xxx"` 特判。

```python
class AcpAgentAdapter:
    def __init__(
        self,
        name: str,  # "codex" / "claude_code" / "opencode"
        descriptor: RuntimeDescriptor,
        runtime_manager: AcpRuntimeManager,
        ...
    ):
        self.name = name
        self.descriptor = descriptor
        self.runtime_manager = runtime_manager
    
    async def stream_turn(self, request: AgentRunRequest):
        conversation_id = request.conversation_id
        
        # 获取 turn lock（串行化同一会话的 prompt）
        turn_lock = self.runtime_manager.get_turn_lock(conversation_id)
        async with turn_lock:
            # 1. 确保连接存在
            command = self._resolve_command()
            env = self._resolve_env()
            connection = await self.runtime_manager.ensure_connection(
                descriptor=self.descriptor,
                command=command,
                env=env,
                workspace=request.workspace,
                conversation_id=conversation_id,
                approvals=self.approvals,
            )
            
            # 2. 确保 session 绑定
            binding = await self.runtime_manager.ensure_session(
                connection=connection,
                conversation_id=conversation_id,
                workspace=request.workspace,
            )
            native_session_id = binding.native_session_id
            
            # 3. 配置 session（mode / model / effort / config）
            await self._configure_session(
                connection=connection,
                native_session_id=native_session_id,
                request=request,
            )
            
            # 4. 发送 prompt
            async for event in self._run_turn(
                connection=connection,
                native_session_id=native_session_id,
                request=request,
            ):
                yield event
    
    async def _configure_session(self, connection, native_session_id, request):
        sdk_connection = connection.sdk_connection
        
        # 配置 mode
        if request.access_mode:
            mode = self._resolve_mode(request.access_mode)
            try:
                await sdk_connection.set_mode(
                    session_id=native_session_id,
                    mode=mode,
                )
                logger.info("Set mode=%s for session %s", mode, native_session_id[:12])
            except Exception as exc:
                logger.warning("Failed to set mode: %s", exc)
        
        # 配置 effort
        if request.reasoning_effort:
            effort_config_id = self._resolve_effort_config_id()
            try:
                await sdk_connection.set_configuration(
                    session_id=native_session_id,
                    configuration_id=effort_config_id,
                    value=request.reasoning_effort,
                )
                logger.info("Set %s=%s", effort_config_id, request.reasoning_effort)
            except Exception as exc:
                logger.warning("Failed to set effort: %s", exc)
        
        # 配置其他选项（如 Claude Code 的 fast）
        # selectedConfig 中的其他字段...
    
    def _resolve_mode(self, product_mode: str) -> str:
        """转换产品层 mode 为 runtime 原生 mode"""
        if self.name == "claude_code":
            # Claude Code mode 映射
            CLAUDE_MODE_MAP = {
                "code": "default",
                "plan": "plan",
                "ask": "default",
            }
            return CLAUDE_MODE_MAP.get(product_mode, "default")
        else:
            # Codex / opencode 直接透传
            return product_mode
    
    def _resolve_effort_config_id(self) -> str:
        """获取 effort 配置项的 id"""
        if self.name == "claude_code":
            return "effort"
        else:
            return "reasoning_effort"
```

**关键点**：

- **共性逻辑**：`ensure_connection` → `ensure_session` → `configure` → `prompt` 流程一致
- **差异特判**：mode 映射、effort config id、命令/环境变量解析等通过 `if self.name == "xxx"` 处理
- **Turn 串行化**：同一会话的多轮 turn 通过 `turn_lock` 串行，避免并发搞乱 session 状态

### 4.3 AcpRuntimeManager：连接池
**职责**：管理所有 ACP 连接的生命周期，per-conversation 隔离。

```python
@dataclass(frozen=True)
class ConnectionKey:
    """连接复用键（per-conversation 隔离）"""
    runtime_id: str           # "codex" / "claude_code" / "opencode"
    workspace: str            # 工作目录路径
    config_mode: str          # "user-native" / "package-isolated"
    conversation_id: str      # 会话 id（隔离键）
    command_fingerprint: str  # 命令 hash
    env_fingerprint: str      # 环境变量 key hash

@dataclass
class AcpRuntimeConnection:
    """常驻 ACP 连接（per-conversation）"""
    key: ConnectionKey
    descriptor: RuntimeDescriptor
    command: list[str]
    env: dict[str, str]
    process: asyncio.subprocess.Process
    sdk_connection: ClientSideConnection
    initialize_result: Any
    stderr_ring_buffer: deque[str]  # 最近 20 行 stderr
    latest_activity_at: float
    sessions: dict[str, str]  # conversation_id → native_session_id
    capabilities_cache: dict[str, Any] | None
    _ready: bool
    _client_handler: AcpClientHandler | None
    _stderr_task: asyncio.Task | None
```

**关键方法**：`ensure_connection()` / `ensure_session()` / `get_turn_lock()`，详见第 4 节。

---

## 5. 会话隔离：从共享连接到 Per-conversation

### 5.1 问题回顾

之前尝试共享连接 + 多路复用时遇到的问题：事件串流、会话 id 冲突、模型错乱、页面卡死。

**根本原因**：所有会话共享一个 ACP 子进程，handler 通过 `session_id` 多路复用，SDK 回调参数有限，draft session 转换导致路由失败。

### 5.2 根治方案

**Per-conversation 连接隔离**：`ConnectionKey` 包含 `conversation_id`，每个会话一个独立连接。

**收益**：彻底消除串流、代码简化（-120 行）、前端简化、调试简单。  
**代价**：每个活跃会话多一个子进程（可接受）。

---

## 6. 前端集成指南

### 6.1 发送 Turn 请求

```typescript
await streamAgentTurn({
  conversationId: activeSession.id,
  turnId: `turn-${uuid()}`,
  input: userInput,
  modelId: selectedModelFamily,  // runtime 原生 id
  accessMode: accessMode,
  reasoningEffort: reasoningEffort,
  selectedConfig: selectedConfig,
  onEvent: handleAgentEvent,
});
```

### 6.2 处理事件流

```typescript
function handleAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case "conversation.turn.started":
      // 创建消息
      break;
    case "agent.text.delta":
      // 追加文本
      break;
    case "agent.context.updated":
      // 更新 Context Ring
      setContextUsage({
        used: event.context.contextUsedTokens,
        total: event.context.contextWindowTokens,
      });
      break;
    case "agent.run.completed":
      // 标记完成
      break;
  }
}
```

### 6.3 初始化会话

```typescript
const caps = await initializeSession(conversationId);
setAvailableModels(caps.models);
setAvailableModes(caps.modes);
// 统一处理 reasoning_effort / effort
const effortOption = caps.configOptions.find(
  opt => opt.id === "reasoning_effort" || opt.id === "effort"
);
```

---

## 7. 扩展新 Runtime 指南

### 7.1 添加新 Runtime（例：opencode）

**步骤 1**：定义 `RuntimeDescriptor`

```python
OPENCODE_DESCRIPTOR = RuntimeDescriptor(
    id="opencode",
    label="opencode (Op)",
    adapter_kind="acp",
    command_template=["opencode-acp"],
    ...
)
```

**步骤 2**：添加 runtime-specific 逻辑（如有）

```python
def _resolve_mode(self, product_mode: str) -> str:
    if self.name == "opencode":
        return product_mode  # 或自定义映射
    ...
```

**步骤 3**：更新 `_ACP_RUNTIME_IDS`

```python
_ACP_RUNTIME_IDS = {"codex", "claude_code", "opencode"}
```

**步骤 4**：前端无需改动（自动支持）

### 7.2 Runtime 差异处理原则

| 差异类型 | 处理方式 |
|---------|---------|
| 模型 id 格式 | 透传，不映射 |
| Mode 映射 | `_resolve_mode()` |
| Config id | `_resolve_effort_config_id()` |
| 额外配置 | `selectedConfig` 透传 |

---

## 8. 存储与持久化

### 8.1 存储结构

```text
conversations/{conversation_id}/
├── metadata.json          # 会话元数据
├── session.json           # 会话状态（agent 绑定）
├── messages.json          # 消息投影
├── events.ndjson          # 事件日志（真相来源）
└── native-session.json    # ACP session 绑定
```

### 8.2 native-session.json

```json
{
  "conversationId": "conv-abc123",
  "runtimeId": "codex",
  "nativeSessionId": "native-xyz",
  "workspace": "H:/codex-lite",
  "createdAt": "2026-07-05T12:00:00Z",
  "capabilities": {...}
}
```

**用途**：backend 重启后尝试 `session/load` 恢复，缓存 capabilities。

---

## 9. 核心设计原则总结

1. **前端显示协议统一**：只需理解 3 个结构，不感知 runtime 差异
2. **后端转换集中**：adapter 层集中处理差异
3. **Runtime 原生优先**：减少不必要的映射
4. **Per-conversation 隔离**：彻底避免事件串流
5. **连接池统一管理**：所有 ACP adapter 共享 manager
6. **Event-first 存储**：events.ndjson 作为真相来源
7. **Turn 串行化**：turn_lock 避免并发冲突
8. **易于扩展**：新增 runtime 前端无需改动

---

## 10. 待优化项

1. 连接池 idle timeout（30 分钟无活动清理）
2. Session capabilities 缓存（避免重复 session/new）
3. 前端 model label 映射表（统一显示名称）
4. Error message 本地化（统一错误码）
5. 事件日志归档/压缩（长会话优化）
6. 连接预热（减少首次对话延迟）

---

## 11. 参考文档

- `docs/design/0704-ACP-RUNTIME-OPTIMIZATION.md` — ACP Runtime 优化
- `docs/research/0703-VIBEX-ACP-RESEARCH.md` — VibeX 调研
- `backend/code_lite_backend/schemas/agent.py` — 后端类型定义
- `ui/src/types.ts` — 前端类型定义

---

**设计完成日期**：2026-07-05  
**文档版本**：v1.0
