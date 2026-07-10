/**
 * 双端同步协议类型定义
 *
 * 本协议用于 code-lite 本地端（ui）和远程端（ui-remote）之间的状态同步。
 * 核心功能：
 * - 会话运行态同步（双端可终止）
 * - 配置同步（模型、思考强度等）
 * - 存在性管理（设备在线状态）
 *
 * 见 docs/design/0710-UNIFIED-SYNC-PROTOCOL.md
 */

/** 同步消息类型 */
export type SyncMessageType =
  // 会话状态同步
  | 'session.state'        // 会话状态变化（创建、归档、删除）
  | 'session.config'       // 会话配置更新
  | 'session.running'      // 运行态：某会话开始执行 turn
  | 'session.stopped'      // 运行态：某会话 turn 结束或被取消

  // 配置同步
  | 'config.model'         // 模型切换
  | 'config.effort'        // 思考强度切换
  | 'config.access_mode'   // 访问模式切换
  | 'config.batch'         // 批量配置更新

  // 控制命令
  | 'control.cancel'       // 取消当前运行的 turn
  | 'control.lock'         // 锁定会话（禁止另一端操作）
  | 'control.unlock'       // 解锁会话

  // 存在性通知
  | 'presence.join'        // 远端设备加入
  | 'presence.leave'       // 远端设备离开
  | 'presence.heartbeat';  // 心跳

/** 消息来源角色 */
export type SyncRole = 'host' | 'remote';

/** 同步消息信封（通过 Transport 传输） */
export interface SyncMessage<TPayload = unknown> {
  type: SyncMessageType;
  payload: TPayload;
  timestamp: number;
  source: SyncRole;
}

/** 会话运行态同步 */
export interface SessionRunningPayload {
  conversationId: string;
  turnId: string;
  startedBy: SyncRole;
  startedAt: number;
}

export interface SessionStoppedPayload {
  conversationId: string;
  turnId: string;
  stoppedBy: SyncRole | 'auto';
  reason: 'cancelled' | 'completed' | 'error';
  stoppedAt: number;
}

/** 会话状态变化 */
export interface SessionStatePayload {
  conversationId: string;
  action: 'created' | 'archived' | 'deleted' | 'restored';
  by: SyncRole;
}

/** 配置同步 Payload */
export interface ConfigModelPayload {
  conversationId: string;
  model: string;
  changedBy: SyncRole;
}

export interface ConfigEffortPayload {
  conversationId: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  changedBy: SyncRole;
}

export interface ConfigAccessModePayload {
  conversationId: string;
  accessMode: 'direct' | 'approval';
  changedBy: SyncRole;
}

/** 批量配置更新（一次更新多个配置项） */
export interface ConfigBatchPayload {
  conversationId: string;
  changes: {
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    accessMode?: 'direct' | 'approval';
    [key: string]: unknown;
  };
  changedBy: SyncRole;
}

export type ConfigChangePayload =
  | ConfigModelPayload
  | ConfigEffortPayload
  | ConfigAccessModePayload
  | ConfigBatchPayload;

/** 控制命令 Payload */
export interface ControlCancelPayload {
  conversationId: string;
  turnId?: string;
  requestedBy: SyncRole;
}

export interface ControlLockPayload {
  conversationId: string;
  lockedBy: SyncRole;
  reason?: string;
}

export interface ControlUnlockPayload {
  conversationId: string;
  unlockedBy: SyncRole;
}

export type ControlPayload =
  | ControlCancelPayload
  | ControlLockPayload
  | ControlUnlockPayload;

/** 存在性 Payload */
export interface PresenceJoinPayload {
  peerId: string;
  role: 'viewer' | 'operator' | 'pending';
  joinedAt: number;
}

export interface PresenceLeavePayload {
  peerId: string;
  leftAt: number;
}

export interface PresenceHeartbeatPayload {
  peerId: string;
  timestamp: number;
}

export type PresencePayload =
  | PresenceJoinPayload
  | PresenceLeavePayload
  | PresenceHeartbeatPayload;

/** 运行态追踪器状态 */
export interface RunningState {
  conversationId: string;
  turnId: string;
  startedBy: SyncRole;
  startedAt: number;
  status: 'running' | 'cancelled' | 'completed' | 'error';
}

/** 配置状态（会话级） */
export interface SessionConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  accessMode?: 'direct' | 'approval';
  locked?: boolean;
  lockedBy?: SyncRole;
  [key: string]: unknown;
}

/** 全局同步状态 */
export interface SyncState {
  /** 当前运行中的会话 */
  running: Map<string, RunningState>;
  /** 各会话配置状态 */
  configs: Map<string, SessionConfig>;
  /** 在线设备列表 */
  peers: Map<string, PresenceJoinPayload>;
}
