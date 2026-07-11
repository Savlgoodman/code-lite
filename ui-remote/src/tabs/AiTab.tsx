import { useEffect, useState } from "react";
import { Plus, Archive, Trash2, MessageSquare } from "lucide-react";
import { Fab, EmptyState } from "../components/ui";
import { useAiConversations } from "../hooks/useAiConversations";
import { useAiProviders } from "../hooks/useAiProviders";
import { aiConversationStore, type AiConversation } from "../services/AiConversationStore";
import { formatMessageTime } from "../lib/formatters";

interface AiTabProps {
  onOpenConversation: (id: string) => void;
  /** 由 HomePager 注入：仅激活 Tab 渲染 FAB */
  active?: boolean;
}

export function AiTab({ onOpenConversation, active = true }: AiTabProps) {
  const conversations = useAiConversations();
  const { models } = useAiProviders();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void aiConversationStore.init().then(() => setReady(true));
  }, []);

  // 未归档，按最后互动时间（updatedAt）降序
  const list = conversations
    .filter((c) => !c.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const hasModel = models.length > 0;

  const startNew = async () => {
    if (!hasModel) return;
    const conv = await aiConversationStore.createConversation(models[0].id);
    onOpenConversation(conv.id);
  };

  if (!hasModel) {
    return (
      <div className="tab-page">
        <h2 className="page-title">AI 对话</h2>
        <div className="page-subtitle">直连大模型</div>
        <EmptyState icon="✦" title="还没有可用模型">
          请到「设置 → 模型供应商配置」添加供应商并选择模型
        </EmptyState>
      </div>
    );
  }

  if (ready && list.length === 0) {
    return (
      <div className="tab-page">
        <h2 className="page-title">AI 对话</h2>
        <div className="page-subtitle">直连大模型</div>
        <EmptyState icon="☺" title="还没有对话">点击右下角开始新对话</EmptyState>
        {active && (
          <Fab onClick={() => void startNew()} aria-label="新建对话" title="新建对话">
            <Plus size={24} />
          </Fab>
        )}
      </div>
    );
  }

  return (
    <div className="tab-page">
      <h2 className="page-title">AI 对话</h2>
      <div className="page-subtitle">直连大模型</div>
      <ul className="ai-conv-list">
        {list.map((conv: AiConversation) => (
          <li key={conv.id} className="ai-conv-item" onClick={() => onOpenConversation(conv.id)}>
            <span className="ai-conv-icon"><MessageSquare size={16} /></span>
            <div className="ai-conv-main">
              <span className="ai-conv-title">{conv.title || "未命名对话"}</span>
              <span className="ai-conv-time">{formatMessageTime(conv.updatedAt)}</span>
            </div>
            <button
              className="ai-icon-btn"
              aria-label="归档"
              title="归档"
              onClick={(e) => {
                e.stopPropagation();
                void aiConversationStore.setArchived(conv.id, true);
              }}
            >
              <Archive size={16} />
            </button>
            <button
              className="ai-icon-btn danger"
              aria-label="删除"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                void aiConversationStore.deleteConversation(conv.id);
              }}
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <Fab onClick={() => void startNew()} aria-label="新建对话" title="新建对话">
          <Plus size={24} />
        </Fab>
      )}
    </div>
  );
}
