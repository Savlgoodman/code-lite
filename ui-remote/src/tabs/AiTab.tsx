import { useEffect, useState } from "react";
import { Plus, Archive, Trash2, MessageSquare, Smartphone, Image as ImageIcon, Sparkles } from "lucide-react";
import { Fab, EmptyState, Portal } from "../components/ui";
import { BlobImage } from "../components/BlobImage";
import { useAiConversations } from "../hooks/useAiConversations";
import { useAiProviders } from "../hooks/useAiProviders";
import { useImageRecords } from "../hooks/useImageRecords";
import { aiConversationStore, type AiConversation } from "../services/AiConversationStore";
import { imageGenStore } from "../services/ImageGenStore";
import { formatMessageTime } from "../lib/formatters";
import { isAiAvailable } from "../lib/environment";

type AiMode = "chat" | "image";

interface AiTabProps {
  onOpenConversation: (id: string) => void;
  onOpenImageRecord: (id: string) => void;
  /** 由 HomePager 注入：仅激活 Tab 渲染 FAB */
  active?: boolean;
}

export function AiTab({ onOpenConversation, onOpenImageRecord, active = true }: AiTabProps) {
  const conversations = useAiConversations();
  const records = useImageRecords();
  const { models } = useAiProviders();
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<AiMode>("chat");

  useEffect(() => {
    void Promise.all([aiConversationStore.init(), imageGenStore.init()]).then(() => setReady(true));
  }, []);

  // PWA / 生产静态部署：AI 不可用（无 /ai-proxy 转发 + 供应商多不支持 CORS）。
  if (!isAiAvailable()) {
    return (
      <div className="tab-page">
        <h2 className="page-title">AI</h2>
        <div className="page-subtitle">直连大模型</div>
        <EmptyState icon={<Smartphone size={40} strokeWidth={1.5} />} title="仅 App 可用">
          AI 对话与图片生成需要 App 的原生网络能力，网页版暂不支持。请下载并使用 App 体验此功能。
        </EmptyState>
      </div>
    );
  }

  // 右下角加号上方的模式切换按钮（生图 <-> 聊天）。
  // 经 Portal 渲染到 body：脱离 HomePager 的 translateX transform 容器，否则会被
  // 轨道盒裁剪/错位而看不见（与 Fab 同理，见 ui-remote/AGENTS.md）。
  const modeToggle = active ? (
    <Portal>
      <button
        className="ai-mode-toggle"
        onClick={() => setMode((m) => (m === "chat" ? "image" : "chat"))}
        aria-label={mode === "chat" ? "切换到图片生成" : "切换到 AI 对话"}
        title={mode === "chat" ? "切换到图片生成" : "切换到 AI 对话"}
      >
        {mode === "chat" ? <ImageIcon size={20} /> : <MessageSquare size={20} />}
      </button>
    </Portal>
  ) : null;

  if (mode === "image") {
    return (
      <ImageModeView
        ready={ready}
        active={active}
        records={records}
        onOpenImageRecord={onOpenImageRecord}
        modeToggle={modeToggle}
      />
    );
  }

  return (
    <ChatModeView
      ready={ready}
      active={active}
      conversations={conversations}
      hasModel={models.length > 0}
      onOpenConversation={onOpenConversation}
      onStartNew={async () => {
        if (models.length === 0) return;
        const conv = await aiConversationStore.createConversation(models[0].id);
        onOpenConversation(conv.id);
      }}
      modeToggle={modeToggle}
    />
  );
}

// ── AI 对话模式 ──

function ChatModeView({
  ready,
  active,
  conversations,
  hasModel,
  onOpenConversation,
  onStartNew,
  modeToggle,
}: {
  ready: boolean;
  active: boolean;
  conversations: AiConversation[];
  hasModel: boolean;
  onOpenConversation: (id: string) => void;
  onStartNew: () => void | Promise<void>;
  modeToggle: React.ReactNode;
}) {
  const list = conversations.filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt);

  if (!hasModel) {
    return (
      <div className="tab-page">
        <h2 className="page-title">AI 对话</h2>
        <div className="page-subtitle">直连大模型</div>
        <EmptyState icon="✦" title="还没有可用模型">
          请到「设置 → 模型供应商配置」添加供应商并选择模型
        </EmptyState>
        {modeToggle}
      </div>
    );
  }

  return (
    <div className="tab-page">
      <h2 className="page-title">AI 对话</h2>
      <div className="page-subtitle">直连大模型</div>
      {ready && list.length === 0 ? (
        <EmptyState icon="☺" title="还没有对话">点击右下角开始新对话</EmptyState>
      ) : (
        <ul className="ai-conv-list">
          {list.map((conv) => (
            <li key={conv.id} className="ai-conv-item" onClick={() => onOpenConversation(conv.id)}>
              <span className="ai-conv-icon"><MessageSquare size={16} /></span>
              <div className="ai-conv-main">
                <span className="ai-conv-title">{conv.title || "未命名对话"}</span>
                <span className="ai-conv-time">{formatMessageTime(conv.updatedAt)}</span>
              </div>
              <button className="ai-icon-btn" aria-label="归档" title="归档" onClick={(e) => { e.stopPropagation(); void aiConversationStore.setArchived(conv.id, true); }}>
                <Archive size={16} />
              </button>
              <button className="ai-icon-btn danger" aria-label="删除" title="删除" onClick={(e) => { e.stopPropagation(); void aiConversationStore.deleteConversation(conv.id); }}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {modeToggle}
      {active && (
        <Fab onClick={() => void onStartNew()} aria-label="新建对话" title="新建对话">
          <Plus size={24} />
        </Fab>
      )}
    </div>
  );
}

// ── 图片生成模式 ──

function ImageModeView({
  ready,
  active,
  records,
  onOpenImageRecord,
  modeToggle,
}: {
  ready: boolean;
  active: boolean;
  records: ReturnType<typeof useImageRecords>;
  onOpenImageRecord: (id: string) => void;
  modeToggle: React.ReactNode;
}) {
  const list = [...records].sort((a, b) => b.updatedAt - a.updatedAt);

  const startNew = async () => {
    const record = await imageGenStore.createRecord();
    onOpenImageRecord(record.id);
  };

  return (
    <div className="tab-page">
      <h2 className="page-title">图片生成</h2>
      <div className="page-subtitle">直连生图供应商</div>
      {ready && list.length === 0 ? (
        <EmptyState icon={<Sparkles size={38} strokeWidth={1.5} />} title="还没有生成记录">点击右下角新建生图任务</EmptyState>
      ) : (
        <div className="imggen-card-grid">
          {list.map((record) => (
            <button key={record.id} className="imggen-card" onClick={() => onOpenImageRecord(record.id)}>
              <span className="imggen-card-cover">
                {record.coverImageId ? (
                  <BlobImage imageId={record.coverImageId} alt={record.title} />
                ) : (
                  <ImageIcon size={26} className="imggen-card-empty" />
                )}
              </span>
              <span className="imggen-card-title">{record.title}</span>
            </button>
          ))}
        </div>
      )}
      {modeToggle}
      {active && (
        <Fab onClick={() => void startNew()} aria-label="新建生图任务" title="新建生图任务">
          <Plus size={24} />
        </Fab>
      )}
    </div>
  );
}
