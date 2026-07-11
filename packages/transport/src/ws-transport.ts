/**
 * WsTransport — 双端共享的 WebSocket 传输基类
 *
 * 桌面端（直连后端 /api/ws）与远端（经中继）复用同一套连接/RPC/订阅/心跳逻辑，
 * 差异通过构造注入项隔离：
 * - socketFactory：创建 WebSocket（注入以避免 packages 依赖浏览器全局）
 * - urlProvider：解析连接 URL（桌面端 Tauri 后端发现 / 远端固定 relay）
 * - encodeFrame/decodeFrame：本地=直通；中继=裹/拆 {type:"msg", payload} 外层
 * - onHandshake：中继需先发 hello 并等 ready；本地无握手
 * - heartbeat：中继开，本地关
 *
 * 业务信封统一为 {v, kind, method, requestId, seq, channel, payload}，
 * 上层（SyncManager / ConversationClient / UI）完全看不出连的是本地还是中继。
 *
 * 见 docs/design/0710-DUAL-END-UNIFICATION-REFACTOR.md 阶段 1。
 */

import type { AgentEvent } from "@code-lite/protocol";
import type {
  Transport,
  TransportStatus,
  Subscription,
  SubscribeOptions,
  EventHandler,
  SnapshotHandler,
  StatusHandler,
  ControlHandler,
} from "./transport";
import { TransportError } from "./transport";

const WIRE_VERSION = 1;
const RPC_TIMEOUT_MS = 30000;

/** 业务信封（本地直发即此结构；中继时作为外层 msg 的 payload）。 */
export interface WireEnvelope {
  v: number;
  kind: "req" | "result" | "error" | "event" | "snapshot" | "control" | "presence";
  channel?: string | null;
  requestId?: string;
  seq?: number;
  method?: string;
  payload?: unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
}

/** 子类通过此结构告知基类如何编解码与握手。 */
export interface WsTransportConfig {
  /** 创建 WebSocket 实例（浏览器传 (url) => new WebSocket(url)）。 */
  socketFactory: (url: string) => WebSocket;
  /** 解析连接 URL（可异步：桌面端需先发现后端端口）。 */
  urlProvider: () => Promise<string> | string;
  /** 出站：把业务信封编码为实际发送的对象（本地=直通，中继=裹外层）。 */
  encodeFrame: (envelope: WireEnvelope) => Record<string, unknown>;
  /** 入站：从原始消息中拆出业务信封；返回 null 表示非业务帧（已在钩子里处理）。 */
  decodeFrame: (raw: Record<string, unknown>) => WireEnvelope | null;
  /**
   * 连接建立后的握手。resolve 表示握手完成、连接可用。
   * 本地端可省略（默认立即完成）。中继端在此发 hello、等 ready。
   * onControlFrame 用于把握手期/连接期的非业务帧（host.online 等）交回基类分发。
   */
  onHandshake?: (ctx: HandshakeContext) => Promise<void>;
  /** 是否启用应用层心跳（中继 true，本地 false）。 */
  heartbeat?: boolean;
  heartbeatIntervalMs?: number;
  /** 是否在非主动关闭时自动重连（默认 true）。 */
  reconnect?: boolean;
  /** 最大重连尝试次数，超过后置为 closed 并停止（默认 6）。 */
  maxReconnectAttempts?: number;
  /** 指数退避基数毫秒（默认 1000）。 */
  reconnectBaseMs?: number;
  /** 指数退避上限毫秒（默认 30000）。 */
  reconnectMaxMs?: number;
}

/** 握手上下文：子类用它发送原始帧、监听原始帧、标记就绪。 */
export interface HandshakeContext {
  sendRaw: (data: Record<string, unknown>) => void;
  /** 注册原始入站帧监听（握手帧 + 连接期控制帧如 host.online/offline）。 */
  onRawMessage: (handler: (msg: Record<string, unknown>) => void) => void;
}

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private _status: TransportStatus = "idle";
  private readonly pending = new Map<string, PendingRpc>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly snapshotHandlers = new Set<SnapshotHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();
  private readonly rawHandlers = new Set<(msg: Record<string, unknown>) => void>();
  private readonly subscribedChannels = new Set<string>();
  private heartbeatTimer: TimerHandle | null = null;
  // 重连状态：主动 close() 置 true 以抑制自动重连；重连尝试计数与定时器句柄。
  private manualClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: TimerHandle | null = null;
  private readonly reconnectedHandlers = new Set<() => void>();
  // 最近入站帧时间戳（心跳存活判定用）。
  private lastInboundAt = 0;

  constructor(private readonly config: WsTransportConfig) {}

  get status(): TransportStatus {
    return this._status;
  }

  private setStatus(s: TransportStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const h of this.statusHandlers) h(s);
  }

  /**
   * 注册重连成功回调：连接断开后自动重连并握手成功时触发。
   * 上层据此重订阅当前频道、重拉列表，补齐断线期间错过的状态。
   */
  onReconnected(handler: () => void): () => void {
    this.reconnectedHandlers.add(handler);
    return () => this.reconnectedHandlers.delete(handler);
  }

  // ─── 连接 ────────────────────────────────────────────────

  async connect(): Promise<void> {
    // 主动连接（含手动重连）：清除重连抑制与退避计数、取消排队中的重连。
    this.manualClose = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      Promise.resolve(this.config.urlProvider()).then((url) => {
        this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
        // 每次建连清空 rawHandlers，避免重连后 onHandshake 重复注册导致帧被多次处理。
        this.rawHandlers.clear();
        const socket = this.config.socketFactory(url);
        this.ws = socket;
        socket.onmessage = (ev) => this.handleRawMessage(ev.data as string);
        socket.onerror = () => {
          // 交给 onclose 统一处理重连；此处仅 reject 首次 connect 的 awaiter。
          reject(new TransportError("WebSocket connection failed", "connect_failed"));
        };
        socket.onclose = () => this.handleClose();
        socket.onopen = () => {
          void this.runHandshake(resolve, reject);
        };
      }, (err) => {
        this.handleClose();
        reject(err instanceof Error ? err : new TransportError(String(err), "url_failed"));
      });
    });
  }

  private async runHandshake(
    resolve: () => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    const ctx: HandshakeContext = {
      sendRaw: (data) => this.sendRaw(data),
      onRawMessage: (handler) => this.rawHandlers.add(handler),
    };
    try {
      if (this.config.onHandshake) {
        await this.config.onHandshake(ctx);
      }
      const wasReconnect = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      if (this.config.heartbeat) this.startHeartbeat();
      resolve();
      // 重连成功：重放订阅并通知上层补齐断线期间错过的状态。
      if (wasReconnect) this.onReconnectSuccess();
    } catch (err) {
      // 握手失败（如中继 room_has_host）视为终态，不自动重连；关闭 socket。
      this.manualClose = true;
      this.ws?.close();
      this.ws = null;
      this.setStatus("closed");
      reject(err instanceof Error ? err : new TransportError(String(err), "handshake_failed"));
    }
  }

  private handleClose(): void {
    this.clearHeartbeat();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError("connection closed", "closed"));
    }
    this.pending.clear();
    this.ws = null;
    const reconnectEnabled = this.config.reconnect !== false;
    const maxAttempts = this.config.maxReconnectAttempts ?? 6;
    if (!this.manualClose && reconnectEnabled && this.reconnectAttempts < maxAttempts) {
      this.scheduleReconnect();
    } else {
      this.setStatus("closed");
    }
  }

  /** 按指数退避排队一次重连尝试。 */
  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const base = this.config.reconnectBaseMs ?? 1000;
    const max = this.config.reconnectMaxMs ?? 30000;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      // openSocket 失败会触发 onclose → handleClose → 下一轮重连（或耗尽后 closed）。
      this.openSocket().catch(() => { /* 由 onclose 驱动后续重连，无需在此处理 */ });
    }, delay);
  }

  /** 重连成功后：重放订阅 + 触发上层回调。 */
  private onReconnectSuccess(): void {
    this.resubscribeAll();
    for (const h of this.reconnectedHandlers) h();
  }

  /**
   * 重放当前所有已订阅频道（重新发 subscribe）。
   * 用于两种场景：本端重连后自动恢复；或宿主重连后（本端 socket 未断）
   * 由上层主动调用，让宿主为本 peer 重建事件 pump。
   */
  resubscribeAll(): void {
    for (const channel of this.subscribedChannels) {
      try {
        this.send({ v: WIRE_VERSION, kind: "req", method: "subscribe", requestId: createRequestId(), payload: { channel } });
      } catch { /* 单个频道重订阅失败不阻断其余 */ }
    }
  }

  /** 心跳探测判定连接已死时强制重连（关闭当前 socket 触发 onclose）。 */
  private forceReconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch { /* 忽略关闭异常 */ }
    }
    this.handleClose();
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.clearHeartbeat();
    this.subscribedChannels.clear();
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  // ─── 收发 ────────────────────────────────────────────────

  private sendRaw(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new TransportError("WS not connected", "not_connected");
    }
    this.ws.send(JSON.stringify(data));
  }

  private send(envelope: WireEnvelope): void {
    this.sendRaw(this.config.encodeFrame(envelope));
  }

  private handleRawMessage(raw: string): void {
    // 记录最近入站时间：任何帧（含中继 ping/pong）都算连接存活证据。
    this.lastInboundAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    // 先给子类的原始帧监听（握手帧、host.online/offline、ping/pong 等）。
    for (const h of this.rawHandlers) h(msg);
    // 再解出业务信封分发。decodeFrame 返回 null 表示这是非业务帧，已被上面处理。
    const envelope = this.config.decodeFrame(msg);
    if (envelope) this.dispatchEnvelope(envelope);
  }

  private dispatchEnvelope(envelope: WireEnvelope): void {
    const { kind, requestId } = envelope;

    if ((kind === "result" || kind === "error") && requestId) {
      const p = this.pending.get(requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        if (kind === "result") p.resolve(envelope.payload);
        else {
          const err = envelope.payload as { code?: string; error?: string } | undefined;
          p.reject(new TransportError(err?.error ?? err?.code ?? "RPC error", err?.code ?? "rpc_error", requestId));
        }
      }
      return;
    }

    if (kind === "snapshot") {
      const channel = envelope.channel ?? "";
      for (const h of this.snapshotHandlers) h(channel, envelope.payload);
      // subscribe 的响应即 snapshot（带 requestId），同时 resolve pending RPC。
      if (requestId) {
        const p = this.pending.get(requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(requestId);
          p.resolve(envelope.payload);
        }
      }
      return;
    }

    if (kind === "event") {
      const channel = envelope.channel ?? "";
      for (const h of this.eventHandlers) h(envelope.payload as AgentEvent, { channel, seq: envelope.seq });
      return;
    }

    if (kind === "control") {
      for (const h of this.controlHandlers) h(envelope.payload);
    }
  }

  // ─── RPC ─────────────────────────────────────────────────

  async request<T = unknown>(method: string, payload?: unknown): Promise<T> {
    await this.connect();
    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new TransportError(`RPC ${method} timed out`, "timeout", requestId));
      }, RPC_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ v: WIRE_VERSION, kind: "req", method, requestId, payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new TransportError(String(error), "send_failed"));
      }
    });
  }

  // ─── 订阅 ────────────────────────────────────────────────

  async subscribe(channel: string, options?: SubscribeOptions): Promise<Subscription> {
    await this.connect();
    this.subscribedChannels.add(channel);
    const requestId = createRequestId();
    // subscribe 的响应是 snapshot（带此 requestId），由 dispatchEnvelope resolve。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // 订阅超时不致命（后端可能只发 event 不发 snapshot）：视为成功。
        resolve();
      }, RPC_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
      });
      try {
        this.send({
          v: WIRE_VERSION,
          kind: "req",
          method: "subscribe",
          requestId,
          payload: { channel, ...(options?.afterSequence ? { afterSequence: options.afterSequence } : {}) },
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new TransportError(String(error), "send_failed"));
      }
    });
    return {
      channel,
      unsubscribe: () => this.unsubscribe(channel),
    };
  }

  unsubscribe(channel: string): void {
    this.subscribedChannels.delete(channel);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ v: WIRE_VERSION, kind: "req", method: "unsubscribe", requestId: createRequestId(), payload: { channel } });
    }
  }

  // ─── 监听注册 ────────────────────────────────────────────

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    return () => this.controlHandlers.delete(handler);
  }

  /** 供子类分发连接期控制信令（host.online/offline）。 */
  protected emitControl(payload: unknown): void {
    for (const h of this.controlHandlers) h(payload);
  }

  // ─── 心跳 ────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const interval = this.config.heartbeatIntervalMs ?? 20000;
    // 连续静默超过该阈值判定连接已死：浏览器 onclose 在 TCP 静默断开时可能长时间
    // 不触发，靠 ping 后仍无任何入站帧来主动发现掉线，触发强制重连。
    const silenceLimit = interval * 2.5;
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // 上一轮 ping 后仍无任何入站帧（含 pong）→ 判定掉线，强制重连。
      if (Date.now() - this.lastInboundAt > silenceLimit) {
        this.forceReconnect();
        return;
      }
      try {
        this.sendRaw({ type: "ping" });
      } catch {
        this.forceReconnect();
      }
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function createRequestId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

