import { useState, useEffect, useRef } from "react";
import { Folder, MessageSquare, Settings, Send, ArrowLeft } from "lucide-react";
import { RelayTransport } from "./services/RelayTransport";

type Page = "projects" | "chat" | "settings";

interface Session {
  id: string;
  title: string;
  preview: string;
  workspace?: string;
  workspaceKind?: string;
  agent?: { id: string; label: string };
  status: string;
  updatedAt: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  streaming?: boolean;
}

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";

async function computeRoomId(pairKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pairKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function App() {
  const [page, setPage] = useState<Page>("settings");
  const [transport, setTransport] = useState<RelayTransport | null>(null);
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem(LS_RELAY_URL) || "ws://localhost:18766/ws");
  const [pairKey, setPairKey] = useState(localStorage.getItem(LS_PAIR_KEY) || "");
  const [connected, setConnected] = useState(false);
  const [hostOnline, setHostOnline] = useState(false);
  const hostOnlineRef = useRef(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeSession]);

  const connect = async () => {
    if (!pairKey.trim()) return;
    localStorage.setItem(LS_RELAY_URL, relayUrl);
    localStorage.setItem(LS_PAIR_KEY, pairKey);
    const roomId = await computeRoomId(pairKey.trim());
    const t = new RelayTransport({
      relayUrl,
      roomId,
      onHostStatusChange: (online) => { hostOnlineRef.current = online; setHostOnline(online); },
    });
    t.onStatus((s) => setConnected(s !== "idle" && s !== "closed"));
    try {
      await t.connect();
      setTransport(t);
      // 订阅全局频道以接收会话列表事件
      await t.subscribe("*");
      setPage("projects");
      // 直接拉取会话列表（host 不在线时 RPC 会超时，显示空列表即可）
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
    if (!transport) return;
    setActiveSession(session);
    setPage("chat");
    // 订阅该会话频道
    await transport.subscribe(session.id);
    // 加载消息
    const result = await transport.request<{ session: Session; messages: ChatMessage[] }>("conversation.get", {
      conversationId: session.id,
    });
    setMessages((prev) => ({ ...prev, [session.id]: result.messages }));
  };

  const sendMessage = async () => {
    if (!transport || !activeSession || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const turnId = `turn-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      streaming: true,
    };
    setMessages((prev) => ({
      ...prev,
      [activeSession.id]: [...(prev[activeSession.id] || []), userMsg, assistantMsg],
    }));
    setRunning((prev) => new Set(prev).add(activeSession.id));

    // 监听事件更新消息
    const unsub = transport.onEvent((event) => {
      if (event.conversationId !== activeSession.id) return;
      if (event.type === "agent.text.delta") {
        setMessages((prev) => {
          const msgs = prev[activeSession.id] || [];
          const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
          if (!lastAssistant) return prev;
          return {
            ...prev,
            [activeSession.id]: msgs.map((m) =>
              m.id === lastAssistant.id ? { ...m, content: m.content + (event as { delta: string }).delta } : m,
            ),
          };
        });
      } else if (event.type === "agent.run.completed" || event.type === "agent.run.failed") {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(activeSession.id);
          return next;
        });
        setMessages((prev) => {
          const msgs = prev[activeSession.id] || [];
          const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
          if (!lastAssistant) return prev;
          return {
            ...prev,
            [activeSession.id]: msgs.map((m) =>
              m.id === lastAssistant.id ? { ...m, streaming: false } : m,
            ),
          };
        });
        unsub();
      }
    });

    await transport.request("turn.start", {
      conversationId: activeSession.id,
      input: text,
      turnId,
    });
  };

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
          <button onClick={connect} disabled={!pairKey.trim()}>
            连接
          </button>
          {connected && !hostOnline && <p className="status">已连接中继，等待宿主上线...</p>}
          {connected && hostOnline && <p className="status" style={{ color: "var(--green)" }}>已连接宿主</p>}
          {!connected && <p className="status">未连接</p>}
        </div>
      </div>
    );
  }

  if (page === "chat" && activeSession) {
    const sessionMessages = messages[activeSession.id] || [];
    return (
      <div className="app-shell chat-page">
        <div className="chat-header">
          <button className="back-btn" onClick={() => { setPage("projects"); setActiveSession(null); }}>
            <ArrowLeft size={20} />
          </button>
          <div className="title">{activeSession.title}</div>
        </div>
        <div className="chat-messages">
          {sessionMessages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              {msg.content || (msg.streaming ? "思考中..." : "")}
              {msg.streaming && <span className="thinking-dots">...</span>}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <div className="chat-input-bar">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="输入消息..."
            disabled={running.has(activeSession.id)}
          />
          <button onClick={sendMessage} disabled={!draft.trim() || running.has(activeSession.id)}>
            <Send size={18} />
          </button>
        </div>
      </div>
    );
  }

  // 项目列表页
  const projectGroups = sessions
    .filter((s) => s.workspaceKind === "project" && s.workspace)
    .reduce((acc, s) => {
      const key = s.workspace!;
      if (!acc[key]) acc[key] = { name: key.split("/").pop() || key, sessions: [] };
      acc[key].sessions.push(s);
      return acc;
    }, {} as Record<string, { name: string; sessions: Session[] }>);

  const generalSessions = sessions.filter((s) => s.workspaceKind !== "project" || !s.workspace);

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
            <div className="project-list">
              {group.sessions.map((s) => (
                <div key={s.id} className="project-item" onClick={() => openSession(s)}>
                  <div className="icon">
                    <MessageSquare size={18} />
                  </div>
                  <div className="info">
                    <div className="name">{s.title || "未命名会话"}</div>
                    <div className="meta">
                      {s.agent?.label || "未知"} · {running.has(s.id) ? "运行中" : "空闲"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {generalSessions.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>普通会话</div>
            <div className="project-list">
              {generalSessions.map((s) => (
                <div key={s.id} className="project-item" onClick={() => openSession(s)}>
                  <div className="icon" style={{ background: "var(--muted)" }}>
                    <MessageSquare size={18} />
                  </div>
                  <div className="info">
                    <div className="name">{s.title || "未命名会话"}</div>
                    <div className="meta">{s.agent?.label || "未知"}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {sessions.length === 0 && (
          <div className="empty-state">
            <div className="icon">📁</div>
            <p>暂无会话</p>
          </div>
        )}
      </div>
      <div className="tab-bar">
        <button className={page === "projects" ? "active" : ""} onClick={() => setPage("projects")}>
          项目
        </button>
        <button onClick={() => setPage("settings")}>
          <Settings size={18} style={{ verticalAlign: "middle" }} />
        </button>
      </div>
    </div>
  );
}
