import type { ChatMessage, Session } from "../types";

export interface StoredState {
  sessions: Session[];
  messages: Record<string, ChatMessage[]>;
  activeSessionId: string;
}

export interface PendingMessageDelta {
  messageId: string;
  reasoning: string;
  sessionId: string;
  text: string;
}

export function createId(prefix: string) {
  if (crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptySession(): Session {
  const now = Date.now();
  return {
    id: createId("session"),
    title: "新会话",
    preview: "",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    agent: null
  };
}

export function createInitialState(): StoredState {
  const session = createEmptySession();
  return {
    activeSessionId: session.id,
    messages: {
      [session.id]: []
    },
    sessions: [session]
  };
}

export function normalizeStoredState(value: StoredState): StoredState {
  if (!value.sessions?.length || !value.activeSessionId) {
    return createInitialState();
  }

  const now = Date.now();
  const sessions = value.sessions.map((session) => ({
    ...session,
    createdAt: typeof session.createdAt === "number" ? session.createdAt : now,
    updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : now,
    status: session.status === "running" || session.status === "approval" ? "idle" : session.status
  }));
  const messages = Object.fromEntries(
    Object.entries(value.messages ?? {}).map(([sessionId, items]) => [
      sessionId,
      items.map((message) => ({
        ...message,
        createdAt: typeof message.createdAt === "number" ? message.createdAt : now,
        updatedAt: typeof message.updatedAt === "number" ? message.updatedAt : undefined,
        streaming: false,
        toolCalls: message.toolCalls ?? [],
        runtimeEvents: message.runtimeEvents ?? []
      }))
    ])
  );

  return {
    activeSessionId: sessions.some((session) => session.id === value.activeSessionId)
      ? value.activeSessionId
      : sessions[0].id,
    messages,
    sessions
  };
}

export function createAssistantMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    streaming: true,
    toolCalls: []
  };
}

export function updateMessage(
  messages: Record<string, ChatMessage[]>,
  sessionId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  return {
    ...messages,
    [sessionId]: (messages[sessionId] ?? []).map((message) =>
      message.id === messageId ? updater(message) : message
    )
  };
}
