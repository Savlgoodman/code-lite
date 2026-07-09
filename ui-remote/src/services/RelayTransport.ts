import type { AgentEvent } from "@code-lite/protocol";
import type { Transport, TransportStatus } from "@code-lite/transport";

/**
 * 中继传输：通过 WebSocket 连接 relay 服务器，
 * 在 `msg` 信封内携带业务 payload。
 */

const RELAY_VERSION = 1;

type RelayKind = "hello" | "ready" | "waiting" | "msg" | "ping" | "pong" | "error" | "peer.joined" | "peer.left" | "host.online" | "host.offline";

interface RelayEnvelope {
  type: RelayKind;
  role?: string;
  peerId?: string;
  roomId?: string;
  error?: string;
  payload?: unknown;
}

export interface RelayTransportOptions {
  relayUrl: string;
  roomId: string;
  peerId?: string;
  onStatusChange?: (status: TransportStatus) => void;
  onHostStatusChange?: (online: boolean) => void;
}

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private options: RelayTransportOptions;
  private _status: TransportStatus = "idle";
  private readonly eventHandlers = new Set<(event: AgentEvent, meta: { channel: string; seq?: number }) => void>();
  private readonly snapshotHandlers = new Set<(channel: string, snapshot: unknown) => void>();
  private readonly statusHandlers = new Set<(status: TransportStatus) => void>();
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private heartbeatTimer: number | null = null;

  constructor(options: RelayTransportOptions) {
    this.options = options;
  }

  get status(): TransportStatus { return this._status; }

  private setStatus(s: TransportStatus) {
    this._status = s;
    this.options.onStatusChange?.(s);
    for (const h of this.statusHandlers) h(s);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    return new Promise<void>((resolve, reject) => {
      this.setStatus("connecting");
      const ws = new WebSocket(this.options.relayUrl);
      this.ws = ws;

      ws.onopen = () => {
        // 发送 hello
        const hello: RelayEnvelope = {
          type: "hello",
          role: "remote",
          roomId: this.options.roomId,
        };
        if (this.options.peerId) hello.peerId = this.options.peerId;
        ws.send(JSON.stringify(hello));
      };

      ws.onmessage = (ev) => {
        let msg: RelayEnvelope;
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        this.handleRelayMessage(msg, resolve);
      };

      ws.onerror = () => {
        this.setStatus("closed");
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        this.setStatus("closed");
        this.clearHeartbeat();
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Connection closed"));
        }
        this.pending.clear();
        this.ws = null;
      };
    });
  }

  private handleRelayMessage(msg: RelayEnvelope, resolveConnect?: () => void) {
    if (msg.type === "ready") {
      this.setStatus("connected");
      this.startHeartbeat();
      resolveConnect?.();
      return;
    }
    if (msg.type === "waiting") {
      this.setStatus("connected");
      resolveConnect?.();
      return;
    }
    if (msg.type === "error") {
      this.setStatus("closed");
      resolveConnect?.();
      return;
    }
    if (msg.type === "host.offline") {
      this.options.onHostStatusChange?.(false);
      return;
    }
    if (msg.type === "host.online") {
      this.options.onHostStatusChange?.(true);
      return;
    }
    if (msg.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "pong") {
      return;
    }
    if (msg.type === "msg" && msg.payload) {
      // payload 是标准的 WS 信封
      const payload = msg.payload as { v?: number; kind?: string; channel?: string; requestId?: string; seq?: number; method?: string; payload?: unknown };
      const kind = payload.kind;
      if (kind === "event" && payload.payload) {
        const event = payload.payload as AgentEvent;
        const channel = payload.channel ?? "";
        for (const h of this.eventHandlers) h(event, { channel, seq: payload.seq });
      } else if (kind === "snapshot" && payload.payload) {
        const channel = payload.channel ?? "";
        for (const h of this.snapshotHandlers) h(channel, payload.payload);
      } else if ((kind === "result" || kind === "error") && payload.requestId) {
        const p = this.pending.get(payload.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(payload.requestId);
          if (kind === "result") p.resolve(payload.payload);
          else p.reject(new Error((payload.payload as { error?: string })?.error ?? "RPC error"));
        }
      }
    }
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close(): void {
    this.clearHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  async request<T = unknown>(method: string, payload?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const requestId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC ${method} timed out`));
      }, 30000);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      const envelope: RelayEnvelope = {
        type: "msg",
        payload: {
          v: RELAY_VERSION,
          kind: "req",
          method,
          requestId,
          payload,
        },
      };
      this.ws!.send(JSON.stringify(envelope));
    });
  }

  async subscribe(channel: string, _options?: { afterSequence?: number }): Promise<{ channel: string; unsubscribe(): void }> {
    await this.request("subscribe", { channel });
    return {
      channel,
      unsubscribe: () => {
        this.request("unsubscribe", { channel }).catch(() => {});
      },
    };
  }

  onEvent(handler: (event: AgentEvent, meta: { channel: string; seq?: number }) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onSnapshot(handler: (channel: string, snapshot: unknown) => void): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
}
