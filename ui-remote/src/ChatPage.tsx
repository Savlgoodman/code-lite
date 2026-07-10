import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Send, Settings, Square } from "lucide-react";
import type { ChatMessage, Session } from "@code-lite/protocol";
import { useConversationState } from "./useConversations";
import { connectionManager } from "./services/ConnectionManager";
import { useSessionConfig } from "./hooks/useSessionConfig";
import { MessageBubble } from "./components/MessageBubble";
import { ConfigSheet } from "./components/ConfigSheet";

interface ChatPageProps {
  sessionId: string;
  onBack: () => void;
}

export function ChatPage({ sessionId, onBack }: ChatPageProps) {
  const client = connectionManager.getClient();
  const { sessions, views } = useConversationState(client);
  const session = sessions.find((s: Session) => s.id === sessionId);
  const view = views[sessionId];
  const messages: ChatMessage[] = view?.messages ?? [];
  const { config, updateConfig } = useSessionConfig(client, sessionId);
  const [input, setInput] = useState("");
  const [showConfigSheet, setShowConfigSheet] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
  // TODO: wire to actual context window usage
  const contextPercent = 0;

  // 从 capabilities 中获取模型显示名
  const modelLabel = config?.grouping.families.find((f) => f.familyId === config.familyId)?.label
    || config?.familyId
    || "-";

  const effortLabel = config?.effort || "-";

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
                  stroke={contextPercent > 80 ? "var(--orange)" : "var(--text)"}
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
            updateConfig(newConfig);
            setShowConfigSheet(false);
          }}
        />
      )}
    </div>
  );
}
