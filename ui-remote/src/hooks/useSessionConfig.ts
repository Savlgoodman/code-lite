import { useState, useEffect } from "react";
import type { SessionConfigOption, SessionMode } from "@code-lite/protocol";
import { groupModelsByFamily, type ModelGrouping } from "@code-lite/chat-core";
import type { ConversationClient } from "@code-lite/chat-core";

export interface SessionConfig {
  familyId: string;
  effort: string;
  grouping: ModelGrouping;
  accessMode: string;
  modes: SessionMode[];
  configOptions: SessionConfigOption[];
  configOptionsRaw: SessionConfigOption[];
}

export function useSessionConfig(
  client: ConversationClient | null,
  sessionId: string
): { config: SessionConfig | null; updateConfig: (config: SessionConfig) => void } {
  const [config, setConfig] = useState<SessionConfig | null>(null);

  // 打开会话 + 拉取 capabilities 和已保存配置
  useEffect(() => {
    if (!client || !sessionId) return;
    client.openConversation(sessionId);

    const loadCaps = async () => {
      let caps: any = null;
      let savedConfig: any = null;

      // 1. 拉取 capabilities（UI 选项：models / modes / configOptions）
      try {
        caps = await client.request<any>("session.initialize", { conversationId: sessionId });
        if (!caps) caps = null;
      } catch (err) {
        console.error("[ChatPage] session.initialize failed:", err);
      }

      // 2. 拉取会话已保存的配置（accessMode / modelFamily / reasoningEffort）
      try {
        const snap = await client.request<any>("conversation.get", { conversationId: sessionId });
        const sessionObj = snap?.session;
        if (sessionObj?.config) {
          savedConfig = sessionObj.config;
          console.log("[ChatPage] saved config:", savedConfig);
        }
      } catch (err) {
        console.error("[ChatPage] conversation.get failed:", err);
      }

      // 3. 合并 capabilities（选项）+ savedConfig（当前值）
      const c = caps?.capabilities ?? caps ?? {};
      const models = c.models ?? [];
      const modes = c.modes ?? [];
      const configOptions = c.configOptions ?? [];
      const grouping = groupModelsByFamily(models);

      const savedAccessMode = savedConfig?.accessMode;
      const defaultMode = modes.find((m: SessionMode) => m.isDefault) ?? modes[0];
      const accessMode = savedAccessMode || defaultMode?.id || "";

      const savedModelFamily = String(savedConfig?.modelFamily ?? "");
      const familyId = savedModelFamily || grouping.currentFamilyId || "";

      let effort = "";
      if (grouping.isGrouped) {
        effort = String(savedConfig?.reasoningEffort ?? grouping.currentEffort ?? "medium");
      } else {
        const reasoningOpt = configOptions.find((o: SessionConfigOption) => o.id === "reasoning_effort");
        effort = String(savedConfig?.reasoningEffort ?? reasoningOpt?.currentValue ?? "medium");
      }

      setConfig({
        familyId,
        effort,
        grouping,
        accessMode,
        modes,
        configOptions,
        configOptionsRaw: configOptions,
      });
    };
    loadCaps();

    // 订阅远端配置同步事件
    const sync = client.getSync();
    const unsubConfig = sync.onConfigChange((payload: any) => {
      if (payload.conversationId !== sessionId) return;
      console.log("[ChatPage] config change from remote:", payload);
      setConfig((prev) => {
        if (!prev) return prev;
        const changes = (payload as any).changes ?? {};
        return {
          ...prev,
          familyId: changes.modelFamily ?? changes.model ?? prev.familyId,
          effort: changes.reasoningEffort ?? changes.effort ?? prev.effort,
          accessMode: changes.accessMode ?? prev.accessMode,
        };
      });
    });

    return () => {
      unsubConfig();
      client.closeConversation(sessionId);
    };
  }, [client, sessionId]);

  const updateConfig = (newConfig: SessionConfig) => {
    setConfig(newConfig);
  };

  return { config, updateConfig };
}
