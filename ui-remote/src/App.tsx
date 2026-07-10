import { useState, useEffect, useRef } from "react";
import { Folder, MessageSquare, Settings, Send, ArrowLeft, Square, Plus } from "lucide-react";
import type { ChatMessage, Session, SessionCapabilities, SessionConfigOption, SessionMode, UsageStats } from "@code-lite/protocol";
import {
  groupModelsByFamily,
  buildModelId,
  ConversationClient,
  type ModelGrouping,
} from "@code-lite/chat-core";
import { RelayTransport } from "./services/RelayTransport";
import { SyncManager, type ConfigBatchPayload } from "@code-lite/sync";
import { useConversationState } from "./useConversations";

type Page = "projects" | "chat" | "settings";

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";

/** 会话运行配置：模型族 + 思考强度 + 权限模式 */
interface SessionConfig {
  familyId: string; // 当前选中的模型族（isGrouped=false 时即模型 id）
  effort: string; // 当前选中的思考强度
  grouping: ModelGrouping; // 分组结构（families 列表 + 当前值）
  accessMode: string; // 权限模式（read-only / agent / agent-full-access）
  modes: SessionMode[]; // 可用权限模式列表
  configOptions: SessionConfigOption[]; // 来自 capabilities，供思考强度选择器用
}

/** 从 capabilities 构建默认运行配置 */
function buildConfigFromCaps(caps: SessionCapabilities): SessionConfig {
  const grouping = groupModelsByFamily(caps.models);
  const defaultMode = caps.modes.find((m) => m.isDefault) ?? caps.modes[0];
  // 思考强度初始值：分组模式（codex）取 grouping.currentEffort；
  // 非分组模式（claude）取 configOptions 里 reasoning_effort 的 currentValue。
  let effort = grouping.currentEffort;
  if (!grouping.isGrouped || !effort) {
    const reasoningOpt = caps.configOptions.find((o) => o.id === "reasoning_effort");
    if (reasoningOpt?.currentValue != null) effort = String(reasoningOpt.currentValue);
  }
  return {
    familyId: grouping.currentFamilyId,
    effort: effort || "medium",
    grouping,
    accessMode: defaultMode?.id ?? "",
    modes: caps.modes,
    configOptions: caps.configOptions ?? [],
  };
}

async function computeRoomId(pairKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pairKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function App() {
  const [page, setPage] = useState<Page>("settings");
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem(LS_RELAY_URL) || "ws://localhost:18766/ws");
  const [pairKey, setPairKey] = useState(localStorage.getItem(LS_PAIR_KEY) || "");
  const [connected, setConnected] = useState(false);
  const [hostOnline, setHostOnline] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 每个会话的运行配置（模型族+思考强度分组，由 session.initialize 的 capabilities 构建）。
  const [configBySession, setConfigBySession] = useState<Record<string, SessionConfig>>({});
  // 共享状态层：会话列表与视图态由 ConversationClient 统一管理（与桌面同源）。
  const [client, setClient] = useState<ConversationClient | null>(null);
  const { sessions, views } = useConversationState(client);

  const transportRef = useRef<RelayTransport | null>(null);
  const syncRef = useRef<SyncManager | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [views, activeSessionId]);

  const connect = async () => {
    if (!pairKey.trim()) return;
    localStorage.setItem(LS_RELAY_URL, relayUrl);
    localStorage.setItem(LS_PAIR_KEY, pairKey);
    const roomId = await computeRoomId(pairKey.trim());
    const t = new RelayTransport({
      relayUrl,
      roomId,
      onHostStatusChange: (online) => setHostOnline(online),
    });
    t.onStatus((s) => setConnected(s !== "idle" && s !== "closed"));
    transportRef.current = t;

    // 创建 SyncManager（role=remote）+ ConversationClient（共享状态层）。
    const sync = new SyncManager({ transport: t, role: "remote" });
    syncRef.current = sync;
    const conv = new ConversationClient({ transport: t, sync });
    // 配置变更同步：另一端切换模型/思考/权限 → 本端选择器跟随。
    sync.onConfigChange((payload) => {
      const p = payload as ConfigBatchPayload;
      const channel = p.conversationId;
      const changes = p.changes as { modelFamily?: string; reasoningEffort?: string; accessMode?: string } | undefined;
      if (!channel || !changes) return;
      setConfigBySession((prev) => {
        const cfg = prev[channel];
        if (!cfg) return prev;
        const newFamily = changes.modelFamily ?? cfg.familyId;
        const newEffort = changes.reasoningEffort ?? cfg.effort;
        const newAccessMode = changes.accessMode ?? cfg.accessMode;
        const fam = cfg.grouping.families.find((f) => f.familyId === newFamily);
        const validEffort = fam && fam.efforts.length > 0
          ? (fam.efforts.includes(newEffort) ? newEffort : fam.efforts[0])
          : newEffort;
        return { ...prev, [channel]: { ...cfg, familyId: newFamily, effort: validEffort, accessMode: newAccessMode } };
      });
    });
    setClient(conv);
    try {
      // ConversationClient.start 内部：connect + 订阅全局频道 + 拉会话列表 + 注册运行态/配置监听。
      await conv.start();
      setPage("projects");
      setHostOnline(true);
    } catch (e) {
      console.error("connect failed", e);
      setHostOnline(false);
    }
  };

  const openSession = async (session: Session) => {
    const transport = transportRef.current;
    if (!client || !transport) return;
    setActiveSessionId(session.id);
    setPage("chat");
    // 订阅该会话频道：后端先回 snapshot（client 建初始视图态），再推增量事件。
    await client.openConversation(session.id);
    // 初始化 ACP session 拿 capabilities（模型列表、configOptions、上下文窗口）。
    // 这是远端特有：用 capabilities 构建模型族/思考强度分组选择器。
    try {
      const caps = await transport.request<SessionCapabilities>("session.initialize", { conversationId: session.id });
      setConfigBySession((prev) => {
        if (prev[session.id]) return prev; // 已有配置则不覆盖
        return { ...prev, [session.id]: buildConfigFromCaps(caps) };
      });
    } catch (e) {
      console.warn("session.initialize failed (capabilities unavailable)", e);
    }
  };

  const closeSession = () => {
    const id = activeSessionIdRef.current;
    if (client && id) client.closeConversation(id);
    setActiveSessionId(null);
    setPage("projects");
  };

  const sendMessage = async () => {
    const id = activeSessionIdRef.current;
    const text = draft.trim();
    if (!client || !id || !text) return;
    setDraft("");
    const cfg = configBySession[id];
    // 组回完整 modelId：分组模式 "family[effort]"，否则直接用 familyId（即模型 id）。
    const modelId = cfg
      ? cfg.grouping.isGrouped
        ? buildModelId(cfg.familyId, cfg.effort)
        : cfg.familyId
      : "";
    const modelLabel = cfg?.grouping.families.find((f) => f.familyId === cfg.familyId)?.label;
    try {
      await client.sendTurn({
        conversationId: id,
        input: text,
        accessMode: cfg?.accessMode || undefined,
        modelId: modelId || undefined,
        modelLabel: modelLabel || undefined,
        reasoningEffort: cfg?.effort || undefined,
      });
    } catch (e) {
      console.error("turn.start failed", e);
    }
  };

  // 终止当前会话（双端均可终止）。走 client.cancelTurn → SyncManager.cancelSession。
  const stopMessage = async () => {
    const id = activeSessionIdRef.current;
    if (!client || !id) return;
    try {
      await client.cancelTurn(id);
    } catch (e) {
      console.error("cancelSession failed", e);
    }
  };

  // 远端新建会话：client.createConversation 走 conversation.create WS RPC，
  // 后端广播 conversation.created 到全局频道，client 列表自动插入。创建后直接打开。
  const createNewConversation = async () => {
    if (!client) return;
    try {
      const session = await client.createConversation();
      if (session) void openSession(session);
    } catch (e) {
      console.error("conversation.create failed", e);
    }
  };

  const activeView = activeSessionId ? views[activeSessionId] : null;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? activeView?.session ?? null;
  const activeRunning = activeView?.running ?? false;
  const activeConfig = activeSessionId ? configBySession[activeSessionId] : undefined;

  // 同步 config 到后端（广播给另一端），使用与桌面版一致的字段名。
  const syncConfigToBackend = (sessionId: string, familyId: string, effort: string, accessMode?: string) => {
    const transport = transportRef.current;
    if (!transport || !sessionId) return;
    const config: Record<string, string> = { modelFamily: familyId, reasoningEffort: effort };
    if (accessMode) config.accessMode = accessMode;
    transport.request("conversation.config.update", {
      conversationId: sessionId,
      config,
    }).catch((e) => console.warn("config sync failed", e));
  };

  // 切换模型族：effort 重置为该族支持的首个（或保留当前若仍受支持）。
  const changeFamily = (familyId: string) => {
    if (!activeSessionId) return;
    setConfigBySession((prev) => {
      const cfg = prev[activeSessionId];
      if (!cfg) return prev;
      const fam = cfg.grouping.families.find((f) => f.familyId === familyId);
      const nextEffort = fam && fam.efforts.length > 0
        ? (fam.efforts.includes(cfg.effort) ? cfg.effort : fam.efforts[0])
        : "";
      syncConfigToBackend(activeSessionId, familyId, nextEffort, prev[activeSessionId]?.accessMode);
      return { ...prev, [activeSessionId]: { ...cfg, familyId, effort: nextEffort } };
    });
  };

  const changeEffort = (effort: string) => {
    if (!activeSessionId) return;
    setConfigBySession((prev) => {
      const cfg = prev[activeSessionId];
      if (!cfg) return prev;
      syncConfigToBackend(activeSessionId, cfg.familyId, effort, cfg.accessMode);
      return { ...prev, [activeSessionId]: { ...cfg, effort } };
    });
  };

  const changeAccessMode = (mode: string) => {
    if (!activeSessionId) return;
    setConfigBySession((prev) => {
      const cfg = prev[activeSessionId];
      if (!cfg) return prev;
      syncConfigToBackend(activeSessionId, cfg.familyId, cfg.effort, mode);
      return { ...prev, [activeSessionId]: { ...cfg, accessMode: mode } };
    });
  };

  // ── 配对页 ──
  if (!connected && page === "settings") {
    return (
      <div className="app-shell">
        <div className="page pairing-page">
          <h2>连接 code-lite</h2>
          <input
            type="text"
            placeholder="Relay 地址"
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
          />
          <input
            type="text"
            placeholder="Pair Key"
            value={pairKey}
            onChange={(e) => setPairKey(e.target.value)}
          />
          <button onClick={connect} disabled={!pairKey.trim()}>连接</button>
          <p className="status">未连接</p>
        </div>
      </div>
    );
  }

  // ── 会话页 ──
  if (page === "chat" && activeSession && activeView) {
    return (
      <div className="app-shell chat-page">
        <div className="chat-header">
          <button className="back-btn" onClick={closeSession}>
            <ArrowLeft size={20} />
          </button>
          <div className="title">{activeSession.title || "未命名会话"}</div>
        </div>
        <div className="chat-messages">
          {activeView.messages.map((msg) => (
            <MessageView key={msg.id} message={msg} />
          ))}
          {activeView.pendingApproval && (
            <div className="approval-card">
              <div className="approval-title">需要审批：{activeView.pendingApproval.name}</div>
              <div className="approval-purpose">{activeView.pendingApproval.purpose}</div>
              <div className="approval-actions">
                <button
                  onClick={() =>
                    transportRef.current?.request("approval.decision", {
                      approvalId: activeView.pendingApproval!.approvalId,
                      decision: "allow",
                    })
                  }
                >
                  允许
                </button>
                <button
                  onClick={() =>
                    transportRef.current?.request("approval.decision", {
                      approvalId: activeView.pendingApproval!.approvalId,
                      decision: "deny",
                    })
                  }
                >
                  拒绝
                </button>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="chat-bottom-bar">
          {activeConfig && (() => {
            const hasReasoningOpt = activeConfig.configOptions.some((o) => o.id === "reasoning_effort" && (o.values?.length ?? 0) > 0);
            return activeConfig.grouping.families.length > 0 || activeConfig.modes.length > 1 || hasReasoningOpt;
          })() && (
            <div className="chat-config-bar">
              {activeConfig.modes.length > 1 && (
                <div className="config-item">
                  <label>模式</label>
                  <select value={activeConfig.accessMode} onChange={(e) => changeAccessMode(e.target.value)}>
                    {activeConfig.modes.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {activeConfig.grouping.families.length > 0 && (
                <div className="config-item">
                  <label>模型</label>
                  <select value={activeConfig.familyId} onChange={(e) => changeFamily(e.target.value)}>
                    {activeConfig.grouping.families.map((f) => (
                      <option key={f.familyId} value={f.familyId}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {(() => {
                // 思考强度选择器：分组模式（codex）用 family.efforts；
                // 非分组模式（claude）用 configOptions 里 reasoning_effort 的 values。
                const familyGrouping = activeConfig.grouping.families.find((f) => f.familyId === activeConfig.familyId);
                const familyEfforts = familyGrouping?.efforts ?? [];
                const reasoningOpt = activeConfig.configOptions.find((o) => o.id === "reasoning_effort");
                const configEfforts = reasoningOpt?.values ?? [];
                const efforts = activeConfig.grouping.isGrouped && familyEfforts.length > 0
                  ? familyEfforts
                  : configEfforts;
                if (efforts.length === 0) return null;
                return (
                  <div className="config-item">
                    <label>思考</label>
                    <select value={activeConfig.effort} onChange={(e) => changeEffort(e.target.value)}>
                      {efforts.map((v) => (
                        <option key={v} value={v}>{reasoningOpt?.valueLabels?.[v] ?? v}</option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              {activeView?.contextUsage && (activeView.contextUsage as { contextWindowTokens?: number }).contextWindowTokens ? (
                <div className="config-item context-usage">
                  <ContextMeter usage={activeView.contextUsage} />
                </div>
              ) : null}
            </div>
          )}
          <div className="chat-input-bar">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={activeRunning ? "运行中..." : "输入消息..."}
              disabled={activeRunning}
            />
            {activeRunning ? (
              <button className="stop-btn" onClick={stopMessage} title="终止当前会话">
                <Square size={18} />
              </button>
            ) : (
              <button onClick={sendMessage} disabled={!draft.trim()}>
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── 项目/会话列表页 ──
  const visibleSessions = sessions.filter((s) => !s.archived);
  const projectGroups = visibleSessions
    .filter((s) => s.workspaceKind === "project" && s.workspace)
    .reduce((acc, s) => {
      const key = s.workspace!;
      if (!acc[key]) acc[key] = { name: key.split(/[/\\]/).pop() || key, sessions: [] };
      acc[key].sessions.push(s);
      return acc;
    }, {} as Record<string, { name: string; sessions: Session[] }>);
  const generalSessions = visibleSessions.filter((s) => s.workspaceKind !== "project" || !s.workspace);

  const renderItem = (s: Session) => (
    <div key={s.id} className="project-item" onClick={() => openSession(s)}>
      <div className="icon">
        <MessageSquare size={18} />
      </div>
      <div className="info">
        <div className="name">{s.title || "未命名会话"}</div>
        <div className="meta">
          {s.agent?.label || "未知"} · {s.status === "running" ? "运行中" : "空闲"}
        </div>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <div className="page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 20 }}>项目</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: hostOnline ? "var(--green)" : "var(--orange)" }}>
              {hostOnline ? "● 宿主在线" : "○ 宿主离线"}
            </span>
            <button
              className="new-conversation-btn"
              onClick={createNewConversation}
              disabled={!hostOnline}
              title="新建会话"
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <Plus size={16} /> 新建
            </button>
          </div>
        </div>
        {Object.entries(projectGroups).map(([key, group]) => (
          <div key={key} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Folder size={14} /> {group.name}
            </div>
            <div className="project-list">{group.sessions.map(renderItem)}</div>
          </div>
        ))}
        {generalSessions.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>普通会话</div>
            <div className="project-list">{generalSessions.map(renderItem)}</div>
          </div>
        )}
        {visibleSessions.length === 0 && (
          <div className="empty-state">
            <div className="icon">📁</div>
            <p>暂无会话</p>
          </div>
        )}
      </div>
      <div className="tab-bar">
        <button className={page === "projects" ? "active" : ""} onClick={() => setPage("projects")}>项目</button>
        <button onClick={() => setPage("settings")}>
          <Settings size={18} style={{ verticalAlign: "middle" }} />
        </button>
      </div>
    </div>
  );
}

/** 简易上下文用量条：百分比 + 颜色。 */
function ContextMeter({ usage }: { usage: UsageStats | null }) {
  const used = (usage as any)?.contextUsedTokens ?? (usage as any)?.totalTokens ?? 0;
  const total = (usage as any)?.contextWindowTokens ?? 0;
  if (!total) return null;
  const ratio = Math.min(used / total, 1);
  const percent = Math.round(ratio * 100);
  const color = ratio > 0.8 ? "var(--red, #e53e3e)" : ratio > 0.5 ? "var(--orange, #dd6b20)" : "var(--blue, #3182ce)";
  return (
    <div className="context-meter" title={`${used.toLocaleString()} / ${total.toLocaleString()} tokens`}>
      <div className="context-meter-bar">
        <div className="context-meter-fill" style={{ width: `${percent}%`, background: color }} />
      </div>
      <span className="context-meter-label" style={{ color }}>{percent}%</span>
    </div>
  );
}

/** 单条消息渲染：文本 + 工具调用摘要 + 流式指示。 */
function MessageView({ message }: { message: ChatMessage }) {
  const hasContent = Boolean(message.content) || (message.toolCalls?.length ?? 0) > 0;
  return (
    <div className={`message ${message.role}`}>
      {message.reasoning && <div className="reasoning">{message.reasoning}</div>}
      {message.content || (message.streaming && !hasContent ? "思考中..." : "")}
      {message.toolCalls?.map((tool) => (
        <div key={tool.id} className={`tool-call ${tool.status}`}>
          <span className="tool-name">{tool.name}</span>
          <span className="tool-status">{tool.status}</span>
          {tool.error && <div className="tool-error">{tool.error}</div>}
        </div>
      ))}
      {message.error && <div className="message-error">{message.error}</div>}
      {message.streaming && <span className="thinking-dots">...</span>}
    </div>
  );
}
