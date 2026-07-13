import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

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
import { ImageGenListPage } from "./image-gen/ImageGenListPage";
import { ImageGenDetailPage } from "./image-gen/ImageGenDetailPage";
import type { SettingsSection } from "./settings/types";
import { createConversation, getConversationClient, initializeSession, uploadTurnAttachments } from "../services/agentClient";
import { getImageGenClient } from "../services/imageGenStore";
import { useConversationState } from "../services/useConversations";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversationConfig,
  updateConversationArchiveState
} from "../services/conversationStore";
import { loadAgentRuntimeModels, loadAgentRuntimeSettings } from "../services/settingsStore";
import { loadPromptOptimizeSettings, optimizeCodePrompt } from "../services/featureStore";
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
// 稳定的空图片数组引用，避免每次渲染都新建 [] 触发下游 memo/effect 重跑。
const EMPTY_DRAFT_IMAGES: DraftImage[] = [];
type ActiveView = "chat" | "overview" | "settings" | "image-gen-list" | "image-gen-detail";
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
  // 共享状态层：会话列表与每会话视图态（消息/运行态/上下文/审批/输入）由 client 管理。
  const client = useMemo(() => getConversationClient(), []);
  const { sessions: clientSessions, views } = useConversationState(client);

  const [activeSessionId, setActiveSessionId] = useState(initialState.activeSessionId);
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [activeImageRecordId, setActiveImageRecordId] = useState<string | null>(null);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection | undefined>(undefined);
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(() => new Set());
  const [searchText, setSearchText] = useState("");
  // composer 草稿态按会话隔离（与 configBySession/capabilitiesBySession 同构）。
  // 不能用全局 useState：那样会导致草稿跨会话串、以及 imagesProcessing 泄漏到
  // 别的会话把发送按钮误禁用。派生的当前会话值见下方 draft/draftImages 等。
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  const [draftImagesBySession, setDraftImagesBySession] = useState<Record<string, DraftImage[]>>({});
  const [draftImageErrorBySession, setDraftImageErrorBySession] = useState<Record<string, string | null>>({});
  const [imagesProcessingBySession, setImagesProcessingBySession] = useState<Record<string, boolean>>({});
  // 提示词优化（code agent）：开关来自功能设置；优化中/撤销快照按会话隔离。
  const [codePromptOptimizeEnabled, setCodePromptOptimizeEnabled] = useState(false);
  const [optimizingPromptBySession, setOptimizingPromptBySession] = useState<Record<string, boolean>>({});
  // 撤销快照：记录优化前后的文本，只要当前草稿仍等于优化结果就允许一键/Ctrl+Z 撤销。
  const [optimizeUndoBySession, setOptimizeUndoBySession] = useState<Record<string, { before: string; after: string }>>({});
  const [activeAgent, setActiveAgent] = useState<AgentSummary | null>(null);
  const [showAgentSelection, setShowAgentSelection] = useState(false);
  const [newSessionWorkspace, setNewSessionWorkspace] = useState("");
  // draft session 仅存在于本地（未落后端），与 client 的真实会话列表合并展示。
  const [draftSession, setDraftSession] = useState<Session | null>(() => createDraftSession());

  // 会话列表 = client 的真实会话 + 本地 draft（若有）。
  const sessions = useMemo<Session[]>(
    () => (draftSession ? [draftSession, ...clientSessions.filter((s) => s.id !== draftSession.id)] : clientSessions),
    [clientSessions, draftSession],
  );

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

  // ─── 同步 config 到 ref（确保 sendMessage 读取到最新值）───
  useEffect(() => {
    configBySessionRef.current = configBySession;
  }, [configBySession]);

  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const configSaveTimerRef = useRef<Record<string, number>>({});
  const activeSessionIdRef = useRef(activeSessionId);
  // 当前已订阅的会话频道（切换会话时先退订旧的）
  const subscribedChannelRef = useRef<string | null>(null);
  // 使用 ref 存储最新的 config，确保 sendMessage 读取到最新值（避免闭包捕获旧值）
  const configBySessionRef = useRef<Record<string, SessionConfig>>({});
  const draftImagesRef = useRef<DraftImage[]>([]);
  const draftImagesBySessionRef = useRef<Record<string, DraftImage[]>>({});

  const activeSession = sessions.find((item) => item.id === activeSessionId) ?? sessions[0];
  const activeView_ = views[activeSession.id];
  const activeMessages = activeView_?.messages ?? [];
  const isActiveSessionRunning = client.isRunning(activeSession.id) || Boolean(activeView_?.running);
  const activePendingApproval = activeView_?.pendingApproval
    ? { ...activeView_.pendingApproval, conversationId: activeSession.id }
    : null;
  const activePendingInput = activeView_?.pendingInput
    ? { ...activeView_.pendingInput, conversationId: activeSession.id }
    : null;
  const sessionAgent = activeSession.agent ?? (isDraftSessionId(activeSession.id) ? activeAgent : null);
  const contextUsage = activeView_?.contextUsage ?? null;
  const activeTurnId = client.getActiveTurnId(activeSession.id) ?? null;

  // ─── 派生：当前会话的 composer 草稿态（按会话隔离，见 *BySession 定义）───
  // 键统一用 activeSessionId：与下方 setter（写 activeSessionIdRef.current）以及
  // configBySession/capabilitiesBySession 的取值口径一致，保证读写命中同一桶。
  const draft = draftBySession[activeSessionId] ?? "";
  const draftImages = draftImagesBySession[activeSessionId] ?? EMPTY_DRAFT_IMAGES;
  const draftImageError = draftImageErrorBySession[activeSessionId] ?? null;
  const imagesProcessing = imagesProcessingBySession[activeSessionId] ?? false;
  const optimizingPrompt = optimizingPromptBySession[activeSessionId] ?? false;
  // 只有当前草稿仍等于上次优化结果（用户未再编辑）时，才允许撤销回优化前文本。
  const optimizeUndo = optimizeUndoBySession[activeSessionId] ?? null;
  const canUndoOptimize = Boolean(optimizeUndo) && draft === optimizeUndo?.after;

  // 当前会话的草稿 setter：把全局 setDraft 等调用改写为只更新当前会话这一桶。
  // 保留原有的「值 or 函数式更新」两种签名，避免大面积改调用点。
  const setDraft = useCallback((value: SetStateAction<string>) => {
    const sessionId = activeSessionIdRef.current;
    setDraftBySession((prev) => {
      const current = prev[sessionId] ?? "";
      const next = typeof value === "function" ? (value as (p: string) => string)(current) : value;
      if (next === current) return prev;
      return { ...prev, [sessionId]: next };
    });
  }, []);
  const setDraftImages = useCallback((value: SetStateAction<DraftImage[]>) => {
    const sessionId = activeSessionIdRef.current;
    setDraftImagesBySession((prev) => {
      const current = prev[sessionId] ?? EMPTY_DRAFT_IMAGES;
      const next = typeof value === "function" ? (value as (p: DraftImage[]) => DraftImage[])(current) : value;
      if (next === current) return prev;
      return { ...prev, [sessionId]: next };
    });
  }, []);
  const setDraftImageError = useCallback((value: string | null) => {
    const sessionId = activeSessionIdRef.current;
    setDraftImageErrorBySession((prev) => {
      if ((prev[sessionId] ?? null) === value) return prev;
      return { ...prev, [sessionId]: value };
    });
  }, []);
  const setImagesProcessing = useCallback((value: boolean) => {
    const sessionId = activeSessionIdRef.current;
    setImagesProcessingBySession((prev) => {
      if ((prev[sessionId] ?? false) === value) return prev;
      return { ...prev, [sessionId]: value };
    });
  }, []);

  // draftImagesRef 跟随当前会话的图片，供 sendMessage/清理等从 ref 读最新值。
  useEffect(() => {
    draftImagesRef.current = draftImages;
  }, [draftImages]);

  // 所有会话的图片桶（供卸载时统一 revoke object URL，避免非当前会话的图片泄漏）。
  useEffect(() => {
    draftImagesBySessionRef.current = draftImagesBySession;
  }, [draftImagesBySession]);

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

  // ─── 客户端启动（0710 统一状态层）───
  // ConversationClient 内部：连接 + 订阅全局频道 + 拉会话列表 + 注册运行态/配置监听。
  // 桌面端在此之上叠加：从各会话 session.json 恢复 config/context 到本地选择器；
  // 通过 onRawEvent 处理 reducer 不覆盖的桌面副作用（caps/config-from-events）；
  // 配置的跨端同步（config.batch）落到 configBySession 让选择器跟随。
  useEffect(() => {
    let cancelled = false;

    // 桌面副作用观察者：capabilities / config-from-events。
    const offRaw = client.onRawEvent((event, channel) => {
      const type = (event as { type?: string }).type;
      if (type === "agent.command.available.updated") {
        setCapabilitiesBySession((prev) => {
          const nextCaps = mergeRuntimeCommands(prev[channel], (event as { commands: SlashCommand[] }).commands);
          return nextCaps ? { ...prev, [channel]: nextCaps } : prev;
        });
      } else if (type === "agent.config.updated") {
        const configOptions = (event as { configOptions: unknown[] }).configOptions;
        setCapabilitiesBySession((prev) => {
          const merged = mergeRuntimeConfigOptions(prev[channel], configOptions, configBySessionRef.current[channel]);
          return merged ? { ...prev, [channel]: merged } : prev;
        });
      } else if (type === "agent.mode.updated") {
        const modeId = (event as { modeId?: string }).modeId;
        if (modeId) {
          setConfigBySession((prev) => {
            const current = prev[channel];
            const next: SessionConfig = {
              accessMode: modeId,
              modelFamily: current?.modelFamily ?? "",
              reasoningEffort: current?.reasoningEffort ?? "medium",
              selectedConfig: current?.selectedConfig ?? {},
            };
            const result = { ...prev, [channel]: next };
            configBySessionRef.current = result;
            return result;
          });
        }
      }
    });

    // 配置跨端同步：另一端改模型/思考/权限 → 本端选择器跟随。
    const offConfig = client.getSync().onConfigChange((payload) => {
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

    async function boot() {
      try {
        await client.start();
        if (cancelled) return;
        const remoteSessions = client.getSnapshot().sessions;
        // 从各会话 session.json 恢复 config（选择器初值）。
        const restoredConfigs: Record<string, SessionConfig> = {};
        for (const session of remoteSessions) {
          const sessionObj = session as unknown as Record<string, unknown>;
          const savedConfig = sessionObj.config;
          if (savedConfig && typeof savedConfig === "object") {
            const cfg = savedConfig as Partial<SessionConfig>;
            const savedAgent = sessionObj.agent;
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
        }
        if (Object.keys(restoredConfigs).length > 0) {
          setConfigBySession(restoredConfigs);
          configBySessionRef.current = { ...configBySessionRef.current, ...restoredConfigs };
        }
        setArchivedSessionIds(new Set(remoteSessions.filter((s) => s.archived).map((s) => s.id)));
        // 有真实会话时默认选中首个未归档会话，并清掉本地 draft。
        const firstVisible = remoteSessions.find((s) => !s.archived);
        if (firstVisible) {
          setDraftSession(null);
          setActiveSessionId(firstVisible.id);
        }
      } catch (error) {
        console.error(error);
      }
    }

    void boot();

    return () => {
      cancelled = true;
      offRaw();
      offConfig();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 提示词优化开关：从功能设置加载，进入设置页返回后刷新一次 ───
  useEffect(() => {
    let cancelled = false;
    void loadPromptOptimizeSettings()
      .then((settings) => {
        if (!cancelled) {
          setCodePromptOptimizeEnabled(settings.codeEnabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeView]);

  // ─── 会话频道订阅（0710 统一状态层）───
  // 切换到真实会话时通过 client 订阅其频道：后端先回 snapshot（client 建视图态），再推增量事件。
  // 切到别的会话或离开时退订。
  useEffect(() => {
    if (!activeSessionId || isDraftSessionId(activeSessionId) || activeView !== "chat") {
      return;
    }
    const myChannel = activeSessionId;
    const prev = subscribedChannelRef.current;
    if (prev && prev !== myChannel) {
      client.closeConversation(prev);
    }
    subscribedChannelRef.current = myChannel;
    void client.openConversation(myChannel);
    return () => {
      if (subscribedChannelRef.current === myChannel) {
        subscribedChannelRef.current = null;
      }
      client.closeConversation(myChannel);
    };
  }, [activeSessionId, activeView, client]);

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
      for (const timer of Object.values(configSaveTimerRef.current)) {
        window.clearTimeout(timer);
      }
      for (const images of Object.values(draftImagesBySessionRef.current)) {
        for (const image of images) {
          revokeDraftImage(image);
        }
      }
    };
  }, []);

  /** 用 client 的会话列表更新一个会话字段（供 resolveApproval/resolveInput/archive 用）。 */
  function patchClientSession(sessionId: string, patch: Partial<Session>): void {
    client.patchSession(sessionId, patch);
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

  // 清空指定会话的草稿（文本+图片+错误）。用于发送后清理来源会话——
  // draft→real 迁移时活动会话已切到真实 id，不能只清当前会话，否则来源
  // draft 桶残留、图片 object URL 泄漏。
  function clearDraftForSession(sessionId: string) {
    setDraftBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setDraftImagesBySession((prev) => {
      const images = prev[sessionId];
      if (!images) return prev;
      for (const image of images) {
        revokeDraftImage(image);
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setDraftImageErrorBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
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
    // 清掉本地 draft（后端 broadcast 会把真实会话插入 client 列表）。
    setDraftSession(null);
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
        if (!current.has(DRAFT_SESSION_ID)) return current;
        const next = new Set(current);
        next.delete(DRAFT_SESSION_ID);
        return next;
      });
      // 清掉本地 draft；后端 broadcast 会把真实会话插入 client 列表。
      setDraftSession(null);
      setActiveSessionId(session.id);
      setActiveView("chat");
      clearDraftForSession(DRAFT_SESSION_ID);
    } catch (error) {
      console.error("Failed to create conversation:", error);
      // fallback: 创建本地 draft session
      const newDraft = createDraftSession();
      setDraftSession(newDraft);
      setActiveSessionId(newDraft.id);
      setActiveView("chat");
    }
  }

  function selectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setActiveView("chat");
    if (isDraftSessionId(sessionId)) {
      return;
    }
    // 切换会话：client 内部会订阅频道并拿到 snapshot，视图态随之更新。
    // 此处仅处理桌面特有副作用：从 session.config 恢复 configBySession 选择器。
    const conversationSession = client.getSnapshot().sessions.find((s) => s.id === sessionId);
    if (!conversationSession) return;
    const sessionObj = conversationSession as unknown as Record<string, unknown>;
    const savedConfig = sessionObj.config;
    const conversationAgent = sessionObj.agent;
    const isCodex = isRecord(conversationAgent) && String(conversationAgent.runtimeId ?? conversationAgent.id ?? "") === "codex";
    if (savedConfig && typeof savedConfig === "object") {
      const cfg = savedConfig as Partial<SessionConfig>;
      const rawModelFamily = String(cfg.modelFamily ?? "");
      const rawReasoningEffort = String(cfg.reasoningEffort ?? "");
      const rawSelectedConfig = configValueRecord(cfg.selectedConfig);
      const modelSelection = isCodex
        ? normalizeCodexModelSelection(rawModelFamily, rawReasoningEffort)
        : { family: rawModelFamily, effort: rawReasoningEffort };
      const selectedConfig = isCodex && modelSelection.effort
        ? { ...rawSelectedConfig, reasoning_effort: modelSelection.effort }
        : rawSelectedConfig;
      setConfigBySession((prev) => {
        if (prev[sessionId]) return prev; // 已有本地配置，不覆盖
        return {
          ...prev,
          [sessionId]: {
            modelFamily: modelSelection.family,
            accessMode: String(cfg.accessMode ?? ""),
            reasoningEffort: modelSelection.effort || "medium",
            selectedConfig,
          },
        };
      });
    }
  }

  function archiveSession(sessionId: string) {
    setArchivedSessionIds((current) => {
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
    patchClientSession(sessionId, { archived: true });
    if (!isDraftSessionId(sessionId)) {
      void updateConversationArchiveState(sessionId, true)
        .then((session) => patchClientSession(sessionId, session))
        .catch((error) => console.error(error));
    }
    if (sessionId !== activeSessionId) return;
    const nextSession = sessions.find((session) => session.id !== sessionId && !archivedSessionIds.has(session.id));
    if (nextSession) {
      selectSession(nextSession.id);
      return;
    }
    createSession();
  }

  function archiveSessionGroup(sessionIds: string[]) {
    if (sessionIds.length === 0) return;
    const ids = new Set(sessionIds);
    setArchivedSessionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      patchClientSession(id, { archived: true });
      if (!isDraftSessionId(id)) {
        void updateConversationArchiveState(id, true)
          .then((session) => patchClientSession(id, session))
          .catch((error) => console.error(error));
      }
    }
    if (!ids.has(activeSessionId)) return;
    const nextSession = sessions.find(
      (session) => !ids.has(session.id) && !archivedSessionIds.has(session.id),
    );
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
    patchClientSession(sessionId, { archived: false });
    if (!isDraftSessionId(sessionId)) {
      void updateConversationArchiveState(sessionId, false)
        .then((session) => patchClientSession(sessionId, session))
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
    // 后端 broadcast 会从 client 列表移除该会话。
  }

  // ─── draft→real 迁移观察（由 ConversationClient 事件触发）───
  // 发起方场景：本窗口在 draft session 发送 turn，后端在 turn.start 结果里返回真实 conversationId，
  // 随后 conversation.turn.started 事件的 conversationId 为真实 id。此时需要：
  // - 把 draft 的 caps/config 迁移到真实 id
  // - 切换到真实会话
  useEffect(() => {
    const off = client.onRawEvent((event, channel) => {
      if (event.type !== "conversation.turn.started") return;
      const draftId = activeSessionIdRef.current;
      if (!draftId || !isDraftSessionId(draftId)) return;
      const realId = event.conversationId;
      if (realId === draftId) return;
      const draftCaps = capabilitiesBySession[draftId];
      if (draftCaps) {
        setCapabilitiesBySession((prev) => ({ ...prev, [realId]: prev[realId] ?? draftCaps }));
      }
      const draftCfg = configBySessionRef.current[draftId];
      if (draftCfg) {
        setConfigBySession((prev) => {
          const next = { ...prev, [realId]: prev[realId] ?? draftCfg };
          configBySessionRef.current = next;
          return next;
        });
      }
      setActiveSessionId(realId);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const turnId = createId("turn");

    // 图片场景：先确保有真实会话（draft 不可上传附件）。
    let conversationId: string | undefined;
    if (images.length > 0) {
      conversationId = await ensureRealConversationForSend(sessionId, text);
    } else if (!isDraftSessionId(sessionId)) {
      conversationId = sessionId;
    }

    // 从 ref 读取最新的 config（避免闭包捕获旧值）
    const cfg = mergeConfigDefaults(configBySessionRef.current[sessionId] ?? currentConfig ?? undefined, currentCapabilities);
    const models = currentCapabilities.models;

    // 解析模型 ID：Codex 用 bracket 格式，其他直接用 id。
    const isCodex = isCodexAgent(sessionAgent);
    let fullModelId: string | undefined;
    let modelLabel: string | undefined;
    if (isCodex && cfg?.modelFamily && cfg.reasoningEffort) {
      fullModelId = buildCodexRuntimeModelId(cfg.modelFamily, cfg.reasoningEffort);
      modelLabel = fullModelId;
    } else if (cfg?.modelFamily) {
      const exact = models.find((m) => m.id === cfg.modelFamily);
      fullModelId = exact?.id ?? cfg.modelFamily;
      modelLabel = exact?.label;
    }

    // 图片附件上传（HTTP，保留原路径）。
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

    // 立即清输入（乐观 UI 反馈）。清来源会话本身：draft→real 迁移后活动会话
    // 已切到真实 id，按 sessionId 清才能连带 revoke 来源 draft 桶的图片。
    clearDraftForSession(sessionId);

    try {
      await client.sendTurn({
        conversationId: conversationId ?? "",
        input: text,
        turnId,
        accessMode: cfg?.accessMode || undefined,
        modelId: fullModelId,
        modelLabel: modelLabel || undefined,
        reasoningEffort: cfg?.reasoningEffort,
        selectedConfig: cfg?.selectedConfig,
        contentBlocks: contentBlocks as unknown[],
      });
    } catch (error) {
      // 发起失败时恢复输入到来源会话（可能已迁移为真实 id）。
      const restoreId = conversationId ?? sessionId;
      setDraftBySession((prev) => ({ ...prev, [restoreId]: text }));
      setDraftImagesBySession((prev) => ({ ...prev, [restoreId]: images }));
      setDraftImageErrorBySession((prev) => ({
        ...prev,
        [restoreId]: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function stopCurrentTurn() {
    if (!activeTurnId || !isActiveSessionRunning) {
      return;
    }
    const sessionId = activeSession.id;
    await client.cancelTurn(sessionId).catch(() => undefined);
  }

  async function resolveApproval(decision: "allow" | "deny") {
    if (!activePendingApproval) return;
    const approval = activePendingApproval;
    const approvalId = approval.approvalId;
    patchClientSession(approval.conversationId, { status: "running", updatedAt: Date.now() });
    try {
      await client.resolveApproval(approvalId, decision);
    } catch (error) {
      patchClientSession(approval.conversationId, { status: "error", updatedAt: Date.now() });
      console.error(error);
    }
  }

  async function resolveInput(action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) {
    if (!activePendingInput) return;
    const input = activePendingInput;
    patchClientSession(input.conversationId, { status: "running", updatedAt: Date.now() });
    try {
      await client.resolveInput(input.inputRequestId, action, content);
    } catch (error) {
      patchClientSession(input.conversationId, { status: "error", updatedAt: Date.now() });
      console.error(error);
    }
  }

  // 一键优化提示词 / 撤销：草稿仍等于上次优化结果时点击（或 Ctrl+Z）回退到优化前文本；
  // 否则调后端优化，成功后写回草稿并记录撤销快照。
  async function optimizePrompt() {
    const sessionId = activeSessionIdRef.current;
    const undo = optimizeUndoBySession[sessionId] ?? null;
    const currentDraft = draftBySession[sessionId] ?? "";

    if (undo && currentDraft === undo.after) {
      setDraft(undo.before);
      setOptimizeUndoBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      return;
    }

    const text = currentDraft.trim();
    if (!text || optimizingPromptBySession[sessionId]) {
      return;
    }
    setOptimizingPromptBySession((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const optimized = await optimizeCodePrompt({
        prompt: currentDraft,
        workspace: activeSession.workspace,
      });
      // 优化过程中用户可能已切换会话或改动草稿；写回目标会话并记录撤销快照。
      setDraftBySession((prev) => ({ ...prev, [sessionId]: optimized }));
      setOptimizeUndoBySession((prev) => ({ ...prev, [sessionId]: { before: currentDraft, after: optimized } }));
    } catch (error) {
      setDraftImageErrorBySession((prev) => ({
        ...prev,
        [sessionId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setOptimizingPromptBySession((prev) => ({ ...prev, [sessionId]: false }));
    }
  }

  async function createImageRecord() {
    try {
      const record = await getImageGenClient().createRecord();
      setActiveImageRecordId(record.id);
      setActiveView("image-gen-detail");
    } catch (error) {
      console.error("Failed to create image record:", error);
    }
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
          initialSection={settingsInitialSection}
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
            onArchiveGroup={archiveSessionGroup}
            onCreateSession={createSession}
            onOpenOverview={() => setActiveView("overview")}
            onOpenImageGen={() => {
              setActiveImageRecordId(null);
              setActiveView("image-gen-list");
            }}
            onOpenSettings={() => {
              setSettingsInitialSection(undefined);
              setActiveView("settings");
            }}
            onSearchTextChange={setSearchText}
            onSelectSession={selectSession}
            searchText={searchText}
            sessions={filteredSessions}
          />

          {activeView === "overview" ? (
            <OverviewPage />
          ) : activeView === "image-gen-list" ? (
            <ImageGenListPage
              onCreateRecord={() => void createImageRecord()}
              onOpenRecord={(recordId) => {
                setActiveImageRecordId(recordId);
                setActiveView("image-gen-detail");
              }}
              onOpenSettings={() => {
                setSettingsInitialSection("imageProviders");
                setActiveView("settings");
              }}
            />
          ) : activeView === "image-gen-detail" && activeImageRecordId ? (
            <ImageGenDetailPage
              onBack={() => setActiveView("image-gen-list")}
              recordId={activeImageRecordId}
            />
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
              onOptimizePrompt={() => void optimizePrompt()}
              optimizePromptEnabled={codePromptOptimizeEnabled}
              optimizePromptCanUndo={canUndoOptimize}
              optimizingPrompt={optimizingPrompt}
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
