# 双端统一大重构方案

## 目标

1. **proxy 对上层完全透明**：业务代码看不出连的是本地后端还是中继
2. **两端同一套连接 + 协议 + 状态逻辑**：桌面端（ui）和远端（ui-remote）复用同一底层
3. **清掉屎山**：桌面端 ~430 行的 `handleAgentEvent` 重实现，收敛到 chat-core 的 reducer
4. **修运行态同步**：远端列表页运行态不刷新（不用轮询，是 bug）
5. **补齐远端能力**：新建会话、终止会话
6. **桌面端视觉风格与交互完全不变**

## 关键事实（调研确认）

- 后端每会话有 `session.json`，含 `config` / `status` / `archived` / `agent`，是**运行态与配置的权威真相源**。`conversation.list` 和 snapshot 天然带 status。
- 中继链路必须多包一层 `{type:"msg", to/from, payload:<业务信封>}`——因为 host 一条连接服务多个 remote，靠外层 peer_id 多路复用。内层 `{v,kind,method,requestId,payload}` 两端已一致。
- 桌面端 `LocalTransport` 接口残缺：无 `status` getter、`request` 返回 `T`（接口要求 `RpcResult<T>`）、`subscribe` 返回 `void`（接口要求 `Subscription`）、有 `onControl` 无 `onStatus`。
- 远端 `RelayTransport` 更完整：有 status、heartbeat、onStatus，但无 onControl。
- subscribe 的 snapshot 关联方式两端不同：Local 走 snapshotListener（不注册 pending RPC），Relay 走 request（snapshot 带 requestId 时同时 resolve pending RPC + 分发 snapshotHandler）。
- 桌面端 turn 流：`streamAgentTurn` 发 `turn.start` + `turnResolvers` map 按 turnId 把 terminal 事件桥接回 Promise。远端是 fire-and-forget，全靠 reducer。
- 桌面独有：fast mode（codex）、codex 模型 id 括号归一化、agent 选择面板、draft session（`__draft_session__`）及 draft→real 迁移、per-session capabilities 加载+缓存+fallback、delta 批处理（60ms flush）。
- 数据路径混用：`listConversations`/`loadConversation` 已走 WS；`saveConversationConfig`/`updateConversationArchiveState`/`deleteConversation`/`loadConversationDiff`/`initializeSession` 仍走 HTTP。后端对应 WS handler 均已存在。

## 决策（用户已拍板）

| 项 | 决策 |
|----|------|
| 传输层 | 合并为单一 `WsTransport` 基类 + 两个薄子类 |
| 数据路径 | 全部收敛到 WS（图片上传/serving/ensureBackend 除外） |
| 范围 | 一次性大重构 |
| 共享状态层 | 并入 `@code-lite/chat-core` |
| delta 批处理 | 移进共享 client，两端都用 |
| 桌面 UI | 视觉与交互完全不变，只换底层状态驱动 |

## 分阶段实施

### 阶段 0：修 bug + 补远端能力（低风险，先见效）

- **修列表运行态**：`ui-remote/src/App.tsx:86` 全局频道事件在 `feedEvent` 前被 `return` 丢弃 → 改为先喂 SyncManager 再判断列表事件。
- **远端新建会话**：接 `conversation.create` WS RPC + UI 入口。
- **远端终止会话**：会话页加终止按钮 → `SyncManager.cancelSession`。
- 验证：ui-remote build + 后端测试。提交。

### 阶段 1：传输层合并（packages/transport）

新增 `WsTransport` 抽象基类，实现完整 `Transport` 接口。子类：`LocalWsTransport`、`RelayWsTransport`。

统一决策（解决报告列出的 10 个 blocker）：
- `request` 统一返回 `Promise<T>`（payload），**修改 Transport 接口**去掉 `RpcResult` 包装（两端实现本就返回 T）。
- `subscribe` 统一返回 `Subscription`；内部统一用「注册 pending RPC + snapshot 带 requestId 时 resolve」策略（采用 Relay 的方式，Local 端后端已回带 requestId 的 snapshot）。
- 注入点（避免 Tauri/浏览器依赖进 packages）：
  - `socketFactory: (url) => WebSocket`
  - `urlProvider: () => Promise<string>`（桌面传 `ensureBackend`，远端传固定 relayUrl）
  - `encodeFrame/decodeFrame`（本地=直通；中继=裹/拆 `{type:"msg"}`）
  - `onHandshake?`（中继发 hello + 处理 ready/waiting/host.online/offline/ping/pong；本地无）
- timer 句柄类型用 `ReturnType<typeof setTimeout>`。
- heartbeat 可配置（中继开，本地关）。
- `AgentEvent` 统一从 `@code-lite/protocol` 导入。
- 保留 `onControl`（作为可选）。
- 桌面 `agentClient.getLocalTransport` 与远端 `App.tsx` 改为构造对应子类。
- 验证：三端 tsc + build。提交。

### 阶段 2：数据路径收敛到 WS（ui/src/services）

`conversationStore.ts` 四个 HTTP 调用改 WS RPC（后端不动）：
- `saveConversationConfig` → `conversation.config.update`
- `updateConversationArchiveState` → `conversation.archive`
- `deleteConversation` → `conversation.delete`
- `loadConversationDiff` → `diff.get`
- `agentClient.initializeSession` → `session.initialize`

保留 HTTP：图片 multipart 上传、图片 serving URL、`ensureBackend`。
- 验证：桌面 build + 手动确认配置保存/归档/删除仍工作。提交。

### 阶段 3：共享状态层进 chat-core

新增 `packages/chat-core/src/conversationClient.ts`（框架无关）+ `useConversations.ts`（React 绑定）。

`ConversationClient`：
- 持有 transport + SyncManager。
- 管理 sessions 列表、per-session 视图态（统一用 `reduceAgentEvent`）、running、config、capabilities。
- delta 批处理（60ms flush）移入此处，两端共享。
- 方法：`loadList / openConversation / sendTurn / cancelTurn / updateConfig / createConversation / archive / delete / resolveApproval / resolveInput`。
- 统一加载策略：进入拉 `conversation.list`（含 status）→ 订阅全局频道 → 打开会话拉 snapshot。
- turnResolvers 逻辑内化。
- 用 `useSyncExternalStore` 暴露。
- 验证：chat-core tsc。提交。

### 阶段 4：干掉桌面端 handleAgentEvent 屎山

- 桌面 `ChatPage` 改用 `useConversations`，删除内联 `handleAgentEvent`（~430 行）、`queueMessageDelta`/`flushQueuedMessageDeltas`、turnResolvers 相关。
- draft→real 迁移抽成薄适配（reduce 前重映射 session id key）。
- 桌面独有（fast mode、codex 归一化、agent 面板、per-session caps）保留在桌面层，作为 client 之上的装饰。
- **所有展示组件（ChatWorkspace/Sidebar/ChatComposer/MessageList 等）与样式不动**，只换状态来源。
- 远端 `App.tsx` 也切到 `useConversations`，删自己的 setViews/setSessions 手写逻辑。
- 验证：三端 tsc + build + 后端测试 + 手动双端联调（发消息、切模型、终止、双端运行态同步、新建会话）。提交。

## 验证矩阵（每阶段）

- `tsc --noEmit`：packages / ui / ui-remote
- `vite build`：ui / ui-remote
- 后端 `unittest`（14 项）
- 阶段 4 额外手动联调双端场景

## 风险

- 阶段 3-4 面最大。draft 迁移、delta 批处理、per-session caps 是易回归点，重点测。
- 协议已是破坏性变更，新旧前端不能混部署。
- 分阶段提交，任一阶段回归可单独回退。
