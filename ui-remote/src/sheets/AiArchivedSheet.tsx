import { useEffect, useState } from "react";
import { ArchiveRestore, Trash2, Inbox } from "lucide-react";
import { Sheet } from "../components/ui";
import { aiConversationStore, type AiConversation } from "../services/AiConversationStore";
import { useAiConversations } from "../hooks/useAiConversations";
import { formatMessageTime } from "../lib/formatters";

interface AiArchivedSheetProps {
  onClose: () => void;
}

/** 已归档 AI 对话：可恢复或永久删除。 */
export function AiArchivedSheet({ onClose }: AiArchivedSheetProps) {
  const all = useAiConversations();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void aiConversationStore.init().then(() => setReady(true));
  }, []);

  const archived = all.filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Sheet title="已归档对话" onClose={onClose}>
      <div className="ai-archived-list">
        {ready && archived.length === 0 && (
          <div className="ai-archived-empty">
            <Inbox size={32} />
            <span>暂无已归档对话</span>
          </div>
        )}
        {archived.map((conv: AiConversation) => (
          <div key={conv.id} className="ai-archived-row">
            <div className="ai-archived-meta">
              <span className="ai-archived-title">{conv.title || "未命名对话"}</span>
              <span className="ai-archived-time">{formatMessageTime(conv.updatedAt)}</span>
            </div>
            <div className="ai-archived-actions">
              <button
                className="ai-icon-btn"
                aria-label="恢复"
                title="恢复"
                onClick={() => void aiConversationStore.setArchived(conv.id, false)}
              >
                <ArchiveRestore size={16} />
              </button>
              <button
                className="ai-icon-btn danger"
                aria-label="永久删除"
                title="永久删除"
                onClick={() => void aiConversationStore.deleteConversation(conv.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
