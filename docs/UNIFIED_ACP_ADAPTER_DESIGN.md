# ACP 大一统适配设计：统一前端交互协议

设计日期：2026-07-03

本文是 code-lite 从 "兼容 nanobot 消息格式" 过渡到 "以 ACP 为大一统协议" 的调研与设计文档。目标是解决当前前端展示字段混乱、各 agent 模型/思考强度/权限各自为政的问题，实现 **逻辑上分离、代码上简洁、协议上统一** 的 agent 接入体系。

## 1. 问题诊断

### 1.1 当前现状

code-lite 目前的 agent 接入层存在以下问题：

**问题一：前端字段散落在各 adapter，无统一会话配置协议**

```text
当前 ChatComposer 硬编码逻辑：
  isCodex = agent?.id === "codex"
  accessMode <select> disabled={!isCodex}  // 只有 Codex 能选权限
  reasoningEffort <select> disabled={!isCodex}  // 只有 Codex 能选思考强度
  model picker 按 providerId 分组  // 模型选择逻辑和 nanobot 完全不同
```

前端通过 `agent.id === "codex"` 判断是否展示权限和思考强度选项。这意味着每接入一个新的 agent（Claude Code、opencode、nanobot），都需要在前端写特殊分支逻辑。

**问题二：模型列表获取方式不一致**

```text
Codex：session/new 返回 models.availableModels -> 从 ACP runtime 获取
nanobot：从产品 model_config_store 获取 -> 从 provider API 获取
Claude Code：未知 -> 可能从 ACP runtime 获取
opencode：未知 -> 可能从 ACP runtime 获取
```

前端在 `ChatPage.tsx` 中通过 `if (sessionAgent?.id === "codex")` 分支决定走哪条路获取模型。未来每加一个 agent 都要加分支。

**问题三：每次 turn 发送的请求字段不统一**

```json
// 当前 /api/turns/stream 请求体
{
  "conversationId": "...",
  "turnId": "...",
  "input": "用户输入",
  "modelId": "...",           // nanobot 是产品模型 ID，codex 是 runtime 模型名
  "accessMode": "read-only",  // 只对应 Codex 的 mode
  "reasoningEffort": "medium" // 只对应 Codex 的 config option
}
```

`modelId` 对 nanobot 和 codex 含义完全不同。`accessMode` 和 `reasoningEffort` 只对 codex 有意义，其他 agent 收到后直接忽略。这种设计导致后端 `turns.py` 需要用 `if agent_id == "codex"` 分支处理。

**问题四：流式事件经过了冗余的转译层**

```text
ACP server 发送 -> ACP SDK 解析为 Python 对象 -> AcpClient handler 转为 dict ->
AgentEvent dict -> NDJSON 编码 -> 前端 NDJSON 解析 -> 前端 AgentEvent 类型
```

ACP 已经定义了标准化的 `session/update` 事件流，但当前 adapter 在 Python 端手动逐字段翻译为 code-lite 自定义的 `AgentEvent`。虽然当前 UI 确实需要一套前端事件格式，但 **从 ACP 原始数据到前端事件之间不应该有手工翻译**，而应该有一层 **声明式的映射表**。

**问题五：nanobot 和 ACP agent 的消息格式不兼容**

nanobot adapter 直接调用 nanobot SDK 的 `run_streamed`，使用 `map_nanobot_event()` 将 nanobot 内部事件转为 `AgentEvent`。ACP adapter 也有一套映射。两个 adapter 各自维护映射逻辑，但输出格式相同——这意味着 code-lite 的 `AgentEvent` 实际上已经是事实上的统一格式，只是没有正式定义和强制执行。

### 1.2 核心矛盾总结

```
nanobot 的设计初衷是 "通用 LLM agent 框架"
ACP 的设计初衷是 "agent-client 统一控制协议"

code-lite 之前的定位是 nanobot 的桌面壳
code-lite 现在的定位是 coding agent 工作台

这两套定位需要一次正式的协议切换：
  - ACP 成为 agent 接入的正式协议
  - nanobot 如果后续还想接入，必须适配 ACP
  - 前端只理解一套统一的交互格式
```

### 1.3 为什么要大一统

| 维度 | 当前 | 目标 |
| --- | --- | --- |
| 前端展示 | `if agent.id === "codex"` 分支判断 | 所有 agent 统一 descriptor，前端按能力渲染 |
| 模型列表 | codex 走 runtime，nanobot 走产品配置 | 统一 `GET /api/agents/{id}/models`，由 adapter 各自解析 |
| 思考强度 | codex 硬编码 none/low/medium/high/xhigh | 从 `session/new` 的 `configOptions` 动态获取 |
| 权限模式 | codex 硬编码 read-only/agent/agent-full-access | 从 `session/new` 的 `modes` 动态获取 |
| 事件流 | 各 adapter 手写映射 | 通用 ACP mapper + adapter-specific 补充 |
| 新 agent 接入 | 前端后端都要写特殊逻辑 | 只需写一个 ACP adapter descriptor，前端自动适配 |

## 2. ACP 协议提供的统一能力

ACP v1 协议的 `session/new` 响应已经定义了所有前端交互所需的元数据：

```json
{
  "sessionId": "...",
  "modes": [
    { "id": "read-only", "label": "Read Only" },
    { "id": "agent", "label": "Agent" },
    { "id": "agent-full-access", "label": "Full Access" }
  ],
  "models": {
    "currentModelId": "o4-mini",
    "availableModels": [
      { "modelId": "o4-mini", "name": "o4-mini", "description": "..." },
      { "modelId": "o3", "name": "o3", "description": "..." }
    ]
  },
  "configOptions": {
    "mode": { "type": "enum", "values": ["read-only", "agent", "agent-full-access"] },
    "model": { "type": "enum", "values": ["o4-mini", "o3"] },
    "reasoning_effort": { "type": "enum", "values": ["none", "low", "medium", "high", "xhigh"] },
    "fast-mode": { "type": "boolean" }
  }
}
```

**关键结论：ACP 协议本身已经提供了统一格式。我们不需要重新发明轮子。**

前端交互所需的全部信息——可用模型、思考强度、权限模式——都可以从 `session/new` 的响应中动态获取。当前的问题是 code-lite 没有利用这些标准化数据，而是在前端硬编码了 Codex 特有的字段。

## 3. 统一交互协议设计

### 3.1 设计原则

1. **ACP 优先**：所有能从 ACP 协议获取的信息，一律从 ACP 获取，不做二次翻译
2. **进入对话即加载**：用户点进一个对话时，就应该完成 agent 的初始化并获取所有可用选项
3. **前端无分支**：前端不写任何 `if agent.id === "xxx"` 的代码，一切由 descriptor 驱动
4. **每 turn 携带选项**：发送消息时，将当前选中的模型、思考强度、权限模式作为字段传递
5. **事件直通**：ACP 事件经过声明式映射直达前端，不做中间翻译

### 3.2 统一数据流

```text
┌──────────────────────────────────────────────────────────────────┐
│                        code-lite 统一架构                        │
│                                                                  │
│  React UI                                                        │
│    │                                                             │
│    │  POST /api/sessions/{conversationId}/initialize             │
│    │  → 返回 SessionCapabilities (models, modes, configOptions)  │
│    │                                                             │
│    │  POST /api/turns/stream                                     │
│    │  body: {                                                    │
│    │    input: string                                            │
│    │    selectedModel: string        // 用户选中的模型            │
│    │    selectedMode: string         // 用户选中的权限模式        │
│    │    selectedConfig: { ... }      // 用户选中的配置选项        │
│    │  }                                                          │
│    │                                                             │
│    │  ← NDJSON stream of UnifiedAgentEvent                     │
│    │                                                             │
│  ──┼─────────────────────────────────────────────────────────── │
│    │                                                             │
│  Python Backend                                                  │
│    │                                                             │
│    ├── SessionManager                                            │
│    │     │  initialize():                                       │
│    │     │    spawn/connect ACP server                          │
│    │     │    session/new                                       │
│    │     │    返回 SessionCapabilities                          │
│    │     │                                                      │
│    ├── AcpAgentAdapter (统一)                                    │
│    │     │  stream_turn():                                      │
│    │     │    将 selectedModel/Mode/Config 应用到 session       │
│    │     │    发送 prompt                                        │
│    │     │    通过 AcpEventMapper 映射事件                      │
│    │     │                                                      │
│    ├── AcpEventMapper (声明式映射表)                             │
│    │     │  ACP session/update → UnifiedAgentEvent             │
│    │     │  ACP request_permission → approval.required          │
│    │     │  ACP prompt result → agent.run.completed            │
│    │     │                                                      │
│  ──┼─────────────────────────────────────────────────────────── │
│    │                                                             │
│  ACP Server (via stdio JSON-RPC)                                │
│    codex-acp / claude-agent-acp / opencode acp / ...            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 SessionCapabilities：进入对话时加载

**新接口**：`POST /api/sessions/{conversationId}/initialize`

用户点进一个对话时，前端调用此接口。后端：

1. 解析该对话绑定的 agent（默认使用当前 activeAdapter）
2. 启动或复用 ACP 连接
3. 调用 `session/new` 或 `session/load`
4. 将 ACP 返回的 modes、models、configOptions 归一化为 `SessionCapabilities`

```typescript
// 前端类型定义
interface SessionCapabilities {
  /** 当前对话绑定的 agent 信息 */
  agent: {
    id: string;
    label: string;
    adapterKind: "acp" | "nanobot";  // 后续 nanobot 也需要适配 ACP
    status: "available" | "experimental" | "missing_dependency";
  };

  /** 可选的权限/访问模式 —— 直接来自 ACP session/new.modes */
  modes: SessionMode[];

  /** 可选的模型 —— 直接来自 ACP session/new.models */
  models: SessionModel[];

  /** 可选的配置选项 —— 直接来自 ACP session/new.configOptions */
  configOptions: SessionConfigOption[];
}

interface SessionMode {
  id: string;         // ACP mode id, e.g. "read-only", "agent", "agent-full-access"
  label: string;      // 展示用标签
  isDefault: boolean;
}

interface SessionModel {
  id: string;         // ACP modelId
  label: string;      // 展示用名称
  description?: string;
  isCurrent: boolean; // 当前 session 默认选中的模型
}

interface SessionConfigOption {
  id: string;         // e.g. "reasoning_effort", "fast-mode"
  label: string;      // 展示用标签, e.g. "思考强度"
  type: "enum" | "boolean" | "number";
  values?: string[];  // enum 类型的可选值
  currentValue?: string | number | boolean;
  valueLabels?: Record<string, string>; // 值到展示标签的映射
}
```

**为什么要在进入对话时加载？**

| 信息 | 来源 | 加载时机 |
| --- | --- | --- |
| 可用模型 | ACP `session/new.models` | 进入对话时 |
| 权限模式 | ACP `session/new.modes` | 进入对话时 |
| 思考强度 | ACP `session/new.configOptions["reasoning_effort"]` | 进入对话时 |
| 其他配置 | ACP `session/new.configOptions` | 进入对话时 |
| 当前 usage | ACP `usage_update` | 流式推送 |

这样前端 **不再需要硬编码任何 agent 特有字段**。所有 UI 控件的渲染都由 `SessionCapabilities` 驱动。

### 3.4 统一 Turn 请求格式

```typescript
// POST /api/turns/stream 请求体
interface UnifiedTurnRequest {
  /** 对话 ID，不传则创建新对话 */
  conversationId?: string;

  /** Turn ID，前端生成 */
  turnId: string;

  /** 用户输入 */
  input: string;

  /** 用户本轮选中的模型 —— 来自 SessionCapabilities.models[].id */
  selectedModel?: string;

  /** 用户本轮选中的权限模式 —— 来自 SessionCapabilities.modes[].id */
  selectedMode?: string;

  /** 用户本轮选中的配置选项 —— 来自 SessionCapabilities.configOptions */
  selectedConfig?: Record<string, string | number | boolean>;
  // 例如：{ "reasoning_effort": "medium", "fast-mode": false }
}
```

**对比当前请求格式的变化：**

| 当前字段 | 统一字段 | 变化说明 |
| --- | --- | --- |
| `modelId` | `selectedModel` | 语义不变，但明确来自 SessionCapabilities |
| `accessMode` | `selectedMode` | 改名以匹配 ACP modes 语义 |
| `reasoningEffort` | `selectedConfig.reasoning_effort` | 从独立字段变为 configOptions 的一部分 |
| 无 | `selectedConfig` | 新增，用于传递任意 config option |

**关键变化**：不再为每个 agent 特有的参数写独立字段。未来 Claude Code 支持 `thinking_budget`、opencode 支持 `compaction_threshold` 等，都通过 `selectedConfig` 传递，不需要改接口。

### 3.5 统一事件格式（UnifiedAgentEvent）

当前 `AgentEvent` 已经是事实上的统一格式，所有 adapter 都输出同样的结构。正式规范化：

```typescript
// 统一事件基础结构
interface UnifiedAgentEventBase {
  /** 事件唯一 ID */
  eventId?: string;
  /** 排序序号，用于远程同步和回放 */
  sequence?: number;
  /** 事件产生时间 */
  createdAt?: string;
  /** 对话 ID */
  conversationId: string;
  /** Turn ID */
  turnId: string;
  /** 产生事件的 agent runtime */
  runtime?: string;
}

// 联合类型
type UnifiedAgentEvent =
  | TurnStartedEvent
  | RunStartedEvent
  | TextDeltaEvent
  | TextCompletedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ApprovalRequiredEvent
  | UsageUpdatedEvent
  | ContextUpdatedEvent
  | RunCompletedEvent
  | RunFailedEvent;
```

**ACP 到统一事件的声明式映射表：**

| ACP session/update kind | UnifiedAgentEvent type | 映射规则 |
| --- | --- | --- |
| `agent_message_chunk` | `agent.text.delta` | `delta = content.text` |
| `agent_thought_chunk` | `agent.reasoning.delta` | `delta = content.text` |
| `tool_call` | `agent.tool.started` | `toolCallId, name=title\|kind, arguments=rawInput, risk=mapRisk(kind)` |
| `tool_call_update(status=completed)` | `agent.tool.completed` | `toolCallId, result=rawOutput\|content` |
| `tool_call_update(status=failed)` | `agent.tool.failed` | `toolCallId, error=rawOutput` |
| `usage_update` | `agent.usage.updated` | `contextUsedTokens=used, contextWindowTokens=size` |
| `config_option_update` | (内部处理，不推送前端) | 更新 session 缓存 |
| `session/request_permission` | `approval.required` | 映射 tool_call + options |
| prompt result `stopReason=end_turn` | `agent.run.completed` | 附带 usage |
| prompt result `stopReason=cancelled` | `agent.run.failed` | `error="用户取消"` |
| prompt result `stopReason=max_tokens` | `agent.run.failed` | `error="达到输出限制"` |
| prompt result `stopReason=refusal` | `agent.run.failed` | `error="runtime 拒绝"` |

**实现方式：** 声明式映射表，不使用 if-else 链。

```python
# 伪代码示意
ACP_EVENT_MAP = {
    "agent_message_chunk": lambda update, ctx: {
        "type": "agent.text.delta",
        "delta": text_from_content(update.content),
    },
    "agent_thought_chunk": lambda update, ctx: {
        "type": "agent.reasoning.delta",
        "delta": text_from_content(update.content),
    },
    "tool_call": lambda update, ctx: {
        "type": "agent.tool.started",
        "toolCallId": update.tool_call_id or generate_id(),
        "name": update.title or update.kind or "tool",
        "arguments": to_jsonable(update.raw_input),
        "risk": risk_level(update.kind),
    },
    # ...
}

class AcpEventMapper:
    def map(self, acp_update, context):
        kind = getattr(acp_update, "session_update", "unknown")
        handler = ACP_EVENT_MAP.get(kind)
        if handler:
            return handler(acp_update, context)
        return None  # 未知事件，记录到 raw diagnostic
```

### 3.6 ACP 数据直通，不做冗余转译

**当前冗余路径：**

```text
ACP server (JSON-RPC)
  → ACP Python SDK 解析为 Python schema 对象 (acp.schema.*)
    → CodexAcpClient.session_update() 手动逐字段翻译为 dict
      → AgentEvent dict
        → NDJSON 编码
          → 前端解析 NDJSON
            → 前端 AgentEvent 类型
```

**优化后的直通路径：**

```text
ACP server (JSON-RPC)
  → ACP Python SDK 解析 (acp.schema.*)
    → AcpEventMapper 声明式映射 (映射表驱动，非手写逻辑)
      → UnifiedAgentEvent dict
        → NDJSON 编码
          → 前端 NDJSON 解析
            → 前端 UnifiedAgentEvent 类型
```

变化点：

1. **去掉手写映射逻辑**，改为声明式映射表 `ACP_EVENT_MAP`
2. **所有 agent 共用同一个 mapper**，差异通过 descriptor 和 runtime-specific caveat 处理
3. **ACP 原始数据可选保留** 在 `metadata.runtimeRaw`，用于调试

```python
# 优化后
class AcpEventMapper:
    """声明式 ACP → UnifiedAgentEvent 映射器。
    所有 ACP agent 共用，不需要为每个 runtime 写映射逻辑。"""

    def __init__(self, runtime_id: str):
        self.runtime_id = runtime_id
        self._text_buffers: dict[str, str] = {}

    def map_update(self, update: Any, context: EventContext) -> dict | None:
        kind = str(getattr(update, "session_update", "unknown"))
        handler = ACP_EVENT_MAP.get(kind)
        if not handler:
            return None

        event = handler(update, context)
        event["runtime"] = self.runtime_id
        return event

    def map_permission_request(
        self, tool_call: Any, options: list[Any], context: EventContext
    ) -> dict:
        """将 ACP session/request_permission 映射为 approval.required"""
        # 统一映射逻辑，不区分 codex / claude / opencode
        ...
```

## 4. 前端统一渲染方案

### 4.1 ChatComposer 按能力渲染

当前 ChatComposer 的核心问题：

```tsx
// 当前代码 —— 硬编码 Codex 特有逻辑
const isCodex = agent?.id === "codex";
<select disabled={!isCodex} ...>
  <option value="read-only">只读</option>
  <option value="agent">Agent</option>
  <option value="agent-full-access">完全访问</option>
</select>
```

**改为按 SessionCapabilities 渲染：**

```tsx
// 重构后 —— 由 capabilities 驱动
function ChatComposer({ capabilities, ... }: ChatComposerProps) {
  return (
    <div className="composer-wrap">
      {/* ... */}

      {/* 权限模式 —— 从 capabilities.modes 动态渲染 */}
      {capabilities.modes.length > 1 && (
        <select value={selectedMode} onChange={onModeChange}>
          {capabilities.modes.map(mode => (
            <option key={mode.id} value={mode.id}>{mode.label}</option>
          ))}
        </select>
      )}

      {/* 配置选项 —— 从 capabilities.configOptions 动态渲染 */}
      {capabilities.configOptions.map(option => (
        <ConfigOptionControl
          key={option.id}
          option={option}
          value={selectedConfig[option.id]}
          onChange={(value) => onConfigChange(option.id, value)}
        />
      ))}

      {/* 模型选择 —— 从 capabilities.models 动态渲染 */}
      {capabilities.models.length > 0 && (
        <ModelPicker
          models={capabilities.models}
          selected={selectedModel}
          onSelect={onModelChange}
        />
      )}
    </div>
  );
}
```

### 4.2 前端状态变化

```typescript
// 当前前端状态（散落在各处）
const [accessMode, setAccessMode] = useState("read-only");     // Codex 特有
const [reasoningEffort, setReasoningEffort] = useState("none"); // Codex 特有
const [selectedModelId, setSelectedModelId] = useState(null);   // 含义不统一
const [availableModels, setAvailableModels] = useState([]);      // 来源不统一

// 重构后前端状态（统一）
const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
const [selectedMode, setSelectedMode] = useState<string>("");
const [selectedModel, setSelectedModel] = useState<string>("");
const [selectedConfig, setSelectedConfig] = useState<Record<string, string | number | boolean>>({});
```

### 4.3 进入对话时的加载流程

```text
用户点击对话
  │
  ├── 1. POST /api/sessions/{conversationId}/initialize
  │     │
  │     └── 后端:
  │           ├── resolve agent for this conversation
  │           ├── spawn / reuse ACP connection
  │           ├── session/new or session/load
  │           └── return SessionCapabilities
  │
  ├── 2. 前端更新 capabilities state
  │     ├── modes → 渲染权限模式选择器
  │     ├── models → 渲染模型选择器
  │     └── configOptions → 渲染配置选项
  │
  ├── 3. 用户设置默认选中值
  │     ├── selectedMode = modes.find(m => m.isDefault)?.id
  │     ├── selectedModel = models.find(m => m.isCurrent)?.id
  │     └── selectedConfig = configOptions 的当前值
  │
  └── 4. 就绪，等待用户输入
```

## 5. 后端模块重设计

### 5.1 目录结构

```text
backend/code_lite_backend/
  ├── agents/
  │   ├── __init__.py
  │   ├── registry.py                 # AgentAdapter 注册表
  │   ├── protocol.py                 # AgentAdapter Protocol 定义
  │   │
  │   ├── acp/                        # 统一 ACP adapter（所有 ACP agent 共用）
  │   │   ├── __init__.py
  │   │   ├── adapter.py              # AcpAgentAdapter: 实现 AgentAdapter
  │   │   ├── client.py               # CodeLiteAcpClient: ACP SDK handler
  │   │   ├── mapper.py               # AcpEventMapper: 声明式映射表
  │   │   ├── session.py              # SessionManager: ACP session 生命周期
  │   │   ├── approvals.py            # ACP permission → approval 映射
  │   │   └── capabilities.py         # SessionCapabilities 构建
  │   │
  │   ├── runtimes/                   # Runtime descriptor 和注册
  │   │   ├── __init__.py
  │   │   ├── registry.py             # RuntimeRegistry
  │   │   ├── codex.py                # Codex descriptor + env + caveats
  │   │   ├── claude.py               # Claude descriptor + env + caveats
  │   │   └── opencode.py             # opencode descriptor + env + caveats
  │   │
  │   └── nanobot/                    # nanobot adapter（后续需要适配 ACP 或保留兼容层）
  │       ├── adapter.py
  │       ├── events.py
  │       └── hooks.py
  │
  ├── api/routes/
  │   ├── sessions.py                 # 新增：session 初始化、capabilities
  │   ├── turns.py                    # 重构：统一请求格式
  │   └── approvals.py
  │
  └── schemas/
      ├── agent.py                    # 重构：统一类型定义
      └── session.py                  # 新增：SessionCapabilities
```

**关键变化**：

1. 合并当前 `agents/codex/adapter.py` 和未来的 `agents/claude_code/adapter.py` 为统一的 `agents/acp/adapter.py`
2. 各 runtime 的差异（command、env、默认模式、caveats）提取为 descriptor，不再用独立 adapter 文件
3. `agents/nanobot/` 保留但标记为 legacy，后续要么适配 ACP，要么只作为兼容层

### 5.2 AgentAdapter Protocol 演进

```python
@dataclass(frozen=True)
class SessionCapabilities:
    """进入对话时加载的完整能力描述"""
    agent: AgentInfo
    modes: list[SessionMode]
    models: list[SessionModel]
    config_options: list[SessionConfigOption]

@dataclass(frozen=True)
class UnifiedTurnRequest:
    """统一的 turn 请求"""
    conversation_id: str
    turn_id: str
    prompt: str
    workspace: Path
    selected_model: str | None = None
    selected_mode: str | None = None
    selected_config: dict[str, Any] = field(default_factory=dict)

class AgentAdapter(Protocol):
    name: str
    capabilities: AgentAdapterCapabilities  # 保留用于 registry

    async def initialize_session(
        self, conversation_id: str, workspace: Path
    ) -> SessionCapabilities:
        """进入对话时调用，返回完整能力描述"""
        ...

    async def stream_turn(
        self, request: UnifiedTurnRequest
    ) -> AsyncIterator[AgentEvent]:
        """发送一轮对话"""
        ...

    async def cancel_turn(self, turn_id: str) -> bool:
        """取消当前 turn"""
        ...
```

### 5.3 Runtime Descriptor

每个 runtime 只需要定义自己的 descriptor，不需要写一个完整的 adapter 类：

```python
@dataclass(frozen=True)
class RuntimeDescriptor:
    """Runtime 描述符 —— 各 ACP agent 的唯一标识"""
    id: str                              # e.g. "codex", "claude_code", "opencode"
    label: str                           # e.g. "Codex", "Claude Code"
    adapter_kind: str                    # "acp" | "nanobot"
    command: list[str]                   # 启动命令
    env: dict[str, str]                  # 默认环境变量
    default_mode: str                    # 默认权限模式
    config_mode: str                     # "user-native" | "isolated"
    caveats: list[str]                   # 已知限制

    def build_env(self, runtime_config) -> dict[str, str]:
        """根据运行时配置构建完整环境变量"""
        ...

    def resolve_command(self, runtime_config) -> list[str]:
        """解析可执行命令"""
        ...
```

当前 `agent_runtime_config.py` 中大量的 codex-specific 逻辑（`codex_command()`, `codex_env()`, `codex_mode()`）应该提取为 descriptor 方法。

## 6. 代码分离策略

### 6.1 逻辑分离

```text
┌───────────────────────────────────────────────────────┐
│                    共享层 (shared)                     │
│                                                       │
│  AgentAdapter Protocol                                │
│  AgentEvent / UnifiedAgentEvent                       │
│  ApprovalBroker                                       │
│  AcpEventMapper (声明式映射表)                         │
│  RuntimeDescriptor base                               │
│                                                       │
├───────────────────────┬───────────────────────────────┤
│  ACP Adapter 层      │  nanobot Adapter 层           │
│                       │                               │
│  AcpAgentAdapter      │  NanobotAgentAdapter          │
│  (所有 ACP agent 共用) │  (后续需要适配或保留)          │
│                       │                               │
│  CodeLiteAcpClient    │  UiApprovalHook               │
│  SessionManager       │  map_nanobot_event            │
│  AcpEventMapper       │                               │
│                       │                               │
├───────────────────────┴───────────────────────────────┤
│                   Runtime 层                          │
│                                                       │
│  RuntimeDescriptor                                    │
│  ├── codex.py   → command, env, defaults, caveats     │
│  ├── claude.py  → command, env, defaults, caveats     │
│  └── opencode.py → command, env, defaults, caveats    │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### 6.2 当前代码的合并路径

**当前 `agents/codex/adapter.py`（585 行）的拆分：**

| 代码段 | 行数 | 去向 |
| --- | --- | --- |
| `_to_jsonable()`, `_text_from_content()`, `_format_json()` 等工具函数 | ~50 | `acp/mapper.py` 或 `acp/utils.py` |
| `_permission_option_*()`, `_choose_permission_option()` | ~30 | `acp/approvals.py` |
| `_usage_event_payload()`, `_models_payload()` | ~30 | `acp/capabilities.py` |
| `CodexAcpClient` 类 | ~180 | `acp/client.py` → 改名为 `CodeLiteAcpClient`，去掉 Codex 特有命名 |
| `CodexAgentAdapter` 类 | ~250 | `acp/adapter.py` → 改名为 `AcpAgentAdapter`，接受 runtime descriptor |
| `_configure_session()` | ~25 | `acp/adapter.py`，通用化 |

**各 runtime 特有逻辑提取到 descriptor：**

```python
# runtimes/codex.py
CODEX_DESCRIPTOR = RuntimeDescriptor(
    id="codex",
    label="Codex",
    adapter_kind="acp",
    default_command=["codex-acp"],
    default_mode="read-only",
    config_mode="user-native",
    env_defaults={"NO_BROWSER": "1"},
    env_hooks={
        "INITIAL_AGENT_MODE": lambda config: config.get("mode", "read-only"),
        "APP_SERVER_LOGS": lambda config: str(config.logs_dir / "codex-acp"),
        "CODEX_HOME": lambda config: config.isolated_codex_home() if config.isolated else None,
        "CODEX_PATH": lambda config: config.get("codexPath"),
    },
    caveats=[
        "compat mode 不能保证所有危险动作经由 gateway",
        "usage_update 是 best effort",
    ],
)
```

### 6.3 代码量预估

| 模块 | 当前代码量 | 重构后预估 | 变化 |
| --- | --- | --- | --- |
| `agents/codex/adapter.py` | ~585 行 | 删除，拆分为 acp/ | -585 |
| `agents/claude_code/adapter.py` | ~8 行 | 删除，descriptor 即可 | -8 |
| `agents/acp/adapter.py` | 新增 | ~250 行 | 通用 ACP adapter |
| `agents/acp/client.py` | 新增 | ~150 行 | 通用 ACP client |
| `agents/acp/mapper.py` | 新增 | ~120 行 | 声明式映射表 |
| `agents/acp/capabilities.py` | 新增 | ~80 行 | SessionCapabilities 构建 |
| `agents/acp/approvals.py` | 新增 | ~60 行 | 审批映射 |
| `agents/acp/session.py` | 新增 | ~100 行 | session 生命周期管理 |
| `agents/runtimes/codex.py` | 新增 | ~60 行 | descriptor |
| `agents/runtimes/claude.py` | 新增 | ~50 行 | descriptor |
| `agents/runtimes/opencode.py` | 新增 | ~50 行 | descriptor |
| `api/routes/sessions.py` | 新增 | ~60 行 | session 初始化接口 |
| `api/routes/turns.py` | ~178 行 | ~80 行 | 简化，去掉 if-else 分支 |
| `schemas/session.py` | 新增 | ~60 行 | 统一类型定义 |
| `agent_runtime_config.py` | ~525 行 | ~300 行 | 提取 runtime-specific 逻辑 |

**总计**：当前 ~1300 行散落代码 → 重构后 ~1400 行结构化代码。代码量基本持平，但结构清晰、扩展容易。

## 7. nanobot 的定位与迁移路径

### 7.1 当前定位

nanobot 是 code-lite 的原生 LLM agent 框架，直接通过 Python SDK 调用 LLM API。它不支持 ACP 协议。

### 7.2 迁移策略

**短期（MVP）**：保留 nanobot adapter 作为兼容层，但不增加新功能。

```text
AgentRouterAdapter
  ├── AcpAgentAdapter (codex / claude / opencode)
  └── NanobotAgentAdapter (兼容层，输出 AgentEvent)
```

**中期**：如果 nanobot 需要继续接入，有两种路线：

| 路线 | 描述 | 工作量 |
| --- | --- | --- |
| A. nanobot 包装为 ACP server | 为 nanobot 写一个 ACP server wrapper，把 nanobot 的 tool call、text streaming 映射为 ACP 事件 | 中等 |
| B. nanobot 保持独立 adapter | nanobot 继续使用原生 SDK，但输出统一的 `UnifiedAgentEvent`；`initialize_session()` 返回从 nanobot config 构建的 `SessionCapabilities` | 较小 |

**推荐路线 B**：nanobot 保持独立 adapter 但适配统一接口。理由：

1. nanobot 不是 coding agent，不需要 ACP 的 fs/terminal gateway
2. nanobot 的 session 模型和 ACP 不同
3. 只要输出统一的 `UnifiedAgentEvent` + `SessionCapabilities`，前端就能无差别渲染

### 7.3 nanobot 的 SessionCapabilities 构建

```python
# nanobot adapter 也需要实现 initialize_session
class NanobotAgentAdapter:
    async def initialize_session(self, conversation_id, workspace):
        config = self._load_nanobot_config()
        models = self._extract_models(config)  # 从 nanobot config 提取可用模型
        return SessionCapabilities(
            agent=AgentInfo(id="nanobot", label="nanobot", adapter_kind="nanobot"),
            modes=[
                SessionMode(id="workspace", label="工作区模式", is_default=True),
            ],
            models=[
                SessionModel(id=m.id, label=m.label, is_current=m.is_default)
                for m in models
            ],
            config_options=[],  # nanobot 暂不支持 ACP-style configOptions
        )
```

## 8. 实施阶段

### 阶段 1：抽取通用 ACP adapter（1-2 天）

1. 将 `agents/codex/adapter.py` 拆分为 `agents/acp/` 目录
2. `CodexAcpClient` → `CodeLiteAcpClient`，去掉 Codex 命名
3. `CodexAgentAdapter` → `AcpAgentAdapter`，接受 `RuntimeDescriptor` 参数
4. 抽取声明式映射表 `ACP_EVENT_MAP`
5. 为 Codex 创建 `RuntimeDescriptor`
6. 验证：Codex 功能不受影响

### 阶段 2：统一前端协议（1-2 天）

1. 新增 `POST /api/sessions/{id}/initialize` 接口
2. 实现 `SessionCapabilities` 从 ACP `session/new` 结果构建
3. 前端 `ChatPage` 改为进入对话时调用 initialize
4. 前端 `ChatComposer` 改为按 capabilities 动态渲染
5. 去掉所有 `agent.id === "codex"` 分支判断
6. 验证：Codex 的权限/思考强度/模型选择正常工作

### 阶段 3：统一 turn 请求格式（0.5 天）

1. 重构 `/api/turns/stream` 请求体为 `UnifiedTurnRequest`
2. `selectedMode` 替代 `accessMode`
3. `selectedConfig` 替代独立的 `reasoningEffort`
4. 后端 `turns.py` 去掉 `if agent_id == "codex"` 分支
5. 前端 `agentClient.ts` 适配新请求格式
6. 验证：Codex 对话正常进行

### 阶段 4：接入 Claude Code ACP（1-2 天）

1. 为 Claude Code 创建 `RuntimeDescriptor`
2. 用 `AcpAgentAdapter` + Claude descriptor 进行 smoke test
3. 验证 `session/new` 返回的 modes/models/configOptions 正确构建 SessionCapabilities
4. 验证 text/tool/approval 事件正确映射
5. 前端自动渲染 Claude 的选项（无需写特殊逻辑）

### 阶段 5：接入 opencode ACP（1 天）

1. 为 opencode 创建 `RuntimeDescriptor`
2. 验证 opencode acp 的 ACP 兼容性
3. 前端自动渲染

### 阶段 6：nanobot 适配统一接口（1 天）

1. 为 `NanobotAgentAdapter` 实现 `initialize_session()`
2. 从 nanobot config 构建 `SessionCapabilities`
3. 验证前端无差别渲染 nanobot 对话

### 阶段 7：清理与文档（0.5 天）

1. 删除旧的 `agents/codex/adapter.py`
2. 删除旧的 `agents/claude_code/adapter.py` placeholder
3. 更新 API 文档
4. 更新前端类型定义

## 9. 风险与决策

| 风险 | 决策 | 缓解 |
| --- | --- | --- |
| ACP `session/new` 不一定返回完整 configOptions | 各 descriptor 提供 fallback 默认值 | descriptor 定义 `default_modes`, `default_config_options` |
| 不同 runtime 的 mode 语义不完全相同 | descriptor 注明 caveats | UI 展示 runtime-specific 提示 |
| nanobot 无法提供 ACP-style modes | 返回单元素 modes 列表 | 前端不渲染模式选择器 |
| 前端改造影响面 | 分阶段实施 | 阶段 1-2 只改内部结构，不改前端交互 |
| ACP 协议升级 | descriptor 标注 protocol version | 跟踪 ACP changelog |

## 10. 核心结论

1. **ACP 已经提供了统一格式**。`session/new` 返回的 modes、models、configOptions 就是前端交互所需的全部元数据。当前的问题是 code-lite 没有利用这些标准化数据，而是在前端硬编码了 Codex 特有的选项。

2. **进入对话时加载是正确的设计**。用户点进对话就应该完成 agent 初始化和能力发现。这比在发送消息时才获取模型列表更合理，也避免了 UI 延迟。

3. **每 turn 携带选项比散落在各处更清晰**。`selectedModel`、`selectedMode`、`selectedConfig` 三个字段覆盖所有交互需求，不需要为每个 agent 特有的参数增加独立字段。

4. **声明式映射表代替手写翻译**。ACP 事件通过 `ACP_EVENT_MAP` 直达前端事件格式，不需要为每个 runtime 写独立的映射逻辑。

5. **ACP adapter 统一，runtime 差异通过 descriptor 隔离**。所有 ACP agent 共用 `AcpAgentAdapter`，差异只在 descriptor（command、env、defaults、caveats）。

6. **nanobot 后续接入需要适配统一接口**。要么包装为 ACP server（工作量大），要么直接实现 `SessionCapabilities` + `UnifiedAgentEvent` 接口（推荐）。

7. **前端零分支**。所有 UI 控件由 `SessionCapabilities` 驱动渲染。新增 agent 不需要改前端代码。

## 11. 参考

1. `docs/ACP_ADAPTER_DESIGN.md` — ACP 协议调研
2. `docs/ACP_AGENT_ADAPTER_IMPLEMENTATION_DESIGN.md` — 当前 ACP 实现设计
3. `docs/AGENT_ADAPTER_REDESIGN.md` — 多 adapter 重设计
4. `docs/AGENT_SDK_CAPABILITY_RESEARCH.md` — SDK 能力矩阵
5. ACP protocol v1: https://agentclientprotocol.com/protocol/v1/
6. ACP session config options: https://agentclientprotocol.com/protocol/v1/session-config-options.md
