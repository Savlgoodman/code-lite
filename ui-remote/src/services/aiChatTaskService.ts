import type { AiReasoningEffort } from "../lib/aiReasoning";
import { streamChat } from "./aiClient";
import {
  aiConversationStore,
  type AiMessage,
  type AiTokenUsage,
} from "./AiConversationStore";
import type { AiModel, AiProvider } from "./AiProviderStore";

export interface AiChatTaskSnapshot {
  messages: AiMessage[];
  running: boolean;
}

interface StartAiChatTaskParams {
  conversationId: string;
  provider: AiProvider;
  model: AiModel;
  requestMessages: AiMessage[];
  initialMessages: AiMessage[];
  assistantMessageId: string;
  reasoningEffort: AiReasoningEffort | null;
  includeUsage: boolean;
}

type Listener = () => void;

const controllers = new Map<string, AbortController>();
const snapshots = new Map<string, AiChatTaskSnapshot>();
const conversationListeners = new Map<string, Set<Listener>>();
const activeListeners = new Set<Listener>();
const persistChains = new Map<string, Promise<void>>();
let activeSnapshot: string[] = [];

function emitConversation(conversationId: string): void {
  for (const listener of conversationListeners.get(conversationId) ?? []) listener();
}

function emitActive(): void {
  activeSnapshot = [...controllers.keys()];
  for (const listener of activeListeners) listener();
}

function persistMessages(conversationId: string, messages: AiMessage[]): void {
  const previous = persistChains.get(conversationId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => aiConversationStore.saveMessages(conversationId, messages));
  persistChains.set(conversationId, next);
  void next
    .catch((error) => {
      console.error("[aiChatTasks] 保存消息失败", error);
    })
    .finally(() => {
      if (persistChains.get(conversationId) === next) persistChains.delete(conversationId);
    });
}

function attachUsage(
  messages: AiMessage[],
  assistantMessageId: string,
  usage: AiTokenUsage | undefined,
): AiMessage[] {
  if (!usage) return messages;
  return messages.map((message) => (
    message.id === assistantMessageId
      ? { ...message, usage, updatedAt: Date.now() }
      : message
  ));
}

function finishTask(
  conversationId: string,
  assistantMessageId: string,
  usage?: AiTokenUsage,
  error?: Error,
): void {
  const current = snapshots.get(conversationId);
  if (!current) return;

  let messages = attachUsage(current.messages, assistantMessageId, usage);
  if (error) {
    messages = messages.map((message) => (
      message.id === assistantMessageId
        ? { ...message, error: error.message, updatedAt: Date.now() }
        : message
    ));
  }

  snapshots.set(conversationId, { messages, running: false });
  controllers.delete(conversationId);
  emitConversation(conversationId);
  emitActive();
  persistMessages(conversationId, messages);
}

export const aiChatTasks = {
  subscribe(conversationId: string, listener: Listener): () => void {
    let listeners = conversationListeners.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      conversationListeners.set(conversationId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) conversationListeners.delete(conversationId);
    };
  },

  getSnapshot(conversationId: string): AiChatTaskSnapshot | null {
    return snapshots.get(conversationId) ?? null;
  },

  subscribeActive(listener: Listener): () => void {
    activeListeners.add(listener);
    return () => activeListeners.delete(listener);
  },

  getActiveSnapshot(): string[] {
    return activeSnapshot;
  },

  isActive(conversationId: string): boolean {
    return controllers.has(conversationId);
  },

  cancel(conversationId: string): boolean {
    const controller = controllers.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  async forget(conversationId: string): Promise<void> {
    if (controllers.has(conversationId)) return;
    await persistChains.get(conversationId)?.catch(() => undefined);
    if (snapshots.delete(conversationId)) emitConversation(conversationId);
  },
};

export function startAiChatTask(params: StartAiChatTaskParams): boolean {
  const {
    conversationId,
    provider,
    model,
    requestMessages,
    initialMessages,
    assistantMessageId,
    reasoningEffort,
    includeUsage,
  } = params;
  if (controllers.has(conversationId)) return false;

  const controller = new AbortController();
  controllers.set(conversationId, controller);
  snapshots.set(conversationId, { messages: initialMessages, running: true });
  emitConversation(conversationId);
  emitActive();
  persistMessages(conversationId, initialMessages);

  void streamChat(
    {
      provider,
      model,
      messages: requestMessages,
      reasoningEffort,
      includeUsage,
      signal: controller.signal,
    },
    {
      onDelta: (delta) => {
        const current = snapshots.get(conversationId);
        if (!current?.running) return;
        const messages = current.messages.map((message) => (
          message.id === assistantMessageId
            ? { ...message, content: message.content + delta, updatedAt: Date.now() }
            : message
        ));
        snapshots.set(conversationId, { messages, running: true });
        emitConversation(conversationId);
      },
      onDone: (usage) => finishTask(conversationId, assistantMessageId, usage),
      onError: (error) => finishTask(conversationId, assistantMessageId, undefined, error),
    },
  );
  return true;
}
