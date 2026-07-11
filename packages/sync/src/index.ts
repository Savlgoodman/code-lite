/**
 * @code-lite/sync — 双端统一同步协议
 *
 * 提供本地端（host）和远程端（remote）之间的状态同步能力：
 * - 会话运行态同步（双端可终止）
 * - 配置同步（模型、思考强度等）
 * - 存在性管理（设备在线状态）
 *
 * 使用方式：
 * ```typescript
 * import { SyncManager, StateTracker, ConfigSyncer } from '@code-lite/sync';
 *
 * const sync = new SyncManager({ transport, role: 'host' });
 * sync.start();
 *
 * // 监听运行态变化
 * sync.onSessionRunning((payload) => {
 *   console.log(`会话 ${payload.conversationId} 开始运行，由 ${payload.startedBy} 发起`);
 * });
 * ```
 *
 * 见 docs/design/0710-UNIFIED-SYNC-PROTOCOL.md
 */

// 类型导出
export type {
  SyncMessageType,
  SyncRole,
  SyncMessage,
  SessionRunningPayload,
  SessionStoppedPayload,
  SessionStatePayload,
  ConfigModelPayload,
  ConfigEffortPayload,
  ConfigAccessModePayload,
  ConfigBatchPayload,
  ConfigChangePayload,
  ControlCancelPayload,
  ControlLockPayload,
  ControlUnlockPayload,
  ControlPayload,
  PresenceJoinPayload,
  PresenceLeavePayload,
  PresenceHeartbeatPayload,
  PresencePayload,
  RunningState,
  SessionConfig,
  SyncState,
} from "./types";

// 核心类导出
export { SyncManager } from "./manager";
export type {
  SyncManagerOptions,
  SyncTransportAdapter,
  SessionRunningHandler,
  SessionStoppedHandler,
  SessionStateHandler,
  ConfigChangeHandler,
  ControlCancelHandler,
  PresenceHandler,
} from "./manager";

export { StateTracker } from "./state-tracker";
export type { StateChangeHandler } from "./state-tracker";

export { ConfigSyncer } from "./config-syncer";
export type { ConfigUpdateHandler } from "./config-syncer";

// 常量和工具函数导出
export {
  SYNC_TYPE_FIELD,
  SYNC_PAYLOAD_FIELD,
  SyncEvents,
  createSyncEvent,
  isSyncEvent,
  extractSyncPayload,
} from "./constants";
