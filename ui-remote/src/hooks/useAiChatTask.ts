import { useCallback, useSyncExternalStore } from "react";
import { aiChatTasks, type AiChatTaskSnapshot } from "../services/aiChatTaskService";

export function useAiChatTask(conversationId: string): AiChatTaskSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) => aiChatTasks.subscribe(conversationId, listener),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => aiChatTasks.getSnapshot(conversationId),
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
