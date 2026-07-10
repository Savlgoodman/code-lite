import { useState, useEffect, useRef, useCallback } from "react";
import { Folder, MessageSquare, Settings, Send, ArrowLeft, Square, Plus } from "lucide-react";
import type { AgentEvent, ChatMessage, Session, SessionCapabilities, SessionMode, UsageStats } from "@code-lite/protocol";
import {
  applyConversationListEvent,
  isConversationListEvent,
  reduceAgentEvent,
  sessionViewFromSnapshot,
  emptySessionView,
  groupModelsByFamily,
  buildModelId,
  type SessionViewState,
  type ModelGrouping,
} from "@code-lite/chat-core";
import { RelayTransport } from "./services/RelayTransport";
import { SyncManager } from "@code-lite/sync";
import type { ConfigBatchPayload } from "@code-lite/sync";

type Page = "projects" | "chat" | "settings";

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";
const GLOBAL_CHANNEL = "*";

/** 会话运行配置：模型族 + 思考强度（二级联动）+ 权限模式 */
interface SessionConfig {
  familyId: string; // 当前选中的模型族（isGrouped=false 时即模型 id）
  effort: string; // 当前选中的思考强度（isGrouped=false 时为空）
  grouping: ModelGrouping; // 分组结构（families 列表 + 当前值）
  accessMode: string; // 权限模式（read-only / agent / agent-full-access）
  modes: SessionMode[]; // 可用权限模式列表
}

/** 从 capabilities 构建默认运行配置 */
function buildConfigFromCaps(caps: SessionCapabilities): SessionConfig {
  const grouping = groupModelsByFamily(caps.models);
  const defaultMode = caps.modes.find((m) => m.isDefault) ?? caps.modes[0];
  return {
    familyId: grouping.currentFamilyId,
    effort: grouping.currentEffort,
    grouping,
    accessMode: defaultMode?.id ?? "",
    modes: caps.modes,
  };
}

async function computeRoomId(pairKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pairKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SnapshotPayload {
  snapshot: { session: Session | null; messages: ChatMessage[] } | null;
  latestSequence?: number;
}

export function App() {
  const [page, setPage] = useState<Page>("settings");
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem(LS_RELAY_URL) || "ws://localhost:18766/ws");
  const [pairKey, setPairKey] = useState(localStorage.getItem(LS_PAIR_KEY) || "");
  const [connected, setConnected] = useState(false);
  const [hostOnline, setHostOnline] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // 每个会话一份视图状态，由 snapshot + 事件 reduce 得到（复用 chat-core，与桌面同源）。
  const [views, setViews] = useState<Record<string, SessionViewState>>({});
  const [draft, setDraft] = useState("");
  // 每个会话的运行配置（模型族+思考强度分组，由 session.initialize 的 capabilities 构建）。
  const [configBySession, setConfigBySession] = useState<Record<string, SessionConfig>>({});

  const transportRef = useRef<RelayTransport | null>(null);
  const syncRef = useRef<SyncManager | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [views, activeSessionId]);

  // 事件入口：同步事件（运行态/配置）先喂 SyncManager；再按频道分列表/单会话 reducer。
  const handleEvent = useCallback((event: AgentEvent, meta: { channel: string }) => {
    // 同步事件优先处理：session.running/stopped 走全局频道，必须在频道分流前拦截，
    // 否则会在全局频道分支被丢弃，导致列表页运行态不刷新。
    if ((event as { type?: string }).type === "sync") {
      syncRef.current?.feedEvent(event);
      return;
    }
    if (meta.channel === GLOBAL_CHANNEL || isConversationListEvent(event)) {
      if (isConversationListEvent(event)) {
        setSessions((current) => applyConversationListEvent(current, event));
      }
      return;
    }
    const channel = (event as { conversationId?: string }).conversationId || meta.channel;
    if (!channel) return;
    setViews((current) => {
      const prev = current[channel] ?? emptySessionView(null);
      return { ...current, [channel]: reduceAgentEvent(prev, event) };
    });
  }, []);

  const handleSnapshot = useCallback((channel: string, payload: unknown) => {
    if (channel === GLOBAL_CHANNEL) return;
    const snap = payload as SnapshotPayload;
    if (!snap?.snapshot) return;
    const view = sessionViewFromSnapshot(snap.snapshot);
    setViews((current) => ({ ...current, [channel]: view }));
    if (view.session) {
      setSessions((current) => {
        const exists = current.some((s) => s.id === view.session!.id);
        return exists
          ? current.map((s) => (s.id === view.session!.id ? { ...s, ...view.session! } : s))
          : [view.session!, ...current];
      });
    }
  }, []);

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
    t.onEvent(handleEvent);
    t.onSnapshot(handleSnapshot);
    transportRef.current = t;

    // 创建 SyncManager（role=remote），统一处理运行态与配置同步。
    const sync = new SyncManager({ transport: t, role: "remote" });
    syncRef.current = sync;
    // 运行态变化 → 列表项 status 与会话视图 running 跟随。
    sync.onSessionRunning((p) => {
      setSessions((current) =>
        current.map((s) => (s.id === p.conversationId ? { ...s, status: "running" } : s)),
      );
      setViews((current) => {
        const view = current[p.conversationId];
        return view ? { ...current, [p.conversationId]: { ...view, running: true } } : current;
      });
    });
    sync.onSessionStopped((p) => {
      setSessions((current) =>
        current.map((s) => (s.id === p.conversationId ? { ...s, status: s.status === "running" ? "idle" : s.status } : s)),
      );
      setViews((current) => {
        const view = current[p.conversationId];
        return view ? { ...current, [p.conversationId]: { ...view, running: false } } : current;
      });
    });
    // 配置变更同步（另一端切换模型/思考强度/权限模式 → 本端跟随）。
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
    try {
      await t.connect();
      await t.subscribe(GLOBAL_CHANNEL);
      setPage("projects");
      try {
        const listResult = await t.request<{ sessions: Session[] }>("conversation.list", {});
        setSessions(listResult.sessions);
        setHostOnline(true);
      } catch {
        setHostOnline(false);
      }
    } catch (e) {
      console.error("connect failed", e);
    }
  };

  const openSession = async (session: Session) => {
    const transport = transportRef.current;
    if (!transport) return;
    setActiveSessionId(session.id);
    setPage("chat");
    // 订阅该会话频道：后端先回 snapshot（handleSnapshot 建初始态），再推增量事件。
    await transport.subscribe(session.id);
    // 初始化 ACP session 拿 capabilities（模型列表、configOptions、上下文窗口）。
    try {
      const caps = await transport.request<SessionCapabilities>("session.initialize", { conversationId: session.id });
      // 初始化默认运行配置（首次进入时取 ACP 返回的当前值）
      setConfigBySession((prev) => {
        if (prev[session.id]) return prev; // 已有配置则不覆盖
        return { ...prev, [session.id]: buildConfigFromCaps(caps) };
      });
    } catch (e) {
      console.warn("session.initialize failed (capabilities unavailable)", e);
    }
  };

  const closeSession = () => {
    const transport = transportRef.current;
    const id = activeSessionIdRef.current;
    if (transport && id) {
      transport.request("unsubscribe", { channel: id }).catch(() => {});
    }
    setActiveSessionId(null);
    setPage("projects");
  };

  const sendMessage = async () => {
    const transport = transportRef.current;
    const id = activeSessionIdRef.current;
    const text = draft.trim();
    if (!transport || !id || !text) return;
    setDraft("");
    const turnId = `turn-${Date.now()}`;
    const cfg = id ? configBySession[id] : undefined;
    // 组回完整 modelId：分组模式 "family[effort]"，否则直接用 familyId（即模型 id）。
    const modelId = cfg
      ? cfg.grouping.isGrouped
        ? buildModelId(cfg.familyId, cfg.effort)
        : cfg.familyId
      : "";
    const modelLabel = cfg?.grouping.families.find((f) => f.familyId === cfg.familyId)?.label;
    // turn.start 携带完整运行配置（模型+思考强度+权限模式），与桌面版一致。
    try {
      await transport.request("turn.start", {
        conversationId: id,
        input: text,
        turnId,
        ...(cfg?.accessMode ? { accessMode: cfg.accessMode } : {}),
        ...(modelId ? { modelId } : {}),
        ...(modelLabel ? { modelLabel } : {}),
        ...(cfg?.grouping.isGrouped && cfg.effort ? { reasoningEffort: cfg.effort } : {}),
      });
    } catch (e) {
      console.error("turn.start failed", e);
    }
  };

  // 终止当前会话（双端均可终止，0710 统一同步协议）。走 SyncManager.cancelSession，
  // 后端取消 turn 后广播 session.stopped，双端同步恢复。
  const stopMessage = async () => {
    const id = activeSessionIdRef.current;
    if (!id) return;
    try {
      await syncRef.current?.cancelSession(id);
    } catch (e) {
      console.error("cancelSession failed", e);
    }
  };

  // 远端新建会话：走 conversation.create WS RPC，后端广播 conversation.created 到全局频道，
  // 本端 handleEvent 的列表 reducer 会自动插入新会话。创建后直接打开。
  const createNewConversation = async () => {
    const transport = transportRef.current;
    if (!transport) return;
    try {
      const result = await transport.request<{ session: Session }>("conversation.create", {});
      if (result?.session) {
        setSessions((current) =>
          current.some((s) => s.id === result.session.id) ? current : [result.session, ...current],
        );
        void openSession(result.session);
      }
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
          {activeConfig && (activeConfig.grouping.families.length > 0 || activeConfig.modes.length > 1) && (
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
              {activeConfig.grouping.isGrouped && (() => {
                const fam = activeConfig.grouping.families.find((f) => f.familyId === activeConfig.familyId);
                if (!fam || fam.efforts.length === 0) return null;
                return (
                  <div className="config-item">
                    <label>思考</label>
                    <select value={activeConfig.effort} onChange={(e) => changeEffort(e.target.value)}>
                      {fam.efforts.map((v) => (
                        <option key={v} value={v}>{v}</option>
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
