import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  aiChatSettingsStore,
  type AiReasoningEffort,
} from "../services/AiChatSettingsStore";

export function useAiChatSettings() {
  const settings = useSyncExternalStore(
    aiChatSettingsStore.subscribe,
    aiChatSettingsStore.getSnapshot,
  );

  useEffect(() => {
    void aiChatSettingsStore.init();
  }, []);

  const setReasoningEffort = useCallback((reasoningEffort: AiReasoningEffort | null) => {
    return aiChatSettingsStore.update({ reasoningEffort });
  }, []);

  const setShowTokenUsage = useCallback((showTokenUsage: boolean) => {
    return aiChatSettingsStore.update({ showTokenUsage });
  }, []);

  return { ...settings, setReasoningEffort, setShowTokenUsage };
}
