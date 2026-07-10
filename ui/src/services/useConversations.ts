import { useSyncExternalStore } from "react";
import type { ConversationClient, ClientState } from "@code-lite/chat-core";

const EMPTY: ClientState = { sessions: [], views: {} };

/** 订阅 ConversationClient 状态快照（sessions + views）。 */
export function useConversationState(client: ConversationClient | null): ClientState {
  return useSyncExternalStore(
    (cb) => (client ? client.subscribe(cb) : () => {}),
    () => (client ? client.getSnapshot() : EMPTY),
  );
}
