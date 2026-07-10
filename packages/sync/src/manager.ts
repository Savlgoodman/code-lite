/**
 * SyncManager：统一的双端同步管理器
 *
 * 核心职责：
 * 1. 监听传输层事件并识别同步事件（type: "sync"）
 * 2. 提供命令式 API 发起控制命令（cancel / syncConfig）
 * 3. 维护本地同步状态（RunningState / ConfigState / Presence）
 *
 * 本地端和远程端使用同一个类，仅 role 不同。
 * Remote 端经中继转发，对 SyncManager 完全透明。
 *
 * 设计要点：
 * - 不强依赖 Transport 接口全集，只需 onEvent + request 两个方法
 * - 接受任何实现了 SyncTransportAdapter 的对象（LocalTransport / RelayTransport 都可）
 * - 后端 sync 事件通过现有 event pump 自动分发到前端
 *
 * 见 docs/design/0710-UNIFIED-SYNC-PROTOCOL.md
 */

import type { AgentEvent } from "@code-lite/protocol";
import { isSyncEvent, extractSyncPayload } from "./constants";
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

export type SessionRunningHandler = (payload: SessionRunningPayload) => void;
export type SessionStoppedHandler = (payload: SessionStoppedPayload) => void;
export type SessionStateHandler = (payload: SessionStatePayload) => void;
export type ConfigChangeHandler = (payload: ConfigChangePayload) => void;
export type ControlCancelHandler = (payload: ControlCancelPayload) => void;
export type PresenceHandler = (payload: PresencePayload) => void;

// ─── Transport 适配器（仅需两个方法） ────────────────────────────

/**
 * SyncManager 对传输层的最小要求。
 * LocalTransport 和 RelayTransport 都满足此接口。
 */
export interface SyncTransportAdapter {
  /** 注册事件监听，返回取消函数 */
  onEvent(handler: (event: AgentEvent, meta: { channel: string; seq?: number }) => void): () => void;
  /** 发送 RPC 请求 */
  request<T = unknown>(method: string, payload?: unknown): Promise<T>;
}

// ─── SyncManager Options ───────────────────────────────────────

export interface SyncManagerOptions {
  transport: SyncTransportAdapter;
  role: SyncRole;
}

// ─── SyncManager ───────────────────────────────────────────────

export class SyncManager {
  private readonly transport: SyncTransportAdapter;
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

  // ─── 主动操作 ──────────────────────────────────────────────

  /**
   * 通知会话开始运行（本地乐观更新）。
   * 实际的跨端同步由后端 turn.start 广播 sync 事件完成。
   */
  notifySessionRunning(conversationId: string, turnId: string): void {
    const payload: SessionRunningPayload = {
      conversationId,
      turnId,
      startedBy: this.role,
      startedAt: Date.now(),
    };
    this.state.running.set(conversationId, { ...payload, status: "running" });
    for (const h of this.sessionRunningHandlers) h(payload);
  }

  /**
   * 通知会话停止运行（本地乐观更新）。
   * 实际的跨端同步由后端 turn 结束后广播 sync 事件完成。
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
    this.state.running.delete(conversationId);
    for (const h of this.sessionStoppedHandlers) h(payload);
  }

  /**
   * 发送取消请求（双向终止）。
   * 任一端均可调用，后端收到后终止 turn 并广播 session.stopped。
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
   * 调用后端 RPC 更新配置，后端成功后广播 config.batch 事件到频道。
   */
  async syncConfig(conversationId: string, changes: Partial<SessionConfig>): Promise<void> {
    await this.transport.request("conversation.config.update", {
      conversationId,
      config: changes,
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

  // ─── 外部喂入事件（供已有 onEvent 的应用层调用） ────────────────

  /**
   * 手动喂入一个 AgentEvent 给 SyncManager 处理。
   * 适用于应用层已有自己的 onEvent 回调，想复用 SyncManager 的场景：
   * 不需要调 start()，只需在收到事件时调用 feedEvent。
   */
  feedEvent(event: AgentEvent): void {
    if (!isSyncEvent(event)) return;
    const extracted = extractSyncPayload(event);
    if (!extracted) return;
    this.handleSyncEvent(extracted.type as SyncMessageType, extracted.payload);
  }

  // ─── 内部事件分发 ──────────────────────────────────────────

  private readonly handleEvent = (event: AgentEvent, _meta: { channel: string; seq?: number }) => {
    this.feedEvent(event);
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
        this.state.running.delete(p.conversationId);
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
        if (p.changes) {
          Object.assign(existing, p.changes);
        }
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
}
