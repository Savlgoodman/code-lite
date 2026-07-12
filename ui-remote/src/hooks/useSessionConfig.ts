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
  /** 速率（fast mode）：on 表示高速档，off 表示普通速率。 */
  fastMode: "on" | "off";
  /** 当前会话是否支持速率切换（codex 恒支持，其余看 caps 是否暴露 fast 选项）。 */
  fastSupported: boolean;
  /** 会话已保存的 selectedConfig 原样保留，保存时无损合并（避免抹掉桌面端设过的项）。 */
  selectedConfig: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 把后端多种写法归一为 on / off。 */
function normalizeFastMode(value: unknown): "on" | "off" {
  if (typeof value === "boolean") return value ? "on" : "off";
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "fast", "high", "1.5x", "1"].includes(normalized)) return "on";
  return "off";
}

function fastModeFromSelected(selected: unknown): "on" | "off" {
  if (!isRecord(selected)) return "off";
  const raw = selected.fast_mode ?? selected.fastMode ?? selected["fast-mode"] ?? selected.fast;
  return normalizeFastMode(raw);
}

/** 从 caps 判断当前会话是否支持速率切换。 */
function detectFastSupport(agentId: string, configOptions: SessionConfigOption[]): boolean {
  const id = agentId.trim().toLowerCase();
  if (id === "codex" || id.includes("codex")) return true;
  return configOptions.some((o) => o.id === "fast_mode" || o.id === "fast-mode" || o.id === "fast");
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

      // 2. 拉取会话已保存的配置（accessMode / modelFamily / reasoningEffort / selectedConfig）
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
      const agentId = String(c.agent?.id ?? "");
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

      const fastSupported = detectFastSupport(agentId, configOptions);
      const fastOpt = configOptions.find(
        (o: SessionConfigOption) => o.id === "fast_mode" || o.id === "fast-mode" || o.id === "fast",
      );
      // 优先取会话已保存的 selectedConfig.fast_mode，其次回退到 caps 里 fast 选项的当前值。
      const fastMode = !fastSupported
        ? "off"
        : savedConfig?.selectedConfig
          ? fastModeFromSelected(savedConfig.selectedConfig)
          : normalizeFastMode(fastOpt?.currentValue);

      setConfig({
        familyId,
        effort,
        grouping,
        accessMode,
        modes,
        configOptions,
        configOptionsRaw: configOptions,
        fastMode,
        fastSupported,
        selectedConfig: isRecord(savedConfig?.selectedConfig) ? { ...savedConfig.selectedConfig } : {},
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
        const nextSelected = isRecord(changes.selectedConfig)
          ? { ...changes.selectedConfig }
          : prev.selectedConfig;
        const nextFast = isRecord(changes.selectedConfig)
          ? fastModeFromSelected(changes.selectedConfig)
          : prev.fastMode;
        return {
          ...prev,
          familyId: changes.modelFamily ?? changes.model ?? prev.familyId,
          effort: changes.reasoningEffort ?? changes.effort ?? prev.effort,
          accessMode: changes.accessMode ?? prev.accessMode,
          fastMode: prev.fastSupported ? nextFast : "off",
          selectedConfig: nextSelected,
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
