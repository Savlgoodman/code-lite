import { useState, useEffect, useRef, useCallback } from "react";
import { Folder, MessageSquare, Settings, Send, ArrowLeft } from "lucide-react";
import type { AgentEvent, ChatMessage, Session, SessionCapabilities, UsageStats } from "@code-lite/protocol";
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

type Page = "projects" | "chat" | "settings";

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";
const GLOBAL_CHANNEL = "*";

/** 会话运行配置：模型族 + 思考强度（二级联动）*/
interface SessionConfig {
  familyId: string; // 当前选中的模型族（isGrouped=false 时即模型 id）
  effort: string; // 当前选中的思考强度（isGrouped=false 时为空）
  grouping: ModelGrouping; // 分组结构（families 列表 + 当前值）
}

/** 从 capabilities 构建默认运行配置 */
function buildConfigFromCaps(caps: SessionCapabilities): SessionConfig {
  const grouping = groupModelsByFamily(caps.models);
  return {
    familyId: grouping.currentFamilyId,
    effort: grouping.currentEffort,
    grouping,
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
  const activeSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [views, activeSessionId]);

  // 事件入口：全局频道走列表 reducer，会话频道走单会话 reducer（0710 第 5 节）。
  const handleEvent = useCallback((event: AgentEvent, meta: { channel: string }) => {
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
    // 运行态变化同步到列表项的 status（供列表显示"运行中"）。
    const type = (event as { type: string }).type;
    if (type === "turn.lock" || type === "turn.unlock" || type === "agent.run.completed" || type === "agent.run.failed") {
      const running = type === "turn.lock";
      setSessions((current) =>
        current.map((s) => (s.id === channel ? { ...s, status: running ? "running" : s.status === "running" ? "idle" : s.status } : s)),
      );
    }
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
    // turn.start 携带完整运行配置（模型+思考强度），与桌面版一致。
    try {
      await transport.request("turn.start", {
        conversationId: id,
        input: text,
        turnId,
        ...(modelId ? { modelId } : {}),
        ...(modelLabel ? { modelLabel } : {}),
        ...(cfg?.grouping.isGrouped && cfg.effort ? { reasoningEffort: cfg.effort } : {}),
      });
    } catch (e) {
      console.error("turn.start failed", e);
    }
  };

  const activeView = activeSessionId ? views[activeSessionId] : null;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? activeView?.session ?? null;
  const activeRunning = activeView?.running ?? false;
  const activeConfig = activeSessionId ? configBySession[activeSessionId] : undefined;

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
      return { ...prev, [activeSessionId]: { ...cfg, familyId, effort: nextEffort } };
    });
  };

  const changeEffort = (effort: string) => {
    if (!activeSessionId) return;
    setConfigBySession((prev) => {
      const cfg = prev[activeSessionId];
      if (!cfg) return prev;
      return { ...prev, [activeSessionId]: { ...cfg, effort } };
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
          {activeConfig && activeConfig.grouping.families.length > 0 && (
            <div className="chat-config-bar">
              <div className="config-item">
                <label>模型</label>
                <select value={activeConfig.familyId} onChange={(e) => changeFamily(e.target.value)}>
                  {activeConfig.grouping.families.map((f) => (
                    <option key={f.familyId} value={f.familyId}>{f.label}</option>
                  ))}
                </select>
              </div>
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
              placeholder={activeRunning ? "另一端正在运行..." : "输入消息..."}
              disabled={activeRunning}
            />
            <button onClick={sendMessage} disabled={!draft.trim() || activeRunning}>
              <Send size={18} />
            </button>
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
          <span style={{ fontSize: 12, color: hostOnline ? "var(--green)" : "var(--orange)" }}>
            {hostOnline ? "● 宿主在线" : "○ 宿主离线"}
          </span>
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
