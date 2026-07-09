/**
 * 会话列表事件 reducer（0710 第 5.2 节）。
 *
 * 全局频道 "*" 上的 conversation.created / updated / archived / deleted 事件，
 * 桌面与远端两端用同一段纯逻辑 reduce，避免列表状态漂移。
 * 不依赖 React，无副作用。
 */

import type { Session } from "@code-lite/protocol";

/** 全局频道上承载的会话列表事件（不在 AgentEvent union 内，后端经事件总线发布）。 */
export type ConversationListEvent =
  | { type: "conversation.created"; session: Session }
  | { type: "conversation.updated"; session: Session }
  | { type: "conversation.archived"; session: Session }
  | { type: "conversation.deleted"; session: { id: string } };

const LIST_EVENT_TYPES = new Set([
  "conversation.created",
  "conversation.updated",
  "conversation.archived",
  "conversation.deleted",
]);

/** 判断一个事件是否为会话列表级事件（用于全局频道路由分流）。 */
export function isConversationListEvent(event: unknown): event is ConversationListEvent {
  return (
    Boolean(event) &&
    typeof event === "object" &&
    LIST_EVENT_TYPES.has((event as { type?: string }).type ?? "")
  );
}

/**
 * 把一个会话列表事件应用到当前列表，返回新列表（不可变）。
 *
 * - created：不存在则插到最前；已存在则合并（幂等，防重连重复）。
 * - updated：已存在则合并字段；不存在则插入（另一端新建后本端首见）。
 * - archived：标记 archived=true（保留在列表，由 UI 决定是否过滤）。
 * - deleted：从列表移除。
 */
export function applyConversationListEvent(
  sessions: Session[],
  event: ConversationListEvent,
): Session[] {
  switch (event.type) {
    case "conversation.created":
    case "conversation.updated": {
      const incoming = event.session;
      const existing = sessions.find((s) => s.id === incoming.id);
      if (existing) {
        return sessions.map((s) => (s.id === incoming.id ? { ...s, ...incoming } : s));
      }
      return [incoming, ...sessions];
    }
    case "conversation.archived": {
      const incoming = event.session;
      return sessions.map((s) => (s.id === incoming.id ? { ...s, ...incoming, archived: true } : s));
    }
    case "conversation.deleted": {
      return sessions.filter((s) => s.id !== event.session.id);
    }
    default:
      return sessions;
  }
}
