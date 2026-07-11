import { WsTransport, type WsTransportConfig, type WireEnvelope, type HandshakeContext } from "@code-lite/transport";

/**
 * 中继传输：远端前端经 relay 服务器连接宿主后端。
 *
 * 复用 @code-lite/transport 的 WsTransport 基类，与桌面 LocalTransport 共享
 * 全部 RPC/订阅/事件逻辑。中继链路的差异全部收敛在此文件的三个注入项：
 * - encodeFrame：业务信封裹进 {type:"msg", payload}
 * - decodeFrame：从 {type:"msg", payload} 拆出业务信封；ping/host.* 等非业务帧返回 null
 * - onHandshake：发 hello、等 ready/waiting；处理 host.online/offline/ping
 *
 * 见 docs/design/0710-DUAL-END-UNIFICATION-REFACTOR.md 阶段 1。
 */

export interface RelayTransportOptions {
  relayUrl: string;
  roomId: string;
  peerId?: string;
  onHostStatusChange?: (online: boolean) => void;
}

export class RelayTransport extends WsTransport {
  constructor(options: RelayTransportOptions) {
    const config: WsTransportConfig = {
      socketFactory: (url) => new WebSocket(url),
      urlProvider: () => options.relayUrl,
      // 出站：业务信封裹进中继 msg 外层（路由字段由中继按连接补 from）。
      encodeFrame: (envelope: WireEnvelope) => ({ type: "msg", payload: envelope }),
      // 入站：只有 {type:"msg"} 携带业务信封；其余（ready/ping/host.*）是连接控制帧，
      // 已在 onHandshake 的 rawMessage 里处理，这里返回 null 不进业务分发。
      decodeFrame: (raw: Record<string, unknown>) => {
        if (raw.type === "msg" && raw.payload && typeof raw.payload === "object") {
          return raw.payload as WireEnvelope;
        }
        return null;
      },
      heartbeat: true,
      onHandshake: (ctx) => this.handshake(ctx, options),
    };
    super(config);
  }

  private handshake(ctx: HandshakeContext, options: RelayTransportOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      ctx.onRawMessage((msg) => {
        const type = msg.type;
        if (type === "ready" || type === "waiting") {
          if (!settled) { settled = true; resolve(); }
        } else if (type === "error") {
          if (!settled) { settled = true; reject(new Error(String(msg.error ?? "relay error"))); }
        } else if (type === "host.online") {
          options.onHostStatusChange?.(true);
          this.emitControl({ type: "host.online" });
        } else if (type === "host.offline") {
          options.onHostStatusChange?.(false);
          this.emitControl({ type: "host.offline" });
        } else if (type === "ping") {
          // 中继心跳探测：回 pong（基类的 sendRaw 不可见，用 ctx.sendRaw）。
          ctx.sendRaw({ type: "pong" });
        }
      });
      // 发送 hello 握手。
      const hello: Record<string, unknown> = { type: "hello", role: "remote", roomId: options.roomId };
      if (options.peerId) hello.peerId = options.peerId;
      ctx.sendRaw(hello);
    });
  }
}
