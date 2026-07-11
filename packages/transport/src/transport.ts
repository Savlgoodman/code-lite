/**
 * 传输抽象。见 docs/design/0709-REMOTE-CONTROL-DUAL-SYNC.md 第 10 节。
 *
 * chat-core 与 UI 组件只依赖本接口，不关心底层是本地 WS（LocalTransport）
 * 还是中继 WS（RelayTransport）。两种实现放在各自的 app 或后续独立文件里。
 */

import type { AgentEvent, WireMethod } from "@code-lite/protocol";

/** 连接状态。 */
export type TransportStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export class TransportError extends Error {
  readonly code: string;
  readonly requestId?: string;
  constructor(message: string, code = "transport_error", requestId?: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.requestId = requestId;
  }
}

/** 订阅句柄，取消订阅用。 */
export interface Subscription {
  readonly channel: string;
  unsubscribe(): void;
}

export interface SubscribeOptions {
  /** 重连补偿：从该会话事件序号之后开始补发。 */
  afterSequence?: number;
}

/** 订阅后收到的会话快照（全量态，见设计文档 5.2）。payload 结构由后端定义。 */
export interface SnapshotHandler {
  (channel: string, snapshot: unknown): void;
}

export interface EventHandler {
  (event: AgentEvent, meta: { channel: string; seq?: number }): void;
}

export interface StatusHandler {
  (status: TransportStatus): void;
}

/**
 * 传输层统一接口。
 *
 * - request：请求/响应式 RPC（列会话、读会话、turn.start、上传附件等）。
 * - subscribe：订阅某会话频道，先回 snapshot，之后推增量 event。
 * - onEvent / onSnapshot / onStatus：注册回调，返回取消函数。
 */
/** 后端 -> 客户端控制信令回调。 */
export interface ControlHandler {
  (payload: unknown): void;
}

export interface Transport {
  readonly status: TransportStatus;

  connect(): Promise<void>;
  close(): void;

  /** 发起 RPC，resolve 为后端返回的 payload（失败时 reject TransportError）。 */
  request<T = unknown>(method: WireMethod | string, payload?: unknown): Promise<T>;

  /** 订阅会话频道；先回 snapshot（走 onSnapshot），之后推增量 event（走 onEvent）。 */
  subscribe(channel: string, options?: SubscribeOptions): Promise<Subscription>;
  /** 退订会话频道。 */
  unsubscribe(channel: string): void;

  onEvent(handler: EventHandler): () => void;
  onSnapshot(handler: SnapshotHandler): () => void;
  onStatus(handler: StatusHandler): () => void;
  /** 可选：订阅后端控制信令（host.online/offline 等）。 */
  onControl?(handler: ControlHandler): () => void;
}
