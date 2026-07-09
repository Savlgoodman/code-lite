# code-lite 远程控制与双端同步 — 架构文档

> 本文档描述 code-lite 远程控制功能的整体架构、数据流和关键设计决策。
> 配合设计文档 `0709-REMOTE-CONTROL-DUAL-SYNC.md` 阅读。

## 1. 系统全景

```
─────────────┐         ┌──────────────┐         ┌──────────────┐
│  ui (桌面端) │◄──WS──►│   Backend    │◄──WS──►│ proxy_server │
│  Tauri+React │  localhost│  (FastAPI)   │  outbound │   (中继)     │
└─────────────┘  :18765  ──────┬───────┘         └──────┬───────┘
                                 │                        │
                          ┌──────┴──────┐           ┌─────┴─────┐
                          │ SessionEvent │           │ 盲转发     │
                          │    Bus       │           │  payload  │
                          └─────────────┘           └─────┬─────┘
                                                          │
                                                    ┌─────┴─────┐
                                                    │ ui-remote  │
                                                    │ (移动端)   │
                                                    │ React PWA  │
                                                    └───────────┘
```

### 核心原则

- **后端是唯一真相源**：所有会话状态、消息、turn 执行都在后端
- **事件总线解耦**：事件通过 `SessionEventBus` 广播，发起方和观察方平等接收
- **turn 与连接解耦**：turn 是会话的后台 task，发起端断线不取消 turn
- **中继盲转发**：中继只按 peerId 路由，不解析 payload

## 2. 数据流架构

### 2.1 发起 turn 的完整流程

```
桌面端/移动端                后端                      中继
    │                        │                        │
    │── turn.start RPC ─────►│                        │
    │                        │── subscribe channel ──►│
    │                        │◄── snapshot ───────────│
    │── result(turnId) ─────│                        │
    │                        │                        │
    │                        │ [spawn run_turn_task]  │
    │                        │                        │
    │                        │── agent.run.started ──►│── broadcast ──► 所有订阅者
    │                        │── agent.text.delta ────►│── broadcast ──► 所有订阅者
    │                        │── agent.tool.started ──►│── broadcast ──► 所有订阅者
    │                        │── approval.required ───►│── broadcast ──► 所有订阅者
    │                        │── agent.run.completed ─►│── broadcast ──► 所有订阅者
    │◄── event (via bus) ────│                        │
```

### 2.2 远程消息转发流程

```
移动端                    中继                      后端
  │                        │                        │
  │── hello(remote) ──────►│                        │
  │◄── ready(peerId) ──────│                        │
  │                        │── peer.joined ─────────►│
  │                        │                        │
  │── msg{subscribe} ─────►│── forward ─────────────►│
  │── msg{snapshot} ──────│── response ────────────│
  │                        │                        │
  │── msg{conversation.list}►── forward ────────────►│
  │◄── msg{sessions} ──────│◄── response ────────────│
  │                        │                        │
  │◄── msg{event} ─────────│◄── event pump ─────────│
  │  (turn 事件广播)        │  (bus → relay)         │
```

## 3. 核心组件

### 3.1 后端组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `SessionEventBus` | `services/event_bus.py` | 进程内事件总线，按 conversationId 分频道 fan-out |
| `ActiveTurnRegistry` | `services/turn_registry.py` | 会话级 turn 互锁，每会话同时只允许一个 turn |
| `ConversationRecorder` | `services/conversation_recorder.py` | 内存中累积会话状态，提供快照 |
| `RemoteBridge` | `services/remote_bridge.py` | 出站连接中继，转发 RPC 和事件 |
| `/api/ws` | `api/routes/ws.py` | WebSocket RPC 端点，处理所有 WS 方法 |
| `prepare_and_start_turn` | `api/routes/turns.py` | turn 启动逻辑，HTTP 和 WS 共用 |

### 3.2 共享包

| 包 | 路径 | 职责 |
|----|------|------|
| `@code-lite/protocol` | `packages/protocol/` | 领域类型（AgentEvent、Session、ChatMessage）+ WS 协议信封 |
| `@code-lite/transport` | `packages/transport/` | Transport 接口定义 |
| `@code-lite/chat-core` | `packages/chat-core/` | 消息 reducer 原语（updateMessage、upsertToolCall 等） |

### 3.3 前端组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `LocalTransport` | `ui/src/services/localTransport.ts` | 桌面端 WS 传输，连接 localhost |
| `RelayTransport` | `ui-remote/src/services/RelayTransport.ts` | 移动端 WS 传输，经中继转发 |
| `ChatPage` | `ui/src/pages/ChatPage.tsx` | 桌面端主页面，管理所有状态 |
| `App` (mobile) | `ui-remote/src/App.tsx` | 移动端主页面，三标签导航 |

### 3.4 中继服务器

| 组件 | 文件 | 职责 |
|------|------|------|
| `RoomRegistry` | `proxy_server/main.py` | 内存房间注册表 |
| `relay_endpoint` | `proxy_server/main.py` | WebSocket 端点，握手 + 转发 |

## 4. 协议设计

### 4.1 WS 信封格式

```json
{
  "v": 1,
  "kind": "req" | "result" | "error" | "event" | "snapshot" | "control",
  "channel": "conv_xxx" | "*" | null,
  "requestId": "c-1023",
  "seq": 42,
  "method": "turn.start",
  "payload": {}
}
```

### 4.2 中继信封格式

中继在 WS 信封外再包一层：

```json
{
  "type": "msg",
  "payload": { /* WS 信封 */ },
  "peerId": "abc123" | "*"
}
```

控制消息：

```json
{
  "type": "hello" | "ready" | "waiting" | "peer.joined" | "peer.left" |
         "host.online" | "host.offline" | "ping" | "pong" | "error"
}
```

### 4.3 RPC 方法

| 方法 | 方向 | 说明 |
|------|------|------|
| `subscribe` | 客户端→后端 | 订阅会话频道，返回 snapshot |
| `unsubscribe` | 客户端→后端 | 取消订阅 |
| `conversation.list` | 客户端→后端 | 列出所有会话 |
| `conversation.get` | 客户端→后端 | 获取单个会话（活动态优先） |
| `conversation.create` | 客户端→后端 | 创建新会话 |
| `conversation.config.update` | 客户端→后端 | 更新会话配置 |
| `turn.start` | 客户端→后端 | 启动 turn |
| `turn.cancel` | 客户端→后端 | 取消 turn |
| `approval.decision` | 客户端→后端 | 审批决定 |
| `input.response` | 客户端→后端 | 输入响应 |
| `remote.config.get` | 桌面端→后端 | 获取远控配置 |
| `remote.config.update` | 桌面端→后端 | 更新远控配置 |
| `remote.config.generate_key` | 桌面端→后端 | 生成 pair key |

## 5. 房间模型

```
roomId = SHA256(pairKey).hex()

Room:
  host: WebSocket | None      # code-lite 后端（唯一）
  remotes: { peerId → WS }    # 可多个移动端
  createdAt, lastHostSeen
```

- 中继只存 `roomId`（哈希），不存原始 `pairKey`
- 一个房间只允许一个 host
- 多个 remote 可同时连接

## 6. 安全边界

| 层面 | 措施 |
|------|------|
| 房间隔离 | `roomId = SHA256(pairKey)`，中继无法反推 key |
| 身份伪造防护 | 中继强制覆盖 `peerId`，remote 不能冒充 |
| 权限控制 | 后端校验 peerId 权限（viewer/operator/owner） |
| 单会话互锁 | 每会话同时只允许一个 turn |
| 传输加密 | 中继链路用 WSS（生产环境） |

## 7. 目录结构

```
code-lite/
├── backend/                      # Python 后端
│   ├── code_lite_backend/
│   │   ├── api/routes/
│   │   │   ├── ws.py             # WebSocket RPC 端点
│   │   │   ├── turns.py          # turn 启动逻辑
│   │   │   └── conversations.py  # 会话 CRUD + 事件广播
│   │   └── services/
│   │       ├── event_bus.py      # 事件总线
│   │       ├── turn_registry.py  # turn 互锁
│   │       ├── remote_bridge.py  # 中继桥接
│   │       └── runtime.py        # AppServices 聚合
│   ── tests/
│       └── test_proxy_server.py  # 中继集成测试
│
├── proxy_server/                 # 中继服务器
│   ├── main.py                   # FastAPI + WebSocket
│   └── requirements.txt
│
├── ui/                           # 桌面端前端
│   └── src/
│       ├── pages/ChatPage.tsx    # 主页面
│       ── services/
│           ├── agentClient.ts    # WS RPC 封装
│           └── localTransport.ts # 本地 WS 传输
│
├── ui-remote/                    # 移动端前端
│   ── src/
│       ├── App.tsx               # 三标签导航
│       └── services/
│           └── RelayTransport.ts # 中继 WS 传输
│
└── packages/                     # 共享包
    ├── protocol/                 # 领域类型 + WS 协议
    ├── transport/                # Transport 接口
    ── chat-core/                # 消息 reducer
```

## 8. 实施进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| 零 | 共享包拆分 | ✅ 完成 |
| 一 | 后端事件总线 + turn 脱离连接 | ✅ 完成 |
| 二 | 宿主前端切 WS + 移除 NDJSON | ✅ 完成 |
| 三 | 会话列表事件化 + 单会话互锁 + 配置同步 | ✅ 完成 |
| 四 | 中继 + ui-remote | ✅ 主体完成 |
| 五 | 断线重连 + E2E 加密 + 设备管理 | ⬜ 未开始 |

## 9. 验证方式

### 9.1 本地双端同步（无需中继）

```bash
# 启动后端
cd backend && uv run --project . python -m code_lite_backend.main

# 启动桌面端 A
npm run ui:dev

# 启动桌面端 B（同一后端）
npm run ui:dev  # 另一个终端
```

在 A 中发消息，B 应实时看到流式文本、工具调用、审批卡。

### 9.2 远程同步（经中继）

```bash
# 1. 启动中继
cd proxy_server && uv run --with fastapi --with uvicorn python main.py --port 18766

# 2. 启动后端（启用远控）
cd backend && uv run --project . python -m code_lite_backend.main

# 3. 桌面端设置页 → 远程控制 → 生成配对码 → 保存

# 4. 移动端输入中继地址和 Pair Key → 连接
```

## 10. 已知限制

1. **无断线重连补偿**：mobile 断线后重连，缺失的事件不会补发（阶段五）
2. **无 E2E 加密**：中继可见明文 payload（阶段五）
3. **无设备管理 UI**：首连确认、踢出、key 轮换未实现（阶段五）
4. **移动端功能简化**：无图片上传、无 diff 查看、无设置页

## 11. 关键设计决策

| 决策 | 理由 |
|------|------|
| turn 与连接解耦 | 手机锁屏/断网不应取消 turn |
| 中继盲转发 | 中继不解析业务，降低复杂度和安全风险 |
| roomId = SHA256(pairKey) | 中继无法伪装接入，几乎零成本 |
| snapshot + 增量 | 解决 text.delta 不落盘的同步问题 |
| 单会话互锁 | 防冲突，不需要显式主控/移交 |
| packages/ 共享 | 避免 ui 和 ui-remote 逻辑漂移 |
