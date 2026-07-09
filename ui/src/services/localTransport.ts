import { ensureBackend } from "./agentClient";
import type { AgentEvent } from "../types";

/**
 * 本地 WS 传输：连接宿主后端 /api/ws。
 *
 * 提供 RPC（requestId 关联）与会话频道订阅（snapshot + 增量 event）。
 * 见 docs/design/0709-REMOTE-CONTROL-DUAL-SYNC.md 第 7 节。
 * 远端 RelayTransport 未来复用同一套信封，仅换连接目标。
 */

const WIRE_VERSION = 1;
const RPC_TIMEOUT_MS = 30000;

type WireKind = "req" | "result" | "error" | "event" | "snapshot" | "control" | "presence";

interface WireEnvelope {
  v: number;
  kind: WireKind;
  channel?: string | null;
  requestId?: string;
  seq?: number;
  method?: string;
  payload?: unknown;
}

export interface SnapshotPayload {
  snapshot: { session: unknown; messages: unknown[] } | null;
  latestSequence: number;
}

export type EventListener = (event: AgentEvent, meta: { channel: string; seq?: number }) => void;
export type SnapshotListener = (channel: string, payload: SnapshotPayload) => void;
export type ControlListener = (payload: unknown) => void;

interface PendingRpc {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

function wsUrlFromBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/ws";
  return url.toString();
}

function createRequestId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LocalTransport {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly controlListeners = new Set<ControlListener>();
  private readonly subscribedChannels = new Set<string>();
  private closed = false;

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.closed = false;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    const baseUrl = await ensureBackend();
    const wsUrl = wsUrlFromBase(baseUrl);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WS connection failed"));
      socket.onmessage = (event) => this.handleMessage(event.data as string);
      socket.onclose = () => this.handleClose();
    });
  }

  private handleClose(): void {
    // 拒绝所有挂起 RPC，避免永久 pending。重连由调用方按需触发。
    for (const [, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("WS closed"));
    }
    this.pending.clear();
    this.ws = null;
  }

  private handleMessage(raw: string): void {
    let message: WireEnvelope;
    try {
      message = JSON.parse(raw) as WireEnvelope;
    } catch {
      return;
    }
    const { kind, requestId } = message;

    if ((kind === "result" || kind === "error") && requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (kind === "result") {
          pending.resolve(message.payload);
        } else {
          const payload = message.payload as { code?: string; error?: string } | undefined;
          pending.reject(new Error(payload?.error ?? payload?.code ?? "RPC error"));
        }
      }
      return;
    }

    if (kind === "snapshot") {
      const channel = message.channel ?? "";
      for (const listener of this.snapshotListeners) {
        listener(channel, message.payload as SnapshotPayload);
      }
      return;
    }

    if (kind === "event") {
      const channel = message.channel ?? "";
      const event = message.payload as AgentEvent;
      for (const listener of this.eventListeners) {
        listener(event, { channel, seq: message.seq });
      }
      return;
    }

    if (kind === "control") {
      for (const listener of this.controlListeners) {
        listener(message.payload);
      }
    }
  }

  private send(envelope: WireEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WS not connected");
    }
    this.ws.send(JSON.stringify(envelope));
  }

  async request<T = unknown>(method: string, payload?: unknown): Promise<T> {
    await this.connect();
    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ v: WIRE_VERSION, kind: "req", method, requestId, payload });
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async subscribe(channel: string, afterSequence?: number): Promise<void> {
    await this.connect();
    this.subscribedChannels.add(channel);
    // subscribe 的响应是 snapshot（经 snapshotListeners 分发），不走 pending RPC
    this.send({
      v: WIRE_VERSION,
      kind: "req",
      method: "subscribe",
      requestId: createRequestId(),
      payload: { channel, ...(afterSequence ? { afterSequence } : {}) },
    });
  }

  unsubscribe(channel: string): void {
    this.subscribedChannels.delete(channel);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        v: WIRE_VERSION,
        kind: "req",
        method: "unsubscribe",
        requestId: createRequestId(),
        payload: { channel },
      });
    }
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onControl(listener: ControlListener): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.subscribedChannels.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
