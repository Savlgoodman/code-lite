import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Send, Settings, Square } from "lucide-react";
import type { ChatMessage, Session, SessionConfigOption, SessionMode } from "@code-lite/protocol";
import { groupModelsByFamily, type ModelGrouping } from "@code-lite/chat-core";
import { useConversationState } from "./useConversations";
import { connectionManager } from "./services/ConnectionManager";

interface ChatPageProps {
  sessionId: string;
  onBack: () => void;
}

interface SessionConfig {
  familyId: string;
  effort: string;
  grouping: ModelGrouping;
  accessMode: string;
  modes: SessionMode[];
  configOptions: SessionConfigOption[];
  configOptionsRaw: SessionConfigOption[];
}

export function ChatPage({ sessionId, onBack }: ChatPageProps) {
  const client = connectionManager.getClient();
  const { sessions, views } = useConversationState(client);
  const session = sessions.find((s: Session) => s.id === sessionId);
  const view = views[sessionId];
  const messages: ChatMessage[] = view?.messages ?? [];
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [input, setInput] = useState("");
  const [showConfigSheet, setShowConfigSheet] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        // session.initialize 返回 { capabilities: {...} } 或直接 {...}
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

      // accessMode 优先取 saved，其次取 modes 默认
      const savedAccessMode = savedConfig?.accessMode;
      const defaultMode = modes.find((m: SessionMode) => m.isDefault) ?? modes[0];
      const accessMode = savedAccessMode || defaultMode?.id || "";

      // modelFamily 优先取 saved
      const savedModelFamily = String(savedConfig?.modelFamily ?? "");
      const familyId = savedModelFamily || grouping.currentFamilyId || "";

      // reasoningEffort：codex 分组模式取 grouping.currentEffort 或 saved；claude 取 configOptions 的 currentValue 或 saved
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

    // 订阅远端配置同步事件（桌面端改配置时广播过来）
    const sync = client.getSync();
    const unsubConfig = sync.onConfigChange((payload) => {
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

  // textarea 自适应高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.max(48, Math.min(textareaRef.current.scrollHeight, 120)) + "px";
    }
  }, [input]);

  if (!session) {
    return (
      <div className="chat-page">
        <div className="empty-state">
          <p>会话不存在</p>
          <button onClick={onBack}>返回</button>
        </div>
      </div>
    );
  }

  const handleSend = async () => {
    if (!client || !input.trim()) return;
    const text = input.trim();
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // 如果 config 还没加载完，用空配置发送（后端会用 session.json 中的配置）
    const sendConfig = config ?? {
      familyId: "",
      effort: "medium",
      grouping: { isGrouped: false, currentFamilyId: "", currentEffort: "medium", families: [] },
      accessMode: "",
      modes: [],
      configOptions: [],
      configOptionsRaw: [],
    };

    try {
      await client.sendTurn({
        conversationId: sessionId,
        input: text,
        accessMode: sendConfig.accessMode,
        modelId: sendConfig.familyId || undefined,
        reasoningEffort: sendConfig.effort,
      });
    } catch (err) {
      console.error("[ChatPage] sendTurn failed:", err);
      alert("发送失败: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleCancel = async () => {
    if (!client) return;
    try {
      await client.cancelTurn(sessionId);
    } catch (err) {
      console.error("[ChatPage] cancelTurn failed:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isRunning = client?.isRunning(sessionId) ?? false;
  const contextPercent = 0;

  // 从 capabilities 中获取模型显示名
  const modelLabel = config?.grouping.families.find((f) => f.familyId === config.familyId)?.label
    || config?.familyId
    || "-";

  const effortLabel = config?.effort || "-";

  // accessMode 显示：从 modes 中找匹配项的 label，否则直接显示值
  const accessModeLabel = (() => {
    if (!config) return "-";
    const matched = config.modes.find((m) => m.id === config.accessMode);
    return matched?.label || config.accessMode || "-";
  })();

  return (
    <div className="chat-page">
      {/* 顶部导航栏 */}
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title">{session.title || "无标题"}</h1>
        <div className="header-spacer" />
      </header>

      {/* 消息流 */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"></div>
            <h2>开始对话</h2>
            <p>输入你的问题，AI 将为你解答</p>
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 顶部信息栏 (输入框上方边缘) */}
      <div className="chat-config-bar">
        <span>{accessModeLabel}</span>
        <span className="config-bar-sep">·</span>
        <span>{modelLabel}</span>
        <span className="config-bar-sep">·</span>
        <span>{effortLabel}</span>
      </div>

      {/* 底部输入区 */}
      <footer className="chat-input-area">
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="输入消息..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <div className="input-bottom-row">
            <button className="input-config-btn" onClick={() => setShowConfigSheet(true)}>
              <Settings size={18} />
            </button>
            <div className="context-ring">
              <svg viewBox="0 0 36 36" width="28" height="28">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line)" strokeWidth="2.5" />
                <circle
                  cx="18" cy="18" r="15.5" fill="none"
                  stroke={contextPercent > 80 ? "#ef4444" : "var(--text)"}
                  strokeWidth="2.5"
                  strokeDasharray={`${contextPercent * 0.97} 100`}
                  strokeLinecap="round"
                  transform="rotate(-90 18 18)"
                />
              </svg>
            </div>
            {isRunning ? (
              <button className="send-btn cancel" onClick={handleCancel}>
                <Square size={18} />
              </button>
            ) : (
              <button className="send-btn" onClick={handleSend} disabled={!input.trim()}>
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </footer>

      {/* 配置选择器 Modal Sheet */}
      {showConfigSheet && config && (
        <ConfigSheet
          config={config}
          onClose={() => setShowConfigSheet(false)}
          onSave={async (newConfig) => {
            if (client) {
              try {
                await client.updateConfig(sessionId, {
                  modelFamily: newConfig.familyId,
                  reasoningEffort: newConfig.effort,
                  accessMode: newConfig.accessMode as any,
                } as any);
              } catch (err) {
                console.error("[ChatPage] updateConfig failed:", err);
              }
            }
            setConfig(newConfig);
            setShowConfigSheet(false);
          }}
        />
      )}
    </div>
  );
}

// ─── 消息气泡 ─────────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      {isUser ? (
        <div className="user-bubble">{message.content}</div>
      ) : (
        <div className="assistant-content">
          {message.reasoning && (
            <details className="reasoning-details">
              <summary>思考过程</summary>
              <div className="reasoning-text">{message.reasoning}</div>
            </details>
          )}
          <div className="assistant-text">{message.content}</div>
        </div>
      )}
    </div>
  );
}

// ─── 配置选择器 ───────────────────────────────────────────

interface ConfigSheetProps {
  config: SessionConfig;
  onClose: () => void;
  onSave: (config: SessionConfig) => void;
}

function ConfigSheet({ config, onClose, onSave }: ConfigSheetProps) {
  const [local, setLocal] = useState(config);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>会话配置</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* 模型选择 — 始终显示（codex 显示族，claude 显示单个模型） */}
          {local.grouping.families.length > 0 && (
            <div className="field">
              <label>模型</label>
              <select value={local.familyId} onChange={(e) => setLocal({ ...local, familyId: e.target.value })}>
                {local.grouping.families.map((fam) => (
                  <option key={fam.familyId} value={fam.familyId}>{fam.label}</option>
                ))}
              </select>
            </div>
          )}
          {/* 思考强度 */}
          <div className="field">
            <label>思考强度</label>
            <select value={local.effort} onChange={(e) => setLocal({ ...local, effort: e.target.value })}>
              {local.grouping.isGrouped
                ? local.grouping.families.find((f) => f.familyId === local.familyId)?.efforts.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))
                : local.configOptionsRaw.find((o) => o.id === "reasoning_effort")?.values?.map((v) => (
                    <option key={String(v)} value={String(v)}>{String(v)}</option>
                  ))
              }
            </select>
          </div>
          {/* 访问模式 */}
          {local.modes.length > 0 && (
            <div className="field">
              <label>访问模式</label>
              <select value={local.accessMode} onChange={(e) => setLocal({ ...local, accessMode: e.target.value })}>
                {local.modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => onSave(local)}>保存</button>
        </div>
      </div>
    </div>
  );
}
