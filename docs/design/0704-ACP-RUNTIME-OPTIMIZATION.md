# ACP Runtime 优化与会话存储重构设计

设计日期：2026-07-04

本文是 code-lite 基于 VibeX ACP Runtime 调研结论，针对当前 ACP 接入体验和会话存储方案的优化设计。本文是 `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md` 和 `docs/design/0703-AGENT-UNIFIED-ACP.md` 的补充，聚焦于运行时性能优化和事件存储重构。

---

## 1. 背景与问题

### 1.1 当前体验瓶颈

code-lite 已完成 Codex ACP 接入，但存在明显体验问题：

```text
当前流程（每轮 prompt）：
  POST /api/turns/stream
    -> spawn ACP 子进程
    -> initialize
    -> session/new
    -> set mode/model/config
    -> prompt
    -> close_session
    -> process exit
```

具体问题：

1. **每轮启动延迟**：每次发送消息都要重新启动 ACP 子进程，Codex ACP、Node/npm shim、初始化都会进入用户可感知延迟。
2. **多轮对话不连续**：UI 会话看起来是多轮对话，但 runtime 侧每轮都是新 session，上下文连续性依赖 runtime 内部机制。
3. **进入会话也要握手**：`POST /api/sessions/{conversationId}/initialize` 临时 spawn ACP 获取 capabilities 后关闭，下次进入又要重复。
4. **取消和审批绑定脆弱**：没有 connection 级 command channel，pending approval 清理可能不完整。
5. **存储偏原型**：流式事件、工具调用、审批、usage 最终折叠进 `messages.json`，缺少可补偿的事件序列，不利于远程同步和回放。

### 1.2 VibeX 的核心启示

VibeX 的 ACP runtime 采用**常驻连接模型**：

```text
AgentRuntime（常驻）
  -> AgentConnectionManager
  -> run_acp 常驻子进程
  -> initialize 后标记 connection ready
  -> ensure_acp_session / load_or_new_acp_session
  -> run_prompt
  -> prompt 完成后 connection/session 继续保留
```

关键特征：

1. **connection 和 session 独立快照**：ACP handshake 成功后才标记 ready，避免首条 prompt 发给即将失败的子进程。
2. **UI conversation 与 native ACP session 绑定**：同一产品 conversation 复用同一 native session。
3. **prompt 队列串行化**：同一 session 的 prompt 使用队列串行，避免并发搞乱状态。
4. **支持 session/load**：backend 重启后尝试恢复 native session，失败时明确提示。
5. **handshake timeout + idle timeout**：避免无限"生成中"。
6. **stderr ring buffer**：失败时可诊断。

VibeX 还把 runtime event 和 product conversation event 分层：

- **AgentEvent**：runtime 层事件，debug audit log，跳过高频 streaming chunk。
- **ConversationEvent**：产品层 append-only log，带 `conversation_id`、`turn_id`、`sequence`、`idempotency_key`，支持远程同步和回放。

---

## 2. 设计目标

1. **性能止血**：去掉每轮启动的最大延迟，同一 backend 生命周期内复用 ACP 子进程和 session。
2. **会话连续**：UI conversation 与 native ACP session 形成稳定绑定，支持重启后恢复。
3. **事件优先**：从 messages-only 过渡到 event-first，为远程同步和审计打基础。
4. **流式质量**：解决文本重复、工具状态粗糙和 usage 展示不足。
5. **渐进迁移**：不一步到位照搬 VibeX SQLite 全表结构，先用 JSON/NDJSON 轻量落地。

---

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────────────┐
│                          code-lite ACP 优化架构                       │
│                                                                     │
│  React UI                                                           │
│    │                                                                │
│    │  POST /api/sessions/{conversationId}/initialize               │
│    │  -> ensure_connection + ensure_session + SessionCapabilities  │
│    │  -> 不关闭 native session                                     │
│    │                                                                │
│    │  POST /api/turns/stream                                       │
│    │  -> 复用 connection + 复用 session + prompt                   │
│    │  <- NDJSON stream of UnifiedAgentEvent                      │
│    │                                                                │
│  ──┼─────────────────────────────────────────────────────────────  │
│    │                                                                │
│  Python Backend                                                     │
│    │                                                                │
│    ├── AcpRuntimeManager（新增）                                    │
│    │     │  connections: dict[ConnectionKey, AcpRuntimeConnection] │
│    │     │  session_bindings: dict[conversationId, AcpSessionBinding] │
│    │     │  turn_locks: dict[conversationId, asyncio.Lock]         │
│    │     │                                                         │
│    │     │  ensure_connection():                                   │
│    │     │    -> 已有 ready connection 则复用                       │
│    │     │    -> 否则 spawn ACP process + initialize + 标记 ready  │
│    │     │                                                         │
│    │     │  ensure_session(conversation_id):                       │
│    │     │    -> 已绑定 nativeSessionId 则复用                      │
│    │     │    -> 如 runtime 支持 loadSession，尝试 session/load    │
│    │     │    -> 否则 session/new + 保存 binding                   │
│    │     │                                                         │
│    │     │  stream_turn():                                         │
│    │     │    -> 获取 conversation lock                            │
│    │     │    -> ensure_connection                                 │
│    │     │    -> ensure_session                                    │
│    │     │    -> apply selectedMode / selectedConfig               │
│    │     │    -> prompt                                            │
│    │     │    -> prompt 结束后保留 connection/session              │
│    │                                                                │
│    ├── AcpAgentAdapter（重构）                                      │
│    │     │  复用 AcpRuntimeManager，不再每轮 spawn                 │
│    │     │                                                         │
│    ├── ConversationEventStore（新增）                               │
│    │     │  events.ndjson: append-only 产品事件日志                │
│    │     │  native-session.json: conversation -> native session    │
│    │     │  messages.json: 投影结果（兼容现有 UI）                 │
│    │                                                                │
│    ├── AcpEventMapper（增强）                                       │
│    │     │  增加去重和更完整的 ACP update 支持                      │
│    │                                                                │
│  ──┼─────────────────────────────────────────────────────────────  │
│    │                                                                │
│  ACP Server (常驻子进程，via stdio JSON-RPC)                       │
│    codex-acp / claude-agent-acp / opencode acp                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. AcpRuntimeManager 设计

### 4.1 核心数据结构

```python
@dataclass(frozen=True)
class ConnectionKey:
    """连接复用键"""
    runtime_id: str           # e.g. "codex-acp"
    workspace: str            # e.g. "H:/codex-lite"
    config_mode: str          # e.g. "user-native"
    command_fingerprint: str  # 命令路径 hash
    env_fingerprint: str      # 环境变量 key 名 + 脱敏 hash（不含 secret 原文）

@dataclass
class AcpRuntimeConnection:
    """常驻 ACP 连接"""
    key: ConnectionKey
    descriptor: RuntimeDescriptor
    command: list[str]
    env: dict[str, str]
    process: Any              # asyncio.subprocess.Process
    sdk_connection: Any       # acp.AgentSideConnection
    initialize_result: Any
    stderr_ring_buffer: list[str]  # 保留最近 N 行
    latest_activity_at: float
    sessions: dict[str, str]  # conversation_id -> native_session_id
    capabilities_cache: dict[str, Any] | None

@dataclass
class AcpSessionBinding:
    """UI conversation 到 native ACP session 的绑定"""
    conversation_id: str
    runtime_id: str
    native_session_id: str
    workspace: str
    config_mode: str
    created_at: str
    updated_at: str
    capabilities: dict[str, Any] | None  # session/new 返回的 modes/models/configOptions

class AcpRuntimeManager:
    connections: dict[ConnectionKey, AcpRuntimeConnection]
    session_bindings: dict[str, AcpSessionBinding]  # conversation_id -> binding
    turn_locks: dict[str, asyncio.Lock]  # conversation_id -> lock
```

### 4.2 核心方法

```python
async def ensure_connection(
    self,
    runtime_id: str,
    workspace: str,
    config_mode: str,
    command: list[str],
    env: dict[str, str],
) -> AcpRuntimeConnection:
    """确保存在 ready 的 ACP 连接"""
    key = self._build_key(runtime_id, workspace, config_mode, command, env)

    # 已有 ready connection 则复用
    existing = self.connections.get(key)
    if existing and self._is_connection_ready(existing):
        existing.latest_activity_at = time.time()
        return existing

    # 否则 spawn ACP process
    process = await self._spawn_process(command, env, workspace)

    # initialize
    client = AcpClientHandler(...)
    async with acp.spawn_agent_process(...) as (conn, process):
        initialize_result = await asyncio.wait_for(
            conn.initialize(...),
            timeout=30,
        )

    # 标记 ready
    connection = AcpRuntimeConnection(
        key=key,
        descriptor=descriptor,
        command=command,
        env=env,
        process=process,
        sdk_connection=conn,
        initialize_result=initialize_result,
        stderr_ring_buffer=[],
        latest_activity_at=time.time(),
        sessions={},
        capabilities_cache=None,
    )
    self.connections[key] = connection
    return connection

async def ensure_session(
    self,
    conversation_id: str,
    connection: AcpRuntimeConnection,
    workspace: str,
) -> AcpSessionBinding:
    """确保存在绑定的 native ACP session"""
    # 已绑定 nativeSessionId 则复用
    existing = self.session_bindings.get(conversation_id)
    if existing and existing.native_session_id in connection.sessions.values():
        existing.updated_at = datetime.utcnow().isoformat()
        return existing

    # 尝试 session/load（如果 runtime 支持）
    if self._supports_load_session(connection):
        try:
            saved_binding = await self._load_saved_binding(conversation_id)
            if saved_binding:
                result = await asyncio.wait_for(
                    connection.sdk_connection.load_session(saved_binding.native_session_id),
                    timeout=10,
                )
                binding = AcpSessionBinding(
                    conversation_id=conversation_id,
                    runtime_id=connection.descriptor.id,
                    native_session_id=str(result.session_id),
                    workspace=workspace,
                    config_mode=connection.key.config_mode,
                    created_at=saved_binding.created_at,
                    updated_at=datetime.utcnow().isoformat(),
                    capabilities=None,
                )
                connection.sessions[conversation_id] = binding.native_session_id
                self.session_bindings[conversation_id] = binding
                await self._save_binding(binding)
                return binding
        except Exception:
            pass  # fallback to session/new

    # 否则 session/new
    result = await asyncio.wait_for(
        connection.sdk_connection.new_session(cwd=workspace, mcp_servers=[]),
        timeout=30,
    )
    binding = AcpSessionBinding(
        conversation_id=conversation_id,
        runtime_id=connection.descriptor.id,
        native_session_id=str(result.session_id),
        workspace=workspace,
        config_mode=connection.key.config_mode,
        created_at=datetime.utcnow().isoformat(),
        updated_at=datetime.utcnow().isoformat(),
        capabilities=None,
    )
    connection.sessions[conversation_id] = binding.native_session_id
    self.session_bindings[conversation_id] = binding
    await self._save_binding(binding)
    return binding

async def stream_turn(
    self,
    request: AgentRunRequest,
    client: AcpClientHandler,
    output_queue: asyncio.Queue,
) -> None:
    """执行一轮 prompt，复用 connection 和 session"""
    # 获取 conversation lock
    lock = self.turn_locks.setdefault(request.conversation_id, asyncio.Lock())
    async with lock:
        # ensure_connection
        connection = await self.ensure_connection(...)
        # ensure_session
        binding = await self.ensure_session(request.conversation_id, connection, ...)
        client.native_session_id = binding.native_session_id

        # apply selectedMode / selectedConfig
        await self._configure_session(connection.sdk_connection, binding, request)

        # prompt
        try:
            prompt_result = await connection.sdk_connection.prompt(
                session_id=binding.native_session_id,
                prompt=[acp.text_block(request.prompt)],
            )
            # 处理结果...
        except asyncio.TimeoutError:
            # 发送 ACP cancel，输出 agent.run.failed，错误码 idle_timeout
            pass

        # prompt 结束后保留 connection/session，不关闭
```

### 4.3 生命周期管理

```python
# FastAPI lifespan 中统一管理
@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime_manager = AcpRuntimeManager()
    app.state.runtime_manager = runtime_manager
    yield
    # 关闭所有 connection
    await runtime_manager.close_all()

async def close_all(self) -> None:
    for connection in self.connections.values():
        with contextlib.suppress(Exception):
            await asyncio.wait_for(connection.process.wait(), timeout=5)
        with contextlib.suppress(Exception):
            await connection.sdk_connection.close()
    self.connections.clear()
```

---

## 5. 存储重构：Event-First

### 5.1 当前存储结构

```text
record/<conversationId>/
  session.json
  messages.json
```

`ConversationRecorder` 在流式阶段主要维护内存态，收到 completed / failed 后写最终 JSON。局限：

1. backend 中断时，未完成 turn 的可恢复信息较少。
2. 远程 viewer 需要从 NDJSON 直播流接入，缺少统一补偿入口。
3. 审批、工具、usage、native session 绑定、错误恢复等信息被折叠进消息对象，审计粒度不足。
4. 后续 reset-to-turn、fork、导出、导入、跨端同步都缺少 append-only 基础。

### 5.2 新存储结构

```text
record/<conversationId>/
  session.json              # UI 会话元数据（兼容）
  messages.json             # 消息投影（兼容现有 UI）
  events.ndjson             # 产品级事件日志（新增，event-first）
  native-session.json       # UI conversation -> native ACP session 绑定（新增）
```

### 5.3 events.ndjson 格式

`events.ndjson` 记录产品级事件，不是原始 ACP JSON-RPC：

```json
{"eventId":"evt_001","sequence":1,"createdAt":"2026-07-04T15:00:00Z","type":"conversation.turn.started","conversationId":"conv_...","turnId":"turn_...","runtime":"codex-acp","nativeSessionId":"019f..."}
{"eventId":"evt_002","sequence":2,"createdAt":"2026-07-04T15:00:01Z","type":"agent.text.delta","conversationId":"conv_...","turnId":"turn_...","delta":"我会先做只读检查。"}
{"eventId":"evt_003","sequence":3,"createdAt":"2026-07-04T15:00:02Z","type":"agent.tool.started","conversationId":"conv_...","turnId":"turn_...","toolCallId":"tool-...","name":"exec","risk":"high"}
{"eventId":"evt_004","sequence":4,"createdAt":"2026-07-04T15:00:03Z","type":"agent.tool.completed","conversationId":"conv_...","turnId":"turn_...","toolCallId":"tool-..."}
{"eventId":"evt_005","sequence":5,"createdAt":"2026-07-04T15:00:04Z","type":"agent.run.completed","conversationId":"conv_...","turnId":"turn_...","usage":{"totalTokens":1234}}
```

事件基础字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `eventId` | string | 事件唯一 ID |
| `sequence` | number | 会话内递增序号，用于远程同步和回放 |
| `createdAt` | string | ISO 8601 时间戳 |
| `type` | string | 事件类型，如 `agent.text.delta` |
| `conversationId` | string | 所属会话 |
| `turnId` | string | 所属 turn |
| `runtime` | string | 产生事件的 runtime，如 `codex-acp` |
| `nativeSessionId` | string | 对应的 native ACP session ID（可选） |

### 5.4 native-session.json 格式

```json
{
  "conversationId": "conv_...",
  "runtimeId": "codex-acp",
  "nativeSessionId": "019f...",
  "workspace": "H:/codex-lite",
  "configMode": "user-native",
  "createdAt": "2026-07-04T15:00:00Z",
  "updatedAt": "2026-07-04T15:05:00Z"
}
```

**禁止保存 API key、token、账号密码、私钥。**

### 5.5 投影机制

```text
events.ndjson -> ConversationEventProjector -> messages.json
```

- 写事件时继续维护 `messages.json`，不破坏现有 UI。
- 读取旧会话时如果没有 `events.ndjson`，仍读 `messages.json`。
- 新会话生成 `events.ndjson`，后续可用它重建 `messages.json`。

### 5.6 ConversationEventStore

```python
class ConversationEventStore:
    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._sequences: dict[str, int] = {}  # conversation_id -> next sequence

    async def append_event(self, conversation_id: str, event: dict[str, Any]) -> None:
        """追加产品级事件到 events.ndjson"""
        seq = self._sequences.get(conversation_id, 1)
        event["eventId"] = event.get("eventId") or f"evt_{uuid.uuid4().hex}"
        event["sequence"] = seq
        event["createdAt"] = event.get("createdAt") or datetime.utcnow().isoformat() + "Z"
        self._sequences[conversation_id] = seq + 1

        path = self._events_path(conversation_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    async def load_events(self, conversation_id: str, after: int = 0) -> list[dict[str, Any]]:
        """加载事件，支持按 sequence 过滤（用于远程同步补偿）"""
        path = self._events_path(conversation_id)
        if not path.exists():
            return []
        events = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                event = json.loads(line)
                if event.get("sequence", 0) > after:
                    events.append(event)
        return events

    def _events_path(self, conversation_id: str) -> Path:
        return self._data_dir / "record" / conversation_id / "events.ndjson"
```

---

## 6. Mapper 增强

### 6.1 当前 Mapper 支持

```text
agent_message_chunk -> agent.text.delta
agent_thought_chunk -> agent.reasoning.delta
tool_call -> agent.tool.started
tool_call_update(status=completed) -> agent.tool.completed
tool_call_update(status=failed) -> agent.tool.failed
```

### 6.2 增加的支持

1. **usage_update -> agent.context.updated**：可选事件，同时 final event 继续带 usage。
2. **plan -> agent.plan.updated**：前端暂可忽略或渲染为工具/计划块。
3. **available_commands_update / config_option_update / current_mode_update**：写入 session capability cache。
4. **文本/思考 chunk 去重**：处理完整 snapshot 重放。
5. **tool_call_update 的非 completed/failed 状态**：转为 `agent.tool.delta`，避免长命令没有中间状态。

### 6.3 文本 chunk 去重

部分 runtime 可能既发送 delta，又发送完整 snapshot。mapper 需按 `conversation_id + turn_id + channel + message_id` 维护累计文本：

```python
@dataclass
class TextDedupState:
    accumulated: str = ""

    def dedup(self, chunk: str) -> str:
        """返回实际需要追加的增量文本"""
        if not chunk:
            return ""
        if chunk == self.accumulated:
            return ""  # 完整 snapshot 重放，丢弃
        if chunk.startswith(self.accumulated):
            delta = chunk[len(self.accumulated):]
            self.accumulated = chunk
            return delta
        # 异常情况：原样追加，记录 diagnostic
        self.accumulated += chunk
        return chunk
```

### 6.4 写入 coalescer

为降低 UI 和存储压力，短时间内连续文本 delta 合并后入库：

```python
class EventCoalescer:
    """合并短时间窗口内连续文本 delta"""

    def __init__(self, window_ms: int = 50) -> None:
        self._window_ms = window_ms
        self._pending: dict[str, dict[str, Any]] = {}  # key -> coalesced event
        self._flush_tasks: dict[str, asyncio.Task] = {}

    async def feed(self, event: dict[str, Any], flush_callback: Callable) -> None:
        """喂入事件，可能合并后 flush"""
        if event["type"] not in ("agent.text.delta", "agent.reasoning.delta"):
            # 非文本事件直接 flush
            await flush_callback(event)
            return

        key = f"{event['conversationId']}:{event['turnId']}:{event['type']}"
        if key in self._pending:
            self._pending[key]["delta"] += event.get("delta", "")
        else:
            self._pending[key] = dict(event)
            self._flush_tasks[key] = asyncio.create_task(
                self._schedule_flush(key, flush_callback)
            )

    async def _schedule_flush(self, key: str, flush_callback: Callable) -> None:
        await asyncio.sleep(self._window_ms / 1000)
        event = self._pending.pop(key, None)
        if event:
            await flush_callback(event)
```

---

## 7. 初始化接口改造

### 7.1 当前问题

当前 `POST /api/sessions/{conversationId}/initialize` 临时 spawn ACP 获取 capabilities 后关闭：

```text
POST /api/sessions/{conversationId}/initialize
  -> spawn ACP process
  -> initialize
  -> session/new
  -> build SessionCapabilities
  -> close_session
  -> process exit
```

下次进入会话又要重复。

### 7.2 改造后

```text
POST /api/sessions/{conversationId}/initialize
  -> ensure_connection（复用已有 connection）
  -> ensure_session（复用已有 session 或 session/load）
  -> 返回 SessionCapabilities
  -> 不关闭 native session
```

返回中增加：

```json
{
  "agent": { ... },
  "modes": [ ... ],
  "models": [ ... ],
  "configOptions": [ ... ],
  "nativeSessionId": "019f...",
  "connectionStatus": "ready",
  "recovery": {
    "strategy": "created_new_session | loaded | resumed",
    "warning": null
  }
}
```

前端仍可忽略新增字段，但 settings/debug 面板可以展示。

---

## 8. Prompt Idle Timeout 与错误终止

### 8.1 问题

只有 HTTP 连接还在不代表 agent 仍在工作。长时间无响应时用户不知道是卡住了还是还在处理。

### 8.2 方案

```python
class AcpRuntimeConnection:
    last_activity_at: float
    prompt_idle_timeout: float = 120.0  # 秒
    pending_permission_exempt: bool = False  # 等待审批时不触发 idle timeout

# 规则：
# 1. 收到任何 text/thought/tool/usage/config update 都刷新 last_activity_at
# 2. 等待用户审批期间不触发 idle timeout
# 3. 超时后发送 ACP cancel，并输出 agent.run.failed，错误码为 idle_timeout
# 4. stderr tail 附在 metadata 中
```

---

## 9. 取消和审批走 Connection Command Channel

### 9.1 当前问题

当前 cancel 主要取消 Python task 并 reject approvals。常驻 connection 后需要更完整的命令抽象。

### 9.2 方案

```python
@dataclass
class PromptCommand:
    """Connection 级命令"""
    kind: str  # "send_prompt" | "cancel_prompt" | "respond_permission" | "disconnect"
    payload: dict[str, Any]

class AcpRuntimeConnection:
    command_queue: asyncio.Queue[PromptCommand]

    async def send_command(self, command: PromptCommand) -> None:
        await self.command_queue.put(command)

# 这样 request_permission 中等待的 future、ACP response、UI decision、cancel 都在同一 connection 上收束，
# 避免出现 task 被取消但 ACP permission 还挂着的状态。
```

---

## 10. 禁止产品态按需 npx

当前 Codex fallback 可以通过 `npx -y @agentclientprotocol/codex-acp` 按需启动。产品体验上应调整为：

1. 设置页检测到缺失时提示安装托管 ACP package。
2. 对话运行只使用固定路径或用户显式 custom command。
3. `npx` 只允许在 dev/debug 模式使用，UI 文案明确说明会慢且版本可能漂移。

---

## 11. 分阶段落地计划

### 阶段 1：性能止血（1-2 天）

目标：去掉每轮启动的最大延迟。

1. 实现 `AcpRuntimeManager.ensure_connection()`。
2. `AcpAgentAdapter.stream_turn()` 复用 connection。
3. `initialize_session` 不再 close session。
4. 保存内存级 `conversationId -> nativeSessionId`。
5. 增加 stderr ring buffer 和 handshake timeout。

验收：

1. 同一 backend 生命周期内，连续两轮 Codex 对话不再重复 spawn ACP 子进程。
2. 第二轮首 token 延迟明显低于第一轮。
3. `agent.run.completed.result.nativeSessionId` 多轮保持一致。

### 阶段 2：会话恢复和配置缓存（2-3 天）

目标：让 UI conversation 与 native ACP session 绑定稳定。

1. 新增 `native-session.json`。
2. backend 重启后优先 `session/load` 或 `session/resume`。
3. load 失败时创建新 native session，并发出 session notice。
4. capabilities 缓存在 session binding 中。
5. settings 页标明当前 runtime connection / session 状态。

验收：

1. 重启 backend 后打开旧 conversation 能恢复或明确提示无法恢复。
2. capabilities 不再通过临时 probe 获取。
3. 发送 turn 时能复用旧 native session 或清楚记录新建原因。

### 阶段 3：事件优先存储（2-3 天）

目标：为远程同步和审计打基础。

1. 写入 `events.ndjson`。
2. 为事件增加 `eventId`、`sequence`、`createdAt`、`runtime`、`nativeSessionId`。
3. 保持 `messages.json` 作为投影兼容输出。
4. 增加 `GET /api/conversations/{id}/events?after=sequence`。
5. 前端可以在 reload 后用 events 补偿缺失片段。

验收：

1. 任一 turn 完成后，`events.ndjson` 可重放生成同等 `messages.json`。
2. 远程 viewer 可以通过 sequence 补事件。
3. backend 中断时已写入事件不丢失。

### 阶段 4：流式质量和工具展示（2-3 天）

目标：解决文本重复、工具状态粗糙和 usage 展示不足。

1. 实现 stream snapshot 去重。
2. 实现文本 delta 写入合并。
3. 支持 `agent.context.updated` 事件。
4. 支持 `agent.tool.delta`。
5. 支持 plan update 的专用 UI 或稳定降级。

验收：

1. Codex ACP 不再出现末尾整段重复。
2. 长输出下 UI 无明显卡顿。
3. usage/context 在 turn 中可更新，最终消息也能显示总量。

### 阶段 5：Context Ring 上下文展示（1-2 天）

目标：在输入框右下角模型选择器左侧增加上下文窗口占用小圆环。

1. 扩展 `UsageStats` 类型，增加 `contextUsedTokens` 和 `contextWindowTokens`。
2. Backend `agent.run.completed.usage` 和新增 `agent.context.updated` 事件携带 context 数据。
3. 前端 `ChatPage` 维护当前会话的 context usage state。
4. 实现 `ContextRing` 组件：SVG 圆环 + 百分比标签 + tooltip。
5. 集成到 `ChatComposer` 的 `composer-right` 区域，位于模型选择器左侧。
6. 无数据时自动隐藏。

验收：

1. 模型选择器左侧显示 context ring 圆环。
2. 颜色随使用比例变化（正常/警告/危险）。
3. Hover 显示详细 token 数。
4. 无 usage 数据时圆环隐藏。

### 阶段 6：新会话 Agent 选择 + 移除 "启用 Agent"（2-3 天）

目标：创建新会话时前置 agent 选择，移除全局 "启用 agent" 机制。

1. 新增 `POST /api/conversations` 接口，创建时绑定 `agentId`。
2. 后端 `stream_turn` 从会话的 `session.agent` 解析 runtime（不再依赖 `activeAdapter`）。
3. 前端新增 `AgentSelectionPanel` 组件：屏幕中间的 agent 选择卡片。
4. `createSession()` 改为弹出选择面板，确认后才创建会话。
5. 设置页移除 "启用" / "当前使用" 按钮。
6. 移除 `updateActiveAgentRuntime()` 和 `POST /api/agent-runtimes/{id}/activate` API。
7. `session.agent` 从可选变为必填。
8. 旧会话兼容：无 agent 字段时引导用户创建新会话。

验收：

1. 点击 "+" 创建新会话时弹出 agent 选择面板。
2. 选择 agent 后创建会话，agent 绑定到 session。
3. 发送消息时始终使用绑定的 agent。
4. 设置页不再有 "启用" 按钮。
5. 已有会话恢复时直接使用绑定的 agent。

### 阶段 7：后续 SQLite 化评估（按需）

目标：判断是否从 JSON/NDJSON 迁移到 SQLite。

触发条件：

1. conversation 数量或事件量明显增长。
2. 远程同步需要高效分页和多索引查询。
3. reset-to-turn、fork、导入导出、checkpoint diff 成为核心功能。

迁移方向可参考 VibeX：

```text
agent_connections
agent_sessions
agent_prompts
agent_events
conversation_agent_bindings
conversation_turns
conversation_events
conversation_tool_calls
conversation_permissions
conversation_terminals
conversation_projection_snapshots
```

---

## 12. 上下文窗口占用展示：Context Ring

### 12.1 设计目标

在输入框右下角的模型选择器左侧增加一个**小圆环**，用于实时展示上下文窗口占用情况。用户可以直观看到当前会话消耗了多少 context window，以及剩余可用空间。

### 12.2 数据来源

上下文数据来自 ACP `usage_update`，在 `agent.run.completed` 中也会携带最新 usage。当前 backend 的 `UsageSnapshot` 已经提取了 `context_used_tokens` 和 `context_window_tokens`，但没有通过事件传递到前端。

需要增加的传递链路：

```text
ACP usage_update
  -> AcpClientHandler 缓存 UsageSnapshot
  -> agent.run.completed.usage 或 新增 agent.context.updated 事件
  -> 前端接收并更新 ContextRing
```

前端 `UsageStats` 类型需要扩展：

```typescript
interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;      // 新增
  contextWindowTokens?: number;    // 新增
}
```

### 12.3 UI 位置

```text
composer-actions
  composer-left
    [附件按钮] [权限模式]
  composer-right
    [ContextRing] [模型选择器] [发送按钮]
```

Context Ring 位于 `composer-right` 区域，在模型选择器（`status-chip`）的左侧，发送按钮的左侧。

### 12.4 圆环设计

```text
         24px diameter
    ┌──────────────────┐
    │   ╭──────────╮   │
    │  ╱  ████████  ╲  │  外环：context window 总量
    │ │  ░░░░░░░░░░  │ │  内环填充：已使用的比例
    │  ╲  ████████  ╱  │
    │   ╰──────────╯   │
    │     53%           │  中心文字：使用百分比
    └──────────────────┘
```

- **尺寸**：24x24px 圆环
- **外环**：灰色底环，代表 context window 总量
- **填充弧**：根据 `contextUsedTokens / contextWindowTokens` 比例绘制
- **颜色**：
  - < 50%：正常色（如 `var(--color-accent)`）
  - 50%-80%：警告色（如 `var(--color-warning)`）
  - \> 80%：危险色（如 `var(--color-danger)`）
- **中心文字**：使用百分比，如 "53%"
- **hover tooltip**：显示详细数据，如 "已用 137,216 / 258,400 tokens"

### 12.5 前端实现

```tsx
interface ContextRingProps {
  usedTokens?: number;
  windowTokens?: number;
}

function ContextRing({ usedTokens, windowTokens }: ContextRingProps) {
  if (!usedTokens || !windowTokens || windowTokens === 0) {
    return null; // 无数据时隐藏
  }

  const ratio = usedTokens / windowTokens;
  const percent = Math.round(ratio * 100);
  const color = ratio > 0.8 ? "danger" : ratio > 0.5 ? "warning" : "normal";

  // SVG 圆环：使用 stroke-dasharray 绘制弧形
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  return (
    <div className="context-ring" title={`已用 ${usedTokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens`}>
      <svg width="24" height="24" viewBox="0 0 24 24">
        {/* 底环 */}
        <circle cx="12" cy="12" r={radius} fill="none" stroke="var(--color-border)" strokeWidth="2" />
        {/* 填充弧 */}
        <circle
          cx="12" cy="12" r={radius}
          fill="none"
          stroke={`var(--color-${color})`}
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
        />
      </svg>
      <span className="context-ring-label">{percent}%</span>
    </div>
  );
}
```

### 12.6 数据更新时机

1. **turn 开始时**：保持上一次 usage 数据（不重置）
2. **收到 `agent.context.updated` 事件**：实时更新圆环
3. **收到 `agent.run.completed` 事件**：用最终 usage 更新圆环
4. **切换会话**：加载该会话的最后 usage 快照

### 12.7 兼容策略

- 如果 runtime 未发送 usage 数据（如 opencode 暂未验证），圆环自动隐藏
- 旧会话没有 usage 数据时，圆环不显示
- 前端 `UsageStats` 的 `contextUsedTokens` 和 `contextWindowTokens` 为可选字段，不影响现有类型

---

## 13. 新会话创建流程：Agent 选择前置

### 13.1 当前问题

当前新会话创建流程：

```text
点击 "+" 创建新会话
  -> 创建 DRAFT_SESSION
  -> 进入聊天界面
  -> 使用全局 activeAdapter 作为 agent
  -> 发送消息时才 spawn ACP 并确定 runtime
```

问题：

1. **Agent 绑定太晚**：用户在发送消息前不知道当前使用哪个 agent。
2. **全局 activeAdapter**：设置中的 "启用" agent 是全局概念，但每个会话可能需要不同 agent。
3. **会话与 agent 没有显式绑定**：`session.agent` 字段存在但没有在创建时确定。

### 13.2 新流程设计

```text
点击 "+" 创建新会话
  -> 屏幕中间弹出 Agent 选择面板
  -> 用户选择 agent（Codex / Claude Code / opencode / nanobot）
  -> 确认选择
  -> 创建会话并绑定 agent（session.agent = 选中的 agent）
  -> 进入聊天界面
  -> 后续所有 turn 使用绑定的 agent
  -> agent 不可更改（会话兼容后续再做）
```

### 13.3 Agent 选择面板

在屏幕中间显示一个选择面板：

```text
┌─────────────────────────────────────────────┐
│                                             │
│         选择 Agent 开始新会话               │
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │   Cx    │  │   Cl    │  │   Op    │   │
│  │  Codex  │  │ Claude  │  │opencode │   │
│  │  Code   │  │  Code   │  │         │   │
│  └─────────┘  └─────────┘  └─────────┘   │
│                                             │
│  ┌─────────┐                                │
│  │   Nb    │                                │
│  │ Nanobot │                                │
│  │ (legacy)│                                │
│  └─────────┘                                │
│                                             │
│  选择后此会话将始终使用该 Agent              │
│                                             │
└─────────────────────────────────────────────┘
```

每个 agent 卡片显示：

- **图标**：运行时缩写（Cx / Cl / Op / Nb）
- **名称**：Codex / Claude Code / opencode / Nanobot
- **状态**：可用 / 需配置 / 实验性
- **点击选中**：高亮选中状态，点击 "开始" 或双击卡片确认

### 13.4 恢复已有会话

当用户点击侧边栏的已有会话时：

```text
点击已有会话
  -> 读取 session.agent
  -> 使用该 agent 初始化（调用 POST /api/sessions/{id}/initialize）
  -> 进入聊天界面
  -> 后续 turn 使用绑定的 agent
```

已有会话的 `session.agent` 在创建时已确定，恢复时不需要再选择。

### 13.5 Session 数据结构变更

```typescript
interface Session {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  agent: AgentSummary;     // 必填，创建时确定
  archived?: boolean;
}
```

`agent` 从可选变为必填。创建会话时必须指定 agent。

### 13.6 移除 "启用 Agent" 机制

当前设置页有 `isActive` 和 "启用" 按钮（`updateActiveAgentRuntime`），用于全局切换当前使用的 agent。新流程下：

1. **移除设置页的 "启用" 按钮**：每个会话自带 agent，不需要全局 "当前使用"。
2. **移除 `activeAdapter` 概念**：后端不再维护全局 activeAdapter，改为从会话的 `session.agent` 解析。
3. **保留 Agent Runtime 配置**：设置页仍然管理各 runtime 的安装、命令、环境变量、模式等，只是不再有 "激活" 操作。

设置页 "Agent Runtime" 区块调整：

```text
Agent Runtime 设置
  ┌──────────────────────────────────────────┐
  │  Codex (Cx)                              │
  │  状态：可用                              │
  │  命令：codex-acp                         │
  │  模式：read-only                         │
  │  配置来源：user-native                   │
  │  [安装 ACP 包] [保存配置]                │
  ├──────────────────────────────────────────┤
  │  Claude Code (Cl)                        │
  │  状态：需配置                            │
  │  [安装 ACP 包]                           │
  ├──────────────────────────────────────────┤
  │  opencode (Op)                           │
  │  状态：待接入                            │
  ├──────────────────────────────────────────┤
  │  Nanobot (Nb)                            │
  │  状态：可用 (legacy)                     │
  └──────────────────────────────────────────┘
```

不再有 "已启用" / "启用" 按钮。

### 13.7 后端适配

`POST /api/turns/stream` 的 agent 解析逻辑需要调整：

```text
当前：
  1. 从 conversation 的 agent 字段解析
  2. 如果没有，从 agent_runtime_config_store.activeAdapter() 解析

新流程：
  1. 从 conversation 的 agent 字段解析（必填）
  2. 如果没有 agent 字段（旧会话兼容），从请求中携带的 agentId 解析
  3. 如果仍没有，返回错误提示用户创建新会话时选择 agent
```

创建会话接口调整：

```text
POST /api/conversations
  body: { "agentId": "codex", "title": "...", "preview": "..." }
  -> 创建会话并绑定 agent
  -> 返回 Session with agent
```

### 13.8 前端流程变更

`createSession()` 函数改造：

```typescript
function createSession() {
  // 1. 弹出 Agent 选择面板（而非直接创建 draft session）
  setAgentSelectionVisible(true);
}

// Agent 选择确认回调
async function confirmAgentSelection(agentId: string) {
  setAgentSelectionVisible(false);

  // 2. 调用后端创建会话
  const session = await createConversation({ agentId, title: "新的会话", preview: "" });

  // 3. 进入聊天界面
  setSessions((current) => [session, ...current]);
  setActiveSessionId(session.id);
  setMessages((current) => ({ ...current, [session.id]: [] }));
  setActiveView("chat");
}
```

### 13.9 旧会话兼容

旧会话可能没有 `agent` 字段：

1. 加载旧会话时，如果 `session.agent` 为 null，从会话历史推断（如之前的 `sessionAgent` 状态）。
2. 如果无法推断，标记为 "未知 agent"，用户可以选择：
   - 使用当前默认 runtime 继续（创建新 native session）
   - 归档此会话

### 13.10 Agent 不可更改

会话创建后 agent 不可更改。原因：

1. 不同 agent 的 native session 不兼容。
2. 消息格式和工具调用可能不同。
3. 多轮对话的上下文连续性依赖同一 runtime。

后续如需 "会话兼容"（如从 Codex 切换到 Claude Code），需要设计会话迁移/导出/导入机制，不在本次设计范围内。

---

## 14. 移除 "启用 Agent" 机制

### 14.1 当前实现

当前 `AgentRuntimeConfig` 有 `isActive` 字段，设置页有 "启用" 按钮：

```typescript
// 设置页
<button
  disabled={selectedRuntime.isActive}
  onClick={() => void activateRuntime(selectedRuntime)}
>
  <Check size={14} />
  <span>{selectedRuntime.isActive ? "当前使用" : "启用"}</span>
</button>
```

后端 API：

```text
POST /api/agent-runtimes/{runtime_id}/activate
  -> 更新 agent_runtimes.json 的 activeAdapter
```

### 14.2 移除原因

1. **会话自带 agent**：每个会话在创建时绑定 agent，不需要全局 "当前使用"。
2. **简化概念**：用户不需要理解 "启用 agent" 和 "会话 agent" 的区别。
3. **减少误操作**：避免用户在设置中切换 agent 后，旧会话的 agent 也发生变化。

### 14.3 移除范围

**后端**：

1. 移除 `AgentRuntimeConfigStore.active_adapter()` 的全局概念（保留 fallback 逻辑供旧会话兼容）。
2. 移除 `POST /api/agent-runtimes/{runtime_id}/activate` API。
3. `AgentRuntimeConfig` 的 `isActive` 字段标记为 deprecated，新代码不依赖。

**前端**：

1. 移除设置页的 "启用" / "当前使用" 按钮。
2. 移除 `updateActiveAgentRuntime()` API 调用。
3. Agent Runtime 设置页改为纯配置管理，不再有 "激活" 操作。

### 14.4 替代方案

用户通过以下方式选择 agent：

1. **创建新会话时**：在 Agent 选择面板中选择。
2. **查看已有会话**：从 `session.agent` 读取，显示在 ConversationHeader。
3. **切换 agent**：创建新会话并选择不同 agent。

---

## 15. 风险与待验证项

| 风险 | 说明 | 建议 |
|------|------|------|
| ACP Python SDK 是否适合长期持有 connection | 当前 demo 多为短连接 probe | 做一个最小常驻连接 spike |
| codex-acp 的 `session/load` 行为 | 需要确认版本差异和失败码 | 对当前固定版本做 smoke test |
| 常驻 process 的资源释放 | backend 退出、runtime 切换、workspace 切换都要清理 | FastAPI lifespan 中统一关闭 |
| 多 conversation 复用同 connection | 同 runtime/workspace 可复用，但 session 要隔离 | 先按 workspace + runtime 复用，后续评估 |
| 环境变量含敏感信息 | env fingerprint 不能记录 key 原文 | 只记录 key 名和脱敏 hash |
| 事件日志膨胀 | 长任务 delta 很多 | 写入 coalescer 和截断策略 |
| 旧 JSON 会话兼容 | 旧会话没有 native binding 和 events | 支持 messages-only 读取，首次新 turn 再创建 binding |
| usage_update 不一定发送 | 部分 runtime 可能不发 usage | Context Ring 无数据时自动隐藏 |
| Agent 选择面板打断创建流程 | 用户可能觉得多了一步 | 保持面板简洁，支持键盘选择和双击确认 |
| 旧会话缺少 agent 字段 | 早期会话没有绑定 agent | 加载时推断或标记 "未知"，引导用户创建新会话 |
| 移除 activeAdapter 影响范围 | 部分代码可能依赖全局 activeAdapter | 保留 fallback 兼容层，逐步清理 |

---

## 16. 核心结论

1. **优先修复每轮临时 spawn ACP + 每轮新 session**：这是当前"慢"和"不像连续对话"的主要原因。建议把 VibeX 的 ACP runtime 生命周期设计作为下一轮重构重点，优先实现 Python 版常驻 `AcpRuntimeManager`。

2. **存储方面，不建议一步到位照搬 VibeX SQLite 全表结构**：更适合 code-lite 当前阶段的方案是：
   - 短期：JSON session/messages + NDJSON product events + native-session binding
   - 中期：events-first projection
   - 长期：按远程同步和审计需求评估 SQLite event sourcing

3. **渐进迁移**：保持 `messages.json` 兼容，新增 `events.ndjson` 作为 event-first 基础，后续按实际需求决定是否迁移 SQLite。

4. **流式质量提升**：通过去重和 coalescer 解决文本重复和 UI 卡顿问题。

5. **会话恢复**：通过 `native-session.json` 和 `session/load` 实现 backend 重启后的会话恢复。

6. **上下文可视化**：Context Ring 小圆环让用户直观看到 context window 占用情况，避免上下文溢出后才发现问题。数据来源复用已有的 `usage_update`，无数据时自动隐藏。

7. **会话级 Agent 绑定**：创建新会话时前置 agent 选择，每个会话绑定一个固定 agent，不再依赖全局 "启用 agent"。简化用户心智模型，避免设置页切换 agent 导致旧会话行为变化。

8. **移除 "启用 Agent"**：设置页回归纯配置管理，不再有 "激活/启用" 概念。用户通过创建新会话时选择 agent 来决定使用哪个 runtime。

---

## 17. 参考

1. `docs/research/0703-VIBEX-ACP-RESEARCH.md` — VibeX ACP Runtime 与会话存储借鉴研究
2. `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md` — ACP Agent Adapter 实施设计
3. `docs/design/0703-AGENT-UNIFIED-ACP.md` — ACP 大一统适配设计
4. `docs/design/0702-REMOTE-SYNC.md` — 远程连接与同步观看设计
5. `docs/refactor/0703-RUNTIME-DATA-CHAT-UI.md` — 运行时数据与聊天 UI 优化设计
