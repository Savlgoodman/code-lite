# 远程控制与双端同步 — 实施交接文档

本文记录 0709 远程控制项目的**实施进度**，供下一位接手者快速进入。设计与决策见主文档，本文只讲「做到哪、怎么验证、下一步做什么」。

- **分支**：`refactor/remote-0709-shared-packages`（从 `dev` 切出）
- **截至**：2026-07-09，最后一个提交 `19dde29`
- **状态**：阶段零～四主体完成；阶段五未开始

## 参考文档

| 文档 | 作用 |
| --- | --- |
| `docs/design/0709-REMOTE-CONTROL-DUAL-SYNC.md` | **主设计文档**。架构、协议、中继、pair key、落地顺序、决策记录。接手前必读 |
| `docs/design/0702-REMOTE-SYNC.md` | 前身（单向只读观看设计），主文档在其事件协议上演进 |
| `AGENTS.md` | 分支命名、提交规范、构建流程 |
| 本文 | 实施进度与交接 |

主文档第 12 节是**落地顺序**（阶段零～五），第 14 节是**已敲定决策**。本文的进度对应主文档的阶段划分。

## 总体进度

```
阶段零  共享包拆分 ............................ ✅ 完成
阶段一  后端事件总线 + turn 脱离连接 ........... ✅ 完成
阶段二  宿主前端切 WS（事件源 + 双端对等）...... ✅ 完成
阶段三  会话列表/配置事件化 + 单会话互锁 ....... 🔶 部分完成（列表已事件化，互锁未开始）
阶段四  中继 proxy_server + ui-remote ......... ⬜ 未开始
阶段五  健壮性 + E2E 加密 ...................... ⬜ 未开始
```

核心目标「双端对等同步」的**地基已经全部铺好**：后端是唯一真相源，事件走总线，turn 与发起连接解耦，前端通过 WS 订阅。阶段三以后都是在这个地基上扩展，不再需要动核心架构。

## 已完成的工作（按提交顺序）

### 阶段零：共享包拆分（`7dce12c` → `658fed9`）

目的：让桌面 `ui` 和未来的 `ui-remote` 共用同一套类型与逻辑，杜绝漂移。

- `packages/protocol`：领域类型（原 `ui/src/types.ts` 整体迁入）+ `wire.ts`（WS 信封与 method 名）。`ui/src/types.ts` 变为 re-export 桩，37 处 `../types` 引用零改动。
- `packages/transport`：`Transport` 接口（request/subscribe/onEvent/onSnapshot/onStatus），为 LocalTransport 与 RelayTransport 预留统一契约。
- `packages/chat-core`：从 `ChatPage.tsx` 抽出的纯 reducer 原语（`upsertToolCall`/`appendRuntimeEvent`/`mergeToolMetadata`/`mergeMessagePlan`/`updateMessage`/`isRecord` 等）+ `planSnapshots`。

**接线方式**（重要）：用 Vite alias + tsconfig paths 直接引用 `packages/*/src` 源码，**没有引入 npm workspaces**。原因：现有 `scripts/sync-ui-deps.ps1` 依赖 `ui` 的 `npm ci`，引入 workspaces 会动整条打包管线。别名方案零风险、无需额外 install。

- Vite：`ui/vite.config.ts` 的 `resolve.alias`
- TS：`ui/tsconfig.json` 的 `paths` + `include`
- 包独立类型检查：`packages/tsconfig.check.json`

### 阶段一：后端事件总线 + turn 脱离连接（`5c568a4` → `d63dd95`）

- `backend/.../services/event_bus.py`：`SessionEventBus`，按 `conversationId` 分频道的进程内 asyncio fan-out。慢订阅者丢最旧事件并告警。接入 `AppServices`。
- turn 事件流并行发布：`turns.py` 的执行体在落盘/yield 的同时 `bus.publish` 相同事件。
- **turn 脱离连接生命周期**（主文档 5.1.1，本项目最关键的一处修复）：turn 改为**会话拥有的后台 asyncio task**，发起它的连接断开不再 `discard_turn`。手机发起后锁屏，任务照跑。
- `backend/.../api/routes/ws.py`：新增 `/api/ws` 端点，实现 `subscribe` → `snapshot`（复用 `ConversationRecorder` 活动态）→ 增量 `event` 推送。
- `ConversationRecorder.snapshot()`：内存活动态优先、回退落盘的快照方法。

### 阶段二：宿主前端切 WS（事件源 + 双端对等同步）

分两次提交完成：

**第一版**（`f703bf5` + `5da41a0`）：事件源切换 + 取消回归修复。

- `ui/src/services/localTransport.ts`：`LocalTransport` 类，封装 `/api/ws` 的 WS 连接、RPC 请求、事件/快照/控制分发。
- `ui/src/services/agentClient.ts`：`streamAgentTurn` 改为发 `turn.start` RPC 并通过 `transport.onEvent` 订阅本 turn 事件；`cancelTurn` 保持 HTTP（后改 WS RPC）。
- 取消回归修复（`5da41a0`）：
  - 后端：`AcpAgentAdapter.cancel_turn` 先查 turn→conversation→native session，调用 `sdk_connection.cancel(session_id=...)` 给 agent 子进程发 ACP 取消通知，再取消本地 producer task。验证了 acp SDK 的 `ClientSideConnection.cancel(session_id: str)` 签名。
  - 前端：`onAbort` 不再立即退订，等终止事件到达再收尾；3s 兜底合成 `run.failed`。

**第二版**（本提交）：完全的前端 WS 打通 + 双端对等同步 + 取消/thinking 健壮化。

- `agentClient.ts`：
  - `cancelTurn` 改为 WS RPC `turn.cancel`（设计 7.5）。
  - `streamAgentTurn` 不再订阅 `transport.onEvent`，改为通过 `notifyTurnEvent` 由全局监听分发。
  - 兜底 `run.failed` 用 `resolvedConversationId`（来自 `turn.start` result），修复 draft→real 后路由错误。
  - 导出 `notifyTurnEvent` + `getLocalTransport` 供 ChatPage 使用。
- `ChatPage.tsx`：
  - 新增全局 WS 事件监听（`useEffect` on mount）：订阅 `*` 频道，接收 `conversation.created/archived/deleted` 更新会话列表；会话级事件路由到 `handleAgentEvent`。
  - 新增会话频道订阅（`useEffect` on `activeSessionId`）：切换会话时退订旧频道、订阅新频道；接收 snapshot 回填消息与会话状态。
  - `handleAgentEvent` 的 `conversation.turn.started`：新增重复检查（避免 observer 场景 snapshot 已带消息时重复追加）；区分发起方/观察方（`isInitiator`），观察方不切换 `activeSessionId`、不清空列表。
  - `stopCurrentTurn` 立即清除 running 态与 streaming 光标（乐观清理），不再完全依赖后端 `run.failed` 到达。
  - 用 `handleAgentEventRef`、`sessionsRef`、`messagesRef`、`activeSessionIdRef` 同步最新 state 到 ref，供全局监听器闭包读取。
  - 用 `pendingDraftIdForTurnRef` 追踪发起方 draft 会话，支持 draft→real 迁移。
  - 用 `globalListenerReadyRef` 保证会话频道订阅在全局监听器就绪后才发送，避免 snapshot 丢失。
- `conversations.py`（后端）：
  - HTTP `POST /conversations`、`DELETE /conversations/{id}`、`PATCH .../archive` 增加 `conversation.created/deleted/archived` 广播到全局频道，让 WS 观察者也能实时更新列表。

**验收**：后端 69 项测试全绿，UI build 通过。

### 阶段四：中继 + ui-remote

分四次提交完成：

1. **proxy_server**（`1ff4352`）：FastAPI + uvicorn 中继服务器，房间模型（SHA256 roomId）、hello/ready/msg/ping 握手、盲转发、心跳保活、10 项集成测试。
2. **ui-remote**（`102be42`）：React + Vite 移动端 PWA，RelayTransport 实现，三页面（配对/项目/聊天），复用 packages/*。
3. **RemoteBridge**（`167f8cd`）：后端出站连中继，pair key 管理，app.py 集成启停。
4. **远控设置页**（`19dde29`）：WS RPC `remote.config.get/update/generate_key`，桌面端 SettingsPage 新增「远程控制」入口。

**验收**：79 项后端测试（69 + 10 proxy）全绿，桌面 UI + ui-remote build 通过。

### 剩余工作（阶段五）

- 断线重连按 `afterSequence` 补发 / 快照自愈
- 载荷 E2E 加密（HKDF + AEAD）
- 首连确认、设备列表/踢出、key 轮换（设计文档 8.5）
- presence、观看者列表、审计完善

<!-- HANDOFF_PLACEHOLDER -->
