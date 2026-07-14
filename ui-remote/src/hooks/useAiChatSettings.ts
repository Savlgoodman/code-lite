import { useCallback, useEffect, useSyncExternalStore } from "react";
import { aiChatSettingsStore } from "../services/AiChatSettingsStore";
import type { AiReasoningEffort } from "../lib/aiReasoning";

export function useAiChatSettings() {
  const settings = useSyncExternalStore(
    aiChatSettingsStore.subscribe,
    aiChatSettingsStore.getSnapshot,
  );

  useEffect(() => {
    void aiChatSettingsStore.init();
  }, []);

  const setDefaultReasoningEffort = useCallback((defaultReasoningEffort: AiReasoningEffort | null) => {
    return aiChatSettingsStore.update({ defaultReasoningEffort });
  }, []);

  const setShowTokenUsage = useCallback((showTokenUsage: boolean) => {
    return aiChatSettingsStore.update({ showTokenUsage });
  }, []);

  return { ...settings, setDefaultReasoningEffort, setShowTokenUsage };
}
