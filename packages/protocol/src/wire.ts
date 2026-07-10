/**
 * WS 传输层协议信封与 RPC 方法定义。
 *
 * 见 docs/design/0709-REMOTE-CONTROL-DUAL-SYNC.md 第 7 节。
 * 本地链路（宿主前端 <-> 后端）与中继链路（远端 <-> 中继 <-> 后端）使用同一信封，
 * 中继只透传 payload，不解析。
 */

import type { AgentEvent } from "./domain";

export const WIRE_PROTOCOL_VERSION = 1 as const;

/** 信封类型。 */
export type WireKind =
  | "req"
  | "result"
  | "error"
  | "event"
  | "snapshot"
  | "control"
  | "presence";

/** 全局会话列表频道（会话增删改走此频道）。 */
export const GLOBAL_CHANNEL = "*" as const;

/** 统一 WS 消息信封。 */
export interface WireEnvelope<TPayload = unknown> {
  v: typeof WIRE_PROTOCOL_VERSION;
  kind: WireKind;
  /** 会话频道 id，或全局频道 "*"，与本条消息无关时为 null。 */
  channel?: string | null;
  /** RPC 关联：客户端生成，result/error 回带同值。 */
  requestId?: string;
  /** 仅 event 有意义：会话级单调递增事件序号。 */
  seq?: number;
  ts?: string;
  /** req 时的 RPC 方法名。 */
  method?: WireMethod;
  payload?: TPayload;
}

/** 客户端 -> 后端 RPC 方法名（见设计文档 7.3）。 */
export type WireMethod =
  | "subscribe"
  | "unsubscribe"
  | "conversation.list"
  | "conversation.get"
  | "conversation.create"
  | "conversation.config.update"
  | "conversation.archive"
  | "conversation.delete"
  | "session.initialize"
  | "turn.start"
  | "turn.cancel"
  | "approval.decision"
  | "input.response"
  | "attachment.upload"
  | "diff.get"
  // 远控设备管理（仅宿主本地前端调用，不经中继）。见 0710 第 6 节。
  | "remote.config.get"
  | "remote.config.update"
  | "remote.config.generate_key"
  | "remote.peers.list"
  | "remote.peer.authorize"
  | "remote.peer.kick";

/**
 * 后端 -> 客户端的控制信令（见设计文档 7.2 control）。
 *
 * 注：会话运行态（原 turn.lock/turn.unlock）已迁移到 @code-lite/sync 统一同步协议，
 * 通过 session.running / session.stopped 同步事件传输，不再走 control 信令。
 */
export type WireControlType =
  | "remote.revoked"
  | "host.online"
  | "host.offline"
  | "token.expired";

/** event 信封的 payload 就是统一 AgentEvent。 */
export type WireEventEnvelope = WireEnvelope<AgentEvent> & { kind: "event" };
