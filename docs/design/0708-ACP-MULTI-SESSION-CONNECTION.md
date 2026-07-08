# ACP 多 Session 连接管理设计

设计日期：2026-07-08

本文记录 code-lite 从“每个 conversation 独立 ACP 连接”迁移到“同一 runtime connection 承载多个 native session”的方案。它是 `docs/design/0704-ACP-RUNTIME-OPTIMIZATION.md` 的后续补充：0704 文档中的 per-conversation 连接隔离是为了解决早期事件串流问题的阶段性取舍，本文给出下一阶段在保留会话隔离的前提下降低进程和内存占用的目标设计。

本文中的“连接管理”不是传统意义上的多连接 pool。一期目标是：

```text
每个 runtime/workspace/config/command/env key 最多 1 条 ACP connection
每条 ACP connection 承载多个 native session
每个 native session 绑定一个 code-lite conversation
```

未来如果某个 runtime 需要多条并行连接，才在这个 manager 之上扩展真正的 pool。

## 1. 背景

当前实现已经把 ACP 从“每轮 prompt 临时 spawn”推进到“常驻连接”：

```text
React UI
  -> POST /api/sessions/{conversationId}/initialize
  -> POST /api/turns/stream
  -> AcpAgentAdapter
  -> AcpRuntimeManager
  -> codex-acp / claude-agent-acp / opencode acp
```

但当前 `AcpRuntimeManager` 的 `ConnectionKey` 包含 `conversation_id`，实际效果是：

```text
conversation A -> ACP process A -> native session A
conversation B -> ACP process B -> native session B
conversation C -> ACP process C -> native session C
```

这解决了事件串流问题，但带来新的资源问题：

1. 用户每首次进入一个真实会话，`/api/sessions/{id}/initialize` 会创建或恢复一个 native ACP session，并常驻一个 ACP 连接。
2. 同一 backend 生命周期内，打开过的会话不会主动空闲回收。
3. 删除或归档会话当前不会通知 runtime manager 释放 ACP 资源。
4. draft `__probe__` capabilities 探测也可能保留一个额外 ACP 连接。
5. 会话越多，ACP 子进程、runtime 上下文、MCP 连接、stderr buffer 和 Python 侧对象会逐步累积。

## 2. ACP 官方依据

ACP 协议层支持一个连接承载多个 session，这不是 code-lite 自己推断出来的能力。

官方文档依据：

1. `Architecture` 文档说明，编辑器按需启动 agent subprocess，通信通过 stdin/stdout；每个 connection 可以支持多个 concurrent sessions，用于同时进行多条思路。
   - `https://agentclientprotocol.com/get-started/architecture`
2. `Session Setup` 文档说明，session 表示 client 与 agent 之间的具体 conversation/thread。每个 session 维护自己的 context、conversation history 和 state，并允许同一个 Agent 上存在多个独立交互。
   - `https://agentclientprotocol.com/protocol/v1/session-setup`
3. `session/new` 返回唯一 `sessionId`，后续 `session/prompt`、`session/cancel`、`session/load`、`session/resume`、`session/close` 都以 `sessionId` 为作用域。
4. `session/load` 会回放历史；`session/resume` 恢复上下文但不回放历史；`session/close` 释放指定 active session 的资源，不要求关闭整个 ACP 连接。
5. `session/update`、工具调用、permission request、terminal request 等事件都携带或关联 `sessionId`，客户端可以按 `sessionId` 做路由。

因此目标架构可以明确为：

```text
同一个 ACP connection/process
  -> native session A -> code-lite conversation A
  -> native session B -> code-lite conversation B
  -> native session C -> code-lite conversation C
```

注意：这不意味着多个 code-lite 会话复用同一个 native `sessionId`。native session 仍必须一会话一个，避免上下文串联。

## 3. 目标

1. 同一 runtime、workspace、config mode、command/env fingerprint 下，优先复用一个 ACP connection。
2. 每个 code-lite conversation 仍绑定独立 native ACP session。
3. 通过 `sessionId -> route` 路由 ACP 回调事件，避免事件串流。
4. 空闲 session 可 `session/close` 后释放 runtime 资源，保留 `native-session.json` 用于后续 `session/resume` 或 `session/load`。
5. 当一个连接内没有 active session 时，连接可在 idle timeout 后关闭。
6. `__probe__` capabilities 探测不再长期占用一个 conversation 连接。
7. 保留 per-conversation 连接作为 feature flag 回滚路径。
8. 清理旧实现中“ACP 池”“per-conversation connection”“handler 单会话改写”等临时结构和命名。

## 4. 非目标

1. 本轮不改变 ACP 协议或 Python SDK。
2. 本轮不复用 native session 给多个 conversation。
3. 本轮不承诺所有 runtime 都能真正并发执行多个 prompt；并发能力需要 runtime smoke 后逐步放开。
4. 本轮不实现 gateway mode 强权限拦截。
5. 本轮不迁移会话存储格式，只扩展 native session 生命周期元数据。

## 5. Runtime 与 Session 类型边界

code-lite 不能把所有 ACP runtime 看成同一种连接。Codex、Claude Code、opencode 分别连接不同的 ACP server wrapper，session 也只能在对应 wrapper 内恢复。

### 5.1 术语

| 名称 | 示例 | 含义 |
| --- | --- | --- |
| `agentId` | `codex` / `claude_code` / `opencode` | code-lite 产品层 agent 标识 |
| `runtimeId` | `codex` / `claude_code` / `opencode` | 后端 runtime descriptor/profile 标识，通常和 agentId 一致 |
| `acpServerKind` | `codex-acp` / `claude-agent-acp` / `opencode-acp` | ACP server wrapper 类型 |
| `command` | `codex-acp` / `claude-agent-acp` / `opencode acp` | 实际启动命令 |
| `nativeSessionId` | runtime 返回的 session id | 只在对应 ACP server 内有效 |

### 5.2 连接 family

一期连接管理按 connection family 隔离：

```text
Codex family
  key: runtimeId=codex, acpServerKind=codex-acp, workspace, configMode, command/env
  connection: codex-acp process
  sessions: Codex native sessions only

Claude Code family
  key: runtimeId=claude_code, acpServerKind=claude-agent-acp, workspace, configMode, command/env
  connection: claude-agent-acp process
  sessions: Claude Code native sessions only

opencode family
  key: runtimeId=opencode, acpServerKind=opencode-acp, workspace, configMode, command/env
  connection: opencode acp process
  sessions: opencode native sessions only
```

禁止行为：

1. Codex conversation 不能 resume 到 Claude Code connection。
2. 不同 `acpServerKind` 的 native session id 不能互相解释。
3. command/env/config 变化后不能复用旧 connection。
4. 不同 workspace 默认不共用 connection。

### 5.3 绑定数据必须带类型

`native-session.json` 必须持久化 runtime 类型信息：

```json
{
  "conversationId": "conv_...",
  "agentId": "codex",
  "runtimeId": "codex",
  "acpServerKind": "codex-acp",
  "nativeSessionId": "sess_...",
  "workspace": "D:/project/code-lite",
  "configMode": "user-native"
}
```

恢复时必须检查：

1. 当前 conversation 绑定的 agent 与 `native-session.json.agentId` 一致。
2. 当前 descriptor 的 `runtimeId`、`acpServerKind` 与绑定一致。
3. 当前 workspace/config mode 可接受。
4. 不一致时不要 resume/load，创建新 native session，并记录 warning。

## 6. 当前实现问题

### 6.1 连接键过细

当前连接键包含 `conversation_id`：

```python
ConnectionKey(
    runtime_id,
    workspace,
    config_mode,
    conversation_id,
    command_fingerprint,
    env_fingerprint,
)
```

这会让同一 runtime/workspace 下的每个会话都有独立 ACP process。目标连接键应移除 `conversation_id`：

```python
ConnectionKey(
    runtime_id,
    workspace,
    config_mode,
    command_fingerprint,
    env_fingerprint,
)
```

conversation 隔离应由 `AcpSessionBinding` 和 `session route` 保证，而不是靠进程隔离。

### 6.2 Handler 是 per-conversation 假设

当前 `AcpClientHandler` 在 turn 开始时被直接改写：

```python
handler.conversation_id = request.conversation_id
handler.turn_id = request.turn_id
handler.output_queue = output_queue
handler.native_session_id = binding.native_session_id
```

这在单连接单 conversation 下可行；多 session 后会导致事件写到错误队列。必须改为：

```text
sessionId -> AcpSessionRoute
```

每个 ACP callback 根据 `sessionId` 找 route，再输出到对应 conversation / turn / queue。

### 6.3 没有 active/idle 生命周期

当前只有 `session_bindings` 和 `connections`，没有明确区分：

1. product conversation 存在。
2. native session binding 已持久化。
3. native session 当前 active。
4. native session 已 `session/close`，可 resume/load。
5. connection 仍活跃但无 active session。

目标实现需要显式状态，便于回收和恢复。

### 6.4 命名和职责混乱

当前文档和代码里仍混用“连接池”“连接管理器”“per-conversation 连接池”等说法，容易误导后续实现。

目标命名：

| 旧说法 | 新说法 |
| --- | --- |
| ACP connection pool | ACP runtime connection manager |
| multi session pool | single connection multi session mode |
| per-conversation pool | per-conversation connection fallback |
| `supports_multi_session_pool` | `supports_multi_session_connection` |

代码层命名建议：

```text
AcpRuntimeManager
  -> 保留类名，语义改成 runtime connection manager

ConnectionKey
  -> 按 runtime/workspace/config/command/env 唯一定位 connection

AcpSessionRoute
  -> native session 到 UI route 的映射

AcpSessionBinding
  -> conversation 到 native session 的持久绑定
```

### 6.5 旧诊断小坑

`connection.sessions` 当前是 `conversation_id -> native_session_id` 字符串映射，但部分诊断代码把它当成 binding 对象读取 `native_session_id`。迁移时要顺手修正：

```text
错误假设:
  binding = connection.sessions.get(conversation_id)
  binding.native_session_id

目标:
  native_session_id = connection.conversation_sessions.get(conversation_id)
  或 runtime_manager.get_session_binding(conversation_id)
```

## 7. 目标架构

```text
React UI
  -> /api/sessions/{conversationId}/initialize
  -> /api/turns/stream

Python Backend
  -> AcpAgentAdapter
  -> AcpRuntimeConnectionManager
       connections:
         ConnectionKey(runtime, acpServerKind, workspace, config, command/env)
           -> AcpRuntimeConnection
                process
                sdk_connection
                initialize_result
                session_routes: nativeSessionId -> AcpSessionRoute
                active_sessions: conversationId -> AcpSessionBinding
                prompt_locks
                latest_activity_at
  -> ACP process
       native session A
       native session B
       native session C
```

### 7.1 数据结构

```python
@dataclass(frozen=True)
class ConnectionKey:
    runtime_id: str
    acp_server_kind: str
    workspace: str
    config_mode: str
    command_fingerprint: str
    env_fingerprint: str


@dataclass
class AcpSessionBinding:
    conversation_id: str
    agent_id: str
    runtime_id: str
    acp_server_kind: str
    native_session_id: str
    workspace: str
    config_mode: str
    state: Literal["active", "idle_closed", "missing", "failed"]
    created_at: str
    updated_at: str
    last_active_at: str
    capabilities: dict[str, Any] | None = None
    close_supported: bool | None = None
    resume_supported: bool | None = None
    load_supported: bool | None = None


@dataclass
class AcpSessionRoute:
    conversation_id: str
    native_session_id: str
    turn_id: str | None
    output_queue: asyncio.Queue[AgentEvent | None] | None
    mapper: AcpEventMapper
    suppress_output: bool = False
    active_prompt: bool = False
    created_at: float = field(default_factory=time.time)
    latest_activity_at: float = field(default_factory=time.time)


@dataclass
class AcpRuntimeConnection:
    key: ConnectionKey
    process: asyncio.subprocess.Process
    sdk_connection: CodeLiteClientSideConnection
    initialize_result: Any
    stderr_ring_buffer: deque[str]
    session_routes: dict[str, AcpSessionRoute]
    conversation_sessions: dict[str, str]
    connection_lock: asyncio.Lock
    prompt_locks: dict[str, asyncio.Lock]
    latest_activity_at: float
```

### 7.2 路由规则

ACP callback 统一入口：

```text
session/update(params.sessionId, update)
  -> route = session_routes[params.sessionId]
  -> if route.suppress_output: update baseline / discard UI event
  -> else mapper.map(update, route.context)
  -> route.output_queue.put(event)

session/request_permission(params.sessionId, ...)
  -> route = session_routes[params.sessionId]
  -> ApprovalBroker.create(conversationId=route.conversation_id, turnId=route.turn_id)

client input / elicitation / terminal request
  -> route by sessionId
  -> emit corresponding AgentEvent or broker request
```

如果 callback 缺少 `sessionId`，按以下策略处理：

1. 若连接上只有一个 active prompt，可暂时路由到该 prompt，并记录 warning。
2. 若连接上有多个 active route，不能猜测，写 diagnostic，并丢弃 UI 输出。
3. 对 runtime-specific raw event 保留到 diagnostics，不进入主 UI。

### 7.3 Prompt 并发策略

阶段 1 保守策略：

```text
同一 connection 内所有 prompt 全局串行
同一 session 内 turn 必须串行
不同 session 可共享连接，但 prompt 先不并发
```

这样可以先验证多 session 路由和资源回收，避免同时引入 runtime 并发差异。

阶段 2 逐步放开：

```text
同一 session 串行
不同 session 可并发
按 runtime profile 声明 max_concurrent_prompts
Codex / Claude Code / opencode 分别 smoke 后启用
```

默认值建议：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `max_connections_per_key` | 1 | 同一 runtime/workspace/config 先保留 1 个 ACP connection |
| `max_active_sessions_per_connection` | 4 | 协议无硬上限，产品层先保守限制 |
| `max_concurrent_prompts_per_connection` | 1 | 第一阶段全局串行 |
| `idle_session_ttl_seconds` | 600 | session 空闲 10 分钟后 close |
| `idle_connection_ttl_seconds` | 300 | 无 active session 的连接空闲 5 分钟后关闭 |
| `probe_session_ttl_seconds` | 0 | probe session 用完即 close |

如果 active session 达到上限：

1. 优先关闭最久未使用且无 active prompt 的 idle session。
2. 若仍超限，阶段 1 返回可诊断错误或排队等待。
3. 阶段 2 可按 profile 允许创建第二条 connection，但必须有上限。

说明：`max_connections_per_key = 1` 是一期固定策略，不代表已经实现传统连接池。只有当 runtime smoke 证明需要并能稳定支持多连接时，才允许把这个值提高。

## 8. Session 生命周期

### 7.1 状态机

```text
missing
  -> session/new
  -> active

active
  -> idle timeout + session/close
  -> idle_closed

idle_closed
  -> session/resume
  -> active

idle_closed
  -> session/load fallback
  -> active

idle_closed
  -> restore failed + session/new
  -> active

active
  -> delete conversation
  -> closed_deleted

active
  -> connection crash
  -> detached

detached
  -> session/resume/load
  -> active
```

### 7.2 初始化会话

进入真实 conversation 时：

```text
initialize_session(conversationId)
  -> resolve agent/runtime/workspace
  -> ensure_connection(key without conversationId)
  -> ensure_session(conversationId)
       if in-memory active: return binding
       if native-session.json exists:
         try session/resume if supported
         else try session/load if supported, with suppress_output
       else session/new
  -> return SessionCapabilities
```

进入 draft 会话时：

```text
initialize_session("__probe__")
  -> use runtime-level capabilities cache if present
  -> otherwise create temporary session
  -> build capabilities
  -> session/close if supported
  -> do not persist native-session.json
```

### 7.3 发送 turn

```text
stream_turn(request)
  -> ensure_connection
  -> ensure_session
  -> acquire session lock
  -> acquire connection prompt lock in phase 1
  -> attach route output_queue + turn_id
  -> mapper.start_turn(baseline)
  -> apply mode/model/config
  -> session/prompt(nativeSessionId)
  -> emit completed/failed
  -> detach route output_queue, keep route for session-level diagnostics
```

### 7.4 空闲回收

后台 cleanup task 每隔 60 秒扫描：

```text
for connection in connections:
  for binding in connection.active_sessions:
    if no active_prompt and idle > idle_session_ttl:
      if supports close:
        session/close(nativeSessionId)
      remove active route
      mark binding state = idle_closed
      persist native-session.json

  if connection has no active session and idle > idle_connection_ttl:
    sdk_connection.close()
    terminate process
    remove connection
```

如果 runtime 不支持 `session/close`：

1. 可以移除 route，避免 UI 持有队列。
2. 不声明 session 已释放 runtime 资源。
3. 当连接空闲且没有 active prompt 时，关闭整个 connection 来释放资源。

## 9. 存储格式调整

现有 `native-session.json` 增加 lifecycle 字段：

```json
{
  "conversationId": "conv_...",
  "agentId": "codex",
  "runtimeId": "codex",
  "acpServerKind": "codex-acp",
  "nativeSessionId": "sess_...",
  "workspace": "D:/project/code-lite",
  "configMode": "user-native",
  "state": "idle_closed",
  "createdAt": "2026-07-08T10:00:00Z",
  "updatedAt": "2026-07-08T10:30:00Z",
  "lastActiveAt": "2026-07-08T10:20:00Z",
  "capabilities": {},
  "lifecycle": {
    "closeSupported": true,
    "resumeSupported": true,
    "loadSupported": true,
    "lastCloseAt": "2026-07-08T10:30:00Z",
    "lastRestoreMethod": "resume"
  }
}
```

兼容规则：

1. 旧文件没有 `state` 时按 `active` 或 `detached` 处理。
2. 旧文件没有 lifecycle 时从当前 connection initialize result 重新判断 capability。
3. 旧 `capabilities` 字段继续保留，用于前端配置控件快速渲染。
4. 禁止保存 API key、token、账号密码、私钥。

## 10. API 与 UI

### 9.1 Backend API

新增或扩展：

```text
GET /api/runtimes/acp/status
POST /api/runtimes/acp/cleanup
POST /api/conversations/{conversation_id}/runtime/close
```

`GET /api/runtimes/acp/status` 返回：

```json
{
  "connections": [
    {
      "runtime": "codex",
      "workspace": "D:/project/code-lite",
      "pid": 1234,
      "activeSessions": 2,
      "idleSessions": 1,
      "latestActivityAt": "...",
      "sessions": [
        {
          "conversationId": "conv_...",
          "nativeSessionId": "sess_...",
          "state": "active",
          "activePrompt": false,
          "lastActiveAt": "..."
        }
      ]
    }
  ]
}
```

### 9.2 UI 展示

设置页日志或 runtime 页建议展示：

1. 当前 ACP 连接数。
2. 当前 active native session 数。
3. 每个 connection 的 runtime、workspace、pid、idle 时长。
4. 手动“释放空闲连接”按钮。
5. 会话详情中可选显示 native session 状态：active、idle closed、restored。

主聊天 UI 不应暴露过多运行时细节；只有恢复失败时显示简洁提示。

## 11. 删除、归档与取消

### 10.1 删除 conversation

删除会话时必须：

```text
delete_conversation(conversationId)
  -> runtime_manager.close_session_for_conversation(conversationId, reason="deleted")
  -> if supports session/close: session/close(nativeSessionId)
  -> remove session route
  -> remove in-memory binding
  -> delete native-session.json with conversation dir
  -> delete attachments
```

### 10.2 归档 conversation

归档不删除 native binding，但可以释放 active runtime 资源：

```text
archive conversation
  -> if no active prompt:
       session/close(nativeSessionId)
       mark state=idle_closed
  -> keep native-session.json
```

### 10.3 取消 turn

取消 turn 时：

1. 优先调用 ACP `session/cancel`，作用域是 native session。
2. 清理该 session 的 pending approval/input。
3. 不关闭整个 connection。
4. 如果取消后 session 状态不可确定，可标记 route dirty，下次 prompt 前尝试 resume/load。

## 12. 旧实现清理范围

迁移不是只加新逻辑，还要把之前为了止血留下的临时结构清理掉，避免“旧 per-conversation 模式”和“新 multi-session 模式”长期互相缠绕。

### 12.1 后端清理

必须清理或收敛：

1. `ConnectionKey.conversation_id`：移出默认 key，只保留在 per-conversation fallback 分支。
2. `AcpClientHandler` 的单一 `conversation_id`、`turn_id`、`output_queue` 改写：改为 `sessionId -> AcpSessionRoute`。
3. `connection.sessions` 命名：改为更明确的 `conversation_sessions` 或 `conversation_to_native_session`。
4. `get_connection_for_runtime()` 这类模糊查询：替换成按 typed `ConnectionKey` 或 conversation binding 查询。
5. `__probe__` 作为普通 conversation 进入 manager：改为 runtime capabilities probe，不持久化、不常驻。
6. 删除/归档会话不释放 runtime 资源：补 `close_session_for_conversation()`。
7. runtime status 缺失：新增 manager 状态 API，方便确认连接和 session 是否泄漏。
8. 诊断里的 native session 读取错误：统一从 binding 或 typed route 读取。

### 12.2 文档清理

旧文档中保留 per-conversation 设计作为历史阶段，但需要补充指向本文：

1. `docs/design/0704-ACP-RUNTIME-OPTIMIZATION.md`：保留历史设计，标注 per-conversation 是阶段性止血方案。
2. `docs/design/0705-UNIFIED-AGENT-PROTOCOL.md`：后续更新“连接池”表述，改成 connection manager。
3. `docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md`：如涉及 runtime manager，补充 session route 诊断字段。

本轮先以本文为最新目标方案，不直接重写旧文档的大段历史内容。

### 12.3 命名清理

建议最终代码和配置命名：

```text
CODE_LITE_ACP_CONNECTION_MODE=per_conversation|multi_session
supports_multi_session_connection
max_sessions_per_connection
idle_session_ttl_seconds
idle_connection_ttl_seconds
```

避免再新增：

```text
pool
multi_session_pool
conversation_pool
```

除非未来真的允许同一个 connection key 下多条 ACP connection。

## 13. 实施阶段

### 阶段 0：确认与测试护栏

目标：

1. 为当前 per-conversation 模式补最小 mock ACP 测试，固定现有行为。
2. 增加 `CODE_LITE_ACP_CONNECTION_MODE`：
   - `per_conversation`
   - `multi_session`
3. 默认仍为 `per_conversation`，方便回滚。

验证：

```powershell
uv run --project backend python -m py_compile backend/code_lite_backend/agents/acp/runtime_manager.py
```

### 阶段 1：连接键去 conversation 化和 runtime 类型化

目标：

1. `ConnectionKey` 移除 `conversation_id`。
2. `ConnectionKey` 增加或明确 `runtime_id`、`acp_server_kind`。
3. `ensure_connection()` 按 runtime/acpServerKind/workspace/config/command/env 复用连接。
4. 保持 connection-level prompt lock，所有 prompt 先串行。
5. 保留旧模式分支。

验收：

1. 打开两个会话时只启动一个同 runtime/workspace 的 ACP process。
2. 每个会话仍创建独立 native session。
3. 不发生事件串流。

### 阶段 2：Session 路由表

目标：

1. `AcpClientHandler` 不再保存单一 conversation/turn/output_queue。
2. 新增 `AcpSessionRoute` 和 `sessionId -> route`。
3. `session/update`、permission、input、elicitation 均按 sessionId 路由。
4. `session/load` replay 时使用 `suppress_output`。

验收：

1. mock ACP 在一个连接中创建两个 session，分别发送 update，UI 事件进入正确 conversation。
2. permission request 能路由到正确会话。
3. load replay 不污染当前 turn。

### 阶段 3：空闲 close 与 resume

目标：

1. 实现 cleanup task。
2. 支持 `session/close` 能力判断。
3. 空闲 session close 后持久化 `state=idle_closed`。
4. 再次进入会话优先 `session/resume`，再 fallback `session/load`。
5. `__probe__` session 用完即 close。

验收：

1. 空闲超过 TTL 后 active session 数下降。
2. 连接内无 active session 后进程会在连接 TTL 后退出。
3. 重新进入会话可恢复 native session。

### 阶段 4：会话删除/归档联动释放

目标：

1. delete conversation 调用 runtime manager cleanup。
2. archive conversation 可释放 active session。
3. 设置页新增 status/cleanup API。

验收：

1. 删除会话后 runtime status 中不再出现该 conversation。
2. 归档后该 session 进入 idle_closed。
3. 手动 cleanup 可以释放空闲连接。

### 阶段 5：Runtime 并发能力 smoke

目标：

1. Codex ACP：一个连接两个 session，串行 prompt smoke。
2. Claude Code ACP：一个连接两个 session，串行 prompt smoke。
3. opencode ACP：一个连接两个 session，串行 prompt smoke。
4. 在稳定 runtime 上尝试并发 prompt，决定 `max_concurrent_prompts`。

真实 runtime smoke 必须使用临时 workspace，避免误改项目文件。

## 14. 测试策略

### 12.1 单元测试

1. `ConnectionKey` 不含 conversation 后的复用行为。
2. `AcpSessionRoute` 根据 `sessionId` 路由事件。
3. 缺失 `sessionId` 的 callback 产生 diagnostic。
4. idle session LRU 选择。
5. close/resume/load capability 判断。
6. `native-session.json` 旧格式兼容读取。

### 12.2 Mock ACP 集成测试

1. 一个连接创建两个 session。
2. session A 和 B 交替发送 `session/update`。
3. session A permission request 不影响 B。
4. session/load replay 被 suppress。
5. session/close 后不再给该 route 输出 UI 事件。

### 12.3 真实 Runtime Smoke

命令示例：

```powershell
uv run --project backend pytest
uv run --with agent-client-protocol python .\demo\acp-demo\python_sdk_acp_probe.py --agent codex --temp-workspace --summary-only
```

后续建议新增专项 smoke：

```text
demo/acp-demo/multi_session_probe.py
  --agent codex
  --sessions 2
  --mode serial
  --temp-workspace
```

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| SDK handler 无法稳定拿到 sessionId | 事件无法安全路由 | 先用 mock ACP 验证所有 callback；缺失 sessionId 时 diagnostic，不猜测 |
| runtime 宣称支持多 session 但实现有 bug | 串流、卡死、错误 session | 默认串行 prompt；保留 per-conversation feature flag |
| `session/close` 不被某 runtime 支持 | session 资源不能精确释放 | 关闭整个 idle connection 作为 fallback |
| `session/load` replay 污染当前 UI | 旧消息重复显示 | load 阶段强制 suppress output，并维护 text baseline |
| 多 session 共用 MCP server 配置导致状态共享 | 工具状态混淆 | session/new/resume/load 每次传完整 mcpServers/cwd/additionalDirectories |
| idle cleanup 误关正在等待审批的 session | 用户审批丢失 | pending approval/input 算 active；cleanup 跳过 |
| connection manager bug 影响同 runtime/workspace 的会话 | blast radius 变大 | feature flag 回滚；runtime status 可见；日志带 connection key 和 sessionId |
| runtime 类型混淆 | Codex session 被拿去 Claude connection 恢复 | binding 持久化 agentId/runtimeId/acpServerKind，恢复前强校验 |

## 16. 回滚策略

1. 保留 `per_conversation` 模式至少一个版本。
2. `multi_session` 初期只在开发设置或实验开关中启用。
3. runtime profile 可单独声明：

```python
supports_multi_session_connection: bool = False
```

4. 任一 runtime smoke 不稳定时，该 runtime 回到 per-conversation 模式。
5. 用户遇到 connection manager 异常时，设置页提供“释放所有 ACP 连接”操作。

## 17. 验收标准

1. 同一 runtime/acpServerKind/workspace 下打开 3 个会话，只保留 1 个 ACP process。
2. 3 个会话各自拥有不同 native sessionId。
3. 任意 session 的 text/tool/approval/input 事件都不会出现在其他 conversation。
4. 空闲 session 超过 TTL 后会被 close 或随 idle connection 关闭释放。
5. 重新进入 idle_closed 会话时优先 resume，失败后 load，再失败才 new。
6. 删除会话会释放对应 active session 和 route。
7. `__probe__` 不长期占用 active session。
8. 设置页或日志 API 能查看连接数、session 数和 idle 状态。
9. `per_conversation` 回滚模式仍可用。

## 18. 最终决策

code-lite 后续应向“runtime/workspace 级 ACP connection manager + conversation 级 native session”迁移。

稳定边界如下：

1. ACP connection 是可复用的进程/通信通道，但按 runtime/acpServerKind/workspace/config 隔离。
2. Codex、Claude Code、opencode 分别连接自己的 ACP server wrapper，不能混用 session。
3. native ACP session 是 conversation 上下文边界，不能跨会话复用。
4. UI event 路由必须以 `sessionId` 为第一键，以 `conversationId` 为产品层投影键。
5. 空闲释放优先 `session/close`，连接关闭作为兜底。
6. 初期 prompt 仍全局串行，先解决资源管理和路由正确性，再评估并发。
7. 旧的 per-conversation 连接、pool 命名和单 handler 改写逻辑要作为迁移清理对象，而不是长期叠加在新架构上。

这条路线能保留当前会话隔离语义，同时避免“打开过多少会话就常驻多少 ACP 子进程”的资源增长问题。

## 19. 参考

1. ACP Architecture：`https://agentclientprotocol.com/get-started/architecture`
2. ACP Session Setup：`https://agentclientprotocol.com/protocol/v1/session-setup`
3. ACP Prompt Turn：`https://agentclientprotocol.com/protocol/v1/prompt-turn`
4. ACP Tool Calls：`https://agentclientprotocol.com/protocol/v1/tool-calls`
5. `docs/design/0704-ACP-RUNTIME-OPTIMIZATION.md`
6. `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`
7. `docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md`
