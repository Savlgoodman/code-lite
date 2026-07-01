# 多 Agent Adapter 重设计与 Codex SDK 探针结论

本文设计 code-lite 的多 Agent 接入适配层，并记录 `openai-codex` Python SDK 的本地探针结论。目标是让 Codex、Claude Code、opencode、nanobot 等 Agent Runtime 可以通过统一协议接入 UI、权限策略、模型配置、远程同步和审计系统。

更新入口：Codex、Claude Code、nanobot 三个 Python SDK 的横向能力矩阵和统一 adapter 方案见 `docs/AGENT_SDK_CAPABILITY_RESEARCH.md`。

## 1. 背景

当前 backend 已有统一入口：

```text
backend/pc_agent_backend/agents/
  registry.py
  nanobot/
  codex/
  claude_code/
```

当前 `AgentAdapterCapabilities` 只包含：

```python
streaming: bool
tool_registration: bool
tool_approval: bool
session_state: bool
notes: list[str]
```

这对单一 nanobot 原型够用，但不够描述 Codex、Claude Code、opencode 这类更完整的 coding agent。后续需要表达：

1. 支持哪些权限级别。
2. 是否支持本地 sandbox。
3. 是否支持用户审批、自动审批、完全允许。
4. 是否支持自定义 Tool 注册。
5. 是否支持 MCP。
6. 是否支持模型配置和 per-turn 模型覆盖。
7. 流式事件的粒度。
8. 是否能观察命令执行、文件修改、工具调用、token usage。

## 2. Codex Python SDK 探针结论

本地环境可发现：

```text
openai-codex 0.1.0b2
openai-codex-cli-bin 0.132.0
```

默认 Python 环境中存在 `openai_codex` 包。`demo/pyproject.toml` 已加入：

```toml
"openai-codex>=0.1.0b2"
```

新增探针：

```powershell
cd .\demo
New-Item -ItemType Directory -Force .\.uv-cache | Out-Null
$env:UV_CACHE_DIR=(Resolve-Path .\.uv-cache).Path
uv sync
uv run python .\codex_adapter_probe.py
```

默认命令只做 SDK 反射，不启动 Codex runtime，不调用模型，不执行命令。

如要显式启动一次只读 smoke run：

```powershell
uv run python .\codex_adapter_probe.py --smoke --permission-mode readonly
```

本次公开 Codex 文档页面和 manual helper 在本机访问返回 HTTP 403，因此本文对 Codex 细节的依据限定为：

1. 本地安装的 `openai-codex 0.1.0b2` API 反射。
2. 本地安装包源码中的公开枚举和 JSON-RPC 类型。
3. `codex_adapter_probe.py --smoke` 的实际运行结果。

### 2.1 已确认能力

`openai-codex 0.1.0b2` 暴露：

1. `Codex` / `AsyncCodex` 高层客户端。
2. `CodexClient` / `AsyncCodexClient` JSON-RPC 客户端。
3. `thread_start(...)` 创建线程。
4. `Thread.turn(...)` 启动 turn。
5. `TurnHandle.stream()` 流式读取 turn notification。
6. `TurnHandle.interrupt()` 中断 turn。
7. `thread_start(..., model=..., model_provider=...)` 设置模型。
8. `Thread.turn(..., model=...)` per-turn 模型覆盖。
9. `Sandbox.read_only`、`Sandbox.workspace_write`、`Sandbox.full_access`。
10. `ApprovalMode.deny_all`、`ApprovalMode.auto_review`。
11. `CodexClient(approval_handler=...)` 可拦截 runtime 发起的审批请求。
12. 事件类型包含文本增量、命令输出、文件修改、MCP 工具进度、auto approval review、token usage、turn completed 等。
13. `Codex.models()` / `CodexClient.model_list()` 可列出 Codex runtime 看到的模型。
14. `Thread.turn(..., effort=..., summary=...)` 支持 reasoning effort 和 reasoning summary 覆盖。

### 2.2 权限能力差异

Codex SDK 高层权限模型不是 `[readonly, fullaccess, ask, auto]` 一组扁平枚举，而是两类概念：

| 概念 | SDK 枚举 | 含义 |
| --- | --- | --- |
| Sandbox | `read_only` / `workspace_write` / `full_access` | 文件系统访问范围 |
| ApprovalMode | `deny_all` / `auto_review` | 对升级权限请求的处理方式 |

SDK 内部协议还存在更细粒度字段：

```text
AskForApprovalValue:
  untrusted
  on-failure
  on-request
  never

ApprovalsReviewer:
  user
  auto_review
  guardian_subagent
```

当前本地包中还可见：

```text
ReasoningEffort:
  none
  minimal
  low
  medium
  high
  xhigh

ReasoningSummary:
  auto
  concise
  detailed
```

但 `openai-codex 0.1.0b2` 的公开高层 `ApprovalMode` 只暴露：

1. `deny_all`
2. `auto_review`

低层 `CodexClient` 支持 `approval_handler(method, params)`，可收到：

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
```

这意味着：

1. 高层 API 没有直接暴露“每次都问 UI”的 `ask` 模式。
2. 低层 JSON-RPC 客户端可以接入我们自己的审批 handler。
3. adapter 可以把 Codex runtime 主动发起的审批请求转成 `approval.required` 事件。
4. 该 handler 不是所有命令和所有文件修改的稳定前置闸门，只能覆盖 Codex runtime 判定需要审批的动作。
5. code-lite 不能把 Codex `approval_handler` 当成产品级完整权限边界。

### 2.2.1 Smoke 结果

本地执行过三类 smoke：

| 场景 | 结果 | 对 adapter 的含义 |
| --- | --- | --- |
| `readonly` + `pwd` | Codex 执行了只读 shell 命令，并输出当前目录；未触发 `approval_handler` | `readonly` 表示文件系统只读，不表示完全禁用 shell |
| `readonly` + 创建文件 | 命令事件出现，但状态为 `declined`，输出 `blocked by policy`；文件未创建 | Codex read-only sandbox 能阻止工作区写入 |
| `ask` 映射为 `workspace-write` + `on-request/user` + 创建文件 | 文件被创建，`approval_handler` 未收到请求 | `ask` 不能仅靠 Codex 原生 approval 实现“所有写入先问用户” |

因此 Codex 接入 code-lite 时必须收紧语义：

1. `readonly` 可作为默认评估模式，但仍要接受它可能运行只读命令。
2. `ask` 只能表示“Codex 原生升级审批请求转给 UI”，不能承诺工作区内每次写入都审批。
3. 涉及仓库外路径、系统目录、权限提升、安装器、远程发布、密钥读取等动作时，不应仅依赖 Codex 原生 shell/file edit 的审批语义。
4. code-lite 自己的高风险动作应通过产品层 PendingAction、审批记录和后续本地执行网关处理。

### 2.3 Tool 注册能力

本地 SDK 反射没有发现类似 nanobot `Tool` 子类或 Python callback function tools 的公开注册 API。

Codex 协议中存在：

1. MCP server 配置和 MCP tool call 事件。
2. dynamic tool call 类型。
3. app tool 配置。
4. skill input。

但在 `openai-codex 0.1.0b2` 的 Python 高层 API 中，未发现“传入 Python 函数并注册成工具”的稳定接口。

因此建议：

1. Codex adapter 的 `toolRegistration` 标记为 `mcp` 或 `external`，不要标为 `python_direct`。
2. code-lite 的一方工具优先走产品 backend、MCP 或后续执行网关。
3. 如需让 Codex 调用一方工具，优先通过 MCP server 或 Codex 配置接入，而不是 Python SDK 直接注册。

## 3. 统一 Adapter 能力模型

建议把 `AgentAdapterCapabilities` 升级为可序列化的结构：

```python
@dataclass(frozen=True)
class AgentAdapterDescriptor:
    id: str
    label: str
    vendor: str
    runtime_kind: Literal["sdk", "cli", "http", "sidecar"]
    version: str | None
    status: Literal["available", "missing_dependency", "not_configured", "experimental"]
    capabilities: AgentAdapterCapabilities
    defaults: AgentAdapterDefaults
    notes: list[str]
```

能力模型：

```python
@dataclass(frozen=True)
class AgentAdapterCapabilities:
    streaming: StreamingCapability
    permissions: PermissionCapabilities
    models: ModelCapabilities
    tools: ToolCapabilities
    sessions: SessionCapabilities
    events: EventCapabilities
```

### 3.1 StreamingCapability

```python
@dataclass(frozen=True)
class StreamingCapability:
    text_delta: bool
    reasoning_delta: bool
    tool_events: bool
    command_output_delta: bool
    file_change_delta: bool
    token_usage: bool
    final_result: bool
```

### 3.2 PermissionCapabilities

产品级权限模式统一为：

```python
PermissionMode = Literal["readonly", "ask", "auto", "fullaccess"]
```

含义：

| 模式 | 产品语义 |
| --- | --- |
| `readonly` | 只读，不允许写入、执行修改或网络副作用 |
| `ask` | 中高风险动作进入用户审批 |
| `auto` | 低中风险自动允许，高风险审批或 adapter 原生自动审查 |
| `fullaccess` | 尽量不中断，但 blocked 仍拒绝，产品层仍记录审计并保留硬阻断 |

能力结构：

```python
@dataclass(frozen=True)
class PermissionCapabilities:
    supported_modes: list[PermissionMode]
    default_mode: PermissionMode
    supports_per_turn_override: bool
    supports_user_approval_callback: bool
    supports_auto_review: bool
    supports_sandbox: bool
    sandbox_levels: list[str]
    hard_block_supported: bool
```

adapter 需要声明“产品模式到 runtime 模式”的映射，而不是让 UI 理解各 SDK 细节。

### 3.3 ModelCapabilities

```python
@dataclass(frozen=True)
class ModelCapabilities:
    supports_model_list: bool
    supports_model_provider_list: bool
    supports_thread_model_override: bool
    supports_turn_model_override: bool
    uses_product_model_config: bool
    model_id_kind: Literal["product_model_id", "runtime_model", "preset"]
```

含义：

1. nanobot 使用产品配置同步出的 `modelPresetId`。
2. Codex 可使用 runtime model 字符串，并可列出 Codex runtime 模型。
3. Claude Code 可能主要依赖 CLI 自身配置，产品配置只做选择和展示。

### 3.4 ToolCapabilities

```python
@dataclass(frozen=True)
class ToolCapabilities:
    builtin_tools: list[str]
    supports_python_tool_registration: bool
    supports_mcp: bool
    supports_dynamic_tools: bool
    supports_tool_approval: bool
    tool_call_event_granularity: Literal["none", "name_only", "arguments", "arguments_and_result"]
```

建议区分：

1. `python_direct`：像 nanobot entry point 或 Python Tool 子类。
2. `mcp`：通过 MCP server 暴露。
3. `runtime_builtin`：Codex/Claude Code 自带 shell、file edit、search 等。
4. `gateway_action`：code-lite 自己的结构化动作或后续本地执行网关。

### 3.5 SessionCapabilities

```python
@dataclass(frozen=True)
class SessionCapabilities:
    supports_resume: bool
    supports_fork: bool
    supports_compact: bool
    supports_persistent_threads: bool
    product_conversation_id_maps_to_runtime_session: bool
```

### 3.6 EventCapabilities

```python
@dataclass(frozen=True)
class EventCapabilities:
    emits_text_delta: bool
    emits_reasoning: bool
    emits_plan: bool
    emits_tool_started: bool
    emits_tool_completed: bool
    emits_command_started: bool
    emits_command_output: bool
    emits_file_change: bool
    emits_approval_review: bool
    emits_usage: bool
```

## 4. Adapter 对比矩阵

| 能力 | nanobot | Codex SDK | Claude Code | opencode |
| --- | --- | --- | --- | --- |
| 文本流 | 支持 `text.delta` | 支持 agent message delta | 待验证 | 待验证 |
| Reasoning 流 | 支持 | 协议有 reasoning 事件 | 待验证 | 待验证 |
| 工具事件 | 支持 tool started/completed/failed | 支持 command/file/MCP/dynamic events | 待验证 | 待验证 |
| 用户审批 | 自定义 hook 支持，可在工具执行前等待 UI | 仅支持 runtime 发起的审批请求；不能覆盖所有工作区写入 | 待验证 | 待验证 |
| 自动审批 | 产品层实现 | SDK `auto_review` | 待验证 | 待验证 |
| 只读模式 | 产品层约束 + 工具配置 | SDK `Sandbox.read_only`，可运行只读 shell，阻止写入 | 待验证 | 待验证 |
| 完全允许 | 产品层实现，但仍需审计和 blocked 硬阻断 | SDK `Sandbox.full_access` + auto review | 待验证 | 待验证 |
| Python Tool 注册 | 支持 entry point | 未发现直接支持 | 待验证 | 待验证 |
| MCP | nanobot 支持 MCP 配置 | 协议支持 MCP | Claude Code 通常支持 MCP，待本地验证 | 待验证 |
| 模型列表 | 来自产品配置或 provider | SDK `model_list()` | 待验证 | 待验证 |
| per-turn 模型 | nanobot `model_preset` | `Thread.turn(model=...)` | 待验证 | 待验证 |
| 思考强度 | 取决于模型 preset/provider 配置 | `Thread.turn(effort=...)` 支持 `none/minimal/low/medium/high/xhigh` | 待验证 | 待验证 |
| 取消 | `RunStream.cancel()` | `TurnHandle.interrupt()` | 待验证 | 待验证 |

## 5. 产品模式到 Codex 映射

建议初版映射：

| 产品模式 | Codex sandbox | Codex approval | 审批 handler |
| --- | --- | --- | --- |
| `readonly` | `read_only` | `deny_all` | 升级审批请求返回 deny；仍允许只读命令 |
| `ask` | `workspace_write` | 低层 `on-request/user` | 只把 runtime 主动发起的审批请求转成 UI `approval.required` |
| `auto` | `workspace_write` | `auto_review` | 记录 auto review 事件，必要时仍可 deny blocked |
| `fullaccess` | `full_access` | `auto_review` | blocked 仍 deny，产品层仍记录审计 |

需要注意：

1. `openai-codex 0.1.0b2` 高层 `ApprovalMode` 没有 `ask`，所以 `ask` 只能基于低层 `CodexClient` 的协议字段尝试实现。
2. smoke 已验证 `ask` 不能保证拦截工作区内写入，所以 UI 不能把它展示成“所有操作都会问我”。
3. `fullaccess` 不是绕过 code-lite blocked 策略。
4. Codex runtime 自带命令执行能力，若用于仓库外路径、系统目录、发布上传或密钥相关任务，必须通过 sandbox 限制、事件观察和产品层策略约束。
5. 初版 Codex adapter 建议只开放 `readonly` 和受控工作区用途；高风险动作继续走产品 PendingAction、MCP 工具或后续本地执行网关。

## 6. 统一 AgentEvent 映射

建议保留当前 UI 事件命名，并扩展命令和文件事件：

```text
agent.run.started
agent.text.delta
agent.reasoning.delta
agent.plan.delta
agent.tool.started
agent.tool.completed
agent.tool.failed
agent.command.started
agent.command.output.delta
agent.command.completed
agent.file_change.started
agent.file_change.delta
agent.file_change.completed
approval.required
approval.auto_review.started
approval.auto_review.completed
approval.auto_decided
agent.usage.updated
agent.run.completed
agent.run.failed
```

Codex 映射示例：

| Codex notification | 产品事件 |
| --- | --- |
| `item/agentMessage/delta` | `agent.text.delta` |
| `item/reasoningText/delta` | `agent.reasoning.delta` |
| `item/plan/delta` | `agent.plan.delta` |
| `item/commandExecution/outputDelta` | `agent.command.output.delta` |
| `item/fileChange/outputDelta` | `agent.file_change.delta` |
| `item/mcpToolCall/progress` | `agent.tool.started/completed` |
| `item/autoApprovalReview/started` | `approval.auto_review.started` |
| `item/autoApprovalReview/completed` | `approval.auto_review.completed` |
| `thread/tokenUsage/updated` | `agent.usage.updated` |
| `turn/completed` | `agent.run.completed` |

## 7. Adapter 接口建议

当前接口：

```python
class AgentAdapter(Protocol):
    name: str
    capabilities: AgentAdapterCapabilities
    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]: ...
    async def cancel_turn(self, turn_id: str) -> bool: ...
```

建议演进为：

```python
class AgentAdapter(Protocol):
    descriptor: AgentAdapterDescriptor

    async def list_models(self) -> list[RuntimeModel]: ...

    async def start_turn(self, request: AgentRunRequest) -> AgentTurnHandle: ...

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]: ...

    async def cancel_turn(self, turn_id: str) -> bool: ...

    async def decide_approval(self, approval_id: str, decision: ApprovalDecision) -> bool: ...
```

`stream_turn(...)` 可以继续作为 MVP 便利接口，内部调用 `start_turn(...)`。

### 7.1 AgentRunRequest 扩展

```python
@dataclass(frozen=True)
class AgentRunRequest:
    conversation_id: str
    turn_id: str
    prompt: str
    workspace: Path
    adapter_id: str
    model_id: str | None = None
    runtime_model: str | None = None
    model_preset_id: str | None = None
    permission_mode: PermissionMode = "ask"
    sandbox: str | None = None
    reasoning_effort: str | None = None
    reasoning_budget: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

规则：

1. `model_id` 是产品级模型 ID。
2. `runtime_model` 是 Codex/Claude Code 这类 runtime 原生模型名。
3. `model_preset_id` 是 nanobot 派生配置。
4. `permission_mode` 是产品统一权限模式。
5. adapter 自己负责映射到 SDK 原生命名。
6. `reasoning_effort` 用于 Codex 这类支持离散思考强度的 runtime。
7. `reasoning_budget` 预留给未来只支持 token/时间预算式思考控制的 runtime；Codex Python SDK 当前本地版本没有发现该字段。

### 7.2 AdapterDescriptor API

新增 backend API：

```text
GET /api/agents/adapters
GET /api/agents/adapters/{adapterId}
GET /api/agents/adapters/{adapterId}/models
```

UI 用这些接口决定：

1. 当前可选 Agent。
2. 每个 Agent 支持哪些权限模式。
3. 是否能选模型。
4. 是否能启用工具注册。
5. 是否展示“实验性”标签。

## 8. 配置设计

产品级配置建议新增：

```json
{
  "agentSettings": {
    "defaultAdapterId": "codex",
    "adapters": {
      "codex": {
        "enabled": true,
        "defaultPermissionMode": "readonly",
        "defaultSandbox": "read-only",
        "defaultRuntimeModel": null,
        "experimental": true
      },
      "claude_code": {
        "enabled": false,
        "defaultPermissionMode": "readonly",
        "experimental": true
      },
      "opencode": {
        "enabled": false,
        "defaultPermissionMode": "readonly",
        "experimental": true
      },
      "nanobot": {
        "enabled": false,
        "defaultPermissionMode": "ask",
        "defaultModelId": "model_deepseek_deepseek_v4_flash"
      }
    }
  }
}
```

不要把不同 runtime 的私有配置强行塞进 nanobot config。`nanobot_config.json` 只给 nanobot 使用；Codex 使用 Codex 自己配置、CLI runtime 或 SDK 参数；Claude Code 和 opencode 同理。

## 9. 推荐落地顺序

### 阶段 1：Adapter 描述能力

1. 扩展 `AgentAdapterCapabilities`。
2. 为 codex、claude_code、opencode、nanobot 提供 descriptor。
3. 新增 `/api/agents/adapters`。
4. UI 先只读展示，不切换真实 runtime。

### 阶段 2：权限模式统一

1. 引入产品级 `PermissionMode = readonly | ask | auto | fullaccess`。
2. nanobot 接入 `ToolPermissionPolicy`。
3. Codex adapter 做产品模式到 sandbox/approval 的映射。
4. 审计日志记录 adapter、runtime mode、产品 mode。

### 阶段 3：Codex adapter 原型

1. 使用 `CodexClient` 低层 API，而不是只用高层 `Codex`。
2. 将 `approval_handler` 接到 `ApprovalBroker`，但只声明其覆盖 runtime 主动审批请求。
3. 将 Codex notification 映射为统一 `AgentEvent`。
4. 支持 `TurnHandle.interrupt()`。
5. 默认 `readonly`，并标记为实验性。
6. 禁止把 Codex `workspace-write ask` 展示成完整用户审批模式。

### 阶段 4：Tool / MCP 策略

1. nanobot 继续支持 Python Tool entry point。
2. Codex 一方工具通过 MCP 接入。
3. code-lite 一方高风险动作统一走 PendingAction、审批记录和后续本地执行网关。
4. UI 不直接承诺“所有 Agent 都支持同一种 Tool 注册”。

### 阶段 5：Claude Code 调研与接入

1. 验证 Claude Code 是否有 SDK 或只适合 CLI wrapper。
2. 验证流式事件、审批、MCP、模型选择。
3. 按同一 descriptor 模型补齐矩阵。

### 阶段 6：opencode 调研与接入

1. 验证 opencode 的 CLI、server、配置文件和事件输出方式。
2. 验证模型 provider、MCP、工具调用、文件变更和取消机制。
3. 按同一 descriptor 模型补齐矩阵。
4. 明确 opencode 是使用 runtime 原生模型配置，还是接入 code-lite 统一模型配置。

### 阶段 7：远程同步适配

1. 将 adapter 输出统一写入有序 `AgentEvent`。
2. 本地 UI 和远程观看都订阅同一事件流。
3. 远端默认只读，远端控制和审批必须显式授权。
4. 审计日志记录远端连接、断开和决策行为。

## 10. 当前建议

短期不要把 adapter 抽象设计成“所有 agent 都像 nanobot 一样注册 Python Tool”。

更稳的抽象是：

```text
Agent Adapter = 对话、流式、模型、权限、事件映射
Tool Extension = Python direct / MCP / runtime builtin / Gateway action
Product Policy = code-lite 的权限模式、审计、远程授权和高风险动作边界
```

这样 Codex、Claude Code、opencode、nanobot 可以各自保留原生能力，同时 UI、远程同步和安全策略仍有统一入口。

当前对 Codex 的产品建议：

1. Codex 适合作为代码仓库、脚本、配置和文档类任务的可选 runtime。
2. Codex 不应被包装成覆盖所有系统动作的强审批执行器。
3. Codex 默认权限应为 `readonly`，并在 UI 标记“实验性”。
4. 如果开放 `ask`，文案应是“越界动作可能请求确认”，不是“每次写入都会确认”。
5. 一方工具优先选 MCP、产品 backend 或 runtime 原生扩展；高风险动作统一走 PendingAction 和产品层审计。
