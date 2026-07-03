# 远程连接与同步观看设计

本文设计 code-lite 的远程连接与同步观看能力。目标是在主设备运行 agent 任务时，让远端设备可以安全、低延迟地观看会话进展，并为后续远程发送消息、取消任务和审批授权预留协议边界。

## 1. 目标

1. 远端可以通过连接码或授权链接连接到主设备。
2. 远端默认只读观看，不自动获得控制权。
3. 远端可以看到当前会话快照和后续实时事件。
4. 断线重连后可以按事件序号补齐遗漏事件。
5. 主设备可以随时撤销连接。
6. 远端连接、断开、权限变化和决策行为写入审计日志。

## 2. 非目标

1. MVP 不做多人同时编辑文件。
2. MVP 不默认提供跨公网中继服务。
3. MVP 不把远端控制做成默认能力。
4. MVP 不上传完整仓库源码到远端服务。
5. MVP 不承诺所有 runtime 的所有底层动作都可被远端审批前置拦截。

## 3. 核心模型

远程同步只消费统一 `AgentEvent`，不直接绑定某个 agent runtime。

```text
Agent Runtime
  -> Agent Adapter
  -> AgentEvent
  -> Event Bus
      -> Local UI
      -> Session Store
      -> Remote Sync Gateway
          -> Remote Viewer
```

这保证 Codex、Claude Code、opencode 等 ACP runtime 的输出都能走同一套远程观看链路。legacy nanobot 如果继续输出统一 `AgentEvent`，也可以复用该链路，但不再作为远程同步设计的主线对象。

## 4. 连接权限

远端权限分级：

| 权限 | 能力 | MVP |
| --- | --- | --- |
| `viewer` | 只读观看会话事件 | 必做 |
| `commenter` | 可发送用户消息 | 可选 |
| `operator` | 可取消任务和处理低中风险审批 | 后续 |
| `owner` | 主设备用户，管理连接和授权 | 必做 |

MVP 只开放 `viewer`。任何提升权限都必须由主设备用户在本地确认。

## 5. 连接流程

### 5.1 创建远程会话

1. 主设备用户在 UI 中点击“开启远程观看”。
2. backend 创建 `remoteSessionId` 和一次性令牌。
3. UI 展示连接码、局域网地址或二维码。
4. backend 记录创建时间、过期时间、权限范围和会话绑定关系。

### 5.2 远端连接

1. 远端提交连接码或令牌。
2. backend 校验令牌、过期时间和撤销状态。
3. backend 返回当前会话快照。
4. backend 从当前最新 `sequence` 开始推送增量事件。
5. UI 记录观看者加入事件。

### 5.3 断线重连

1. 远端重连时提交 `lastSequence`。
2. backend 从事件存储中补发 `lastSequence + 1` 之后的事件。
3. 如果事件已被清理，则返回最新快照并重新开始增量同步。

### 5.4 撤销连接

1. 主设备用户点击撤销。
2. backend 标记令牌失效。
3. 已连接远端收到 `remote.revoked` 事件并断开。
4. 审计日志记录撤销时间和操作者。

## 6. 事件协议

远程事件沿用统一 `AgentEvent` 基础字段：

```json
{
  "eventId": "evt_...",
  "sequence": 42,
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "runtime": "codex",
  "type": "message.delta",
  "createdAt": "2026-07-01T12:00:00Z",
  "payload": {}
}
```

远程相关事件：

```text
remote.session_created
remote.viewer_joined
remote.viewer_left
remote.permission_changed
remote.revoked
remote.sync_resumed
```

远程同步规则：

1. 每个会话的事件序号单调递增。
2. 本地 UI、远端 UI 和审计日志使用同一事件源。
3. 远端只接收必要事件和脱敏摘要。
4. 命令输出、diff 和大附件可通过引用懒加载。
5. 敏感字段必须在发送远端前脱敏。

## 7. API 草案

MVP 可先采用 SSE 只读同步，后续切换或补充 WebSocket。

```text
POST /api/remote/sessions
GET  /api/remote/sessions/{remoteSessionId}
POST /api/remote/sessions/{remoteSessionId}/revoke
GET  /api/remote/sessions/{remoteSessionId}/events?token=...&lastSequence=42
```

后续双向控制可增加：

```text
POST /api/remote/sessions/{remoteSessionId}/messages
POST /api/remote/sessions/{remoteSessionId}/approvals/{approvalId}/decision
POST /api/remote/sessions/{remoteSessionId}/turns/{turnId}/cancel
```

## 8. 安全要求

1. 远程令牌必须有过期时间。
2. 主设备可以随时撤销远程令牌。
3. 远程令牌不得明文写入仓库或可导出日志。
4. 默认只读，不默认允许远端发送消息或审批。
5. 远端事件必须脱敏 API Key、Token、私钥和 `.env` 内容。
6. 远端访问仓库文件内容时必须另行授权，MVP 不开放完整文件读取。
7. 远程连接状态必须在本地 UI 可见。

## 9. 本地与跨网络策略

MVP 推荐先实现局域网或本机调试链路：

1. 主设备 backend 监听本地端口。
2. 用户明确开启远程观看后，才允许绑定局域网地址或生成访问入口。
3. 默认不开公网端口，不自动穿透 NAT。

跨公网中继作为后续阶段：

1. 中继服务只转发事件，不默认存储完整会话。
2. 引入设备身份、端到端加密和令牌撤销。
3. 中继服务不能看到 API Key、Token、私钥和未脱敏敏感内容。

## 10. MVP 落地顺序

1. 为会话事件增加稳定 `sequence`。
2. 将事件写入 `data/events/`。
3. 增加远程 session 创建和撤销 API。
4. 实现只读 SSE 事件订阅。
5. UI 增加远程观看入口和观看者列表。
6. 支持断线按 `lastSequence` 补发。
7. 为远端事件做脱敏过滤。

## 11. 待确认问题

1. MVP 是否只支持局域网访问？
2. 连接码是数字短码、随机 token，还是二维码承载完整 URL？
3. 远程只读观看是否需要主设备二次确认每个连接？
4. 远端是否允许看到完整命令输出和 diff？
5. 事件保留多久，超出保留期如何恢复快照？
6. 远端发送消息是否进入 MVP？
