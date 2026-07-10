# 统一双端同步协议设计

## 背景

当前 code-lite 支持本地桌面端（ui）和远程控制端（ui-remote）双端协同。两端通过不同的传输层连接后端：
- **本地端**：直接 WebSocket 连接后端 `/api/ws`
- **远程端**：通过中继服务器（relay）转发，remote -> relay -> host backend

现有实现存在的问题：
1. 两端使用不同的信封格式，难以维护
2. 状态同步不完整（缺少运行态同步）
3. 远端只能观看，不能完全介入（双向终止、配置同步等）
4. 协议分散在多个文件，扩展不便

## 设计目标

1. **统一协议**：本地端和远程端使用完全相同的业务层协议
2. **透明中转**：中继层只负责路由，不解析业务 payload
3. **状态同步**：会话运行态双向同步，任一端可终止
4. **配置同步**：模型、思考强度等配置双向同步
5. **可扩展性**：协议独立成包，便于后续增加同步内容

## 协议分层

```
┌─────────────────────────────────────────────┐
│         Application Layer (UI/Chat)         │
├─────────────────────────────────────────────┤
│      Sync Protocol (@code-lite/sync)        │  ← 新增协议层
│  - Session State Sync                       │
│  - Config Sync                              │
│  - Running State Sync                       │
├─────────────────────────────────────────────┤
│   Transport Layer (@code-lite/transport)    │
│  - LocalTransport  / RelayTransport         │
├─────────────────────────────────────────────┤
│        Wire Protocol (WebSocket)            │
│  - Local: /api/ws                           │
│  - Remote: relay + host bridge              │
└─────────────────────────────────────────────┘
```

## 核心概念

### 1. 同步消息类型

```typescript
// 同步消息信封
interface SyncMessage {
  type: SyncMessageType;
  payload: unknown;
  timestamp: number;
  source: 'host' | 'remote';  // 消息来源
}

type SyncMessageType =
  // 会话状态同步
  | 'session.state'        // 会话状态变化
  | 'session.config'       // 会话配置更新
  | 'session.running'      // 运行态同步（某会话开始运行）
  | 'session.stopped'      // 运行态同步（某会话停止运行）
  
  // 配置同步
  | 'config.model'         // 模型切换
  | 'config.effort'        // 思考强度切换
  | 'config.access_mode'   // 访问模式切换
  
  // 控制命令
  | 'control.cancel'       // 取消当前运行
  | 'control.lock'         // 锁定会话（禁止另一端操作）
  | 'control.unlock'       // 解锁会话
  
  // 存在性通知
  | 'presence.join'        // 远端加入
  | 'presence.leave'       // 远端离开
  | 'presence.heartbeat';  // 心跳
```

### 2. 会话运行态同步

**核心需求**：当任一端开始一个 turn 时，另一端需要同步显示"运行中"状态，且双方都可以终止。

```typescript
// 当 host 或 remote 调用 turn.start 时
interface SessionRunningPayload {
  conversationId: string;
  turnId: string;
  startedBy: 'host' | 'remote';
  startedAt: number;
}

// 当任一端取消或 turn 自然结束时
interface SessionStoppedPayload {
  conversationId: string;
  turnId: string;
  stoppedBy: 'host' | 'remote' | 'auto';
  reason: 'cancelled' | 'completed' | 'error';
}
```

**实现流程**：
1. 用户在任一端点击发送消息
2. 该端调用 `turn.start` RPC
3. 后端在 `_handle_turn_start` 中启动 turn 后，广播 `session.running` 事件到全局频道
4. 另一端收到事件，更新 UI 显示"运行中"
5. turn 结束或被取消时，广播 `session.stopped` 事件
6. 双端同步恢复可操作状态

### 3. 配置同步

**核心需求**：模型选择器、思考强度、访问模式等配置变更需要双端同步。

```typescript
interface ConfigModelPayload {
  conversationId: string;
  model: string;
  changedBy: 'host' | 'remote';
}

interface ConfigEffortPayload {
  conversationId: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  changedBy: 'host' | 'remote';
}

interface ConfigAccessModePayload {
  conversationId: string;
  accessMode: 'direct' | 'approval';
  changedBy: 'host' | 'remote';
}
```

**实现机制**：
- 任一端修改配置时，调用 `conversation.config.update` RPC
- 后端更新数据库后，广播 `config.*` 事件到该会话频道
- 订阅该会话的双端都收到更新，同步刷新 UI

### 4. 双向终止

**核心需求**：host 和 remote 都可以终止正在运行的会话。

```typescript
interface CancelRequest {
  conversationId: string;
  turnId: string;
  requestedBy: 'host' | 'remote';
}
```

**实现流程**：
1. 任一端调用 `turn.cancel` RPC
2. 后端调用 nanobot 的 `cancel_session`
3. 后端广播 `session.stopped` 事件
4. 双端同步更新状态

### 5. 中转层处理

**关键约束**：remote 端消息需要经过 relay 中转到 host backend。

**设计原则**：
- **中继透传**：relay 服务器不解析 SyncMessage，只做路由
- **信封嵌套**：
  ```
  Relay层：{type: "msg", to: "host", from: "peerId", payload: WireEnvelope}
  Wire层：{v: 1, kind: "req", method: "turn.start", payload: {...}}
  ```
- **双向通道**：
  - remote -> relay -> host backend（RPC 请求）
  - host backend -> relay -> remote（事件推送）

## 协议实现

### 包结构

创建新包 `@code-lite/sync`：

```
packages/sync/
├── src/
│   ├── index.ts              # 导出所有类型和工具
│   ├── types.ts              # 同步消息类型定义
│   ├── manager.ts            # SyncManager 核心类
│   ├── state-tracker.ts      # 运行态追踪器
│   └── config-syncer.ts      # 配置同步器
├── package.json
└── tsconfig.json
```

### 核心 API

```typescript
// SyncManager：统一的同步管理器
class SyncManager {
  constructor(transport: Transport, role: 'host' | 'remote');
  
  // 运行态同步
  notifySessionRunning(conversationId: string, turnId: string): void;
  notifySessionStopped(conversationId: string, turnId: string, reason: string): void;
  onSessionRunning(handler: (payload: SessionRunningPayload) => void): () => void;
  onSessionStopped(handler: (payload: SessionStoppedPayload) => void): () => void;
  
  // 配置同步
  syncConfig(conversationId: string, config: Partial<SessionConfig>): Promise<void>;
  onConfigChange(handler: (payload: ConfigChangePayload) => void): () => void;
  
  // 双向取消
  cancelSession(conversationId: string, turnId: string): Promise<void>;
  
  // 存在性管理
  onPresenceChange(handler: (payload: PresencePayload) => void): () => void;
}
```

### 集成方式

1. **后端集成**（`remote_bridge.py`）：
   ```python
   # 在 turn.start 成功后
   event_bus.publish("*", {
       "type": "session.running",
       "conversationId": conversation_id,
       "turnId": turn_id,
       "startedBy": "host" or "remote",
       "startedAt": time.time()
   })
   
   # 在 turn 结束时
   event_bus.publish("*", {
       "type": "session.stopped",
       "conversationId": conversation_id,
       "turnId": turn_id,
       "reason": "completed"
   })
   ```

2. **前端集成**（`chat-core`）：
   ```typescript
   import { SyncManager } from '@code-lite/sync';
   
   const syncManager = new SyncManager(transport, 'host');
   
   // 监听运行态变化
   syncManager.onSessionRunning((payload) => {
       // 更新 UI 显示"运行中"
       conversationStore.setRunning(payload.conversationId, true);
   });
   
   syncManager.onSessionStopped((payload) => {
       // 恢复可操作状态
       conversationStore.setRunning(payload.conversationId, false);
   });
   ```

## 实现步骤

1. ✅ 设计文档（本文档）
2. ✅ 创建 `@code-lite/sync` 包结构
3. ✅ 实现 `types.ts` / `manager.ts` / `state-tracker.ts` / `config-syncer.ts` / `constants.ts`
4. ✅ 后端集成：`turns.py`（运行态）+ `ws.py`/`conversations.py`（配置）广播 sync 事件；`remote_bridge.py` 注入来源标记
5. ✅ 前端集成：桌面端 `ChatPage` 与远端 `App.tsx` 均通过 `SyncManager.feedEvent` 接管运行态与配置同步
6. ✅ 清理旧协议：移除 `turn.lock`/`turn.unlock` 与 `conversation.config.updated` 事件
7. ✅ 验证：三端 TypeScript 编译 + 前端构建 + 后端 14 项测试全部通过

## 实现说明（最终落地）

### 线路机制：sync 事件嵌入 AgentEvent

同步事件不新增信封类型，而是复用现有的 `event` 分发通道，以特殊的 AgentEvent 承载：

```json
{ "type": "sync", "syncType": "session.running", "syncPayload": { ... } }
```

- 后端 `sync_protocol.create_sync_event()` 构造，`event_bus.publish()` 广播
- 中继层照常透传（不解析 payload）
- 前端在已有的 `onEvent` 回调里识别 `type === "sync"`，交给 `SyncManager.feedEvent()`
- 这样无需改动 Transport 层，本地端和远端零差异

### 频道策略

- **运行态**（session.running/stopped）：同时广播到会话频道 + 全局频道 `*`
  - 会话频道 → 会话内视图锁定/解锁输入框
  - 全局频道 → 会话列表页显示/取消"运行中"标记
- **配置**（config.batch）：`broadcast_to_all` 广播到会话频道 + 全局频道

### 来源标记

远端发起的操作经 `remote_bridge.py` 注入内部标记（`_startedBy: "remote"` / `_changedBy: "remote"`），
后端据此在 sync 事件的 `startedBy` / `changedBy` 字段标注来源。这些标记是 payload 顶层字段，
不进入持久化的 config。

### 双向终止

`SyncManager.cancelSession()` 走 `turn.cancel` RPC，任一端均可调用；后端终止 turn 后在 finally 块
广播 `session.stopped`，双端同步恢复空闲。

### SyncTransportAdapter

`SyncManager` 不依赖完整 `Transport` 接口，只需 `onEvent` + `request` 两个方法（`SyncTransportAdapter`），
因此桌面端 `LocalTransport` 和远端 `RelayTransport` 无需改造即可直接接入。

## 扩展性考虑

该协议设计为可扩展：

- **新增同步类型**：只需在 `SyncMessageType` 中添加新类型，无需修改传输层
- **新增配置项**：在 `ConfigChangePayload` 中添加新字段
- **新增控制命令**：在 `control.*` 命名空间下添加新类型
- **中继无感知**：所有新增同步内容对中继透明

## 安全性考虑

1. **权限校验**：remote 端的权限在 `remote_bridge.py` 中统一校验
2. **防伪造**：中继层覆盖 `from` 字段，防止 peerId 伪造
3. **审计日志**：所有同步操作记录 `source` 字段，可追溯操作来源

## 总结

通过引入 `@code-lite/sync` 协议层：
- ✅ 统一了双端协议，减少维护成本
- ✅ 完整的状态同步（运行态、配置）
- ✅ 双向控制能力（双端都可终止）
- ✅ 中继透明转发，架构清晰
- ✅ 易于扩展新的同步内容

下一步开始实现协议包代码。
