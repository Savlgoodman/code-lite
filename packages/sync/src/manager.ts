/**
 * SyncManager：统一的双端同步管理器
 *
 * 核心职责：
 * 1. 通过 Transport 监听同步事件并分发到各处理器
 * 2. 提供命令式 API 向另一端广播状态变更
 * 3. 维护本地同步状态（RunningState / ConfigState / Presence）
 *
 * 本地端和远程端使用同一个类，仅 role 不同。
 * Remote 端经中继转发，对 SyncManager 完全透明。
 *
 * 见 docs/design/0710-UNIFIED-SYNC-PROTOCOL.md
 */

import type { Transport, EventHandler } from "@code-lite/transport";
import type { AgentEvent } from "@code-lite/protocol";
import type {
  SyncRole,
  SyncMessageType,
  SessionRunningPayload,
  SessionStoppedPayload,
  SessionStatePayload,
  ConfigChangePayload,
  ConfigBatchPayload,
  ControlCancelPayload,
  PresencePayload,
  PresenceJoinPayload,
  PresenceLeavePayload,
  RunningState,
  SessionConfig,
  SyncState,
} from "./types";

// ─── Handler types ─────────────────────────────────────────────

type SessionRunningHandler = (payload: SessionRunningPayload) => void;
type SessionStoppedHandler = (payload: SessionStoppedPayload) => void;
type SessionStateHandler = (payload: SessionStatePayload) => void;
type ConfigChangeHandler = (payload: ConfigChangePayload) => void;
type ControlCancelHandler = (payload: ControlCancelPayload) => void;
type PresenceHandler = (payload: PresencePayload) => void;

// ─── SyncManager Options ───────────────────────────────────────

export interface SyncManagerOptions {
  transport: Transport;
  role: SyncRole;
}

// ─── SyncManager ───────────────────────────────────────────────

export class SyncManager {
  private readonly transport: Transport;
  private readonly role: SyncRole;
  private readonly state: SyncState;

  // Handler sets
  private readonly sessionRunningHandlers = new Set<SessionRunningHandler>();
  private readonly sessionStoppedHandlers = new Set<SessionStoppedHandler>();
  private readonly sessionStateHandlers = new Set<SessionStateHandler>();
  private readonly configChangeHandlers = new Set<ConfigChangeHandler>();
  private readonly controlCancelHandlers = new Set<ControlCancelHandler>();
  private readonly presenceHandlers = new Set<PresenceHandler>();

  private unsubscribeEvent: (() => void) | null = null;

  constructor(options: SyncManagerOptions) {
    this.transport = options.transport;
    this.role = options.role;
    this.state = {
      running: new Map(),
      configs: new Map(),
      peers: new Map(),
    };
  }

  /** 启动同步，开始监听传输层事件 */
  start(): void {
    this.unsubscribeEvent = this.transport.onEvent(this.handleEvent);
  }

  /** 停止同步，释放资源 */
  stop(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
  }

  /** 获取当前同步状态（只读） */
  getState(): Readonly<SyncState> {
    return this.state;
  }

  /** 检查某会话是否正在运行 */
  isRunning(conversationId: string): boolean {
    const s = this.state.running.get(conversationId);
    return s != null && s.status === "running";
  }

  /** 获取某会话的运行态（如果有） */
  getRunningState(conversationId: string): RunningState | undefined {
    return this.state.running.get(conversationId);
  }

  /** 获取某会话的配置 */
  getConfig(conversationId: string): SessionConfig | undefined {
    return this.state.configs.get(conversationId);
  }

  // ─── 主动广播 ──────────────────────────────────────────────

  /**
   * 通知会话开始运行（由发起 turn 的一端调用）。
   * 后端在 turn.start 成功后广播此事件到全局频道。
   */
  notifySessionRunning(conversationId: string, turnId: string): void {
    const payload: SessionRunningPayload = {
      conversationId,
      turnId,
      startedBy: this.role,
      startedAt: Date.now(),
    };
    this.state.running.set(conversationId, {
      ...payload,
      status: "running",
    });
    // 在后端场景下由 event_bus 广播，前端场景下由 Transport 发送。
    // 这里的方法主要用于前端侧本地状态更新 + 通知 UI。
    this.dispatch("session.running", payload);
  }

  /**
   * 通知会话停止运行。
   * 后端在 turn 结束/取消后广播此事件。
   */
  notifySessionStopped(
    conversationId: string,
    turnId: string,
    reason: "cancelled" | "completed" | "error",
    stoppedBy?: SyncRole | "auto",
  ): void {
    const payload: SessionStoppedPayload = {
      conversationId,
      turnId,
      stoppedBy: stoppedBy ?? this.role,
      reason,
      stoppedAt: Date.now(),
    };
    const existing = this.state.running.get(conversationId);
    if (existing) {
      existing.status = reason === "cancelled" ? "cancelled" : reason === "completed" ? "completed" : "error";
    }
    this.dispatch("session.stopped", payload);
  }

  /**
   * 发送取消请求（双向终止）。
   * 实际取消通过 Transport.request("turn.cancel") 走 RPC。
   */
  async cancelSession(conversationId: string, turnId?: string): Promise<void> {
    const running = this.state.running.get(conversationId);
    const effectiveTurnId = turnId ?? running?.turnId;
    if (!effectiveTurnId) return;

    await this.transport.request("turn.cancel", {
      conversationId,
      turnId: effectiveTurnId,
    });
  }

  /**
   * 同步配置变更。
   * 调用后端 RPC 更新配置，后端成功后广播事件到频道。
   */
  async syncConfig(conversationId: string, changes: Partial<SessionConfig>): Promise<void> {
    await this.transport.request("conversation.config.update", {
      conversationId,
      ...changes,
    });
  }

  // ─── 事件监听注册 ──────────────────────────────────────────

  onSessionRunning(handler: SessionRunningHandler): () => void {
    this.sessionRunningHandlers.add(handler);
    return () => this.sessionRunningHandlers.delete(handler);
  }

  onSessionStopped(handler: SessionStoppedHandler): () => void {
    this.sessionStoppedHandlers.add(handler);
    return () => this.sessionStoppedHandlers.delete(handler);
  }

  onSessionState(handler: SessionStateHandler): () => void {
    this.sessionStateHandlers.add(handler);
    return () => this.sessionStateHandlers.delete(handler);
  }

  onConfigChange(handler: ConfigChangeHandler): () => void {
    this.configChangeHandlers.add(handler);
    return () => this.configChangeHandlers.delete(handler);
  }

  onControlCancel(handler: ControlCancelHandler): () => void {
    this.controlCancelHandlers.add(handler);
    return () => this.controlCancelHandlers.delete(handler);
  }

  onPresence(handler: PresenceHandler): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  // ─── 内部事件分发 ──────────────────────────────────────────

  private readonly handleEvent: EventHandler = (event: AgentEvent, meta) => {
    // 同步事件通过 AgentEvent 的 type 字段传输。
    // 后端将同步事件包装为 AgentEvent 格式广播到频道。
    const syncType = (event as unknown as { syncType?: SyncMessageType }).syncType;
    if (!syncType) return;

    const payload = (event as unknown as { syncPayload?: unknown }).syncPayload;
    if (payload == null) return;

    this.handleSyncEvent(syncType, payload);
  };

  private handleSyncEvent(type: SyncMessageType, payload: unknown): void {
    switch (type) {
      case "session.running": {
        const p = payload as SessionRunningPayload;
        this.state.running.set(p.conversationId, { ...p, status: "running" });
        for (const h of this.sessionRunningHandlers) h(p);
        break;
      }
      case "session.stopped": {
        const p = payload as SessionStoppedPayload;
        const existing = this.state.running.get(p.conversationId);
        if (existing) {
          existing.status = p.reason === "cancelled" ? "cancelled" : p.reason === "completed" ? "completed" : "error";
        }
        for (const h of this.sessionStoppedHandlers) h(p);
        break;
      }
      case "session.state": {
        const p = payload as SessionStatePayload;
        for (const h of this.sessionStateHandlers) h(p);
        break;
      }
      case "config.model":
      case "config.effort":
      case "config.access_mode":
      case "config.batch": {
        const p = payload as ConfigBatchPayload;
        const existing = this.state.configs.get(p.conversationId) ?? {};
        Object.assign(existing, p.changes ?? { [type.replace("config.", "")]: (payload as Record<string, unknown>)[type.replace("config.", "")] });
        this.state.configs.set(p.conversationId, existing);
        for (const h of this.configChangeHandlers) h(payload as ConfigChangePayload);
        break;
      }
      case "control.cancel": {
        const p = payload as ControlCancelPayload;
        for (const h of this.controlCancelHandlers) h(p);
        break;
      }
      case "presence.join": {
        const p = payload as PresenceJoinPayload;
        this.state.peers.set(p.peerId, p);
        for (const h of this.presenceHandlers) h(p);
        break;
      }
      case "presence.leave": {
        const p = payload as PresenceLeavePayload;
        this.state.peers.delete(p.peerId);
        for (const h of this.presenceHandlers) h(p);
        break;
      }
      case "presence.heartbeat": {
        for (const h of this.presenceHandlers) h(payload as PresencePayload);
        break;
      }
    }
  }

  private dispatch(_type: SyncMessageType, _payload: unknown): void {
    // 前端侧：本地状态已更新，UI 通过 handlers 获取通知。
    // 后端侧由 event_bus.publish() 广播，不经此方法。
    // 此方法仅用于本地端的乐观更新。
  }
}
