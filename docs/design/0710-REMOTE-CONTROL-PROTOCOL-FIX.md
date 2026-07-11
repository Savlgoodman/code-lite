# 远程控制协议修复与双端同步收敛

本文承接 `0709-REMOTE-CONTROL-DUAL-SYNC.md`（总体架构与落地顺序），聚焦已落地代码中导致"远端无法双向控制、发消息拿不到响应"的具体缺陷，给出**完整的传输协议定义**、**链路路由规则**和**双端同步逻辑**，作为修复的唯一权威依据。

0709 定义了"后端事件总线 + 附着快照 + 对等订阅"的正确内核，且该内核（`SessionEventBus`、`ActiveTurnRegistry`、turn 脱离连接生命周期）已实现且无误。本次问题全部集中在**传输层协议不统一**与 **remote 前端未复用共享逻辑**，不动内核。

## 1. 问题诊断

对当前 `dev` 分支代码逐帧追踪 remote 发消息链路（ui-remote → RelayTransport → proxy_server → RemoteBridge → ws.py handler → SessionEventBus → 回流），确认以下缺陷，按严重程度排列。

### 1.1 致命 bug：`turn.start` 参数不匹配（发消息无响应的直接根因）

`ws.py` 中依赖订阅状态的 handler 有两个，签名都是 5 个参数：

- `_handle_subscribe(ws, services, request_id, payload, tasks)`
- `_handle_turn_start(ws, services, request_id, payload, tasks)`

但 `remote_bridge.py` 的分发只给 `subscribe` 特判了第 5 个参数，`turn.start` 落进了 4 参数分支：

```python
# remote_bridge.py _handle_rpc
elif method in handlers:
    handler = handlers[method]
    if method == "subscribe":
        await handler(fake_ws, services, request_id, rpc_payload, self._pump_tasks)
    else:
        await handler(fake_ws, services, request_id, rpc_payload)  # turn.start 少传 tasks
```

结果：remote 每发一次 `turn.start`，`_handle_turn_start` 抛 `TypeError: missing 1 required positional argument: 'tasks'`，被 `_handle_rpc` 的 `except Exception` 吞掉，回一条 `{"code":"internal_error"}`，**turn 从未在宿主启动**。

这精确解释现象：remote 的 `conversation.list` / `conversation.get` / `subscribe` 观看都能用（前两个是 4 参 handler，subscribe 已特判），唯独 `turn.start`（5 参）静默失败。即"能连、能看列表、能进会话，一发消息就没反应"。

### 1.2 host→remote 路由字段错位（多设备必然串台）

`peerId`（路由目标）在三个组件里放的层级不一致：

- `_FakeWebSocket.send_json` 把 `peerId` 放在**外层中继信封**：`{"type":"msg","payload":data,"peerId":self._peer_id}`。
- 中继 `handle_msg_from_host` 从**内层业务 payload** 找目标：`target = payload.get("peerId")`（此处 `payload` 已是内层业务信封，外层 peerId 被丢弃）→ `target=None` → 广播给房间内所有 remote。
- 而 remote→host 方向，中继把 peerId 注入内层再包外层，宿主从外层读——这条方向恰好对上。

现状能"歪打正着"跑通单台 remote，仅因为 host→remote 全退化成广播。一旦接第二台设备：RPC 响应串台（A 的 `turn.start` result 广播给 B）、定向快照错乱、定向踢出失效。这是"协议有大问题"的结构性来源之一。

### 1.3 remote 前端未复用 chat-core，自写残缺 reducer

`ui-remote/src/App.tsx` 完全没 import `packages/chat-core`，在 `sendMessage` 里手搓了只认三种事件的 mini-reducer：只处理 `agent.text.delta` 与 `agent.run.completed/failed`，其余全丢。后果：

1. 即使修好 1.1、1.2，remote 也只能看到纯文本流——工具调用、reasoning、审批卡、plan、diff、`conversation.turn.started` 骨架全部渲染不出来。
2. assistant 消息在 `sendMessage` 里本地乐观插入，与宿主经 `conversation.turn.started` 事件驱动的骨架是两套并行逻辑，双端必然漂移。
3. `onEvent` 在每次 `sendMessage` 时临时注册、terminal 时 `unsub()`——"谁发起谁收事件"的老模型在 remote 端复活，别人发起的 turn remote 看不到，违背对等订阅。

### 1.4 多 peer 的 pump 与订阅按 channel 单键，跨设备串台

`RemoteBridge._pump_tasks` 与 `ws.py` 的 `tasks` 都以 `channel` 为唯一键。两台设备订阅同一会话时，第二台因 `_ensure_channel_pump` 幂等判断"channel 已存在"被跳过，pump 里绑定的 `fake_ws` 仍是第一台，第二台收不到事件。键必须包含 `peerId`。

### 1.5 snapshot 未被 remote 用于渲染

`_handle_subscribe` 回的 snapshot（含运行中会话累积文本）在 `RelayTransport` 里只用于 resolve pending RPC，`onSnapshot` 无人订阅，数据被丢。中途加入看不到"跑到一半"的会话，与 0709 设计 5.2 "附着即快照"相悖。

### 1.6 无鉴权与首连确认（安全）

`RemoteBridge._handle_rpc` 对任意 peer 的任意 method 直接执行。0709 设计 8.5 要求首连确认 + 权限校验，当前形同裸奔。MVP 也应有最小开关，本文纳入。

### 1.7 会话状态双端同步的具体缺口

用户明确要求"创建会话、会话进行中"等状态两端同步。逐项核对现状：

| 状态 | 宿主→远端 | 远端→宿主 | 现状缺口 |
| --- | --- | --- | --- |
| 会话创建 | 全局频道 `conversation.created` 已发 | 远端 `conversation.create` 命中同一 handler，也会广播 | remote 未订阅 `*` 做列表 reduce（App.tsx 只在 connect 时拉一次 list）；远端创建的会话不回流到远端自己的列表 |
| 会话进行中（running） | `turn.lock` + `agent.run.*` 已发；快照 `session.status==running` 也标记 | 同左 | remote 无 `turn.lock`/`turn.unlock` 处理，输入框不禁用；宿主发起的 turn，remote 列表项不显示"运行中" |
| 会话归档/删除 | 全局频道已发 | HTTP 路由发；WS 无 `archive`/`delete` RPC | remote 收不到（未订阅 reduce），且无法从远端发起归档/删除 |
| 配置变更 | 会话频道 `conversation.config.updated` 已发 | WS `conversation.config.update` 已发 | remote 无 config 事件处理 |
| 标题变更 | `agent.session.updated` 走会话频道 | 同左 | remote reducer 缺失（1.3） |

结论：后端广播基本齐全，缺口在 **remote 端没有统一 reduce 全局频道与会话频道事件**，以及 **archive/delete 未纳入 WS RPC**。

## 2. 修复目标

1. remote 发消息能启动宿主 turn，并实时收到完整响应（文本、工具、审批、plan、diff）。
2. 双端对等：任一端发起的 turn，另一端无操作即可实时观看；发起端离线 turn 不停。
3. 会话生命周期（创建、运行中、归档、删除、配置、标题）双向实时同步。
4. 多设备不串台：RPC 响应定向、快照定向、事件按需广播。
5. 传输层"一套协议、一套 dispatch"，本地与远程零逻辑差异。
6. 最小安全：首连确认 + 权限等级校验。

## 3. 传输协议定义（权威）

### 3.1 两层信封

链路分两层，职责严格分离：

- **业务信封（WireEnvelope）**：端到端语义，中继视为黑盒，定义见 `packages/protocol/src/wire.ts`，本次不改结构，仅补 `method`。
- **中继信封（RelayEnvelope）**：仅中继关心的路由层，包裹业务信封。

#### 业务信封（不变）

```json
{
  "v": 1,
  "kind": "req | result | error | event | snapshot | control | presence",
  "channel": "conv_xxx | * | null",
  "requestId": "c-1023",
  "seq": 42,
  "method": "turn.start",
  "payload": {}
}
```

#### 中继信封（本次统一，路由字段只放外层）

```json
{
  "type": "hello | ready | waiting | msg | ping | pong | error | peer.joined | peer.left | host.online | host.offline",
  "to":   "<peerId> | \"*\" | null",
  "from": "<peerId> | \"host\"",
  "payload": { /* 业务信封，中继绝不解析 */ }
}
```

**唯一路由规则**：中继只读 `to`/`from`/`type`，永不触碰 `payload`。

- remote → host：中继**强制**用连接真实 `peerId` 覆盖 `from`，`to` 恒为 host（房间只有一个 host，无需显式指定）。业务 `payload` 原样透传。
- host → remote：host 在**外层** `to` 填目标 `peerId`（或 `"*"` 广播）；中继按外层 `to` 路由。业务 `payload` 原样透传。
- 删除现状里"peerId 塞进内层业务 payload"的所有写法（`handle_msg_from_remote` 的 `payload["peerId"]=...`、`_FakeWebSocket` 外层 peerId 与内层不一致）。

### 3.2 本地链路（宿主前端 ↔ 后端）

宿主前端直连 `ws://127.0.0.1:<port>/api/ws`，**不经中继信封**，直接收发业务信封。这一层已由 `LocalTransport` 正确实现，本次不改传输，仅随 dispatch 统一（第 4 节）联动。

### 3.3 RPC 方法全集

统一 dispatch 表（本地与中继共用），方法与命中的后端能力：

| method | 类型 | payload | 命中能力 | 权限 |
| --- | --- | --- | --- | --- |
| `subscribe` | req→snapshot | `{ channel, afterSequence? }` | 总线订阅 + 快照 | viewer |
| `unsubscribe` | req→result | `{ channel }` | 退订 | viewer |
| `conversation.list` | req→result | `{}` | `list_sessions` | viewer |
| `conversation.get` | req→result | `{ conversationId }` | 活动态优先快照 | viewer |
| `conversation.create` | req→result | `{ agentId, title?, workspace? }` | 建会话 + 广播 `conversation.created` | operator |
| `conversation.config.update` | req→result | `{ conversationId, config }` | 存配置 + 广播 `conversation.config.updated` | operator |
| `conversation.archive` | req→result | `{ conversationId, archived }` | 归档 + 广播 `conversation.archived`（**新增 WS**） | operator |
| `conversation.delete` | req→result | `{ conversationId }` | 删除 + 广播 `conversation.deleted`（**新增 WS**） | operator |
| `session.initialize` | req→result | `{ conversationId }` | 返回 capabilities（**新增 WS**） | viewer |
| `turn.start` | req→result(ack) | `{ conversationId?, input, contentBlocks?, modelId?, ..., turnId }` | spawn 会话后台 task；result 回带真实 conversationId/turnId | operator |
| `turn.cancel` | req→result | `{ turnId }` | 取消 turn | operator |
| `approval.decision` | req→result | `{ approvalId, decision }` | ApprovalBroker | operator |
| `input.response` | req→result | `{ inputRequestId, action, content? }` | InputBroker | operator |
| `diff.get` | req→result | `{ conversationId, diffId }` | 拉 diff 全文（**新增 WS**） | viewer |
| `attachment.upload` | req→result | `{ conversationId, turnId, files[] }` | 附件 base64（后续阶段） | operator |

远控专用（仅本地前端调，不经中继）：`remote.config.get` / `remote.config.update` / `remote.config.generate_key` / `remote.peers.list` / `remote.peer.authorize` / `remote.peer.kick`。

### 3.4 响应形状约定（消除歧义）

- `subscribe` 的响应是 `kind:"snapshot"`，带 `requestId`：**既触发 `onSnapshot`，又 resolve 该 requestId 的 pending**。两端 transport 都必须这样处理（现状 RelayTransport 已修，LocalTransport 用 snapshotListener 分发不 resolve pending，但其 subscribe 不 await result，一致）。
- 其余 req 的响应是 `kind:"result"` 或 `kind:"error"`，回带同 `requestId`。
- `event` 无 requestId，按 `channel` 分发给 `onEvent`。
- `control`（`turn.lock`/`turn.unlock`/`host.online`/`host.offline`/`remote.revoked`）按 `kind:"control"` 分发给 `onControl`；当前实现把 `turn.lock` 混在 event 流里，本文统一为：**turn.lock/turn.unlock 走会话频道 event（payload.type 判定）**，与 ChatPage 现状一致，不新造 control 通道，降低改动面。

## 4. 后端 dispatch 统一（消灭参数不匹配）

问题 1.1 的根因是 handler 签名不齐（4 参/5 参混用），修复不能只补一个分支，要从结构上消除这类 bug。

### 4.1 引入 `WsSession` 连接会话对象

为每个连接（本地 WS 连接、以及中继里每个 authorized peer）建一个 `WsSession`：

```python
class WsSession:
    send: Callable[[dict], Awaitable[None]]   # 发业务信封（本地=ws.send_json；中继=包中继信封后发）
    pump_tasks: dict[tuple[str, str], asyncio.Task]  # (peer_id, channel) -> pump
    peer_id: str            # 本地固定 "local"；中继为真实 peerId
    role: str               # owner | operator | viewer
    services: AppServices
```

- `pump_tasks` 的键改为 `(peer_id, channel)`，解决 1.4 串台。
- `_FakeWebSocket` 升级为 `WsSession` 的中继实现：`send` 负责包 `{"type":"msg","to":peer_id,"from":"host","payload":envelope}`。

### 4.2 统一 handler 签名

所有 handler 改为单一签名，`tasks` 从 session 取：

```python
async def handle_xxx(session: WsSession, request_id: str | None, payload: dict) -> None: ...
```

- `ws.py` 与 `remote_bridge.py` **共用同一张 dispatch 表**（`DISPATCH: dict[str, Handler]`），不再各写各的分支。
- dispatch 入口统一做权限校验（第 6 节），未授权直接回 `error{code:"forbidden"}`。
- 消除"哪些 handler 要 tasks"的特判——所有 handler 拿的都是同一个 `session`。

### 4.3 pump 改为按 (peer, channel) 且带定向 send

`_ensure_channel_pump` 用 `session.send` 推送，键 `(session.peer_id, channel)`。这样中继下每个 peer 各有独立 pump，事件只发给订阅了该 channel 的 peer 的 send（中继 send 会填 `to=peer_id`），不再广播串台。全局频道 `*` 同理按 peer 建 pump。

## 5. 双端同步逻辑

### 5.1 事件流的唯一真相源

后端 `SessionEventBus` 是唯一真相源，两端都是订阅者。已实现，不改。关键补齐在**两端 reducer 一致**：桌面已用 `handleAgentEvent`（其纯逻辑已在 `packages/chat-core`），remote 改为复用 `chat-core`（第 7 节）。

### 5.2 会话列表同步（创建/归档/删除）

- 后端已在 `conversation.created/archived/deleted` 广播到全局频道 `*`。
- 补齐：`conversation.archive` / `conversation.delete` 新增 WS RPC，内部复用 HTTP 路由逻辑并广播（远端也能发起）。
- 两端在 `*` 频道用**同一段列表 reducer** 处理这三类事件（新增/标记归档/移除）。抽到 `packages/chat-core` 的 `applyConversationListEvent(list, event)`，桌面 ChatPage 与 remote 共用，消除漂移。
- remote connect 后先 `subscribe("*")` 再 `conversation.list` 拉初始态，之后完全靠事件增量——不再只拉一次。

### 5.3 会话运行中状态同步

- 后端在 `turn.start` 受理后广播 `turn.lock{conversationId,turnId}`；terminal 事件（`agent.run.completed/failed`）隐式解锁。
- **补齐后端显式 `turn.unlock`**：当前只靠前端在 terminal 事件里 `setSessionRunning(false)`。为让"只订阅列表、没进会话"的端也能准确显示运行态，turn task 收尾时（`finally` 完成后）在会话频道广播一条 `turn.unlock{conversationId,turnId}`。两端列表项据 lock/unlock 显示"运行中/空闲"，进入会话据此禁用/启用输入框。
- 快照对齐：`subscribe` 回的 snapshot 里 `session.status=="running"` 时，订阅端立即标记该会话 running（中途加入也能看到"正在跑"）。已实现于 ChatPage，remote 补齐。

### 5.4 单会话互锁（防双端并发）

- 后端 `ActiveTurnRegistry.is_running` 是权威判定，`prepare_and_start_turn` 已校验，busy 回 `error{code:"busy"}`。
- 两端 UI 在 `turn.lock` 后禁用输入框并提示"另一端正在运行"；收到 `busy` error 时提示"会话正忙"，不本地插入乐观消息。

### 5.5 draft→real 会话迁移

- 远端与本地一致：`turn.start` 无 conversationId 时后端生成，result 回带真实 id。发起端据此把本地 draft 频道迁移到真实频道并订阅。
- remote 侧目前是"先进已存在会话再发消息"，draft 新建流后续跟进；本文先保证已有会话双向可控，draft 新建纳入第 7 节 remote 改造。

## 6. 最小安全模型

- `RemoteBridge` 每个 peer 会话持有 `role`（`viewer` | `operator`）。
- 新 peer `peer.joined` 时默认权限跟随配置（0709 设计 8.4）：**默认 `operator`**（目标即"随时介入"），仅当宿主开启"新接入设备默认只读"开关时落为 `viewer`。加入后向本地前端推 `remote.peer.joined` 供设置页刷新设备列表。
- 权限校验在 dispatch 入口按 `role` 与方法所需等级（3.3 表）比对：`viewer` 只允许 `subscribe`/`conversation.list`/`conversation.get`/`session.initialize`/`diff.get` 等只读方法，介入类命令回 `forbidden`。
- 宿主可 `remote.peer.authorize{peerId, role}` 升/降权、`remote.peer.kick{peerId}` 移出并软断开。
- 弹窗式"首连确认"（接入即冻结、须点确认才放行）作为后续增强；MVP 用"默认 operator + 设备列表 + 一键踢出/降级"提供等价管控，避免默认只读导致远端发消息被静默拒绝。

## 7. remote 前端改造（复用 chat-core）

1. 删除 `App.tsx` 里的 mini-reducer 与本地乐观插入。
2. import `packages/chat-core`：会话内消息用与桌面同一套 `handleAgentEvent` 纯逻辑（reducer 需从 ChatPage 完成抽取，若仍有耦合部分一并抽到 chat-core），列表用 `applyConversationListEvent`。
3. 事件源改常驻订阅：`onSnapshot` 建初始态、`onEvent` 持续 reduce、`onControl`/lock 处理运行态。进入会话即 `subscribe(convId)`，离开退订。
4. `sendMessage` 只发 `turn.start` RPC，不本地插消息；骨架由回流的 `conversation.turn.started` 生成。
5. `RelayTransport` 已支持 `onSnapshot`/`onEvent`，补 `onControl`（若采用 5.3 的 unlock 走 event 则无需新通道）。
6. 移动端布局保持现状，仅数据层换血。

## 8. 落地顺序与验证

**步骤 A：最小修复（先让链路通）**
- remote_bridge dispatch 给 `turn.start` 传 `tasks`（或先用 4.1 的 WsSession 统一，一步到位）。
- 验证：remote 进已有会话发消息，宿主 turn 启动，remote 收到文本流。

**步骤 B：传输协议统一**
- 中继信封 `to`/`from` 外层路由（3.1），改 proxy_server + RemoteBridge + RelayTransport 三处。
- 后端 `WsSession` + 统一 dispatch + `(peer,channel)` pump（第 4 节）。
- 验证：本机开两台"remote"（浏览器指 127.0.0.1:18766）+ 宿主，A 发消息只有 A 收到自己的 result，两台都收到 event，互不串台。

**步骤 C：双端同步补齐**
- WS 新增 `conversation.archive/delete`、`session.initialize`、`diff.get`。
- 后端补 `turn.unlock` 广播。
- chat-core 抽 `applyConversationListEvent`，桌面与 remote 共用。
- 验证（对应 0709 验收 1-5）：一端建会话另一端列表实时新增；运行中两端输入框禁用；归档/删除/配置/标题双向同步。

**步骤 D：remote 前端 chat-core 化（第 7 节）**
- 验证：remote 能渲染工具调用、审批卡、plan、diff；宿主发起的 turn，remote 无操作即见全过程。

**步骤 E：最小安全（第 6 节）**
- 验证：新设备接入需宿主确认；未授权只读；踢出后立即失效。

每步可独立验证、可回滚。A-D 全部在本机可复现（宿主 + 中继 + 浏览器），不依赖公网。

## 9. 不改动项（避免误伤）

- `SessionEventBus`、`ActiveTurnRegistry`、`ConversationRecorder` 快照/投影逻辑：正确，不动。
- turn 脱离连接生命周期（0709 设计 5.1.1）：已实现，不动。
- 业务信封结构（`wire.ts`）：不动，仅补 method 枚举。
- HTTP 路由：落地期保留供桌面回退与调试，不在本次移除。

