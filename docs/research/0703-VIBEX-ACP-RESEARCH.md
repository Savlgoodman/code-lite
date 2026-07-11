# VibeX ACP Runtime 与会话存储借鉴研究

调研日期：2026-07-03

本文记录对 `ref/VibeX-master` 中 ACP adapter、对话记录和结果存储方式的对照研究，并收敛为 code-lite 可执行的改进方案。本文只作为研究和后续重构输入，不替代主实施入口 `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`。

## 1. 背景

code-lite 已完成 Codex ACP 接入，但当前体验仍有明显问题：

1. 进入会话和发送消息都有明显等待。
2. 多轮对话的连续性不稳定，UI 会话和 runtime native session 没有形成清晰绑定。
3. 流式事件、工具调用、审批、usage 和最终消息的存储还偏早期原型。
4. 后续远程同步观看需要可补偿、可回放的事件序列，而不是只依赖最终 `messages.json`。

本次调研重点不是比较 Rust 与 Python 技术栈，而是比较成熟 ACP 工作台在以下方面的产品工程做法：

1. ACP 子进程和连接生命周期。
2. ACP session 与产品 conversation 的绑定方式。
3. prompt 队列、取消、审批和超时处理。
4. live event、runtime audit log、product conversation log 的分层。
5. 对话结果如何落盘并重建 UI timeline。

## 2. 参考范围

本地参考项目：

```text
ref/VibeX-master
```

重点阅读文件：

| 路径 | 关注点 |
| --- | --- |
| `ref/VibeX-master/crates/agents/src/runtime.rs` | 常驻 `AgentRuntime`、连接快照、session 快照、prompt 队列 |
| `ref/VibeX-master/crates/agents/src/manager.rs` | ACP 子进程启动、initialize、session/new、session/load、prompt、cancel、permission |
| `ref/VibeX-master/crates/agents/src/session.rs` | `AgentPromptQueue`，同一 session 内 prompt 串行化 |
| `ref/VibeX-master/crates/agents/src/conversation.rs` | 产品级 conversation event、timeline、usage、工具、审批、终端模型 |
| `ref/VibeX-master/src-tauri/src/events.rs` | runtime event 到 conversation event 的映射、合并、入库和前端广播 |
| `ref/VibeX-master/src-tauri/src/conversation_service.rs` | start turn、绑定 ACP session、取消、截断和 checkpoint diff |
| `ref/VibeX-master/crates/db/migrations/20260611000000_create_agent_runtime_tables.sql` | runtime audit 表 |
| `ref/VibeX-master/crates/db/migrations/20260616000000_event_sourced_conversation_core.sql` | conversation event sourcing 表 |
| `ref/VibeX-master/frontend/src/features/conversation/conversationStore.ts` | 前端按 conversation event 增量折叠 timeline |

code-lite 对照文件：

| 路径 | 当前现状 |
| --- | --- |
| `backend/code_lite_backend/agents/acp/adapter.py` | 每轮 prompt 临时 spawn ACP 子进程和创建 session |
| `backend/code_lite_backend/api/routes/sessions.py` | 初始化 capabilities 时临时 spawn ACP、`session/new` 后关闭 |
| `backend/code_lite_backend/services/agent_runtime_config.py` | Codex 可 fallback 到 `npx -y @agentclientprotocol/codex-acp` |
| `backend/code_lite_backend/services/conversation_recorder.py` | turn 期间内存折叠，完成或失败后写 `session.json` / `messages.json` |
| `backend/code_lite_backend/storage/conversations.py` | 每个 conversation 一个目录，JSON 文件原子替换 |
| `backend/code_lite_backend/agents/acp/mapper.py` | ACP update 到当前 `AgentEvent` 的初版映射 |

## 3. 核心发现

### 3.1 当前 code-lite 的主要体验瓶颈

当前 code-lite 的 ACP 路径仍是临时会话模型：

```text
POST /api/sessions/{conversationId}/initialize
  -> spawn ACP process
  -> initialize
  -> session/new
  -> build SessionCapabilities
  -> close_session
  -> process exit

POST /api/turns/stream
  -> spawn ACP process
  -> initialize
  -> session/new
  -> set mode/model/config
  -> prompt
  -> close_session
  -> process exit
```

这会导致：

1. **每次进入会话都要握手**：capabilities 获取成本高。
2. **每轮消息都要重启 runtime**：Codex ACP、Node/npm shim、Codex app server 初始化都会进入用户可感知延迟。
3. **UI conversation 与 native ACP session 不一致**：前端看起来是多轮对话，但 runtime 侧每轮可能都是新 session。
4. **无法稳定使用 `session/load` / `session/resume`**：没有持久保存 native session 绑定，也没有 session 状态机。
5. **取消和审批只能绑定当前 task**：没有 connection 级 command channel，复杂情况下容易出现 pending approval 清理不完整。

因此用户感觉“反应慢、别扭”并不只是 UI 问题，核心是 runtime 生命周期还停留在 probe / demo 形态。

### 3.2 VibeX 的 ACP runtime 是常驻连接模型

VibeX 的核心不是“每个 turn 调一次 ACP”，而是：

```text
AgentRuntime
  -> AgentConnectionManager
  -> run_acp 常驻子进程
  -> initialize 后标记 connection ready
  -> ensure_acp_session / load_or_new_acp_session
  -> run_prompt
  -> prompt 完成后 connection/session 继续保留
```

关键特征：

1. connection 和 session 都有独立快照。
2. ACP handshake 成功后才把 connection 标记为 ready，避免首条 prompt 发给即将失败的子进程。
3. 同一产品 session 复用同一 native ACP session。
4. 支持 `session/load`，失败后有明确 `SessionLoadFailureReason`。
5. 同一 session 的 prompt 使用队列串行化。
6. prompt 运行期间可以响应 cancel 和 permission decision。
7. 有 handshake timeout、prompt idle timeout、stderr ring buffer。

这套模型值得 code-lite 借鉴，且可以在 Python backend 中实现，不需要改成 Rust。

### 3.3 VibeX 把 runtime event 和 product conversation event 分层

VibeX 不把 ACP 原始事件直接当 UI 最终数据，而是分成两层：

```text
AgentEvent
  runtime 层事件：connection、session、prompt、ACP update、permission、terminal、error

ConversationEvent
  产品层事件：UserTurnCreated、AssistantTextDelta、ToolCallUpsert、
  PermissionRequested、UsageUpdated、TurnCompleted、FileChangeSummaryUpdated
```

`agent_events` 是 runtime/debug audit log，并且跳过高频 streaming chunk，避免 SQLite 写锁被 token 流打爆。

`conversation_events` 是产品对话的 append-only log，带：

1. `conversation_id`
2. `turn_id`
3. `sequence`
4. `source`
5. `event_kind`
6. `normalized_json`
7. `raw_json`
8. `idempotency_key`

前端不是直接消费最终 messages 文件，而是用 conversation event 增量折叠 timeline，并能检测 sequence gap。

对 code-lite 的启发是：远程同步和本地恢复不应只依赖 `messages.json`，应至少有一条可补偿的产品事件日志。

### 3.4 VibeX 对流式文本做了两个层面的降噪

VibeX 有两个不同目的的流式优化：

1. **ACP stream 去重**：处理 codex-acp 可能在 delta 后重放完整 message snapshot 的情况，避免文本重复。
2. **conversation event coalescer**：把短时间窗口内连续文本 delta 合并后入库和广播，降低写入压力，但仍保持接近 token 级实时感。

code-lite 当前 `AcpEventMapper` 直接把 `agent_message_chunk` 映射为 `agent.text.delta`，暂未实现 snapshot 去重和写入合并。后续真实长任务中容易出现：

1. 文本重复。
2. 消息区频繁 rerender。
3. 事件日志过碎。
4. 远程同步压力过大。

### 3.5 VibeX 的存储比 code-lite 当前方案更适合远程同步

code-lite 当前落盘方式是：

```text
record/<conversationId>/
  session.json
  messages.json
```

`ConversationRecorder` 在流式阶段主要维护内存态，收到 completed / failed 后写最终 JSON。这对 MVP 简单有效，但有局限：

1. backend 中断时，未完成 turn 的可恢复信息较少。
2. 远程 viewer 需要从当前 NDJSON 直播流接入，缺少统一补偿入口。
3. 审批、工具、usage、native session 绑定、错误恢复等信息会被折叠进消息对象，审计粒度不足。
4. 后续 reset-to-turn、fork、导出、导入、跨端同步都缺少 append-only 基础。

VibeX 使用 event sourcing 加 projection。code-lite 不一定立即上 SQLite，但应借鉴“事件是事实，messages 是投影”的方向。

## 4. 是否值得借鉴

结论：**值得借鉴，而且优先级很高；但不应整套照搬。**

### 4.1 立即值得借鉴

| 借鉴项 | 价值 | code-lite 落地方式 |
| --- | --- | --- |
| 常驻 ACP connection | 降低每轮启动和握手延迟 | 新增 `AcpRuntimeManager`，按 runtime + workspace 复用连接 |
| 产品 conversation 到 native ACP session 绑定 | 保证多轮上下文连续 | 保存 `conversationId -> nativeSessionId` |
| prompt 队列 | 避免同 session 并发 prompt 搞乱状态 | 每个 conversation 一个 async queue / lock |
| capabilities cache | 避免进入会话反复临时 probe | `initialize_session` 改为 ensure 并缓存 session result |
| `session/load` / `session/resume` | backend 重启后恢复 native session | runtime 支持时优先 load，失败时创建新 session 并发 notice |
| handshake timeout + idle timeout | 避免无限“生成中” | 在 runtime manager 和 prompt loop 中实现 |
| stderr ring buffer | 失败时可诊断 | 保留最近 N 行 stderr 放入错误 metadata |
| stream snapshot 去重 | 避免 Codex 文本重复 | mapper 增加按 session/channel 的累计文本状态 |
| streaming coalescer | 降低 UI 和存储压力 | NDJSON 仍实时，落盘事件按小窗口合并 |
| append-only event log | 支持恢复和远程同步 | 先落 `events.ndjson`，后续再迁移 SQLite |

### 4.2 暂不应照搬

| VibeX 做法 | 暂不照搬原因 | code-lite 替代路径 |
| --- | --- | --- |
| Rust ACP client 全实现 | code-lite 已有 Python backend 和官方 Python SDK | 继续用 `agent-client-protocol` Python SDK |
| SQLite 全量 conversation event sourcing | 当前项目仍在原型阶段，直接换库影响面大 | 先用 JSON + NDJSON 轻量事件日志 |
| Tauri command 直连 runtime | code-lite 当前 UI 到 FastAPI NDJSON 已可用 | 保留 FastAPI sidecar |
| 完整 checkpoint diff 和 reset-to-turn | 需要更成熟的 workspace/git 管理 | 后续远程协作阶段再设计 |
| agent runtime 多表审计模型 | 对 MVP 偏重 | 先保留 stderr tail、event log 和 native session binding |

## 5. code-lite 改进方案

### 5.1 新增 AcpRuntimeManager

建议在 Python backend 新增：

```text
backend/code_lite_backend/agents/acp/
  runtime_manager.py
  connection.py
  session_store.py
  coalescer.py
```

核心对象：

```text
AcpRuntimeManager
  connections: dict[ConnectionKey, AcpRuntimeConnection]
  session_bindings: dict[conversationId, AcpSessionBinding]
  turn_locks: dict[conversationId, asyncio.Lock]
```

`ConnectionKey` 建议包含：

```text
runtime_id
workspace
config_mode
command fingerprint
env fingerprint without secrets
```

`AcpRuntimeConnection` 持有：

```text
descriptor
command
env
process
sdk_connection
initialize_result
stderr_ring_buffer
latest_activity_at
sessions: conversationId -> nativeSessionId
capabilities_cache
```

生命周期：

```text
ensure_connection()
  -> 已有 ready connection 则复用
  -> 否则 spawn ACP process
  -> initialize
  -> 标记 ready

ensure_session(conversationId)
  -> 已绑定 nativeSessionId 则复用
  -> 如 runtime 支持 loadSession，尝试 session/load
  -> 否则 session/new
  -> 保存 binding 和 capabilities

stream_turn()
  -> 获取 conversation lock
  -> ensure_connection
  -> ensure_session
  -> apply selectedMode / selectedConfig
  -> prompt
  -> prompt 结束后保留 connection/session
```

这样能直接移除每轮 `spawn -> initialize -> new_session -> close` 的主要延迟。

### 5.2 初始化接口改为真正的 session ensure

当前 `POST /api/sessions/{conversationId}/initialize` 不应只是 probe。建议改为：

```text
POST /api/sessions/{conversationId}/initialize
  -> ensure_connection
  -> ensure_session
  -> 返回 SessionCapabilities
  -> 不关闭 native session
```

返回中建议增加：

```json
{
  "nativeSessionId": "...",
  "connectionStatus": "ready",
  "recovery": {
    "strategy": "created_new_session | loaded | resumed",
    "warning": null
  }
}
```

前端仍可忽略新增字段，但 settings/debug 面板可以展示。

### 5.3 禁止产品态按需 npx

当前 Codex fallback 可以通过 `npx -y @agentclientprotocol/codex-acp` 按需启动。开发期可以保留，但产品体验上应调整为：

1. 设置页检测到缺失时提示安装托管 ACP package。
2. 对话运行只使用固定路径或用户显式 custom command。
3. `npx` 只允许在 dev/debug 模式使用，UI 文案明确说明会慢且版本可能漂移。

这和已有设计文档方向一致，但应作为性能改进的前置条件。

### 5.4 事件存储从 messages-only 改为 event-first

短期不必立即上 SQLite，可先扩展当前目录：

```text
record/<conversationId>/
  session.json
  messages.json
  events.ndjson
  native-session.json
```

`events.ndjson` 记录产品级事件，不是原始 ACP JSON-RPC：

```json
{"eventId":"evt_...","sequence":1,"createdAt":"2026-07-03T15:00:00Z","type":"conversation.turn.started",...}
{"eventId":"evt_...","sequence":2,"createdAt":"2026-07-03T15:00:01Z","type":"agent.text.delta","delta":"..."}
{"eventId":"evt_...","sequence":3,"createdAt":"2026-07-03T15:00:02Z","type":"agent.run.completed",...}
```

`native-session.json` 保存非敏感绑定：

```json
{
  "conversationId": "...",
  "runtimeId": "codex-acp",
  "nativeSessionId": "...",
  "workspace": "H:/code-lite",
  "configMode": "user-native",
  "createdAt": "...",
  "updatedAt": "..."
}
```

禁止保存 API key、token、账号密码、私钥。

`messages.json` 变成投影结果：

```text
events.ndjson -> ConversationRecorder / Projector -> messages.json
```

MVP 兼容策略：

1. 写事件时继续维护 `messages.json`，不破坏现有 UI。
2. 读取旧会话时如果没有 `events.ndjson`，仍读 `messages.json`。
3. 新会话生成 `events.ndjson`，后续可用它重建 `messages.json`。

### 5.5 Mapper 增加去重和更完整的 ACP update 支持

当前 mapper 主要支持：

```text
agent_message_chunk
agent_thought_chunk
tool_call
tool_call_update
usage_update 内部缓存
request_permission
```

建议增加：

1. `usage_update -> agent.context.updated` 可选事件，同时 final event 继续带 usage。
2. `plan -> agent.plan.updated`，前端暂可忽略或渲染为工具/计划块。
3. `available_commands_update`、`config_option_update`、`current_mode_update` 写入 session capability cache。
4. 文本/思考 chunk 去重，处理完整 snapshot 重放。
5. `tool_call_update` 的非 completed / failed 状态转为 `agent.tool.delta`，避免长命令没有中间状态。

### 5.6 增加 prompt idle timeout 和错误终止事件

VibeX 的经验是：只有 HTTP 连接还在不代表 agent 仍在工作。code-lite 应增加：

```text
last_activity_at
prompt_idle_timeout
pending_permission_exempt
```

规则：

1. 收到任何 text/thought/tool/usage/config update 都刷新 `last_activity_at`。
2. 等待用户审批期间不触发 idle timeout。
3. 超时后发送 ACP cancel，并输出 `agent.run.failed`，错误码为 `idle_timeout`。
4. stderr tail 附在 metadata 中，便于判断认证、代理、网络或模型不可达问题。

### 5.7 取消和审批走 connection command channel

当前 cancel 主要取消 Python task 并 reject approvals。常驻 connection 后建议抽象命令：

```text
PromptCommand
  SendPrompt
  CancelPrompt
  RespondPermission
  Disconnect
```

这样 `request_permission` 中等待的 future、ACP response、UI decision、cancel 都在同一 connection 上收束，避免出现 task 被取消但 ACP permission 还挂着的状态。

## 6. 分阶段落地计划

### 阶段 1：性能止血

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

### 阶段 2：会话恢复和配置缓存

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

### 阶段 3：事件优先存储

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

### 阶段 4：流式质量和工具展示

目标：解决文本重复、工具状态粗糙和 usage 展示不足。

1. 实现 stream snapshot 去重。
2. 实现文本 delta 写入合并。
3. 支持 `agent.context.updated`。
4. 支持 `agent.tool.delta`。
5. 支持 plan update 的专用 UI 或稳定降级。

验收：

1. Codex ACP 不再出现末尾整段重复。
2. 长输出下 UI 无明显卡顿。
3. usage/context 在 turn 中可更新，最终消息也能显示总量。

### 阶段 5：后续 SQLite 化评估

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

但这应作为后续架构升级，不建议阻塞当前 ACP 体验优化。

## 7. 风险与待验证项

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| ACP Python SDK 是否适合长期持有 connection | 当前 demo 多为短连接 probe | 做一个最小常驻连接 spike |
| codex-acp 的 `session/load` 行为 | 需要确认版本差异和失败码 | 对当前固定版本做 smoke test |
| 常驻 process 的资源释放 | backend 退出、runtime 切换、workspace 切换都要清理 | FastAPI lifespan 中统一关闭 |
| 多 conversation 复用同 connection | 同 runtime/workspace 可复用，但 session 要隔离 | 先按 workspace + runtime 复用，后续评估 |
| 环境变量含敏感信息 | env fingerprint 不能记录 key 原文 | 只记录 key 名和脱敏 hash |
| 事件日志膨胀 | 长任务 delta 很多 | 写入 coalescer 和截断策略 |
| 旧 JSON 会话兼容 | 旧会话没有 native binding 和 events | 支持 messages-only 读取，首次新 turn 再创建 binding |

## 8. 最终建议

code-lite 现在最应优先修复的是：

```text
每轮临时 spawn ACP + 每轮新 session
```

这是当前“慢”和“不像连续对话”的主要原因。建议把 VibeX 的 ACP runtime 生命周期设计作为下一轮重构重点，优先实现 Python 版常驻 `AcpRuntimeManager`。

存储方面，不建议一步到位照搬 VibeX SQLite 全表结构。更适合 code-lite 当前阶段的方案是：

```text
短期：JSON session/messages + NDJSON product events + native-session binding
中期：events-first projection
长期：按远程同步和审计需求评估 SQLite event sourcing
```

这样既能快速改善 Codex ACP 体验，又不会把当前原型阶段拖进过重的数据层迁移。

