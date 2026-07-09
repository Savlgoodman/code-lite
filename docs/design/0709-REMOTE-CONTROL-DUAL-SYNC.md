# 远程控制与双端对等同步设计

本文设计 code-lite 的远程控制能力，重点解决"宿主机前端"与"远程设备前端"之间的实时对等同步：模型输出、工具调用、审批、配置和会话列表在两端保持一致，用户可以在任意一端观看或介入，双端切换无感知。

本文是 `0702-REMOTE-SYNC.md`（只读观看设计）的演进。0702 定义了单向观看链路，本文在其事件协议基础上把后端升级为"会话权威广播者"，让两个前端成为对等订阅者。

## 1. 目标

1. 远程前端与宿主前端观看同一份运行中的会话，模型输出（含流式文本）、工具调用、审批和运行状态实时同步。
2. 任意一端都可以发送消息、创建新会话、处理审批；操作的结果在另一端实时出现。
3. 远程新建的会话会同步出现在宿主机会话列表，反之亦然。
4. 双端各自独立导航（各自可以停留在不同会话），但底层会话数据是同一份。
5. 断线重连后按事件序号补齐，不丢事件、不重复渲染。
6. 中继服务器只转发，不理解业务，不存储明文敏感数据。

## 2. 非目标

1. 不做同一会话的多人实时协同编辑输入框（不做字符级 OT/CRDT）。
2. 不做"跟随模式"（远程画面镜像宿主当前所看会话）。本文采用共享数据 + 各自导航。
3. 不追求同一会话多个 turn 并发运行；后端对单会话强制串行互锁。
4. 不把完整仓库源码上传中继或远端。
5. MVP 不做载荷端到端加密（E2E），但第一天就做哈希房间号让中继无法伪装接入；E2E 作为紧跟的第二步（第 9 节）。
6. MVP 不追求同一 pair key 的密码学级单设备撤销，单设备撤销先用"踢出"（软断开）实现。

## 3. 关键现状（为什么需要重构）

调研当前代码后，确认双端同步的核心障碍在于**事件流是请求作用域的，不是会话作用域的**：

1. `POST /api/turns/stream`（`api/routes/turns.py`）返回 NDJSON 流，**只有发起该 turn 的调用方**能收到事件。会话没有"广播总线"。
2. 宿主前端能看到 turn，仅仅因为是它自己调用了 `streamAgentTurn`（`ui/src/services/agentClient.ts`）。若 turn 由别处发起，本地 UI 收不到任何实时事件。
3. `ConversationEventStore`（`storage/event_store.py`）已经为每个会话维护单调递增 `sequence` 并落盘 `events.ndjson`，但**刻意跳过 `agent.text.delta` / `agent.reasoning.delta`** 以省 IO。因此单靠回放事件日志会丢失流式文本。
4. `ConversationRecorder`（`services/conversation_recorder.py`）在内存中累积 assistant 的部分文本（`apply_agent_event` 逐段拼接 `content`），turn 结束才落盘 `messages.json`。所以"当前快照"里是有中途文本的，回放日志里没有。
5. 全部 UI 状态在 `ChatPage.tsx` 的 `useState`，由 `handleAgentEvent` 从"自己发起的流"重建。没有独立于该流的共享真相源。
6. 全仓无任何 WebSocket / SSE 广播实现（grep 确认）。`docs` 里 0702 只是设计，未落地。

结论：要实现双端对等，必须把"谁发起 turn"与"谁接收事件"解耦。做法是引入**会话级事件总线 + 附着即快照**，两个前端都退化为总线的对等订阅者，后端成为唯一真相源。

## 4. 总体架构

```text
remote 前端  <--WS-->  中继服务器  <--WS-->  宿主 code-lite 后端  <~~本地WS/HTTP~~>  宿主 code-lite 前端
   (对等订阅者)          (盲转发)              (会话权威 / 事件总线 / 真相源)         (对等订阅者)
```

核心思想：**后端是唯一真相源，两个前端都是它的对等订阅者。**

宿主前端不再"因为自己发起 turn 才收到事件"，而是和远程前端一样，通过一条持久 WS 订阅会话事件总线。发起 turn 只是往后端发一条"意图"命令，事件从总线回流给所有订阅者。这样"谁点的发送"与"谁看得到"彻底解耦，双端天然一致。

### 4.1 三条链路的职责

| 链路 | 协议 | 职责 |
| --- | --- | --- |
| 宿主前端 <-> 宿主后端 | 本地 WS（`ws://127.0.0.1:<port>/ws`） | 订阅事件总线、发送控制命令。取代现有"发起 turn 才订阅"的模型 |
| 宿主后端 <-> 中继 | WS（出站，后端主动连中继） | 后端作为"设备"注册到中继，转发事件、接收远端命令 |
| 远程前端 <-> 中继 | WS | 远端用连接码加入，收事件、发命令 |

宿主后端**主动出站**连接中继（而非中继连宿主），这样宿主无需公网端口、无需 NAT 穿透，符合 0702 "默认不开公网端口"的安全约束。

### 4.2 中继只做盲转发

中继按 `deviceId` + `remoteSessionId` 维护路由表，把一端的帧转发到另一端。它不解析 `payload`，不落盘会话内容，只记录连接元数据和审计。敏感数据脱敏在**后端出站前**完成（见第 9 节），中继永远看不到明文。

## 5. 同步模型：事件总线 + 附着快照

### 5.1 后端事件总线

新增 `SessionEventBus`（进程内），是本设计的核心新组件：

```text
Agent Adapter -> AgentEvent -> ConversationRecorder(累积状态) -> SessionEventBus
                                                                    |-> 本地前端订阅者
                                                                    |-> 远程前端订阅者(经中继)
                                                                    |-> EventStore(落盘, 现有)
```

- 按 `conversationId` 分频道。每个频道复用 `ConversationEventStore` 的 `sequence`（已单调递增）。
- turn 运行时，adapter 产出的每个事件在执行循环内既落盘又 `bus.publish(conversationId, event)`。
- 订阅者是 asyncio 队列；`publish` 向所有该频道的队列 fan-out。
- 关键改动：**发起 turn 的 HTTP 请求不再是事件的唯一出口**。turn 可以由任一端发起（甚至由后端自身恢复），事件统一走总线。

### 5.1.1 turn 必须脱离发起连接的生命周期（必改）

这是双端方案里最容易漏、又最致命的一处现状缺陷。当前 `turns.py` 的 `event_stream` 把 turn 的执行**绑在了发起它的 HTTP 请求上**：

- 客户端断开连接 → 触发 `asyncio.CancelledError`（`event_stream` 第 659 行）→ `finally` 里 `discard_turn`（第 685-687 行）。
- 也就是说，现在"**发起者一断线，正在跑的 turn 就被丢弃**"。

这与"会话归后端所有、连接只是订阅者"直接冲突。手机发起一个 turn 然后锁屏/切后台/断网，按现状这个 turn 会被丢弃——正是要避免的。

改法：`turn.start` 命令受理后，后端 spawn 一个**会话拥有的后台 asyncio task**（挂在会话对象上，不挂在连接上），它负责 `adapter.stream_turn` → 落盘 → `bus.publish`。这个 task 与发起它的连接彻底无关：

1. 发起连接断开，task 照跑，事件继续进总线和落盘。
2. 只有显式 `turn.cancel` 命令，或后端关停，才取消这个 task。
3. `discard_turn` 仅在真正异常（task 内未捕获错误）时调用，不再由"连接断开"触发。
4. task 完成后把自己从会话的 `activeTurn` 清除，解锁会话（见第 6 节）。

这样"手机发起、电脑接管观看""发起端离线任务不停"才成立。这一改动是阶段一的核心，必须先落地。

### 5.2 附着即快照（新订阅者如何追上）

因为 `text.delta` 不落盘，单纯回放日志会丢流式文本。所以订阅采用"快照 + 增量"：

1. 前端建立 WS 后发 `subscribe { conversationId, afterSequence? }`。
2. 后端回 `snapshot`：直接复用 `ConversationRecorder` 的当前 `messages`（含运行中 assistant 的已累积 `content`/`reasoning`/`toolCalls`）+ 当前 `session` + 运行状态 + `latestSequence`。这一步等价于现有 `GET /api/conversations/{id}` 的返回，但取的是**内存活动态**而非落盘态。
3. 之后后端从 `latestSequence` 开始推增量事件。
4. 若前端带了 `afterSequence`（重连场景）且缺口都在落盘日志内，则用 `EventStore.load_events(after=...)` 补发，不必重发整快照。
5. 若缺口跨越了未落盘的 delta（比如错过了一段流式文本），则回退到"重发快照"——因为快照里已有完整累积文本，天然自愈。

这套机制让"中途加入的第二个前端"能立刻看到运行到一半的会话，正是你要的"随时实时观看"。

### 5.3 双端状态一致性的保证

- 所有会话状态变更（消息、工具、审批、配置、标题、运行状态）都表达为总线上的 `AgentEvent`，两端用**同一套 `handleAgentEvent` reducer** 重建。宿主前端现有的 reducer（`ChatPage.tsx`）几乎可直接复用。
- 会话列表本身也事件化：新增 `conversation.created` / `conversation.updated` / `conversation.deleted` / `conversation.archived` 走一个全局频道（`conversationId = "*"`），两端订阅后列表实时同步。
- 配置同步：现有 `agent.config.updated` / `agent.mode.updated` 已经是事件；把用户主动改配置（`updateSessionConfig` → `PATCH /config`）也广播一条 `conversation.config.updated`，另一端跟随更新选择器。

## 6. 控制权模型：后端单会话互锁

采纳"后端单会话互锁"：不设固定主控端，谁都能操作，但每个会话同一时刻只允许一个运行中的 turn。

### 6.1 互锁规则

- 后端为每个 `conversationId` 维护 `activeTurn` 状态（`idle` / `running` / `awaiting_approval`）。这部分可复用现有 `runningSessionIds` 语义，但**权威判定移到后端**。
- 发起 turn 是命令 `turn.start`。后端校验：该会话无运行中 turn 才受理；否则回 `command.rejected { reason: "busy" }`。
- turn 运行时，后端广播 `turn.lock { conversationId, ownerLabel }`。两端 UI 据此禁用输入框，并显示"另一端正在运行"。
- 审批"先到先得"：`approval.required` 广播到两端，任一端 `approval.decision` 先到即生效，后端立即广播 `approval.resolved` 让另一端清除审批卡。这与现有 `ApprovalBroker`（`services/approvals.py`）的单次 resolve 语义一致。
- 取消同理：任一端可发 `turn.cancel`，命中现有 `/turns/{id}/cancel`。

### 6.2 为什么不做显式主控

单会话互锁在"防冲突"上已经足够，且天然契合现状：审批和输入本来就是单次消费的 broker。显式主控/移交会引入额外状态机和"请求控制"交互，对 MVP 是过度设计。若未来要限制远端权限，用第 8 节的权限分级即可（例如远端只有 `viewer` 时输入框始终禁用）。

## 7. 通信协议：WS 上的完整 RPC

### 7.1 为什么 WS 必须是完整 RPC，不只是事件流

一个决定协议形状的约束：**远端手机够不到宿主的任何 HTTP 接口**。宿主前端能直接打 `http://127.0.0.1:18765`，但手机只有一条中继隧道。而当前很多操作是 HTTP 请求/响应式的，不是流：

- 列会话 `GET /conversations`（`listConversations`）
- 读单个会话 `GET /conversations/{id}`（`loadConversation`）
- 拉 diff 全文 `GET /conversations/{id}/diffs/{diffId}`
- 改配置 `PATCH /conversations/{id}/config`
- 上传图片附件 `POST .../attachments`（multipart）

因此 WS 协议不能只有"事件推送 + 单向命令"，它必须支持**请求/响应式 RPC**：每条命令带 `requestId`，后端处理完回一条带同 `requestId` 的 `result`（或 `error`）。对手机而言，列表、读会话、上传、拉 diff 全部是 WS RPC 命令。

为满足"一套代码路径"，**宿主前端也走同样的 WS RPC**，而不是"本地用 HTTP、远端用 WS"（那仍是两套）。HTTP 路由在 MVP 落地期作为回退保留，目标态下前端不再直接依赖它们（见 7.5）。

### 7.2 传输帧信封

统一 WS 消息信封（本地链路与中继链路同构，中继只透传 `payload`）：

```json
{
  "v": 1,
  "kind": "req | result | error | event | snapshot | control | presence",
  "channel": "conv_xxx | * | null",
  "requestId": "c-1023",
  "seq": 42,
  "ts": "2026-07-09T12:00:00Z",
  "method": "turn.start",
  "payload": {}
}
```

- `req`：客户端发起的 RPC 请求，`method` + `payload`，带客户端生成的 `requestId`。
- `result` / `error`：后端对某个 `req` 的响应，回带同一 `requestId`。
- `event`：会话增量 `AgentEvent`，`payload` 就是现有 `AgentEvent`，带会话级 `seq`。两端 reducer 不改协议。
- `snapshot`：订阅响应的会话全量态（既是某个 `subscribe` req 的 result，也可主动补发）。
- `control`：`turn.lock` / `remote.revoked` / `host.offline` / 令牌过期等信令。
- `presence`：观看者加入/离开（可选）。
- `seq` 只对 `event` 有意义（会话事件序号）；RPC 关联一律用 `requestId`。

### 7.3 客户端 -> 后端 RPC 方法

| method | 类型 | payload | 命中现有后端能力 |
| --- | --- | --- | --- |
| `subscribe` | req→snapshot | `{ channel, afterSequence? }` | 新增总线订阅 |
| `unsubscribe` | req→result | `{ channel }` | 新增 |
| `conversation.list` | req→result | `{}` | `list_conversations` |
| `conversation.get` | req→result | `{ conversationId }` | `get_conversation`（活动态优先） |
| `conversation.create` | req→result | `{ agentId, title?, workspace? }` | `create_conversation` |
| `conversation.config.update` | req→result | `{ conversationId, config }` | `PATCH /config` + 广播 `conversation.config.updated` |
| `conversation.archive` / `delete` | req→result | `{ conversationId }` | 现有路由 + 广播 |
| `session.initialize` | req→result | `{ conversationId \| "__probe__" }` | `POST /sessions/{id}/initialize`（返回 capabilities） |
| `turn.start` | req→result(ack) | `{ conversationId?, input, contentBlocks?, modelId?, modelLabel?, accessMode?, reasoningEffort?, selectedConfig?, turnId }` | 复用 `stream_turn` 逻辑，去掉 HTTP 流出口，spawn 会话后台 task（见 5.1.1），result 回带真实 `conversationId`（draft→real） |
| `turn.cancel` | req→result | `{ turnId }` | `POST /turns/{id}/cancel` |
| `approval.decision` | req→result | `{ approvalId, decision }` | `ApprovalBroker` |
| `input.response` | req→result | `{ inputRequestId, action, content? }` | `InputBroker` |
| `attachment.upload` | req→result | `{ conversationId, turnId, files: [{ name, mimeType, dataBase64, width?, height?, wasCompressed? }] }` | `AttachmentStore`（见 7.4） |
| `diff.get` | req→result | `{ conversationId, diffId }` | `load_diff` |

`turn.start` 的 result 是一个轻量 ack（受理 + 真实 `conversationId`/`turnId`）；实际内容通过 `event` 从总线回流，与发起端无关。这正是双端一致的关键：发起者收到的和旁观者收到的是同一批 `event`。

### 7.4 附件走 WS base64（带大小上限）

远端够不到 HTTP multipart 上传口，所以图片附件改为 `attachment.upload` RPC，文件内容 base64 编码进 payload。约束：

- 单条 WS 消息有帧大小上限（建议后端配置 8 MB/帧）。单张图超限则客户端**分片**：`attachment.upload.begin` / `.chunk` / `.commit`，或先客户端压缩（现有 `draftImages` 已有 `normalized` 压缩产物，直接复用）。
- 沿用现有限制：单轮最多 20 张、总量 200 MB（`MAX_IMAGES_PER_TURN` / `MAX_IMAGE_BYTES_PER_TURN`）。
- 宿主本地前端也走同一 RPC，不再走 multipart，保证一套路径。
- base64 膨胀约 33%，在帧上限和总量限制内可接受；MVP 不做二进制帧优化。

### 7.5 彻底迁移到 WebSocket（移除 `POST /turns/stream`）

已确认目标态：宿主前端完全迁移到 WS，不保留 NDJSON 流式接口作为长期回退。

- 落地期（阶段一、二）HTTP 路由与 WS 并存，便于逐步切换和对拍。
- 阶段二完成、验收通过后，**移除 `POST /api/turns/stream` 及 `agentClient.streamAgentTurn`**，前端 `sendMessage` 只发 `turn.start` RPC。
- 其余 HTTP 路由（list/get/config/diff/attachment/initialize）在前端不再直接调用，改走对应 RPC；后端路由可暂留供调试和潜在的非 WS 工具使用，但不在前端主路径上。
- 好处：一套 reducer、一套订阅逻辑、一套传输抽象，本地与远程零差异。

## 8. 中继服务器设计（`./proxy_server`）

独立 Python 程序，放仓库根的 `proxy_server/`。技术栈用 FastAPI + uvicorn（与 backend 一致，复用团队技能和打包经验），虽然纯转发用 `websockets` 库更轻——一致性优先。中继无状态、内存维护路由表，重启后各端自动重连，MVP 不需要数据库。

### 8.1 房间模型

中继的唯一职责是把同一"房间"内 host 与 remote 的帧互转。房间由 pair key 的**哈希**标识，绝不用原始 key：

```text
roomId = SHA256(pairKey) 的十六进制（取足够长前缀，如 32 hex）

RoomRegistry: { roomId -> Room }
Room:
  host:     WS | None            # code-lite 后端，唯一
  remotes:  { peerId -> WS }     # 可多个手机
  createdAt, lastHostSeen
```

用哈希做房间号的意义：中继只存 `SHA256(pairKey)`，永远拿不到原始 key，因此无法伪装成合法端加入别人的房间。原始 key 只在 host 和手机手里。这一条几乎零成本，第一天就做。

### 8.2 连接与握手流程

1. **host 上线**（宿主后端主动出站）：连中继后发 `hello { role: "host", roomId }`。
   - 房间不存在 → 建房，`host = 本连接`，回 `ready`。
   - 房间已有存活 host → **拒绝**（回 `error: room_has_host`）。一个房间只允许一个 host，否则真相源打架。旧 host 心跳超时判死后，新 host 方可接管。
2. **心跳保活**：host 建房后只有心跳在跑（WS ping/pong + 应用层 `ping`）。中继按超时（如 30s 无 pong）驱逐死连接。这对应你说的"一开始只有心跳数据包在交互"。
3. **remote 上线**：手机连中继发 `hello { role: "remote", roomId }`。
   - host 在线 → 分配 `peerId`，挂进 `remotes`，通知 host `peer.joined { peerId }`，回 remote `ready`。此后两端开始完整数据传输。
   - host 不在线 → 回 remote `waiting`，remote 进"等待宿主上线"态；host 来了再补 `peer.joined` 并通知 remote `host.online`。
4. **数据帧转发**：`msg { peerId, payload }`。
   - remote → host：中继**强制用该连接自己的 `peerId` 覆盖**帧里的 peerId，防止一个手机冒充另一个。
   - host → remote：host 用 `peerId` 定向到某台手机，或 `peerId: "*"` 广播给房间内所有 remote。
   - `payload` 对中继是**黑盒**，绝不解析。
5. **断线**：
   - remote 断 → 中继从 `remotes` 移除，通知 host `peer.left { peerId }`。
   - host 断 → 房间标记 hostless，给所有 remote 发 `host.offline`，remote 进等待态；host 重连后恢复。

### 8.3 中继侧消息（仅路由信封，不含业务）

| kind | 方向 | 说明 |
| --- | --- | --- |
| `hello` | 端→中继 | 声明 role + roomId |
| `ready` / `waiting` | 中继→端 | 握手结果 |
| `peer.joined` / `peer.left` | 中继→host | remote 上下线 |
| `host.online` / `host.offline` | 中继→remote | host 上下线 |
| `msg` | 双向 | 承载业务 `payload`（第 7 节的 WS 信封），中继只按 peerId 路由 |
| `ping` / `pong` | 双向 | 应用层心跳 |
| `error` | 中继→端 | `room_has_host` / `bad_room` 等 |

### 8.4 权限模型

权限判定一律在**宿主后端**做（命令入口校验），中继不参与授权决策。等级沿用：

- `viewer`：只读，输入/审批/新建 UI 禁用。
- `operator`：可发消息、取消、审批、新建会话。
- `owner`：宿主本机前端，恒为最高权限。

已确认：**远端默认 `operator`**（目标就是"随时介入"），但设置页保留"新接入设备默认只读"开关。宿主可随时把某设备降为 `viewer` 或踢出（8.5）。

### 8.5 设备管理与首连确认（安全关键）

pair key 是匿名、bearer 性质、默认全权限的凭证，而 coding agent 能跑任意命令——一旦 key 泄露，等于把电脑 shell 交出去。因此配套管控是必需项，不是可选项：

1. **首连确认**：新 `peerId` 首次接入时，宿主前端弹确认（"有新设备请求接入，是否允许"）。拒绝则后端不受理该 peer 的任何命令。匿名不等于无感接入。
2. **已连接设备列表 + 一键踢出**：设置页显示当前 `remotes`（peerId、接入时间、权限）。踢出 = 后端请中继软断开该 peerId 并拒绝其后续命令。
3. **key 轮换**：宿主可重新生成 pair key。换 key = roomId 变化，所有旧端下线，需重新配对。这是密码学级的"全部撤销"。
4. **单设备撤销**：MVP 用"踢出"（软断开）实现；密码学级单设备撤销不进 MVP（见非目标 6）。

## 9. 配对与安全边界

### 9.1 pair key 与配对流程

1. 宿主设置页有"远控配置"：开关（默认关）、远控地址（开发期 `127.0.0.1:18766`）、pair key。
2. 开启远控时，后端生成 **128 位随机 pair key**（`secrets.token_bytes(16)`，展示为 32 hex 字符）。
3. 后端算 `roomId = SHA256(pairKey)`，主动出站连中继并 `hello` 建房。
4. 宿主设置页展示 **二维码**，内容为 `relayUrl + pairKey`（如 `code-lite://pair?relay=wss://...&key=<hex>`）。手机扫码即配对；32 hex 手输作为兜底。
5. 远端可有多个：任何持有同一 pair key 的设备都能加入同一房间，匿名交互。
6. key 轮换 = 换 roomId = 所有端重连（见 8.5）。

pair key 只在 host 与手机手里，中继与任何第三方都拿不到（中继只见哈希）。

### 9.2 安全边界

沿用 0702 第 8 节并强化：

1. **脱敏在后端出站前完成**：API Key、Token、`.env` 内容、私钥在 `payload` 序列化前过滤，中继与远端永不接触明文。
2. **命令鉴权**：每条来自远端的 `req` 必须归属已确认的 `peerId`，后端校验权限等级后才路由到 broker；未确认设备的命令一律拒绝。
3. **单会话互锁**本身也是安全阀：远端无法在宿主运行时插入并发 turn。
4. **哈希房间号**：中继只存 `SHA256(pairKey)`，无法伪装接入或反推 key（8.1）。
5. **文件内容、大 diff 走引用懒加载**：远端按 `diff.get` RPC 显式拉取并二次鉴权，不随事件推全文。
6. **传输**：中继链路用 WSS；本地链路 `ws://127.0.0.1`。MVP 若先做局域网直连可跳过中继，协议不变。
7. **载荷 E2E 加密（紧跟的第二步，非 MVP）**：从 pair key 用 HKDF 派生对称密钥，对 WS 信封的 `payload` 做 AEAD 加密。这样中继连转发的内容都看不到，配合哈希房间号使中继成为纯盲管。代价是多端共享同一派生密钥，单设备撤销仍靠"踢出"或轮换 key。建议 MVP 验证链路后立即做这一层。

## 10. 共享包拆分（`packages/`）

双端一致的最大隐性风险是 `ui` 和 `ui-remote` 各写一份逻辑，慢慢漂移。`ChatPage.tsx` 里那套 1300+ 行的 `handleAgentEvent` 状态机、`types.ts`、以及新的 WS 传输层，必须抽到共享包，两个 app import 同一份。`ARCHITECTURE.md` 已预留 `packages/`，现在落地：

```text
packages/
  protocol/     # WS 信封、method 名、AgentEvent schema、共享 TS 类型（含现 types.ts）
  chat-core/    # reducer（从 handleAgentEvent 抽出）、快照合并、plan/tool 合并等纯逻辑
  transport/    # 传输抽象：Transport 接口 + 两种实现
```

**传输抽象是关键**：现有 `agentClient.ts` 深度耦合 Tauri（`invoke`、`__TAURI_INTERNALS__`），手机端没有 Tauri。定义一个 `Transport` 接口（`request(method, payload)` / `subscribe(channel)` / `onEvent`），两种实现：

- `LocalTransport`：宿主前端，连 `ws://127.0.0.1:<port>/ws`（端口仍可经 Tauri `ensure_backend` 获取）。
- `RelayTransport`：ui-remote，连中继 WSS + pair key，帧包在中继 `msg` 信封里。

`chat-core` 和 UI 组件只依赖 `Transport` 接口，不关心底层是本地还是中继。这个抽象不做，ui-remote 无法复用 reducer。

已确认：**现在就抽 `packages/`，不走"先复制到 ui-remote 以后再收敛"**——复制的债后面还得还。

## 11. 远程前端形态（`./ui-remote`）

- React 技术栈，面向手机，独立 app 放仓库根 `ui-remote/`。
- **不是 Tauri**，跑在手机浏览器；不依赖任何 Tauri API，传输走 `RelayTransport`。
- 建议做成 **PWA**（可加到主屏、离线壳），体验接近原生。
- 首屏是**配对页**：扫码（`code-lite://pair?...`）或手输 relay 地址 + pair key，存 localStorage。
- 移动端重排：会话列表抽屉化、审批卡与输入框适配触屏和小屏、流式消息滚动优化。
- **数据层与 reducer 与桌面完全共用**（import `packages/chat-core` + `packages/protocol`），只有布局和交互是移动端专属。

## 12. 落地顺序

分阶段，每阶段可独立验证、可回滚：

**阶段零：共享包拆分（前置）**
0. 抽 `packages/protocol`（含现 `types.ts`）、`packages/chat-core`（从 `handleAgentEvent` 抽 reducer）、`packages/transport`（`Transport` 接口）。桌面 `ui` 先改为从共享包 import，行为不变，作为纯重构验证。

**阶段一：后端事件总线（不涉远程）**
1. 实现 `SessionEventBus`（asyncio fan-out）。
2. **turn 脱离连接生命周期**（5.1.1）：`turn.start` spawn 会话后台 task，事件既落盘又 `bus.publish`；断连不再 `discard_turn`。
3. 新增本地 WS 端点 `/ws`，实现 RPC 分发 + `subscribe` + `snapshot`（复用 `ConversationRecorder` 活动态）+ 增量推送。
4. 快照接口补齐"内存活动态优先，回退落盘"。

**阶段二：宿主前端切 WS（并移除 NDJSON）**
5. `LocalTransport` 落地；`sendMessage` 改发 `turn.start` RPC + 等 result。
6. `ChatPage` 事件源接入 WS（reducer 已在 chat-core，基本不动）；list/get/config/diff/attachment/initialize 全改 RPC。
7. 验收后**移除 `POST /turns/stream` 和 `streamAgentTurn`**（7.5）。
8. 验证：本地开两个窗口订阅同一后端，A 发消息 B 无操作实时可见——双端对等内核成立，无需中继。

**阶段三：会话列表与配置事件化 + 互锁**
9. 新增 `conversation.*` 全局频道事件，两端列表/配置实时同步。
10. 单会话互锁：后端权威 `activeTurn` + `turn.lock` 广播 + `command.rejected(busy)`。

**阶段四：中继 + ui-remote**
11. `proxy_server/`：房间模型、哈希 roomId、握手、心跳、盲转发（第 8 节）。
12. 宿主后端出站连中继（`hello` 建房）；远控设置页 + pair key 生成 + 二维码。
13. `ui-remote/`：配对页 + `RelayTransport` + 移动端布局，复用 chat-core。
14. 权限分级校验、首连确认、设备列表/踢出、脱敏出站。

**阶段五：健壮性与加固**
15. 断线重连按 `afterSequence` 补发 / 快照自愈；附件分片。
16. 载荷 E2E 加密（9.2 第 7 条）。
17. presence、观看者列表、审计完善。

阶段零到三完全在本机可测（两个前端连同一后端即可复现双端同步），不依赖中继，风险最低、验证最快。中继与 ui-remote 是传输与展现扩展，复用同一套 chat-core 和协议。

## 13. 验收标准

1. 本机两个前端订阅同一后端：一端发消息，另一端**无操作**即看到流式文本、工具调用、审批卡实时出现。
2. **发起端离线任务不停**：一端发起 turn 后立即断开该连接，turn 继续运行，另一端（或该端重连后）能看到完整过程和结果。
3. 一端新建会话，另一端会话列表实时新增；点进去看到同一份内容。
4. 一端改模型/模式/速率，另一端选择器实时跟随。
5. 运行中，两端输入框都禁用并提示"另一端正在运行"；审批任一端处理，另一端卡片即时消失。
6. 手机经中继上传图片、拉取 diff 全文均成功（走 WS RPC，不依赖 HTTP）。
7. 远端断线重连后不丢事件、不重复渲染。
8. 中继抓包不含任何明文密钥或 `.env` 内容；中继内存只见 `SHA256(pairKey)`，不见原始 key。
9. 新设备接入需宿主确认；宿主踢出后该设备立即断开且无法再发命令；轮换 key 后所有旧端失效。

## 14. 决策与开放问题

已敲定（记录以备追溯）：

1. 附件走 WS base64 + 大小上限（7.4）。
2. WS 采用完整 RPC，宿主前端也走 WS，彻底移除 `POST /turns/stream`（7.1、7.5）。
3. MVP 先做哈希房间号；载荷 E2E 加密作为紧跟的第二步（9.2）。
4. 新设备首连需宿主确认，配套设备列表 + 踢出 + key 轮换（8.5）。
5. 现在就抽 `packages/`（protocol / chat-core / transport），不走"先复制后收敛"（第 10 节）。
6. 远端默认权限 `operator`（8.4）。
7. **中继 MVP 先用本地局域网直连验证**，公网自建部署作为后续（协议一致，仅 relay 地址不同）。
8. **二维码用自定义 scheme `code-lite://pair?relay=...&key=...`**。

仍开放（可边写边定，不阻塞主体）：

1. 事件日志保留时长与快照恢复边界：超期/已归档会话被远端附着时的降级策略。
2. presence（显示"对方正在看哪个会话/在线"）是否进 MVP。
3. 附件分片阈值与单帧上限的具体取值（8 MB/帧是初值，需实测手机端 WS 表现）。
4. 多手机同时操作同一会话时，`turn.lock` 的 `ownerLabel` 如何命名（设备名？peerId？），以便 UI 显示"谁在跑"。
