import { useSyncExternalStore, useEffect } from "react";
import { aiConversationStore, type AiConversation } from "../services/AiConversationStore";

/** 订阅 AI 会话元数据列表快照（按 updatedAt 降序）。 */
export function useAiConversations(): AiConversation[] {
  useEffect(() => {
    void aiConversationStore.init();
  }, []);

  const conversations = useSyncExternalStore(
    aiConversationStore.subscribe,
    aiConversationStore.getSnapshot,
  );

  return conversations;
}
