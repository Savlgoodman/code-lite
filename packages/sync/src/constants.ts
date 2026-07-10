/**
 * 同步事件常量
 *
 * 后端通过 event_bus 广播的同步事件字段名：
 * - syncType: 同步消息类型（对应 SyncMessageType）
 * - syncPayload: 同步消息载荷
 *
 * 这些字段嵌入 AgentEvent 中，通过已有的 event 分发机制传输。
 * 双端 Transport 层无感知，只需要在应用层识别并处理。
 *
 * 后端 Python 侧使用相同的字符串常量。
 */

/** AgentEvent 中携带同步信息的保留字段 */
export const SYNC_TYPE_FIELD = "syncType" as const;
export const SYNC_PAYLOAD_FIELD = "syncPayload" as const;

/** 同步事件类型常量（与 SyncMessageType 一一对应） */
export const SyncEvents = {
  SESSION_RUNNING: "session.running",
  SESSION_STOPPED: "session.stopped",
  SESSION_STATE: "session.state",
  SESSION_CONFIG: "session.config",

  CONFIG_MODEL: "config.model",
  CONFIG_EFFORT: "config.effort",
  CONFIG_ACCESS_MODE: "config.access_mode",
  CONFIG_BATCH: "config.batch",

  CONTROL_CANCEL: "control.cancel",
  CONTROL_LOCK: "control.lock",
  CONTROL_UNLOCK: "control.unlock",

  PRESENCE_JOIN: "presence.join",
  PRESENCE_LEAVE: "presence.leave",
  PRESENCE_HEARTBEAT: "presence.heartbeat",
} as const;

/**
 * 构造一个携带同步信息的 AgentEvent。
 * 后端 Python 侧应生成相同结构。
 */
export function createSyncEvent(
  syncType: string,
  syncPayload: unknown,
): { type: "sync"; syncType: string; syncPayload: unknown } {
  return {
    type: "sync",
    syncType,
    syncPayload,
  };
}

/**
 * 判断一个 AgentEvent 是否为同步事件。
 */
export function isSyncEvent(event: unknown): event is { type: "sync"; syncType: string; syncPayload: unknown } {
  if (event == null || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return e.type === "sync" && typeof e.syncType === "string" && e.syncPayload !== undefined;
}

/**
 * 从 AgentEvent 中提取同步载荷。
 * 如果不是同步事件返回 null。
 */
export function extractSyncPayload(event: unknown): { type: string; payload: unknown } | null {
  if (!isSyncEvent(event)) return null;
  return { type: event.syncType, payload: event.syncPayload };
}
