import { WsTransport, type WsTransportConfig, type WireEnvelope } from "@code-lite/transport";
import type { AgentEvent } from "../types";

/**
 * 本地 WS 传输：桌面前端直连宿主后端 /api/ws。
 *
 * 复用 @code-lite/transport 的 WsTransport 基类，本地链路无中继外层包装、无握手，
 * 业务信封直接收发。与远端 RelayWsTransport 共享全部 RPC/订阅/事件逻辑。
 *
 * 见 docs/design/0710-DUAL-END-UNIFICATION-REFACTOR.md 阶段 1。
 */

export type EventListener = (event: AgentEvent, meta: { channel: string; seq?: number }) => void;

/** 订阅会话频道后收到的快照结构（后端定义）。 */
export interface SnapshotPayload {
  snapshot: { session: unknown; messages: unknown[] } | null;
  latestSequence: number;
}

/** 快照监听器：基类回调 payload 为 unknown，此处窄化为 SnapshotPayload 供桌面消费。 */
export type SnapshotListener = (channel: string, payload: SnapshotPayload) => void;

function wsUrlFromBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/ws";
  return url.toString();
}

export class LocalTransport extends WsTransport {
  constructor(urlProvider: () => Promise<string> | string) {
    const config: WsTransportConfig = {
      socketFactory: (url) => new WebSocket(url),
      urlProvider: async () => wsUrlFromBase(await urlProvider()),
      // 本地链路直通：业务信封即实际帧。
      encodeFrame: (envelope: WireEnvelope) => envelope as unknown as Record<string, unknown>,
      decodeFrame: (raw: Record<string, unknown>) => raw as unknown as WireEnvelope,
      heartbeat: false,
    };
    super(config);
  }

  /** 窄化 onSnapshot 的 payload 类型为 SnapshotPayload，方便桌面消费。 */
  onSnapshot(listener: SnapshotListener): () => void {
    return super.onSnapshot((channel, payload) => listener(channel, payload as SnapshotPayload));
  }
}
