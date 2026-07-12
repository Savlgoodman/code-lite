import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, ArrowDown, Image, Loader2, Send, Cpu, Square, X } from "lucide-react";
import { MessageRenderer } from "../components/MessageRenderer";
import { AiModelSheet } from "../sheets/AiModelSheet";
import { EmptyState, Portal, TextArea } from "../components/ui";
import { formatMessageTime, formatFullDateTime } from "../lib/formatters";
import {
  aiConversationStore,
  type AiConversation,
  type AiMessage,
  type AiImage,
} from "../services/AiConversationStore";
import { aiProviderStore, type AiModel, type AiProvider } from "../services/AiProviderStore";
import { streamChat, blobToDataUrl } from "../services/aiClient";
import { useDismissable } from "../hooks/useDismissable";
import {
  IMAGE_ACCEPT,
  MAX_DRAFT_IMAGES,
  createDraftImage,
  revokeDraftImage,
  type DraftImage,
} from "../lib/draftImages";

interface AiChatPageProps {
  conversationId: string;
  onBack: () => void;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function AiChatPage({ conversationId, onBack }: AiChatPageProps) {
  const [conversation, setConversation] = useState<AiConversation | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draftImageError, setDraftImageError] = useState<string | null>(null);
  const [imagesProcessing, setImagesProcessing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showModelSheet, setShowModelSheet] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [resolved, setResolved] = useState<{ model: AiModel; provider: AiProvider } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // 系统返回键优先关闭这些瞬态层
  useDismissable(previewImage !== null, () => setPreviewImage(null));
  useDismissable(showModelSheet, () => setShowModelSheet(false));

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftImagesRef = useRef<DraftImage[]>([]);
  const messagesRef = useRef<AiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pinnedRef = useRef(true);

  draftImagesRef.current = draftImages;
  messagesRef.current = messages;

  const multimodal = resolved?.model.multimodal ?? false;

  // 载入会话元数据、消息、解析当前模型
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await aiConversationStore.init();
      if (cancelled) return;
      const conv = aiConversationStore.getConversation(conversationId) ?? null;
      setConversation(conv);
      const msgs = await aiConversationStore.loadMessages(conversationId);
      if (cancelled) return;
      setMessages(msgs);
      if (conv) {
        const r = await aiProviderStore.resolveModel(conv.modelRefId);
        if (!cancelled) setResolved(r);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // 卸载时释放草稿图片 + 中止进行中的请求
  useEffect(() => {
    return () => {
      for (const image of draftImagesRef.current) revokeDraftImage(image);
      abortRef.current?.abort();
    };
  }, []);

  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = isAtBottom(el);
      pinnedRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [isAtBottom]);

  useEffect(() => {
    if (pinnedRef.current) requestAnimationFrame(() => scrollToBottom());
  }, [messages, scrollToBottom]);

  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom());
  }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.max(48, Math.min(textareaRef.current.scrollHeight, 120)) + "px";
    }
  }, [input]);

  useEffect(() => {
    if (!isRunning) {
      setShowThinking(false);
      return;
    }
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last?.content) {
      setShowThinking(true);
    } else {
      const timer = setTimeout(() => setShowThinking(true), 1200);
      return () => clearTimeout(timer);
    }
  }, [isRunning, messages]);

  // ── 草稿图片 ──

  const clearDraftImages = () => {
    setDraftImages((prev) => {
      for (const image of prev) revokeDraftImage(image);
      return [];
    });
    setDraftImageError(null);
  };

  const addDraftImages = async (files: File[]) => {
    if (files.length === 0) return;
    setDraftImageError(null);
    setImagesProcessing(true);
    try {
      const slots = Math.max(0, MAX_DRAFT_IMAGES - draftImagesRef.current.length);
      if (slots <= 0) {
        setDraftImageError(`最多添加 ${MAX_DRAFT_IMAGES} 张图片。`);
        return;
      }
      const created: DraftImage[] = [];
      let failure: string | null = null;
      for (const file of files.slice(0, slots)) {
        try {
          created.push(await createDraftImage(file));
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
      }
      if (created.length > 0) setDraftImages((prev) => [...prev, ...created]);
      if (failure) setDraftImageError(failure);
    } finally {
      setImagesProcessing(false);
    }
  };

  const removeDraftImage = (id: string) => {
    setDraftImages((prev) => {
      const target = prev.find((image) => image.id === id);
      if (target) revokeDraftImage(target);
      return prev.filter((image) => image.id !== id);
    });
    setDraftImageError(null);
  };

  const filesFromList = (list: FileList | null) =>
    Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));

  // ── 发送 / 取消 ──

  const persist = (next: AiMessage[]) => {
    void aiConversationStore.saveMessages(conversationId, next);
  };

  const maybeSetTitle = (text: string) => {
    if (!conversation) return;
    if (conversation.title && conversation.title !== "新对话") return;
    const title = text.slice(0, 24) || "新对话";
    void aiConversationStore.updateConversation(conversationId, { title });
    setConversation((prev) => (prev ? { ...prev, title } : prev));
  };

  const handleSend = async () => {
    if (isRunning || imagesProcessing) return;
    const text = input.trim();
    const drafts = draftImagesRef.current;
    if (!text && drafts.length === 0) return;

    if (!resolved) {
      setDraftImageError("当前对话没有可用模型，请在设置页配置模型供应商。");
      return;
    }

    // 组装用户消息图片（data URL 直接进历史与请求体）
    let images: AiImage[] | undefined;
    if (drafts.length > 0 && multimodal) {
      setImagesProcessing(true);
      try {
        images = await Promise.all(
          drafts.map(async (image) => ({
            dataUrl: await blobToDataUrl(image.normalized?.blob ?? image.file),
            name: image.name,
            mimeType: image.normalized?.mimeType ?? image.mimeType,
          })),
        );
      } catch (err) {
        setDraftImageError("图片处理失败: " + (err instanceof Error ? err.message : String(err)));
        setImagesProcessing(false);
        return;
      }
      setImagesProcessing(false);
    }

    const now = Date.now();
    const userMessage: AiMessage = {
      id: makeId("msg"),
      role: "user",
      content: text,
      createdAt: now,
      images,
    };
    const assistantMessage: AiMessage = {
      id: makeId("msg"),
      role: "assistant",
      content: "",
      createdAt: now + 1,
      updatedAt: now + 1,
    };

    const history = [...messagesRef.current, userMessage];
    const withAssistant = [...history, assistantMessage];
    setMessages(withAssistant);
    messagesRef.current = withAssistant;
    persist(withAssistant);
    maybeSetTitle(text);

    setInput("");
    clearDraftImages();
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);

    // 增量在 updater 内部拼接，避免 React 批处理时读到过期 content 丢字
    const appendDelta = (delta: string) => {
      setMessages((prev) => {
        const next = prev.map((m) =>
          m.id === assistantMessage.id ? { ...m, content: m.content + delta, updatedAt: Date.now() } : m,
        );
        messagesRef.current = next;
        return next;
      });
    };

    await streamChat(
      { provider: resolved.provider, model: resolved.model, messages: history, signal: controller.signal },
      {
        onDelta: (delta) => appendDelta(delta),
        onDone: () => {
          setIsRunning(false);
          abortRef.current = null;
          persist(messagesRef.current);
        },
        onError: (error) => {
          const next = messagesRef.current.map((m) =>
            m.id === assistantMessage.id ? { ...m, error: error.message, updatedAt: Date.now() } : m,
          );
          messagesRef.current = next;
          setMessages(next);
          setIsRunning(false);
          abortRef.current = null;
          persist(next);
        },
      },
    );
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
  };

  const handleSelectModel = (modelRefId: string) => {
    void aiConversationStore.updateConversation(conversationId, { modelRefId });
    setConversation((prev) => (prev ? { ...prev, modelRefId } : prev));
    void aiProviderStore.resolveModel(modelRefId).then(setResolved);
  };

  const modelLabel = resolved?.model.label ?? "未选择模型";
  const sendDisabled = (!input.trim() && draftImages.length === 0) || imagesProcessing || !resolved;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title">{conversation?.title || "AI 对话"}</h1>
        <div className="header-spacer" />
      </header>

      <div className="chat-messages" ref={scrollContainerRef}>
        {messages.length === 0 ? (
          <EmptyState title="开始对话">输入你的问题，直连大模型为你解答</EmptyState>
        ) : (
          messages.map((msg, i) => (
            <AiMessageBubble
              key={msg.id}
              message={msg}
              streaming={isRunning && i === messages.length - 1 && msg.role === "assistant"}
              onPreviewImage={(url, name) => setPreviewImage({ url, name })}
            />
          ))
        )}
        {showThinking && (
          <div className="thinking-indicator-row">
            <span className="thinking-indicator" data-text="正在思考">正在思考</span>
          </div>
        )}
      </div>

      {showScrollToBottom && (
        <button
          className="scroll-bottom-button"
          style={{ bottom: 88 }}
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          <ArrowDown size={18} />
        </button>
      )}

      <footer className="chat-input-area">
        <div className="input-wrapper">
          {draftImages.length > 0 && (
            <div className="draft-image-strip" aria-label="待发送图片">
              {draftImages.map((image) => (
                <div className="draft-image-thumb" key={image.id}>
                  <img alt={image.name} src={image.objectUrl} />
                  <button
                    className="draft-image-remove"
                    aria-label={`移除图片 ${image.name}`}
                    onClick={() => removeDraftImage(image.id)}
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {draftImageError && <div className="draft-image-error">{draftImageError}</div>}
          <TextArea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="输入消息..."
            value={input}
            onValueChange={setInput}
            onEnter={() => void handleSend()}
            rows={1}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              void addDraftImages(filesFromList(e.currentTarget.files));
              e.currentTarget.value = "";
            }}
          />
          <div className="input-bottom-row">
            <button
              className="input-config-btn"
              aria-label="选择模型"
              title={modelLabel}
              onClick={() => setShowModelSheet(true)}
            >
              <Cpu size={18} />
            </button>
            <button
              className="input-config-btn"
              aria-label={multimodal ? "添加图片" : "当前模型不支持图片"}
              title={multimodal ? "添加图片" : "当前模型不支持图片"}
              disabled={isRunning || imagesProcessing || !multimodal}
              onClick={() => fileInputRef.current?.click()}
            >
              {imagesProcessing ? <Loader2 className="draft-image-spin" size={18} /> : <Image size={18} />}
            </button>
            <span className="ai-model-inline" onClick={() => setShowModelSheet(true)}>{modelLabel}</span>
            {isRunning ? (
              <button className="send-btn cancel" onClick={handleCancel}>
                <Square size={18} />
              </button>
            ) : (
              <button className="send-btn" onClick={() => void handleSend()} disabled={sendDisabled}>
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </footer>

      {showModelSheet && (
        <AiModelSheet
          value={conversation?.modelRefId ?? ""}
          onClose={() => setShowModelSheet(false)}
          onSelect={handleSelectModel}
        />
      )}

      {previewImage && (
        <Portal>
          <div className="image-preview-overlay" onClick={() => setPreviewImage(null)}>
            <button
              className="image-preview-close"
              aria-label="关闭预览"
              onClick={() => setPreviewImage(null)}
              type="button"
            >
              <X size={22} />
            </button>
            <img
              className="image-preview-full"
              src={previewImage.url}
              alt={previewImage.name}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </Portal>
      )}
    </div>
  );
}

// ── 单条消息 ──

function AiMessageBubble({
  message,
  streaming,
  onPreviewImage,
}: {
  message: AiMessage;
  streaming: boolean;
  onPreviewImage: (url: string, name: string) => void;
}) {
  const isUser = message.role === "user";
  const time = message.updatedAt ?? message.createdAt;

  if (isUser) {
    return (
      <div className="message-row user">
        <div className="user-message-column">
          {message.images && message.images.length > 0 && (
            <div className="message-attachment-strip">
              {message.images.map((img, i) => (
                <button
                  key={i}
                  className="message-attachment-thumb"
                  title={img.name}
                  onClick={() => onPreviewImage(img.dataUrl, img.name)}
                  type="button"
                >
                  <img alt={img.name} src={img.dataUrl} />
                </button>
              ))}
            </div>
          )}
          {message.content && <div className="user-bubble">{message.content}</div>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="message-row assistant">
        <div className="assistant-content">
          <MessageRenderer content={message.content} streaming={streaming} />
          {message.error && <div className="ai-message-error">请求出错：{message.error}</div>}
        </div>
      </div>
      {!streaming && (
        <div className="message-time" title={formatFullDateTime(time)}>
          {formatMessageTime(time)}
        </div>
      )}
    </>
  );
}
