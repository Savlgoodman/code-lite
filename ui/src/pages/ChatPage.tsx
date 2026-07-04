import { useEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "../features/chat/ChatComposer";
import { ConversationHeader } from "../features/chat/ConversationHeader";
import { MessageList } from "../features/chat/MessageList";
import { AgentSelectionPanel } from "../features/chat/AgentSelectionPanel";
import {
  createEmptySession,
  createId,
  createInitialState,
  normalizeStoredState,
  type PendingMessageDelta,
  type StoredState,
  updateMessage
} from "../lib/chatState";
import { formatJson } from "../lib/formatters";
import { Sidebar } from "../layout/Sidebar";
import { OverviewPage } from "./OverviewPage";
import { SettingsPage } from "./SettingsPage";
import { cancelTurn, createConversation, initializeSession, sendApprovalDecision, streamAgentTurn } from "../services/agentClient";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  updateConversationArchiveState
} from "../services/conversationStore";
import { loadAgentRuntimeModels, loadAgentRuntimeSettings, loadModelSettings } from "../services/settingsStore";
import type {
  AgentEvent,
  AgentRuntimeModel,
  AgentSummary,
  ApprovalRequest,
  ChatMessage,
  ChatModelOption,
  ConfiguredModel,
  Session,
  SessionCapabilities,
  SessionConfigOption,
  SessionModel,
  ToolCallItem,
  UsageStats
} from "../types";
import "./ChatPage.css";

const DRAFT_SESSION_ID = "__draft_session__";
const STREAM_DELTA_FLUSH_MS = 60;
type ActiveView = "chat" | "overview" | "settings";
type PendingApprovalState = ApprovalRequest & { conversationId: string };

function createDraftSession(): Session {
  return {
    ...createEmptySession(),
    id: DRAFT_SESSION_ID
  };
}

function isDraftSessionId(sessionId: string) {
  return sessionId === DRAFT_SESSION_ID;
}

function upsertToolCall(
  toolCalls: ToolCallItem[],
  item: Partial<ToolCallItem> & Pick<ToolCallItem, "id" | "name">,
) {
  const now = Date.now();
  const index = toolCalls.findIndex((tool) => tool.id === item.id);
  if (index < 0) {
    return [
      ...toolCalls,
      {
        argumentsText: "{}",
        createdAt: now,
        status: "running",
        updatedAt: now,
        ...item
      } as ToolCallItem
    ];
  }

  return toolCalls.map((tool, currentIndex) =>
    currentIndex === index
      ? {
          ...tool,
          ...item,
          anchorOffset: item.anchorOffset ?? tool.anchorOffset,
          updatedAt: now
        }
      : tool
  );
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

function configuredModelOptions(models: ConfiguredModel[]): ChatModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    model: model.model,
    providerId: model.providerId,
    providerName: model.providerName,
    reasoningEffort: model.generation.reasoningEffort,
    source: "product-config"
  }));
}

function runtimeModelOptions(agent: AgentSummary, models: AgentRuntimeModel[]): ChatModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label || model.id,
    model: model.id,
    providerId: agent.runtimeId ?? agent.id,
    providerName: agent.label,
    reasoningEffort: model.id.match(/\[(.*?)\]$/)?.[1] ?? undefined,
    source: "agent-runtime"
  }));
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
  const [activeTurnIdBySession, setActiveTurnIdBySession] = useState<Record<string, string>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [activeAgent, setActiveAgent] = useState<AgentSummary | null>(null);
  const [accessMode, setAccessMode] = useState("read-only");
  const [reasoningEffort, setReasoningEffort] = useState("xhigh");
  const [sessionCapabilities, setSessionCapabilities] = useState<SessionCapabilities | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<Record<string, string | number | boolean>>({});
  const [selectedModelFamily, setSelectedModelFamily] = useState<string>("");
  const [contextUsageBySession, setContextUsageBySession] = useState<Record<string, UsageStats>>({});
  const [showAgentSelection, setShowAgentSelection] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingMessageDeltasRef = useRef<Record<string, PendingMessageDelta>>({});
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  const streamFlushTimerRef = useRef<number | null>(null);
  // per-session stream state
  const activeAssistantMessageIdBySessionRef = useRef<Record<string, string>>({});
  const activeStreamSessionIdByTurnRef = useRef<Record<string, string>>({});

  const activeSession = sessions.find((item) => item.id === activeSessionId) ?? sessions[0];
  const activeMessages = messages[activeSession.id] ?? [];
  const isActiveSessionRunning = runningSessionIds.has(activeSession.id);
  const activePendingApproval = pendingApproval?.conversationId === activeSession.id ? pendingApproval : null;
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

  useEffect(() => {
    let cancelled = false;

    async function loadCapabilities() {
      try {
        const probeId = activeSession.id && !isDraftSessionId(activeSession.id)
          ? activeSession.id
          : "__probe__";
        const caps = await initializeSession(probeId);
        if (cancelled) return;
        setSessionCapabilities(caps);

        // 初始化默认选中值
        const defaultMode = caps.modes.find((m) => m.isDefault);
        if (defaultMode) setAccessMode(defaultMode.id);

        // 从 configOptions 提取默认值
        const configDefaults: Record<string, string | number | boolean> = {};
        for (const opt of caps.configOptions) {
          if (opt.currentValue != null) {
            configDefaults[opt.id] = opt.currentValue;
          }
        }
        if (Object.keys(configDefaults).length > 0) setSelectedConfig(configDefaults);

        // 提取推理强度
        const reasoningOpt = caps.configOptions.find((o) => o.id === "reasoning_effort");
        if (reasoningOpt?.currentValue) setReasoningEffort(String(reasoningOpt.currentValue));

        // 提取模型族：从当前模型 ID 或第一个模型中提取
        const currentModel = caps.models.find((m) => m.isCurrent) ?? caps.models[0];
        if (currentModel) {
          const familyMatch = currentModel.id.match(/^(.*?)\[/);
          setSelectedModelFamily(familyMatch ? familyMatch[1] : currentModel.id);
        }
      } catch (error) {
        console.error("Failed to load session capabilities:", error);
        if (!cancelled) {
          try {
            const runtimeSettings = await loadAgentRuntimeSettings();
            if (cancelled) return;
            const runtime = runtimeSettings.runtimes.find((item) => item.adapter === runtimeSettings.activeAdapter);
            if (runtime) {
              setActiveAgent({
                configMode: runtime.configMode,
                id: runtime.adapter,
                label: runtime.label,
                mode: runtime.mode,
                runtimeId: runtime.id,
              });
              setAccessMode(runtime.mode || "read-only");

              const fallbackModes = runtime.id === "codex"
                ? [
                    { id: "read-only", label: "只读", isDefault: runtime.mode === "read-only" },
                    { id: "agent", label: "Agent", isDefault: runtime.mode === "agent" },
                    { id: "agent-full-access", label: "完全访问", isDefault: runtime.mode === "agent-full-access" },
                  ]
                : [{ id: runtime.mode || "workspace", label: runtime.mode || "工作区", isDefault: true }];

              const fallbackConfigOptions = runtime.id === "codex"
                ? [{
                    id: "reasoning_effort",
                    label: "思考强度",
                    type: "enum" as const,
                    values: ["none", "low", "medium", "high", "xhigh"],
                    currentValue: "xhigh",
                    valueLabels: { none: "无", low: "低", medium: "中", high: "高", xhigh: "超高" },
                  }]
                : [];

              // 加载模型并构建 models 列表
              let fallbackModels: SessionModel[] = [];
              const agentId = runtime.adapter;
              if (agentId === "codex") {
                try {
                  const runtimeModels = await loadAgentRuntimeModels(runtime.id ?? "codex");
                  fallbackModels = runtimeModels.models.map((m: AgentRuntimeModel) => ({
                    id: m.id, label: m.label, description: m.description,
                    isCurrent: m.id === runtimeModels.currentModelId,
                  }));
                } catch { /* ignore */ }
              }

              setSessionCapabilities({
                agent: {
                  id: runtime.adapter, label: runtime.label,
                  adapterKind: "acp" as const, status: runtime.status || "available",
                },
                modes: fallbackModes,
                models: fallbackModels,
                configOptions: fallbackConfigOptions,
              });

              // 设置模型族
              if (fallbackModels.length > 0) {
                const currentModel = fallbackModels.find((m) => m.isCurrent) ?? fallbackModels[0];
                const familyMatch = currentModel.id.match(/^(.*?)\[/);
                setSelectedModelFamily(familyMatch ? familyMatch[1] : currentModel.id);
              }
            }
          } catch (fallbackError) {
            console.error("Fallback model loading also failed:", fallbackError);
          }
        }
      }
    }

    void loadCapabilities();

    return () => { cancelled = true; };
  }, [activeView, activeSession.id, sessionAgent?.id, sessionAgent?.runtimeId]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
      }
    };
  }, []);

  function updateSession(sessionId: string, updater: (session: Session) => Session) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
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

  function createSession(nextView: ActiveView = "chat") {
    // 显示 Agent 选择面板，让用户选择要使用的 agent
    setShowAgentSelection(true);
  }

  async function confirmAgentSelection(agentId: string) {
    setShowAgentSelection(false);
    try {
      const result = await createConversation({ agentId });
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
      activeAssistantMessageIdBySessionRef.current[nextSessionId] = event.assistantMessage.id;
      activeStreamSessionIdByTurnRef.current[nextSessionId] = nextSessionId;
      if (nextSessionId !== sessionId) {
        setSessionRunning(sessionId, false);
      }
      setSessionRunning(nextSessionId, true);
      // 只有当前是 draft 或空时才自动切换 — 不强制打断用户正在看的会话
      setActiveSessionId((current) => {
        if (isDraftSessionId(current) || !current) {
          return nextSessionId;
        }
        return current;
      });
      setSessions((current) => {
        // 移除 draft 和同 id 的旧会话，用事件中的真实 session 替换
        const cleaned = current.filter(
          (session) => !isDraftSessionId(session.id) && session.id !== nextSessionId,
        );
        return [event.session, ...cleaned];
      });
      setMessages((current) => ({
        ...current,
        [nextSessionId]: [...(current[nextSessionId] ?? []), event.userMessage, event.assistantMessage],
      }));
      return;
    }

    // 用事件的 conversationId 做路由（draft session 发送后会变成真实 id）
    const targetSessionId = event.conversationId || sessionId;
    const assistantMessageId = activeAssistantMessageIdBySessionRef.current[targetSessionId]
      ?? activeAssistantMessageIdBySessionRef.current[sessionId];
    if (!assistantMessageId) {
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

    if (event.type === "agent.tool.started") {
      flushQueuedMessageDeltas();
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          toolCalls: upsertToolCall(message.toolCalls, {
            anchorOffset: message.content.length,
            argumentsText: formatJson(event.arguments),
            id: event.toolCallId || createId("tool"),
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
          toolCalls: upsertToolCall(message.toolCalls, {
            id: event.toolCallId || createId("tool"),
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

    if (event.type === "agent.run.completed") {
      flushQueuedMessageDeltas();
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
          streaming: false,
          usage: typeof event.usage === "object" && event.usage ? (event.usage as ChatMessage["usage"]) : message.usage
        }))
      );
      updateSession(targetSessionId, (session) => event.session ?? { ...session, status: "idle", updatedAt: Date.now() });
      return;
    }

    if (event.type === "agent.run.failed") {
      flushQueuedMessageDeltas();
      setSessionRunning(targetSessionId, false);
      setMessages((current) =>
        updateMessage(current, targetSessionId, assistantMessageId, (message) => ({
          ...message,
          error: event.error ?? "Agent 运行失败",
          streaming: false
        }))
      );
      updateSession(targetSessionId, (session) => event.session ?? { ...session, status: "error", updatedAt: Date.now() });
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || activeTurnId) {
      return;
    }

    const sessionId = activeSession.id;
    const conversationId = isDraftSessionId(sessionId) ? undefined : sessionId;
    const turnId = createId("turn");
    setDraft("");
    setActiveTurnIdBySession((prev) => ({ ...prev, [sessionId]: turnId }));
    setSessionRunning(sessionId, true);
    delete activeAssistantMessageIdBySessionRef.current[sessionId];
    delete activeStreamSessionIdByTurnRef.current[sessionId];
    setPendingApproval(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // 拼接完整模型 ID：模型族[推理强度]
      const fullModelId = selectedModelFamily && reasoningEffort
        ? `${selectedModelFamily}[${reasoningEffort}]`
        : selectedModelFamily || undefined;
      await streamAgentTurn({
        accessMode,
        conversationId,
        input: text,
        modelId: fullModelId,
        onEvent: (event) => handleAgentEvent(sessionId, event),
        signal: abortController.signal,
        reasoningEffort,
        selectedConfig,
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
        handleAgentEvent(sessionId, {
          conversationId: sessionId,
          error: error instanceof Error ? error.message : String(error),
          turnId,
          type: "agent.run.failed"
        });
      }
    } finally {
      setActiveTurnIdBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      delete activeAssistantMessageIdBySessionRef.current[sessionId];
      delete activeStreamSessionIdByTurnRef.current[sessionId];
      abortControllerRef.current = null;
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
    await cancelTurn(turnId).catch(() => undefined);
    setActiveTurnIdBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPendingApproval(null);
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

  return (
    <>
      {showAgentSelection ? (
        <AgentSelectionPanel
          availableAgents={[
            { id: "codex", label: "Codex", glyph: "Cx", status: "available", description: "OpenAI Codex，通过 ACP 协议接入。支持代码生成、工具调用和文件操作。" },
            { id: "claude_code", label: "Claude Code", glyph: "Cl", status: "available", description: "Anthropic Claude Code，通过 ACP 协议接入。支持 Haiku/Sonnet/Opus 等模型等级，代码生成和分析。" },
            { id: "opencode", label: "opencode", glyph: "Op", status: "planned", description: "opencode agent，通过 ACP 协议接入。当前为计划接入状态。" },
            { id: "nanobot", label: "Nanobot", glyph: "Nb", status: "available", description: "Legacy agent，使用产品级模型配置。适合非代码任务。" },
          ]}
          onCancel={() => setShowAgentSelection(false)}
          onSelect={(agentId) => void confirmAgentSelection(agentId)}
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
            onCreateSession={() => createSession()}
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
            <main className="main-panel">
              <ConversationHeader agent={sessionAgent} isRunning={isActiveSessionRunning} title={activeSession.title} />
              <MessageList
                isRunning={isActiveSessionRunning}
                messages={activeMessages}
                sessionId={activeSession.id}
                updatedAt={activeSession.updatedAt}
              />
              <ChatComposer
                activeTurnId={isActiveSessionRunning ? activeTurnId : null}
                configOptions={sessionCapabilities?.configOptions ?? []}
                contextUsage={contextUsage}
                draft={draft}
                accessMode={accessMode}
                agent={sessionAgent}
                modes={sessionCapabilities?.modes ?? []}
                models={sessionCapabilities?.models ?? []}
                onAccessModeChange={setAccessMode}
                onConfigChange={(optionId, value) => setSelectedConfig((prev) => ({ ...prev, [optionId]: value }))}
                onDraftChange={setDraft}
                onModelFamilyChange={setSelectedModelFamily}
                onReasoningEffortChange={setReasoningEffort}
                onResolveApproval={(decision) => void resolveApproval(decision)}
                onSendMessage={() => void sendMessage()}
                onStopTurn={() => void stopCurrentTurn()}
                pendingApproval={activePendingApproval}
                reasoningEffort={reasoningEffort}
                selectedConfig={selectedConfig}
                selectedModelFamily={selectedModelFamily}
              />
            </main>
          )}
        </>
      )}
    </>
  );
}
