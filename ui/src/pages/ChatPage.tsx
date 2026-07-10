import { useEffect, useMemo, useRef, useState } from "react";

import { AgentSelectionPanel } from "../features/chat/AgentSelectionPanel";
import { ChatWorkspace } from "../features/chat/ChatWorkspace";
import type { ChatConfigValue, SessionConfig } from "../features/chat/chatTypes";
import {
  appendRuntimeEvent,
  hasVisiblePlan,
  isRecord,
  latestMergedPlanFromMessages,
  mergeMessagePlan,
  mergePlanSnapshot,
  updateMessage,
  upsertToolCall
} from "@code-lite/chat-core";
import {
  createEmptySession,
  createId,
  normalizeStoredState,
  type PendingMessageDelta,
  type StoredState
} from "../lib/chatState";
import { formatJson } from "../lib/formatters";
import { Sidebar } from "../layout/Sidebar";
import { OverviewPage } from "./OverviewPage";
import { SettingsPage } from "./SettingsPage";
import { cancelTurn, createConversation, getLocalTransport, getSyncManager, initializeSession, notifyTurnEvent, sendApprovalDecision, sendInputResponse, streamAgentTurn, uploadTurnAttachments } from "../services/agentClient";
import type { SnapshotListener } from "../services/localTransport";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversationConfig,
  updateConversationArchiveState
} from "../services/conversationStore";
import { loadAgentRuntimeModels, loadAgentRuntimeSettings } from "../services/settingsStore";
import {
  createDraftImage,
  MAX_DRAFT_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
  revokeDraftImage,
  type DraftImage,
} from "../features/chat/draftImages";
import type {
  AgentEvent,
  AgentRuntimeModel,
  AgentSummary,
  ApprovalRequest,
  ChatMessage,
  InputRequest,
  Session,
  SessionCapabilities,
  SessionConfigOption,
  SessionModel,
  ToolCallItem,
  PlanSnapshot,
  RuntimeEventRecord,
  SlashCommand,
  UserContentBlock,
  UsageStats
} from "../types";

const DRAFT_SESSION_ID = "__draft_session__";
const STREAM_DELTA_FLUSH_MS = 60;
type ActiveView = "chat" | "overview" | "settings";
type PendingApprovalState = ApprovalRequest & { conversationId: string };
type PendingInputState = InputRequest & { conversationId: string };

function splitRuntimeModelId(modelId: string): { family: string; effort: string | null } {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return { family: "", effort: null };
  }
  const match = trimmed.match(/^([^\[]+)((?:\[[^\]]+\])+)?$/);
  if (!match) {
    return { family: trimmed, effort: null };
  }
  const efforts = [...(match[2] ?? "").matchAll(/\[([^\]]+)\]/g)].map((item) => item[1].trim()).filter(Boolean);
  return {
    family: match[1].trim(),
    effort: efforts.length > 0 ? efforts[efforts.length - 1] : null,
  };
}

function normalizeCodexModelSelection(modelId: string, effort?: string | null): { family: string; effort: string } {
  const parsed = splitRuntimeModelId(modelId);
  return {
    family: parsed.family,
    effort: String(effort || parsed.effort || "").trim(),
  };
}

function buildCodexRuntimeModelId(modelFamily: string, reasoningEffort: string): string {
  const selection = normalizeCodexModelSelection(modelFamily, reasoningEffort);
  return selection.family && selection.effort ? `${selection.family}[${selection.effort}]` : selection.family;
}

function isCodexAgent(agent: AgentSummary | null | undefined): boolean {
  return (agent?.runtimeId ?? agent?.id ?? "") === "codex";
}

function isCodexCapabilities(caps: SessionCapabilities): boolean {
  return caps.agent.id === "codex";
}

function fastModeConfigOption(options: SessionConfigOption[] | undefined): SessionConfigOption | null {
  return options?.find((option) => option.id === "fast_mode" || option.id === "fast-mode" || option.id === "fast") ?? null;
}

function withoutFastModeConfigOption(options: SessionConfigOption[]): SessionConfigOption[] {
  return options.filter((option) => option.id !== "fast_mode" && option.id !== "fast-mode" && option.id !== "fast");
}

function createCodexFastModeConfigOption(currentValue: ChatConfigValue = "off"): SessionConfigOption {
  return {
    id: "fast_mode",
    label: "速率",
    type: "enum",
    values: ["off", "on"],
    currentValue,
    valueLabels: {
      off: "1x 普通速率",
      on: "1.5x 高速",
    },
  };
}

function currentModelFamilyFromCapabilities(caps: SessionCapabilities): string {
  const currentModel = caps.models.find((model) => model.isCurrent) ?? caps.models[0];
  if (!currentModel) {
    return "";
  }
  return isCodexCapabilities(caps) ? splitRuntimeModelId(currentModel.id).family : currentModel.id;
}

function codexModelLikelySupportsFast(modelFamily: string): boolean {
  const normalized = modelFamily.trim().toLowerCase();
  return Boolean(normalized) && !normalized.includes("mini");
}

function prepareRuntimeCapabilities(
  caps: SessionCapabilities,
  config?: SessionConfig | null,
): SessionCapabilities {
  void config;
  const runtimeFamily = currentModelFamilyFromCapabilities(caps);
  const currentFastOption = fastModeConfigOption(caps.configOptions);
  const fastOption = currentFastOption
    ?? caps.fastModeConfigOption
    ?? (isCodexCapabilities(caps) ? createCodexFastModeConfigOption() : null);
  const modelFastSupport = { ...(caps.modelFastSupport ?? {}) };
  if (runtimeFamily && currentFastOption) {
    modelFastSupport[runtimeFamily] = true;
  }

  return {
    ...caps,
    fastModeConfigOption: fastOption,
    modelFastSupport,
  };
}

function applyFastModeVisibility(
  caps: SessionCapabilities | null,
  config: SessionConfig | null | undefined,
): SessionCapabilities | null {
  if (!caps || !isCodexCapabilities(caps)) {
    return caps;
  }
  const selectedFamily = config?.modelFamily || currentModelFamilyFromCapabilities(caps);
  const storedFastOption = fastModeConfigOption(caps.configOptions)
    ?? caps.fastModeConfigOption
    ?? createCodexFastModeConfigOption();
  if (!storedFastOption) {
    return caps;
  }

  const support = selectedFamily ? caps.modelFastSupport?.[selectedFamily] : undefined;
  const shouldShow = support ?? codexModelLikelySupportsFast(selectedFamily);
  const configOptions = withoutFastModeConfigOption(caps.configOptions);
  if (!shouldShow) {
    return {
      ...caps,
      configOptions,
    };
  }

  const selectedValue = config?.selectedConfig?.fast_mode
    ?? config?.selectedConfig?.fastMode
    ?? config?.selectedConfig?.["fast-mode"]
    ?? config?.selectedConfig?.fast
    ?? storedFastOption.currentValue
    ?? "off";
  return {
    ...caps,
    configOptions: [
      ...configOptions,
      {
        ...storedFastOption,
        id: "fast_mode",
        label: "速率",
        currentValue: isConfigValue(selectedValue) ? selectedValue : storedFastOption.currentValue,
      },
    ],
  };
}

function createDraftSession(): Session {
  return {
    ...createEmptySession(),
    id: DRAFT_SESSION_ID
  };
}

function isDraftSessionId(sessionId: string) {
  return sessionId === DRAFT_SESSION_ID;
}

function isConfigValue(value: unknown): value is ChatConfigValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function configValueRecord(value: unknown): Record<string, ChatConfigValue> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, ChatConfigValue>>((result, [key, item]) => {
    if (isConfigValue(item)) {
      result[key] = item;
    }
    return result;
  }, {});
}

function fastModeFromModelInfo(modelInfo: Record<string, unknown>): "off" | "on" | null {
  const fastMode = modelInfo.fastMode;
  if (!isRecord(fastMode)) {
    return null;
  }
  const raw = fastMode.runtimeValue ?? fastMode.speedMode ?? fastMode.displayRate ?? fastMode.enabled;
  if (typeof raw === "boolean") {
    return raw ? "on" : "off";
  }
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (["on", "true", "fast", "high", "1.5x"].includes(normalized)) {
    return "on";
  }
  if (["off", "false", "normal", "default", "1x"].includes(normalized)) {
    return "off";
  }
  return null;
}

function mergeRuntimeCommands(current: SessionCapabilities | undefined, commands: SlashCommand[]): SessionCapabilities | undefined {
  if (!current || commands.length === 0) {
    return current;
  }
  return {
    ...current,
    commands,
  };
}

function normalizeRuntimeConfigOptions(options: unknown[]): SessionConfigOption[] {
  return options
    .filter(isRecord)
    .map((option): SessionConfigOption | null => {
      const rawId = String(option.id ?? "").trim();
      if (!rawId || rawId === "mode" || rawId === "model") {
        return null;
      }
      const id = rawId === "fast-mode" || rawId === "fast"
        ? "fast_mode"
        : rawId === "effort"
          ? "reasoning_effort"
          : rawId;
      const values: string[] = [];
      const valueLabels: Record<string, string> = {};
      const rawOptions = Array.isArray(option.options) ? option.options : [];
      for (const item of rawOptions) {
        if (!isRecord(item)) {
          continue;
        }
        const value = String(item.value ?? "").trim();
        if (!value) {
          continue;
        }
        values.push(value);
        valueLabels[value] = String(item.name ?? value);
      }
      const rawType = String(option.type ?? "enum");
      const type: SessionConfigOption["type"] = rawType === "boolean"
        ? "boolean"
        : rawType === "number"
          ? "number"
          : "enum";
      return {
        id,
        label: id === "fast_mode"
          ? "速率"
          : id === "reasoning_effort"
            ? "思考强度"
            : String(option.name ?? id),
        type,
        values: values.length > 0 ? values : null,
        currentValue: isConfigValue(option.currentValue) ? option.currentValue : null,
        valueLabels: Object.keys(valueLabels).length > 0 ? valueLabels : null,
      };
    })
    .filter((option): option is SessionConfigOption => option !== null);
}

function mergeRuntimeConfigOptions(
  current: SessionCapabilities | undefined,
  options: unknown[],
  config?: SessionConfig | null,
): SessionCapabilities | undefined {
  if (!current) {
    return current;
  }
  const incoming = normalizeRuntimeConfigOptions(options);
  const incomingFastOption = fastModeConfigOption(incoming);
  const modelFastSupport = { ...(current.modelFastSupport ?? {}) };
  if (isCodexCapabilities(current)) {
    const selectedFamily = config?.modelFamily || currentModelFamilyFromCapabilities(current);
    if (selectedFamily) {
      modelFastSupport[selectedFamily] = Boolean(incomingFastOption);
    }
  }
  const merged = {
    ...current,
    configOptions: incoming,
    fastModeConfigOption: incomingFastOption ?? current.fastModeConfigOption ?? (isCodexCapabilities(current) ? createCodexFastModeConfigOption() : null),
    modelFastSupport,
  };
  return prepareRuntimeCapabilities(merged, config);
}

function mergeLoadedMessages(loadedMessages: ChatMessage[], cachedMessages: ChatMessage[] | undefined) {
  if (!cachedMessages?.length) {
    return loadedMessages;
  }

  const cachedById = new Map(cachedMessages.map((message) => [message.id, message]));
  const loadedIds = new Set(loadedMessages.map((message) => message.id));
  return [
    ...loadedMessages.map((message) => cachedById.get(message.id) ?? message),
    ...cachedMessages.filter((message) => !loadedIds.has(message.id))
  ];
}

function mergeLoadedSession(loadedSession: Session, cachedSession: Session | undefined, isRunning: boolean) {
  if (!cachedSession || !isRunning) {
    return loadedSession;
  }

  return {
    ...loadedSession,
    ...cachedSession,
    updatedAt: Math.max(loadedSession.updatedAt, cachedSession.updatedAt)
  };
}

function buildDefaultConfig(caps: SessionCapabilities): SessionConfig {
  const defaultMode = caps.modes.find((mode) => mode.isDefault);
  const accessMode = defaultMode?.id ?? caps.modes[0]?.id ?? "read-only";
  const reasoningOpt = caps.configOptions.find((option) => option.id === "reasoning_effort" || option.id === "effort");
  const reasoningEffort = reasoningOpt?.currentValue ? String(reasoningOpt.currentValue) : "medium";
  const selectedConfig: Record<string, ChatConfigValue> = {};
  for (const option of caps.configOptions) {
    if (option.currentValue != null) {
      selectedConfig[option.id] = option.currentValue;
    }
  }

  const currentModel = caps.models.find((model) => model.isCurrent) ?? caps.models[0];
  let modelFamily = "";
  if (currentModel) {
    modelFamily = isCodexCapabilities(caps) ? splitRuntimeModelId(currentModel.id).family : currentModel.id;
  }

  return {
    accessMode,
    modelFamily,
    reasoningEffort,
    selectedConfig,
  };
}

function mergeConfigDefaults(config: SessionConfig | undefined, caps: SessionCapabilities): SessionConfig {
  const defaults = buildDefaultConfig(caps);
  if (!config) {
    return defaults;
  }

  return {
    accessMode: config.accessMode || defaults.accessMode,
    modelFamily: config.modelFamily || defaults.modelFamily,
    reasoningEffort: config.reasoningEffort || defaults.reasoningEffort,
    selectedConfig: {
      ...defaults.selectedConfig,
      ...config.selectedConfig,
    },
  };
}

function isConfigReady(caps: SessionCapabilities | null, config: SessionConfig | null | undefined): boolean {
  if (!caps || !config) {
    return false;
  }
  const nextConfig = mergeConfigDefaults(config, caps);
  const hasRequiredModel = caps.models.length > 0 && Boolean(nextConfig.modelFamily);
  const hasRequiredMode = caps.modes.length === 0 || Boolean(nextConfig.accessMode);
  const hasReasoningPicker = caps.configOptions.some((option) => option.id === "reasoning_effort" || option.id === "effort");
  const hasRequiredReasoning = !hasReasoningPicker || Boolean(nextConfig.reasoningEffort);
  return hasRequiredModel && hasRequiredMode && hasRequiredReasoning;
}

export function ChatPage() {
  const initialState = useMemo<StoredState>(() => {
    const session = createDraftSession();
    return {
      activeSessionId: session.id,
      messages: {
        [session.id]: []
      },
      sessions: [session]
    };
  }, []);
  const [sessions, setSessions] = useState(initialState.sessions);
  const [messages, setMessages] = useState(initialState.messages);
  const [activeSessionId, setActiveSessionId] = useState(initialState.activeSessionId);
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(() => new Set());
  const [searchText, setSearchText] = useState("");
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draftImageError, setDraftImageError] = useState<string | null>(null);
  const [imagesProcessing, setImagesProcessing] = useState(false);
  const [activeTurnIdBySession, setActiveTurnIdBySession] = useState<Record<string, string>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [pendingInput, setPendingInput] = useState<PendingInputState | null>(null);
  const [activeAgent, setActiveAgent] = useState<AgentSummary | null>(null);
  const [contextUsageBySession, setContextUsageBySession] = useState<Record<string, UsageStats>>({});
  const [showAgentSelection, setShowAgentSelection] = useState(false);
  const [newSessionWorkspace, setNewSessionWorkspace] = useState("");

  // ─── Per-session 状态：每个会话独立的 capabilities 和 config ───
  const [capabilitiesBySession, setCapabilitiesBySession] = useState<Record<string, SessionCapabilities>>({});
  const [configBySession, setConfigBySession] = useState<Record<string, SessionConfig>>({});
  const [configLoadingBySession, setConfigLoadingBySession] = useState<Record<string, boolean>>({});

  // ─── 派生：当前会话的 capabilities 和 config ───
  const currentConfig = configBySession[activeSessionId] ?? null;
  const rawCurrentCapabilities = capabilitiesBySession[activeSessionId] ?? null;
  const currentCapabilities = useMemo(
    () => applyFastModeVisibility(rawCurrentCapabilities, currentConfig),
    [rawCurrentCapabilities, currentConfig],
  );
  const isCurrentConfigReady = isConfigReady(currentCapabilities, currentConfig);
  const isCurrentConfigLoading =
    activeView === "chat" && ((configLoadingBySession[activeSessionId] ?? false) || !isCurrentConfigReady);

  // ─── 同步 state 到 ref（确保 sendMessage 读取到最新值）───
  useEffect(() => {
    configBySessionRef.current = configBySession;
  }, [configBySession]);

  useEffect(() => {
    draftImagesRef.current = draftImages;
  }, [draftImages]);

  // ─── 同步 state 到 ref（供全局 WS 事件监听器使用）───
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // ─── 向后兼容：draft session 时仍用全局 activeAgent ───
  // draft session 的 capabilities 通过 __probe__ 获取，存储到 draft id 下
  // 一旦 draft → real id，会把 draft 的 caps/config 迁移到 real id
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingMessageDeltasRef = useRef<Record<string, PendingMessageDelta>>({});
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  const streamFlushTimerRef = useRef<number | null>(null);
  const configSaveTimerRef = useRef<Record<string, number>>({});
  // per-session stream state
  const activeAssistantMessageIdBySessionRef = useRef<Record<string, string>>({});
  const activeStreamSessionIdByTurnRef = useRef<Record<string, string>>({});
  // 全局 WS 事件路由需要最新的 state 与 handler（0709 阶段二：附着即快照 + 增量事件）
  const handleAgentEventRef = useRef<(sessionId: string, event: AgentEvent) => void>(() => undefined);
  const sessionsRef = useRef(sessions);
  const messagesRef = useRef(messages);
  const activeSessionIdRef = useRef(activeSessionId);
  // 当前已订阅的会话频道（切换会话时先退订旧的）
  const subscribedChannelRef = useRef<string | null>(null);
  // 发送方：本窗口正在发起 turn 的 draft 会话 id（供 conversation.turn.started 路由到 draft→real 迁移）
  const pendingDraftIdForTurnRef = useRef<string | null>(null);
  // 全局 WS 监听器是否已就绪（异步 setup 完成后标记；会话频道订阅需等待）
  const globalListenerReadyRef = useRef<Promise<void> | null>(null);
  // 使用 ref 存储最新的 config，确保 sendMessage 读取到最新值（避免闭包捕获旧值）
  const configBySessionRef = useRef<Record<string, SessionConfig>>({});
  const draftImagesRef = useRef<DraftImage[]>([]);

  const activeSession = sessions.find((item) => item.id === activeSessionId) ?? sessions[0];
  const activeMessages = messages[activeSession.id] ?? [];
  const isActiveSessionRunning = runningSessionIds.has(activeSession.id);
  const activePendingApproval = pendingApproval?.conversationId === activeSession.id ? pendingApproval : null;
  const activePendingInput = pendingInput?.conversationId === activeSession.id ? pendingInput : null;
  const sessionAgent = activeSession.agent ?? (isDraftSessionId(activeSession.id) ? activeAgent : null);
  const contextUsage = contextUsageBySession[activeSession.id] ?? null;
  const activeTurnId = activeTurnIdBySession[activeSession.id] ?? null;

  const visibleSessions = useMemo(
    () => sessions.filter((session) => !archivedSessionIds.has(session.id)),
    [archivedSessionIds, sessions]
  );
  const archivedSessions = useMemo(
    () => sessions.filter((session) => archivedSessionIds.has(session.id)),
    [archivedSessionIds, sessions]
  );

  const filteredSessions = useMemo(() => visibleSessions.filter((item) => {
    const query = searchText.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return `${item.title} ${item.preview}`.toLowerCase().includes(query);
  }), [searchText, visibleSessions]);

  useEffect(() => {
    let cancelled = false;

    async function loadStoredState() {
      try {
        const remoteSessions = await listConversations();
        let nextState: StoredState;

        if (remoteSessions.length > 0) {
          const firstVisibleSession = remoteSessions.find((session) => !session.archived);
          if (firstVisibleSession) {
            const activeId = firstVisibleSession.id;
            const loaded = await loadConversation(activeId);
            nextState = normalizeStoredState({
              activeSessionId: activeId,
              messages: {
                [activeId]: loaded.messages
              },
              sessions: remoteSessions
            });

            // 恢复所有会话的保存配置和 context usage
            const restoredConfigs: Record<string, SessionConfig> = {};
            const restoredContextUsage: Record<string, UsageStats> = {};
            for (const session of remoteSessions) {
              const sessionObj = session as unknown as Record<string, unknown>;
              // 恢复 config
              const savedConfig = sessionObj.config;
              if (savedConfig && typeof savedConfig === "object") {
                const cfg = savedConfig as Partial<SessionConfig>;
                const savedAgent = (session as unknown as Record<string, unknown>).agent;
                const isCodex = isRecord(savedAgent) && String(savedAgent.runtimeId ?? savedAgent.id ?? "") === "codex";
                const rawModelFamily = String(cfg.modelFamily ?? "");
                const rawReasoningEffort = String(cfg.reasoningEffort ?? "");
                const rawSelectedConfig = (cfg.selectedConfig as Record<string, ChatConfigValue>) ?? {};
                const modelSelection = isCodex
                  ? normalizeCodexModelSelection(rawModelFamily, rawReasoningEffort)
                  : { family: rawModelFamily, effort: rawReasoningEffort };
                const selectedConfig = isCodex && modelSelection.effort
                  ? { ...rawSelectedConfig, reasoning_effort: modelSelection.effort }
                  : rawSelectedConfig;
                restoredConfigs[session.id] = {
                  modelFamily: modelSelection.family,
                  accessMode: String(cfg.accessMode ?? ""),
                  reasoningEffort: modelSelection.effort || "medium",
                  selectedConfig,
                };
              }
              // 恢复 context usage
              const savedUsage = sessionObj.contextUsage;
              if (savedUsage && typeof savedUsage === "object") {
                restoredContextUsage[session.id] = savedUsage as UsageStats;
              }
            }
            if (Object.keys(restoredConfigs).length > 0) {
              setConfigBySession(restoredConfigs);
            }
            if (Object.keys(restoredContextUsage).length > 0) {
              setContextUsageBySession(restoredContextUsage);
            }
          } else {
            const draftSession = createDraftSession();
            nextState = normalizeStoredState({
              activeSessionId: draftSession.id,
              messages: {
                [draftSession.id]: []
              },
              sessions: [draftSession, ...remoteSessions]
            });
          }
        } else {
          nextState = initialState;
        }

        if (cancelled) {
          return;
        }

        setSessions(nextState.sessions);
        setMessages(nextState.messages);
        setActiveSessionId(nextState.activeSessionId);
        setArchivedSessionIds(new Set(nextState.sessions.filter((session) => session.archived).map((session) => session.id)));
      } catch (error) {
        console.error(error);
      }
    }

    void loadStoredState();

    return () => {
      cancelled = true;
    };
  }, []);

  // ─── 全局 WS 事件监听（0709 阶段二）───
  // 订阅全局频道 "*"，接收 conversation.created / conversation.archived / conversation.deleted，
  // 实时更新本地会话列表；同时作为所有会话频道路由的中枢。
  useEffect(() => {
    const transport = getLocalTransport();
    let globalUnsub: (() => void) | null = null;
    let cancelled = false;
    // 让会话频道订阅等待全局监听器就绪
    let resolveReady: (() => void) | null = null;
    globalListenerReadyRef.current = new Promise<void>((resolve) => { resolveReady = resolve; });

    async function setup() {
      await transport.connect();
      if (cancelled) return;
      // 全局事件分发：路由到 handleAgentEvent 并通知 turn resolvers
      const unsubEvent = transport.onEvent((event) => {
        // turn resolver（供 streamAgentTurn 的 Promise 收尾）
        notifyTurnEvent(event);

        // 会话列表级事件走全局频道（channel="*"）。
        // conversation.created/archived/deleted 不在 AgentEvent union 里（后端通过事件总线发布），
        // 这里用 string 比较做路由判断，再按类型缩窄。
        const eventType = (event as unknown as { type: string }).type;
        if (eventType === "conversation.created" || eventType === "conversation.archived" || eventType === "conversation.deleted") {
          const session = (event as unknown as { session?: Session }).session;
          if (!session) return;
          setSessions((current) => {
            if (eventType === "conversation.created") {
              if (current.some((s) => s.id === session.id)) {
                return current;
              }
              return [session, ...current];
            }
            if (eventType === "conversation.deleted") {
              return current.filter((s) => s.id !== session.id);
            }
            if (eventType === "conversation.archived") {
              return current.map((s) => s.id === session.id ? { ...s, archived: true } : s);
            }
            return current;
          });
          if (eventType === "conversation.archived") {
            setArchivedSessionIds((current) => {
              const next = new Set(current);
              next.add(session.id);
              return next;
            });
          }
          return;
        }
        // 会话级事件：路由到 handleAgentEvent（观察者与发起方共用 reducer）。
        const channel = (event as { conversationId?: string }).conversationId;
        const eventType2 = (event as unknown as { type: string }).type;
        // 同步事件（运行态/配置）统一交给 SyncManager 处理（0710 统一同步协议）。
        if (eventType2 === "sync") {
          getSyncManager().feedEvent(event);
          return;
        }
        if (channel && channel !== "*") {
          handleAgentEventRef.current(channel, event);
        }
      });

      // 快照监听：切换会话时 subscribe 触发 snapshot，回填消息与会话状态
      const unsubSnapshot: SnapshotListener = (channel, payload) => {
        if (!payload.snapshot) return;
        const session = payload.snapshot.session as Session | null;
        const msgs = payload.snapshot.messages as ChatMessage[] | undefined;
        if (session) {
          // 合并/更新会话：保留已有的 archived/本地字段
          setSessions((current) => {
            const existing = current.find((s) => s.id === session.id);
            if (existing) {
              return current.map((s) => s.id === session.id ? { ...s, ...session } : s);
            }
            return [session, ...current];
          });
          // 从快照恢复时，若会话正在运行，标记 running（供观察者）
          if (session.status === "running") {
            setSessionRunning(session.id, true);
          }
        }
        if (msgs) {
          setMessages((current) => ({ ...current, [channel]: msgs }));
          // 找出最新 streaming assistant 的 id 供后续事件路由
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i].role === "assistant" && msgs[i].streaming) {
              activeAssistantMessageIdBySessionRef.current[channel] = msgs[i].id;
              break;
            }
          }
        }
      };
      const unsubSnapshotListener = transport.onSnapshot(unsubSnapshot);

      // 订阅全局频道
      void transport.subscribe("*");
      globalUnsub = () => {
        unsubEvent();
        unsubSnapshotListener();
      };
      // 标记就绪，允许会话频道订阅开始
      if (resolveReady) resolveReady();
    }

    void setup();
    return () => {
      cancelled = true;
      if (globalUnsub) globalUnsub();
      transport.unsubscribe("*");
    };
    // setSessionRunning 是稳定引用（内部 useState setter），handleAgentEventRef 是 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── SyncManager 事件绑定（0710 统一同步协议）───
  // 运行态与配置的双端同步由 SyncManager 统一驱动：
  // - session.running/stopped → 更新 runningSessionIds（供输入框锁定/解锁）
  // - config.batch → 另一端改配置后本端选择器跟随
  useEffect(() => {
    const sync = getSyncManager();
    const offRunning = sync.onSessionRunning((p) => {
      setSessionRunning(p.conversationId, true);
    });
    const offStopped = sync.onSessionStopped((p) => {
      setSessionRunning(p.conversationId, false);
    });
    const offConfig = sync.onConfigChange((payload) => {
      const p = payload as { conversationId?: string; changes?: Partial<SessionConfig> };
      const channel = p.conversationId;
      const changes = p.changes;
      if (!channel || !changes) return;
      setConfigBySession((prev) => {
        const existing = prev[channel];
        const next: SessionConfig = {
          modelFamily: changes.modelFamily ?? existing?.modelFamily ?? "",
          accessMode: changes.accessMode ?? existing?.accessMode ?? "",
          reasoningEffort: changes.reasoningEffort ?? existing?.reasoningEffort ?? "medium",
          selectedConfig: changes.selectedConfig ?? existing?.selectedConfig ?? {},
        };
        const result = { ...prev, [channel]: next };
        configBySessionRef.current = result;
        return result;
      });
    });
    return () => {
      offRunning();
      offStopped();
      offConfig();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 会话频道订阅（0709 阶段二）───
  // 每次切换到真实会话（非 draft）时，订阅其频道：后端先发 snapshot（走 onSnapshot），
  // 再发增量事件（走 onEvent）。切换到其他会话或离开时退订。
  useEffect(() => {
    if (!activeSessionId || isDraftSessionId(activeSessionId) || activeView !== "chat") {
      return;
    }
    const myChannel = activeSessionId;
    const transport = getLocalTransport();
    let cancelled = false;

    async function subscribe() {
      // 等待全局监听器就绪（否则 snapshot 到达时还没有 listener 接收）
      if (globalListenerReadyRef.current) {
        await globalListenerReadyRef.current;
      }
      if (cancelled) return;
      // 退订前一个频道（仅在 ref 仍指向前一个频道时；快速切换时可能已被后续 effect 的 cleanup 清理）
      const prev = subscribedChannelRef.current;
      if (prev && prev !== myChannel) {
        transport.unsubscribe(prev);
      }
      subscribedChannelRef.current = myChannel;
      void transport.subscribe(myChannel);
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (subscribedChannelRef.current === myChannel) {
        subscribedChannelRef.current = null;
      }
      transport.unsubscribe(myChannel);
    };
  }, [activeSessionId, activeView]);

  // ─── handleAgentEventRef：让全局 WS 监听器始终调用最新的 handleAgentEvent ───
  // handleAgentEvent 定义在后面（依赖众多 state），这里用 useLayoutEffect 同步。

  useEffect(() => {
    // draft session 也通过 __probe__ 探测 capabilities
    // 真实会话的 agent 来自 session.agent 字段
    if (!activeSessionId || activeView !== "chat") return;
    let cancelled = false;
    setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: true }));

    async function loadCapabilities() {
      try {
        // 如果当前会话已有缓存，跳过重复初始化（切换回该会话时从缓存读取）
        const existingCaps = capabilitiesBySession[activeSessionId];
        if (existingCaps && activeSessionId !== DRAFT_SESSION_ID) {
          // capabilities 已缓存；使用函数式更新确保不覆盖用户的选择
          setConfigBySession((prev) => {
            const result = { ...prev, [activeSessionId]: mergeConfigDefaults(prev[activeSessionId], existingCaps) };
            configBySessionRef.current = result;
            return result;
          });
          if (!cancelled) {
            setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: false }));
          }
          return;
        }

        const probeId = isDraftSessionId(activeSessionId) ? "__probe__" : activeSessionId;
        const caps = await initializeSession(probeId);
        if (cancelled) return;

        // 写入 capabilities 缓存
        setCapabilitiesBySession((prev) => ({
          ...prev,
          [activeSessionId]: prepareRuntimeCapabilities(caps, configBySessionRef.current[activeSessionId]),
        }));

        // 初始化 config（仅当该会话没有 config 时）— 使用函数式更新确保不覆盖
        setConfigBySession((prev) => {
          const result = { ...prev, [activeSessionId]: mergeConfigDefaults(prev[activeSessionId], caps) };
          configBySessionRef.current = result;
          return result;
        });
        setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: false }));
      } catch (error) {
        console.error("Failed to load session capabilities:", error);
        // ... fallback 逻辑（保留原有行为，但写入 capabilitiesBySession 而非全局 state）
        if (!cancelled) {
          void loadCapabilitiesFallback();
        }
      }
    }

    async function loadCapabilitiesFallback() {
      try {
        const fallbackAgentId = sessionAgent?.id
          ?? (await loadAgentRuntimeSettings().then(s => s.activeAdapter).catch(() => null));
        const runtimeSettings = await loadAgentRuntimeSettings();
        const runtime = runtimeSettings.runtimes.find(
          (item) => item.adapter === (fallbackAgentId || runtimeSettings.activeAdapter)
        );
        if (!runtime) {
          setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: false }));
          return;
        }

        setActiveAgent({
          configMode: runtime.configMode,
          id: runtime.adapter,
          label: runtime.label,
          mode: runtime.mode,
          runtimeId: runtime.id,
        });

        const isCodex = runtime.id === "codex";
        const fallbackModes = isCodex
          ? [
              { id: "read-only", label: "只读", isDefault: runtime.mode === "read-only" },
              { id: "agent", label: "Agent", isDefault: runtime.mode === "agent" },
              { id: "agent-full-access", label: "完全访问", isDefault: runtime.mode === "agent-full-access" },
            ]
          : [{ id: runtime.mode || "default", label: runtime.mode || "默认", isDefault: true }];

        const fallbackConfigOptions: SessionConfigOption[] = isCodex
          ? [{
              id: "reasoning_effort",
              label: "思考强度",
              type: "enum" as const,
              values: ["none", "low", "medium", "high", "xhigh"],
              currentValue: "xhigh",
              valueLabels: { none: "无", low: "低", medium: "中", high: "高", xhigh: "超高" },
            }]
          : [];

        let fallbackModels: SessionModel[] = [];
        try {
          const runtimeModels = await loadAgentRuntimeModels(runtime.id ?? runtime.adapter);
          fallbackModels = runtimeModels.models.map((m: AgentRuntimeModel) => ({
            id: m.id, label: m.label, description: m.description,
            isCurrent: m.id === runtimeModels.currentModelId,
          }));
        } catch { /* ignore */ }

        const fallbackCaps: SessionCapabilities = {
          agent: {
            id: runtime.adapter, label: runtime.label,
            adapterKind: "acp" as const, status: runtime.status || "available",
          },
          modes: fallbackModes,
          models: fallbackModels,
          configOptions: fallbackConfigOptions,
          commands: [],
        };

        setCapabilitiesBySession((prev) => ({
          ...prev,
          [activeSessionId]: prepareRuntimeCapabilities(fallbackCaps, configBySessionRef.current[activeSessionId]),
        }));

        // 初始化 config（仅当该会话没有 config 时）— 使用函数式更新确保不覆盖
        setConfigBySession((prev) => {
          const result = { ...prev, [activeSessionId]: mergeConfigDefaults(prev[activeSessionId], fallbackCaps) };
          configBySessionRef.current = result;
          return result;
        });
        setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: false }));
      } catch (fallbackError) {
        console.error("Fallback model loading also failed:", fallbackError);
        setConfigLoadingBySession((prev) => ({ ...prev, [activeSessionId]: false }));
      }
    }

    void loadCapabilities();
    return () => { cancelled = true; };
  }, [activeView, activeSessionId, sessionAgent?.id, sessionAgent?.runtimeId]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
      }
      // 清理所有 config save timers
      for (const timer of Object.values(configSaveTimerRef.current)) {
        window.clearTimeout(timer);
      }
      for (const image of draftImagesRef.current) {
        revokeDraftImage(image);
      }
    };
  }, []);

  function updateSession(sessionId: string, updater: (session: Session) => Session) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  }

  /** 更新当前会话的 config（同时保存到后端） */
  function updateSessionConfig(patch: Partial<SessionConfig>) {
    const sessionId = activeSessionId;
    if (isDraftSessionId(sessionId)) return; // draft session 不保存

    setConfigBySession((prev) => {
      const current = prev[sessionId];
      const next: SessionConfig = current
        ? { ...current, ...patch }
        : {
            modelFamily: "",
            accessMode: "",
            reasoningEffort: "medium",
            selectedConfig: {},
            ...patch,
          };
      const result = { ...prev, [sessionId]: next };
      // 同步更新 ref，确保后续事件处理器立即读取到最新值
      configBySessionRef.current = result;

      // debounce 保存到后端（500ms 内只保存最后一次）
      const prevTimer = configSaveTimerRef.current[sessionId];
      if (prevTimer) window.clearTimeout(prevTimer);
      configSaveTimerRef.current[sessionId] = window.setTimeout(() => {
        saveConversationConfig(sessionId, next as unknown as Record<string, unknown>)
          .catch((err) => console.error("Failed to save session config:", err));
      }, 500);

      return result;
    });
  }

  function setSessionRunning(sessionId: string, running: boolean) {
    const next = new Set(runningSessionIdsRef.current);
    if (running) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    runningSessionIdsRef.current = next;
    setRunningSessionIds(next);
  }

  function clearDraftImages() {
    setDraftImages((current) => {
      for (const image of current) {
        revokeDraftImage(image);
      }
      return [];
    });
    setDraftImageError(null);
  }

  function removeDraftImage(imageId: string) {
    setDraftImages((current) => {
      const target = current.find((image) => image.id === imageId);
      if (target) {
        revokeDraftImage(target);
      }
      return current.filter((image) => image.id !== imageId);
    });
    setDraftImageError(null);
  }

  async function addDraftImages(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setImagesProcessing(true);
    setDraftImageError(null);
    try {
      const slots = Math.max(0, MAX_DRAFT_IMAGES - draftImagesRef.current.length);
      if (slots <= 0) {
        setDraftImageError("单轮最多支持 20 张图片。");
        return;
      }
      const accepted = files.slice(0, slots);
      if (accepted.length < files.length) {
        setDraftImageError("单轮最多支持 20 张图片，已忽略多余图片。");
      }

      const created: DraftImage[] = [];
      for (const file of accepted) {
        try {
          created.push(await createDraftImage(file));
        } catch (error) {
          setDraftImageError(error instanceof Error ? error.message : String(error));
        }
      }
      if (created.length === 0) {
        return;
      }

      setDraftImages((current) => {
        const next = [...current, ...created];
        const totalBytes = next.reduce((sum, image) => sum + (image.normalized?.normalizedBytes ?? image.rawBytes), 0);
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
          for (const image of created) {
            revokeDraftImage(image);
          }
          setDraftImageError("单轮图片总大小不能超过 200 MB。");
          return current;
        }
        return next;
      });
    } finally {
      setImagesProcessing(false);
    }
  }

  async function ensureRealConversationForSend(sessionId: string, text: string): Promise<string> {
    if (!isDraftSessionId(sessionId)) {
      return sessionId;
    }

    const result = await createConversation({
      agentId: sessionAgent?.id ?? activeAgent?.id ?? currentCapabilities?.agent.id ?? "codex",
      preview: text,
      title: text.slice(0, 24) || (draftImagesRef.current.length ? "图片输入" : undefined),
      ...(newSessionWorkspace ? { workspace: newSessionWorkspace } : {}),
    });
    const session = result.session;
    const draftCaps = capabilitiesBySession[sessionId];
    const draftCfg = configBySessionRef.current[sessionId];

    if (draftCaps) {
      setCapabilitiesBySession((prev) => ({ ...prev, [session.id]: prev[session.id] ?? draftCaps }));
    }
    if (draftCfg) {
      setConfigBySession((prev) => {
        const next = { ...prev, [session.id]: prev[session.id] ?? draftCfg };
        configBySessionRef.current = next;
        return next;
      });
    }
    setSessions((current) => [
      session,
      ...current.filter((item) => !isDraftSessionId(item.id) && item.id !== session.id),
    ]);
    setMessages((current) => ({
      ...current,
      [session.id]: result.messages as ChatMessage[],
    }));
    setActiveSessionId(session.id);
    return session.id;
  }

  function createSession(workspace = "") {
    // 显示 Agent 选择面板，让用户选择要使用的 agent
    setNewSessionWorkspace(workspace);
    setShowAgentSelection(true);
  }

  async function confirmAgentSelection(agentId: string, workspace: string) {
    setShowAgentSelection(false);
    setNewSessionWorkspace("");
    try {
      const result = await createConversation({
        agentId,
        ...(workspace ? { workspace } : {})
      });
      const session = result.session;
      setArchivedSessionIds((current) => {
        if (!current.has(DRAFT_SESSION_ID)) {
          return current;
        }
        const next = new Set(current);
        next.delete(DRAFT_SESSION_ID);
        return next;
      });
      setSessions((current) => [
        session,
        ...current.filter((s) => !isDraftSessionId(s.id))
      ]);
      setMessages((current) => ({
        ...current,
        [session.id]: []
      }));
      setActiveSessionId(session.id);
      setActiveView("chat");
      setDraft("");
      setPendingApproval(null);
      setPendingInput(null);
    } catch (error) {
      console.error("Failed to create conversation:", error);
      // fallback: 创建本地 draft session
      const draftSession = createDraftSession();
      setSessions((current) => [
        draftSession,
        ...current.filter((s) => !isDraftSessionId(s.id))
      ]);
      setMessages((current) => ({
        ...current,
        [draftSession.id]: []
      }));
      setActiveSessionId(draftSession.id);
      setActiveView("chat");
    }
  }

  function selectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setActiveView("chat");
    if (isDraftSessionId(sessionId)) {
      return;
    }

    void loadConversation(sessionId)
      .then((conversation) => {
        const isRunning = runningSessionIdsRef.current.has(sessionId);
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId ? mergeLoadedSession(conversation.session, session, isRunning) : session
          )
        );
        setMessages((current) => ({
          ...current,
          [sessionId]: isRunning ? mergeLoadedMessages(conversation.messages, current[sessionId]) : conversation.messages
        }));

        // 从最后一条 assistant 消息恢复 model 和 context usage
        const messages = isRunning
          ? mergeLoadedMessages(conversation.messages, undefined)
          : conversation.messages;
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

        // 恢复 config（从 session.config 或最后一条消息的 model 字段）
        const savedConfig = (conversation.session as unknown as Record<string, unknown>).config;
        let restoredModel = "";
        let restoredEffort = "";
        let restoredSelectedConfig: Record<string, ChatConfigValue> = {};
        const conversationAgent = (conversation.session as unknown as Record<string, unknown>).agent;
        const isCodex = isRecord(conversationAgent) && String(conversationAgent.runtimeId ?? conversationAgent.id ?? "") === "codex";
        if (savedConfig && typeof savedConfig === "object") {
          const cfg = savedConfig as Partial<SessionConfig>;
          restoredModel = String(cfg.modelFamily ?? "");
          restoredEffort = String(cfg.reasoningEffort ?? "");
          restoredSelectedConfig = configValueRecord(cfg.selectedConfig);
        }
        // fallback: 从最后一条消息的 model 字段解析
        if (!restoredModel && lastAssistant?.model) {
          const modelInfo = lastAssistant.model as Record<string, unknown>;
          restoredModel = String(modelInfo.runtimeModel ?? modelInfo.model ?? "");
          restoredEffort = String(modelInfo.reasoningEffort ?? "");
          const restoredFastMode = fastModeFromModelInfo(modelInfo);
          if (restoredFastMode) {
            restoredSelectedConfig.fast_mode = restoredFastMode;
          }
        }
        if (isCodex && restoredModel) {
          const modelSelection = normalizeCodexModelSelection(restoredModel, restoredEffort);
          restoredModel = modelSelection.family;
          restoredEffort = modelSelection.effort;
          if (restoredEffort) {
            restoredSelectedConfig.reasoning_effort = restoredEffort;
          }
        }
        // 从 session.agent.mode 恢复 accessMode
        const restoredAccessMode = isRecord(conversationAgent)
          ? String(conversationAgent.mode ?? "")
          : "";

        if (restoredModel || restoredAccessMode) {
          setConfigBySession((prev) => {
            if (prev[sessionId]) return prev; // 已有本地配置，不覆盖
            const selectedConfig: Record<string, ChatConfigValue> = restoredEffort
              ? { ...restoredSelectedConfig, reasoning_effort: restoredEffort }
              : restoredSelectedConfig;
            return {
              ...prev,
              [sessionId]: {
                modelFamily: restoredModel,
                accessMode: restoredAccessMode || "read-only",
                reasoningEffort: restoredEffort || "medium",
                selectedConfig,
              },
            };
          });
        }

        // 恢复 context usage（从最后一条消息的 usage 字段）
        if (lastAssistant?.usage) {
          const usage = lastAssistant.usage as UsageStats;
          if (usage.contextUsedTokens != null || usage.contextWindowTokens != null) {
            setContextUsageBySession((prev) => {
              if (prev[sessionId]) return prev;
              return { ...prev, [sessionId]: usage };
            });
          }
        }
      })
      .catch((error) => console.error(error));
  }

  function archiveSession(sessionId: string) {
    setArchivedSessionIds((current) => {
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
    updateSession(sessionId, (session) => ({ ...session, archived: true }));
    if (!isDraftSessionId(sessionId)) {
      void updateConversationArchiveState(sessionId, true)
        .then((session) => updateSession(sessionId, () => session))
        .catch((error) => console.error(error));
    }

    if (sessionId !== activeSessionId) {
      return;
    }

    const nextSession = sessions.find((session) => session.id !== sessionId && !archivedSessionIds.has(session.id));
    if (nextSession) {
      selectSession(nextSession.id);
      return;
    }

    createSession();
  }

  function restoreArchivedSession(sessionId: string) {
    setArchivedSessionIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    updateSession(sessionId, (session) => ({ ...session, archived: false }));
    if (!isDraftSessionId(sessionId)) {
      void updateConversationArchiveState(sessionId, false)
        .then((session) => updateSession(sessionId, () => session))
        .catch((error) => console.error(error));
    }
  }

  async function deleteArchivedSession(sessionId: string) {
    if (!isDraftSessionId(sessionId)) {
      await deleteConversation(sessionId);
    }

    setArchivedSessionIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setMessages((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function flushQueuedMessageDeltas() {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }

    const pendingDeltas = Object.values(pendingMessageDeltasRef.current);
    if (pendingDeltas.length === 0) {
      return;
    }

    pendingMessageDeltasRef.current = {};
    setMessages((current) => {
      let next = current;
      for (const delta of pendingDeltas) {
        if (!delta.text && !delta.reasoning) {
          continue;
        }

        next = updateMessage(next, delta.sessionId, delta.messageId, (message) => ({
          ...message,
          content: delta.text ? message.content + delta.text : message.content,
          reasoning: delta.reasoning ? `${message.reasoning ?? ""}${delta.reasoning}` : message.reasoning
        }));
      }
      return next;
    });
  }

  function scheduleMessageDeltaFlush() {
    if (streamFlushTimerRef.current !== null) {
      return;
    }

    streamFlushTimerRef.current = window.setTimeout(flushQueuedMessageDeltas, STREAM_DELTA_FLUSH_MS);
  }

  function queueMessageDelta(
    sessionId: string,
    assistantMessageId: string,
    delta: string,
    kind: "text" | "reasoning",
  ) {
    const key = `${sessionId}:${assistantMessageId}`;
    const current = pendingMessageDeltasRef.current[key] ?? {
      messageId: assistantMessageId,
      reasoning: "",
      sessionId,
      text: ""
    };

    pendingMessageDeltasRef.current[key] = {
      ...current,
      reasoning: kind === "reasoning" ? current.reasoning + delta : current.reasoning,
      text: kind === "text" ? current.text + delta : current.text
    };
    scheduleMessageDeltaFlush();
  }

  function handleAgentEvent(sessionId: string, event: AgentEvent) {
    if (event.type === "conversation.turn.started") {
      const nextSessionId = event.conversationId;
      // 发起方（draft 会话）场景：本窗口发起 turn 时 draft→real 转换，
      // sessionId 可能是 draft id；迁移 caps/config。
      // 观察方（直接订阅 real channel）场景：sessionId === nextSessionId，无需迁移。
      const draftSessionId = isDraftSessionId(sessionId) ? sessionId : pendingDraftIdForTurnRef.current;
      activeAssistantMessageIdBySessionRef.current[nextSessionId] = event.assistantMessage.id;
      activeStreamSessionIdByTurnRef.current[nextSessionId] = nextSessionId;

      // draft → real id 转换时，迁移 capabilities 和 config
      if (draftSessionId && nextSessionId !== draftSessionId && isDraftSessionId(draftSessionId)) {
        const draftCaps = capabilitiesBySession[draftSessionId];
        if (draftCaps) {
          setCapabilitiesBySession((prev) => {
            // 如果目标 session 已有 capabilities，不覆盖
            if (prev[nextSessionId]) {
              return prev;
            }
            return { ...prev, [nextSessionId]: prepareRuntimeCapabilities(draftCaps, configBySessionRef.current[draftSessionId]) };
          });
        }
        const draftCfg = configBySession[draftSessionId];
        if (draftCfg) {
          setConfigBySession((prev) => {
            // 如果目标 session 已有 config，不覆盖（保留用户的选择）
            if (prev[nextSessionId]) {
              return prev;
            }
            const result = { ...prev, [nextSessionId]: draftCfg };
            // 同步更新 ref
            configBySessionRef.current = result;
            return result;
          });
        }
        // 清除 pending draft 映射（已消费）
        pendingDraftIdForTurnRef.current = null;
      }

      // 区分发起方与观察方：
      // - 发起方：sessionId 是 draft（draftSessionId 已设置）或等于 nextSessionId 且本窗口有活动 turn。
      // - 观察方：sessionId 是不相关的真实会话 id。
      //   观察方只更新 running 与 messages，不切换 activeSessionId、不清除其他会话的 running 态。
      const hasActiveTurnForSession = Boolean(activeTurnIdBySession[nextSessionId]);
      const isInitiator = (draftSessionId && sessionId === draftSessionId)
        || (sessionId === nextSessionId && hasActiveTurnForSession);

      if (isInitiator) {
        if (nextSessionId !== sessionId && !isDraftSessionId(sessionId)) {
          setSessionRunning(sessionId, false);
        }
        setSessionRunning(nextSessionId, true);
        // 总是切换到真实会话 id（draft -> real id 转换必须切换）
        setActiveSessionId(nextSessionId);
      } else {
        // 观察方：只标记该会话在运行
        setSessionRunning(nextSessionId, true);
      }
      setSessions((current) => {
        if (isInitiator) {
          // 发起方：移除 draft 和同 id 的旧会话，用事件中的真实 session 替换
          const cleaned = current.filter(
            (session) => !isDraftSessionId(session.id) && session.id !== nextSessionId,
          );
          return [event.session, ...cleaned];
        }
        // 观察方：更新会话字段（如 status、title），保留列表位置
        return current.map((s) => s.id === nextSessionId ? { ...s, ...event.session } : s);
      });
      setMessages((current) => {
        const existing = current[nextSessionId] ?? [];
        // 观察者场景：snapshot 已携带 user+assistant 消息，不要重复添加。
        const hasUser = existing.some((m) => m.id === event.userMessage.id);
        const hasAssistant = existing.some((m) => m.id === event.assistantMessage.id);
        if (hasUser && hasAssistant) {
          return current;
        }
        const toAdd: ChatMessage[] = [];
        if (!hasUser) toAdd.push(event.userMessage);
        if (!hasAssistant) toAdd.push(event.assistantMessage);
        return {
          ...current,
          [nextSessionId]: [...existing, ...toAdd],
        };
      });
      return;
    }

    // 用事件的 conversationId 做路由（draft session 发送后会变成真实 id）
    const targetSessionId = event.conversationId || sessionId;
    const assistantMessageId = activeAssistantMessageIdBySessionRef.current[targetSessionId]
      ?? activeAssistantMessageIdBySessionRef.current[sessionId];
    if (!assistantMessageId) {
      // assistantMessageId 丢失时，run 的终端事件仍需清除 running 态，
      // 否则 UI 会永远卡在"运行中"。常见场景：snapshot 回填消息后 ref 没同步，
      // 或 finally 块先于 run.completed 路由执行清了 ref。
      if (event.type === "agent.run.completed" || event.type === "agent.run.failed") {
        setSessionRunning(targetSessionId, false);
        if (event.type === "agent.run.failed") {
          if (draftImagesRef.current.length > 0) {
            setDraftImageError(event.error ?? "Agent 运行失败");
          }
          updateSession(targetSessionId, (session) => ({ ...session, status: "error", updatedAt: Date.now() }));
        }
      }
      return;
    }

    if (event.type === "agent.text.delta") {
      queueMessageDelta(targetSessionId, assistantMessageId, event.delta, "text");
      return;
    }

    if (event.type === "agent.reasoning.delta") {
      queueMessageDelta(targetSessionId, assistantMessageId, event.delta, "reasoning");
      return;
    }

    if (event.type === "agent.text.completed" || event.type === "agent.reasoning.completed") {
      flushQueuedMessageDeltas();
      return;
    }

    if (event.type === "agent.plan.updated") {
      flushQueuedMessageDeltas();
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          plan: mergeMessagePlan(message, current[targetSessionId], event.plan),
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
          updatedAt: Date.now(),
        }))
      );
      return;
    }

    if (event.type === "agent.command.available.updated") {
      setCapabilitiesBySession((prev) => {
        const nextCaps = mergeRuntimeCommands(prev[targetSessionId], event.commands);
        return nextCaps ? { ...prev, [targetSessionId]: nextCaps } : prev;
      });
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
        }))
      );
      return;
    }

    if (event.type === "agent.mode.updated") {
      if (event.modeId) {
        setConfigBySession((prev) => {
          const current = prev[targetSessionId];
          const nextConfig: SessionConfig = {
            accessMode: event.modeId,
            modelFamily: current?.modelFamily ?? "",
            reasoningEffort: current?.reasoningEffort ?? "medium",
            selectedConfig: current?.selectedConfig ?? {},
          };
          const result = { ...prev, [targetSessionId]: nextConfig };
          configBySessionRef.current = result;
          return result;
        });
      }
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
        }))
      );
      return;
    }

    if (event.type === "agent.input.required") {
      flushQueuedMessageDeltas();
      setPendingInput({
        conversationId: targetSessionId,
        inputRequestId: event.inputRequestId,
        message: event.message,
        mode: event.mode,
        schema: event.schema,
        toolCallId: event.toolCallId,
      });
      updateSession(targetSessionId, (session) => ({ ...session, status: "approval", updatedAt: Date.now() }));
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
        }))
      );
      return;
    }

    if (event.type === "agent.input.completed") {
      setPendingInput((current) => current?.inputRequestId === event.inputRequestId ? null : current);
    }

    if (event.type === "agent.config.updated") {
      const nextConfigOptions = normalizeRuntimeConfigOptions(event.configOptions);
      const hasFastOption = nextConfigOptions.some((option) => option.id === "fast_mode");
      setCapabilitiesBySession((prev) => ({
        ...prev,
        [targetSessionId]: mergeRuntimeConfigOptions(
          prev[targetSessionId],
          event.configOptions,
          configBySessionRef.current[targetSessionId],
        ) ?? prev[targetSessionId],
      }));
      setConfigBySession((prev) => {
        const current = prev[targetSessionId];
        if (!current) {
          return prev;
        }
        const nextSelectedConfig = { ...current.selectedConfig };
        let nextReasoningEffort = current.reasoningEffort;
        for (const option of nextConfigOptions) {
          if (option.currentValue != null) {
            nextSelectedConfig[option.id] = option.currentValue;
            if (option.id === "reasoning_effort") {
              nextReasoningEffort = String(option.currentValue);
            }
          }
        }
        if (!hasFastOption) {
          nextSelectedConfig.fast_mode = "off";
        }
        const result = {
          ...prev,
          [targetSessionId]: {
            ...current,
            reasoningEffort: nextReasoningEffort,
            selectedConfig: nextSelectedConfig,
          },
        };
        configBySessionRef.current = result;
        return result;
      });
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
        }))
      );
      return;
    }

    if (
      event.type === "agent.input.completed"
      || event.type === "agent.raw.rpc"
      || event.type === "agent.raw.update"
    ) {
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          runtimeEvents: appendRuntimeEvent(message.runtimeEvents, event),
        }))
      );
      return;
    }

    if (event.type === "agent.tool.started") {
      flushQueuedMessageDeltas();
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          plan: mergeMessagePlan(message, current[targetSessionId], event.plan),
          toolCalls: upsertToolCall(message.toolCalls, {
            anchorOffset: message.content.length,
            argumentsText: formatJson(event.arguments),
            id: event.toolCallId || createId("tool"),
            metadata: event.metadata ?? null,
            name: event.name,
            risk: event.risk,
            status: "running"
          })
        }))
      );
      return;
    }

    if (event.type === "agent.tool.delta") {
      // 工具中间状态更新（长命令进度）
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          toolCalls: upsertToolCall(message.toolCalls, {
            id: event.toolCallId,
            metadata: event.metadata ?? null,
            name: event.name,
            status: "running",
            resultText: event.progress != null ? formatJson(event.progress) : undefined,
          })
        }))
      );
      return;
    }

    if (event.type === "agent.tool.completed") {
      flushQueuedMessageDeltas();
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          plan: mergeMessagePlan(message, current[targetSessionId], event.plan),
          toolCalls: upsertToolCall(message.toolCalls, {
            id: event.toolCallId || createId("tool"),
            metadata: event.metadata ?? null,
            name: event.name,
            resultText: formatJson(event.result ?? event.metadata),
            status: "complete"
          })
        }))
      );
      return;
    }

    if (event.type === "agent.tool.failed") {
      flushQueuedMessageDeltas();
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          toolCalls: upsertToolCall(message.toolCalls, {
            error: event.error ?? "工具调用失败",
            id: event.toolCallId || createId("tool"),
            metadata: event.metadata ?? null,
            name: event.name,
            status: "error"
          })
        }))
      );
      return;
    }

    if (event.type === "approval.required") {
      flushQueuedMessageDeltas();
      setPendingApproval({
        approvalId: event.approvalId,
        argumentsText: formatJson(event.argumentsText ? event.argumentsText : event.arguments),
        conversationId: targetSessionId,
        impact: event.impact,
        name: event.name,
        plan: event.plan,
        purpose: event.purpose,
        risk: event.risk,
        risks: event.risks,
        rollback: event.rollback,
        toolCallId: event.toolCallId
      });
      updateSession(targetSessionId, (session) => ({ ...session, status: "approval", updatedAt: Date.now() }));
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          plan: mergeMessagePlan(message, current[targetSessionId], event.plan),
          toolCalls: upsertToolCall(message.toolCalls, {
            anchorOffset: message.content.length,
            argumentsText: formatJson(event.argumentsText ? event.argumentsText : event.arguments),
            id: event.toolCallId || event.approvalId,
            name: event.name,
            risk: event.risk,
            status: "approval"
          })
        }))
      );
      return;
    }

    if (event.type === "agent.context.updated") {
      setContextUsageBySession((prev) => ({
        ...prev,
        [targetSessionId]: event.context,
      }));
      return;
    }

    if (event.type === "agent.session.updated") {
      const title = event.title?.trim();
      if (event.session || title) {
        updateSession(targetSessionId, (session) => event.session ?? {
          ...session,
          title: title ?? session.title,
          updatedAt: Date.now(),
        });
      }
      return;
    }

    if (event.type === "agent.run.completed") {
      flushQueuedMessageDeltas();
      const completedAt = Date.now();
      setSessionRunning(targetSessionId, false);
      // 从 final usage 更新 context（如果 turn 结束时携带了 context 数据）
      if (typeof event.usage === "object" && event.usage) {
        const finalUsage = event.usage as Record<string, unknown>;
        if (finalUsage.contextUsedTokens != null || finalUsage.contextWindowTokens != null) {
          setContextUsageBySession((prev) => ({
            ...prev,
            [targetSessionId]: {
              ...(prev[targetSessionId] ?? {}),
              ...finalUsage,
            } as UsageStats,
          }));
        }
      }
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          model: typeof event.model === "object" && event.model ? (event.model as ChatMessage["model"]) : message.model,
          streaming: false,
          updatedAt: completedAt,
          usage: typeof event.usage === "object" && event.usage ? (event.usage as ChatMessage["usage"]) : message.usage
        }))
      );
      updateSession(targetSessionId, (session) => event.session ?? { ...session, status: "idle", updatedAt: completedAt });
      return;
    }

    if (event.type === "agent.run.failed") {
      flushQueuedMessageDeltas();
      const failedAt = Date.now();
      setSessionRunning(targetSessionId, false);
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          error: event.error ?? "Agent 运行失败",
          streaming: false,
          updatedAt: failedAt
        }))
      );
      updateSession(targetSessionId, (session) => event.session ?? { ...session, status: "error", updatedAt: failedAt });
    }
  }
  // 保持 handleAgentEventRef 指向最新版本，供全局 WS 事件监听器调用
  handleAgentEventRef.current = handleAgentEvent;

  async function sendMessage() {
    const text = draft.trim();
    const images = draftImagesRef.current;
    if ((!text && images.length === 0) || activeTurnId || imagesProcessing || isCurrentConfigLoading || !isCurrentConfigReady) {
      return;
    }
    if (!currentCapabilities) {
      return;
    }

    const sessionId = activeSession.id;
    let streamSessionId = sessionId;
    let turnStarted = false;
    const turnId = createId("turn");
    setActiveTurnIdBySession((prev) => ({ ...prev, [sessionId]: turnId }));
    setSessionRunning(sessionId, true);
    delete activeAssistantMessageIdBySessionRef.current[sessionId];
    delete activeStreamSessionIdByTurnRef.current[sessionId];
    setPendingApproval(null);
    setPendingInput(null);

    // 记录发起方 draft 会话（供全局 WS 监听在 conversation.turn.started 时迁移 caps/config）
    if (isDraftSessionId(sessionId)) {
      pendingDraftIdForTurnRef.current = sessionId;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const conversationId = images.length > 0
        ? await ensureRealConversationForSend(sessionId, text)
        : isDraftSessionId(sessionId) ? undefined : sessionId;
      if (conversationId) {
        streamSessionId = conversationId;
        if (conversationId !== sessionId) {
          setActiveTurnIdBySession((prev) => ({ ...prev, [conversationId]: turnId }));
          setSessionRunning(conversationId, true);
        }
      }

      // 从 ref 读取最新的 config（避免闭包捕获旧值）
      const cfg = mergeConfigDefaults(configBySessionRef.current[sessionId] ?? currentConfig ?? undefined, currentCapabilities);
      const models = currentCapabilities.models;

      // 解析模型 ID：
      // - Codex 用 "模型族[推理强度]" 格式（模型 id 本身含括号）
      // - Claude Code 用短名称（如 haiku/sonnet/opus[1m]），推理强度走 effort config
      const isCodex = isCodexAgent(sessionAgent);
      let fullModelId: string | undefined;
      let modelLabel: string | undefined;
      if (isCodex && cfg?.modelFamily && cfg.reasoningEffort) {
        // Codex: 用 bracket 格式 "family[effort]"
        fullModelId = buildCodexRuntimeModelId(cfg.modelFamily, cfg.reasoningEffort);
        modelLabel = fullModelId;
      } else if (cfg?.modelFamily) {
        // Claude Code 等：直接用模型 id，推理强度通过 effort config 传递
        const exact = models.find((m) => m.id === cfg.modelFamily);
        fullModelId = exact?.id ?? cfg.modelFamily;
        modelLabel = exact?.label;
      }
      let contentBlocks: UserContentBlock[] | undefined;
      if (images.length > 0 && conversationId) {
        const uploaded = await uploadTurnAttachments({
          conversationId,
          images: images.map((image) => ({
            blob: image.normalized?.blob ?? image.file,
            fileName: image.name,
            height: image.normalized?.height ?? image.height,
            mimeType: image.normalized?.mimeType ?? image.mimeType,
            wasCompressed: image.normalized?.wasCompressed,
            width: image.normalized?.width ?? image.width,
          })),
          turnId,
        });
        contentBlocks = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...uploaded.map((attachment) => ({
            type: "image" as const,
            mimeType: attachment.mimeType as "image/png" | "image/jpeg" | "image/webp",
            source: { kind: "attachment" as const, attachmentId: attachment.id },
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            width: attachment.width,
            height: attachment.height,
            sha256: attachment.sha256,
            wasCompressed: attachment.wasCompressed,
          })),
        ];
      }
      await streamAgentTurn({
        accessMode: cfg?.accessMode,
        conversationId,
        contentBlocks,
        input: text,
        modelId: fullModelId,
        modelLabel,
        onEvent: (event) => {
          // 事件路由已交给全局 WS 监听（0709 阶段二）；这里只处理发起方 UI 副作用。
          if (event.type === "conversation.turn.started") {
            turnStarted = true;
            setDraft("");
            clearDraftImages();
            // 发起方：turn 已确认启动，订阅真实会话频道（后端生成的 conversationId）。
            // 全局监听会收到后续事件并路由到 handleAgentEvent。
            const realId = event.conversationId;
            if (realId && !isDraftSessionId(realId) && subscribedChannelRef.current !== realId) {
              const transport = getLocalTransport();
              if (subscribedChannelRef.current) {
                transport.unsubscribe(subscribedChannelRef.current);
              }
              subscribedChannelRef.current = realId;
              void transport.subscribe(realId);
            }
          }
        },
        signal: abortController.signal,
        reasoningEffort: cfg?.reasoningEffort,
        selectedConfig: cfg?.selectedConfig,
        turnId
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        handleAgentEvent(sessionId, {
          conversationId: sessionId,
          error: "用户取消了当前任务。",
          turnId,
          type: "agent.run.failed"
        });
      } else {
        if (!turnStarted) {
          setDraft(text);
          setDraftImages(images);
          setDraftImageError(error instanceof Error ? error.message : String(error));
        }
        handleAgentEvent(sessionId, {
          conversationId: streamSessionId,
          error: error instanceof Error ? error.message : String(error),
          turnId,
          type: "agent.run.failed"
        });
      }
    } finally {
      setActiveTurnIdBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        if (streamSessionId !== sessionId) {
          delete next[streamSessionId];
        }
        return next;
      });
      delete activeAssistantMessageIdBySessionRef.current[sessionId];
      delete activeStreamSessionIdByTurnRef.current[sessionId];
      if (streamSessionId !== sessionId) {
        delete activeAssistantMessageIdBySessionRef.current[streamSessionId];
        delete activeStreamSessionIdByTurnRef.current[streamSessionId];
      }
      abortControllerRef.current = null;
      pendingDraftIdForTurnRef.current = null;
    }
  }

  async function stopCurrentTurn() {
    if (!activeTurnId || !isActiveSessionRunning) {
      return;
    }

    const sessionId = activeSession.id;
    const turnId = activeTurnId;
    abortControllerRef.current?.abort();
    flushQueuedMessageDeltas();

    // 立即清掉"正在思考"与流式光标：停止是显式用户操作，UI 应即时反馈，
    // 不依赖后端 run.failed 的到达时机（后端事件仍是最终 status/error 的真相源）。
    setSessionRunning(sessionId, false);
    const streamingAssistantId = activeAssistantMessageIdBySessionRef.current[sessionId];
    if (streamingAssistantId) {
      setMessages((current) =>
        updateMessage(current, sessionId, streamingAssistantId, (message) => ({
          ...message,
          streaming: false,
          updatedAt: Date.now(),
        }))
      );
    }

    await cancelTurn(turnId).catch(() => undefined);
    setActiveTurnIdBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPendingApproval(null);
    setPendingInput(null);
  }

  async function resolveApproval(decision: "allow" | "deny") {
    if (!activePendingApproval) {
      return;
    }

    const approval = activePendingApproval;
    const approvalId = approval.approvalId;
    setPendingApproval(null);
    updateSession(approval.conversationId, (session) => ({ ...session, status: "running", updatedAt: Date.now() }));
    await sendApprovalDecision(approvalId, decision)
      .then((result) => {
        if (result.session) {
          updateSession(approval.conversationId, () => result.session as Session);
        }
      })
      .catch((error) => {
        updateSession(approval.conversationId, (session) => ({ ...session, status: "error", updatedAt: Date.now() }));
        console.error(error);
      });
  }

  async function resolveInput(action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) {
    if (!activePendingInput) {
      return;
    }

    const input = activePendingInput;
    setPendingInput(null);
    updateSession(input.conversationId, (session) => ({ ...session, status: "running", updatedAt: Date.now() }));
    await sendInputResponse(input.inputRequestId, action, content)
      .then((result) => {
        if (result.session) {
          updateSession(input.conversationId, () => result.session as Session);
        }
      })
      .catch((error) => {
        updateSession(input.conversationId, (session) => ({ ...session, status: "error", updatedAt: Date.now() }));
        console.error(error);
      });
  }

  return (
    <>
      {showAgentSelection ? (
        <AgentSelectionPanel
          availableAgents={[
            { id: "codex", label: "Codex", status: "available", description: "OpenAI Codex，通过 ACP 协议接入。支持代码生成、工具调用和文件操作。" },
            { id: "claude_code", label: "Claude Code", status: "available", description: "Anthropic Claude Code，通过 ACP 协议接入。支持 Haiku/Sonnet/Opus 等模型等级，代码生成和分析。" },
            { id: "opencode", label: "opencode", status: "planned", description: "opencode agent，通过 ACP 协议接入。当前为计划接入状态。" },
            { id: "nanobot", label: "Nanobot", status: "available", description: "Legacy agent，使用产品级模型配置。适合非代码任务。" },
          ]}
          initialWorkspace={newSessionWorkspace}
          onCancel={() => {
            setShowAgentSelection(false);
            setNewSessionWorkspace("");
          }}
          onSelect={(agentId, workspace) => void confirmAgentSelection(agentId, workspace)}
        />
      ) : null}
      {activeView === "settings" ? (
        <SettingsPage
          archivedSessions={archivedSessions}
          onBack={() => setActiveView("chat")}
          onDeleteArchivedSession={deleteArchivedSession}
          onRestoreArchivedSession={restoreArchivedSession}
        />
      ) : (
        <>
          <Sidebar
            activeSessionId={activeSession.id}
            activeView={activeView}
            onArchiveSession={archiveSession}
            onCreateSession={createSession}
            onOpenOverview={() => setActiveView("overview")}
            onOpenSettings={() => setActiveView("settings")}
            onSearchTextChange={setSearchText}
            onSelectSession={selectSession}
            searchText={searchText}
            sessions={filteredSessions}
          />

          {activeView === "overview" ? (
            <OverviewPage />
          ) : (
            <ChatWorkspace
              accessMode={currentConfig?.accessMode ?? ""}
              activeTurnId={isActiveSessionRunning ? activeTurnId : null}
              agent={sessionAgent}
              commands={currentCapabilities?.commands ?? []}
              configLoading={isCurrentConfigLoading}
              configOptions={currentCapabilities?.configOptions ?? []}
              contextUsage={contextUsage}
              draft={draft}
              draftImageError={draftImageError}
              draftImages={draftImages}
              imagesProcessing={imagesProcessing}
              isRunning={isActiveSessionRunning}
              messages={activeMessages}
              modes={currentCapabilities?.modes ?? []}
              models={currentCapabilities?.models ?? []}
              onAccessModeChange={(value) => updateSessionConfig({ accessMode: value })}
              onConfigChange={(optionId, value) => {
                const next = { ...(currentConfig?.selectedConfig ?? {}), [optionId]: value };
                updateSessionConfig({ selectedConfig: next });
              }}
              onDraftChange={setDraft}
              onDraftImagesAdd={(files) => void addDraftImages(files)}
              onDraftImageRemove={removeDraftImage}
              onModelFamilyChange={(value) => updateSessionConfig({ modelFamily: value })}
              onReasoningEffortChange={(value) => updateSessionConfig({ reasoningEffort: value })}
              onResolveApproval={(decision) => void resolveApproval(decision)}
              onResolveInput={(action, content) => void resolveInput(action, content)}
              onSendMessage={() => void sendMessage()}
              onStopTurn={() => void stopCurrentTurn()}
              pendingApproval={activePendingApproval}
              pendingInput={activePendingInput}
              reasoningEffort={currentConfig?.reasoningEffort ?? ""}
              sendDisabled={imagesProcessing || isCurrentConfigLoading || !isCurrentConfigReady}
              selectedConfig={currentConfig?.selectedConfig ?? {}}
              selectedModelFamily={currentConfig?.modelFamily ?? ""}
              sessionId={activeSession.id}
              title={activeSession.title}
              updatedAt={activeSession.updatedAt}
              workspace={activeSession.workspace}
            />
          )}
        </>
      )}
    </>
  );
}
