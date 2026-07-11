import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, ArrowDown, Image, Loader2, Send, Settings, Square, X } from "lucide-react";
import type { ChatMessage, Session, UserContentBlock } from "@code-lite/protocol";
import { useConversationState } from "../hooks/useConversations";
import { connectionManager } from "../services/ConnectionManager";
import { useSessionConfig } from "../hooks/useSessionConfig";
import { MessageBubble } from "../components/MessageBubble";
import { DetailOverlay, type DetailRoute } from "../components/DetailOverlay";
import { ApprovalCard } from "../components/ApprovalCard";
import { ConfigSheet } from "../sheets/ConfigSheet";
import { ConfigBar } from "../components/ConfigBar";
import { EmptyState, Button, Sheet, Portal } from "../components/ui";
import {
  IMAGE_ACCEPT,
  MAX_DRAFT_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
  blobToBase64,
  createDraftImage,
  revokeDraftImage,
  type DraftImage,
} from "../lib/draftImages";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** 三阶段缓动：加速 → 恒速 → 减速 */
function scrollCruiseProgress(progress: number) {
  const ramp = 0.22;
  const t = clamp(progress, 0, 1);
  if (t < ramp) {
    return (t * t) / (2 * ramp * (1 - ramp));
  }
  if (t > 1 - ramp) {
    const remaining = 1 - t;
    return 1 - (remaining * remaining) / (2 * ramp * (1 - ramp));
  }
  return (t - ramp / 2) / (1 - ramp);
}

/** 是否应显示该 assistant 消息的时间戳 */
function shouldShowTimestamp(msg: ChatMessage, index: number, messages: ChatMessage[], isRunning: boolean) {
  if (msg.role !== "assistant" || msg.streaming) return false;
  return !isRunning || index < messages.length - 1;
}

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
  const pendingApproval = view?.pendingApproval ?? null;
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const { config, updateConfig } = useSessionConfig(client, sessionId);
  const [input, setInput] = useState("");
  const [showConfigSheet, setShowConfigSheet] = useState(false);
  const [showContextModal, setShowContextModal] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [composerHeight, setComposerHeight] = useState(0);
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draftImageError, setDraftImageError] = useState<string | null>(null);
  const [imagesProcessing, setImagesProcessing] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [detailRoute, setDetailRoute] = useState<DetailRoute | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftImagesRef = useRef<DraftImage[]>([]);
  const smoothScrollFrameRef = useRef<number | null>(null);
  const smoothScrollActiveRef = useRef(false);

  draftImagesRef.current = draftImages;

  const isRunning = client?.isRunning(sessionId) ?? false;

  /** 判断是否在底部（8px 容差） */
  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  }, []);

  /** 取消正在进行的平滑滚动动画 */
  const cancelSmoothScroll = useCallback(() => {
    if (smoothScrollFrameRef.current !== null) {
      cancelAnimationFrame(smoothScrollFrameRef.current);
      smoothScrollFrameRef.current = null;
    }
    smoothScrollActiveRef.current = false;
  }, []);

  /** 带缓动动画的滚动到底部（加速→恒速→减速） */
  const animateScrollToBottom = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    cancelSmoothScroll();

    const startTop = element.scrollTop;
    const targetTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const distance = targetTop - startTop;
    if (distance <= 1) {
      element.scrollTop = targetTop;
      setIsPinnedToBottom(true);
      setShowScrollToBottom(false);
      return;
    }

    // 自适应时长：1.8px/ms，范围 [360ms, 860ms]
    const duration = clamp(Math.round(distance / 1.8), 360, 860);
    const startTime = performance.now();
    smoothScrollActiveRef.current = true;

    const step = (now: number) => {
      const progress = clamp((now - startTime) / duration, 0, 1);
      // 每帧重新读取 scrollHeight，处理流式内容增长
      const latestTargetTop = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = startTop + (latestTargetTop - startTop) * scrollCruiseProgress(progress);

      if (progress < 1) {
        smoothScrollFrameRef.current = requestAnimationFrame(step);
        return;
      }
      // 最终对齐
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      smoothScrollFrameRef.current = null;
      smoothScrollActiveRef.current = false;
      setIsPinnedToBottom(true);
      setShowScrollToBottom(false);
    };

    smoothScrollFrameRef.current = requestAnimationFrame(step);
  }, [cancelSmoothScroll]);

  /** 即时跳到底部（无动画） */
  const scrollToBottom = useCallback((behavior: "auto" | "smooth" = "auto") => {
    const element = scrollContainerRef.current;
    if (!element) return;
    if (behavior === "smooth") {
      animateScrollToBottom();
    } else {
      cancelSmoothScroll();
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      setIsPinnedToBottom(true);
      setShowScrollToBottom(false);
    }
  }, [animateScrollToBottom, cancelSmoothScroll]);

  // 滚动事件监听：更新磁吸状态 & 显示/隐藏回到底部按钮
  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    const handleScroll = () => {
      if (smoothScrollActiveRef.current) {
        setShowScrollToBottom(false);
        return;
      }
      const atBottom = isAtBottom(element);
      setIsPinnedToBottom(atBottom);
      setShowScrollToBottom(!atBottom);
    };

    const cancelOnUserScroll = () => cancelSmoothScroll();

    element.addEventListener("scroll", handleScroll, { passive: true });
    element.addEventListener("touchstart", cancelOnUserScroll, { passive: true });
    element.addEventListener("wheel", cancelOnUserScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
      element.removeEventListener("touchstart", cancelOnUserScroll);
      element.removeEventListener("wheel", cancelOnUserScroll);
    };
  }, [isAtBottom, cancelSmoothScroll]);

  // 消息更新时：仅在底部磁吸时自动跟随
  useEffect(() => {
    if (isPinnedToBottom) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    }
  }, [isPinnedToBottom, messages, scrollToBottom]);

  // 切换会话时：无条件滚动到底部
  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // textarea 自适应高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.max(48, Math.min(textareaRef.current.scrollHeight, 120)) + "px";
    }
  }, [input]);

  // 测量输入区域（config-bar + input-area）总高度，供回到底部按钮定位
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerHeight(el.offsetHeight));
    ro.observe(el);
    setComposerHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // 卸载时释放所有草稿图片的 objectURL，避免内存泄漏
  useEffect(() => {
    return () => {
      for (const image of draftImagesRef.current) revokeDraftImage(image);
    };
  }, []);

  // "正在思考" 流光指示器：running 且没有内容流式输出时显示
  useEffect(() => {
    if (!isRunning) {
      setShowThinking(false);
      return;
    }
    // 检查是否有正在 streaming 的 assistant 消息且已有内容
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const hasStreamingContent = lastAssistant?.streaming && lastAssistant.content.length > 0;

    if (!hasStreamingContent) {
      // 没有内容在 streaming，立即显示
      setShowThinking(true);
    } else {
      // 有内容在 streaming，延迟 1200ms 再显示（避免闪烁）
      const timer = setTimeout(() => setShowThinking(true), 1200);
      return () => clearTimeout(timer);
    }
  }, [isRunning, messages]);

  if (!session) {
    return (
      <div className="chat-page">
        <EmptyState title="会话不存在">
          <Button variant="secondary" onClick={onBack}>返回</Button>
        </EmptyState>
      </div>
    );
  }

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
      if (created.length > 0) {
        setDraftImages((prev) => {
          const next = [...prev, ...created];
          const totalBytes = next.reduce((sum, image) => sum + (image.normalized?.normalizedBytes ?? image.rawBytes), 0);
          if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
            for (const image of created) revokeDraftImage(image);
            failure = "图片总大小超过 200 MB。";
            return prev;
          }
          return next;
        });
      }
      if (files.length > slots) {
        failure = `最多添加 ${MAX_DRAFT_IMAGES} 张图片。`;
      }
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

  const handleSend = async () => {
    if (!client || imagesProcessing) return;
    const text = input.trim();
    const images = draftImagesRef.current;
    if (!text && images.length === 0) return;

    const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

    // 先上传图片附件（base64 走 WS），再把 attachmentId 组成 contentBlocks 随 turn 发出。
    let contentBlocks: UserContentBlock[] | undefined;
    if (images.length > 0) {
      setImagesProcessing(true);
      try {
        const uploaded = await Promise.all(
          images.map(async (image) => {
            const blob = image.normalized?.blob ?? image.file;
            const data = await blobToBase64(blob);
            return client.uploadAttachment({
              conversationId: sessionId,
              turnId,
              fileName: image.name,
              mimeType: image.normalized?.mimeType ?? image.mimeType,
              data,
              width: image.normalized?.width ?? image.width,
              height: image.normalized?.height ?? image.height,
              wasCompressed: image.normalized?.wasCompressed,
            });
          }),
        );
        contentBlocks = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...uploaded.map((attachment) => ({
            type: "image" as const,
            mimeType: attachment.mimeType as "image/png" | "image/jpeg" | "image/webp",
            source: { kind: "attachment" as const, attachmentId: attachment.id },
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            width: attachment.width,
            height: attachment.height,
            sha256: attachment.sha256,
            wasCompressed: attachment.wasCompressed,
          })),
        ];
      } catch (err) {
        console.error("[ChatPage] uploadAttachment failed:", err);
        setDraftImageError("图片上传失败: " + (err instanceof Error ? err.message : String(err)));
        setImagesProcessing(false);
        return;
      }
      setImagesProcessing(false);
    }

    // 上传成功后再清空输入（失败时保留草稿供重试）
    setInput("");
    clearDraftImages();
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await client.sendTurn({
        conversationId: sessionId,
        input: text,
        turnId,
        accessMode: sendConfig.accessMode,
        modelId: sendConfig.familyId || undefined,
        reasoningEffort: sendConfig.effort,
        contentBlocks,
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

  const handleResolveApproval = async (decision: "allow" | "deny") => {
    if (!client || !pendingApproval) return;
    setResolvingApproval(true);
    try {
      await client.resolveApproval(pendingApproval.approvalId, decision);
    } catch (err) {
      console.error("[ChatPage] resolveApproval failed:", err);
    } finally {
      setResolvingApproval(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 上下文占用（来自 agent.context.updated / run.completed 累积的 usage）
  const usage = view?.contextUsage ?? null;
  const contextUsed = usage?.contextUsedTokens ?? usage?.totalTokens ?? 0;
  const contextWindow = usage?.contextWindowTokens ?? 0;
  const hasContextUsage = contextUsed > 0 && contextWindow > 0;
  const contextRatio = hasContextUsage ? Math.min(contextUsed / contextWindow, 1) : 0;
  const contextPercent = Math.round(contextRatio * 100);

  // 从 capabilities 中获取模型显示名
  const modelLabel = config?.grouping.families.find((f) => f.familyId === config.familyId)?.label
    || config?.familyId
    || "-";

  const effort = config?.effort || "";
  const effortLabel = effort || "-";

  const accessModeId = config?.accessMode || "";
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
      <div className="chat-messages" ref={scrollContainerRef}>
        {messages.length === 0 ? (
          <EmptyState title="开始对话">输入你的问题，AI 将为你解答</EmptyState>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              conversationId={sessionId}
              showTimestamp={shouldShowTimestamp(msg, i, messages, isRunning)}
              onPreviewImage={(url, name) => setPreviewImage({ url, name })}
              onOpenTool={(target) => setDetailRoute({ kind: "tool", target })}
              onOpenDiff={(target) => setDetailRoute({ kind: "diff", target })}
            />
          ))
        )}
        {/* 正在思考流光指示器 */}
        {showThinking && (
          <div className="thinking-indicator-row">
            <span className="thinking-indicator" data-text="正在思考">正在思考</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 回到底部按钮（输入框上方） */}
      {showScrollToBottom && (
        <button
          className="scroll-bottom-button"
          style={{ bottom: composerHeight + 8 }}
          aria-label="回到底部"
          onClick={() => {
            setShowScrollToBottom(false);
            scrollToBottom("smooth");
          }}
        >
          <ArrowDown size={18} />
        </button>
      )}

      {/* 底部输入区（含配置栏） */}
      <div ref={composerRef}>
        {/* 审批卡片：输入框上方，不进消息历史 */}
        {pendingApproval && (
          <ApprovalCard
            approval={pendingApproval}
            disabled={resolvingApproval}
            onResolve={handleResolveApproval}
          />
        )}

        {/* 顶部信息栏 (输入框上方边缘) */}
        <ConfigBar
          agent={session.agent}
          accessModeId={accessModeId}
          accessModeLabel={accessModeLabel}
          modelLabel={modelLabel}
          effort={effort}
          effortLabel={effortLabel}
        />

      {/* 底部输入区 */}
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
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="输入消息..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
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
            <button className="input-config-btn" onClick={() => setShowConfigSheet(true)}>
              <Settings size={18} />
            </button>
            <button
              className="input-config-btn"
              aria-label="添加图片"
              title="添加图片"
              disabled={isRunning || imagesProcessing}
              onClick={() => fileInputRef.current?.click()}
            >
              {imagesProcessing ? <Loader2 className="draft-image-spin" size={18} /> : <Image size={18} />}
            </button>
            <button
              className="context-ring"
              onClick={() => setShowContextModal(true)}
              aria-label={hasContextUsage ? `上下文占用 ${contextPercent}%` : "上下文占用"}
              title="上下文占用"
            >
              <svg viewBox="0 0 24 24" width="22" height="22">
                <circle cx="12" cy="12" r="9" fill="none" stroke="var(--line)" strokeWidth="3.5" />
                <circle
                  cx="12" cy="12" r="9" fill="none"
                  stroke={contextRatio > 0.8 ? "var(--orange)" : "var(--text)"}
                  strokeWidth="3.5"
                  strokeDasharray={2 * Math.PI * 9}
                  strokeDashoffset={2 * Math.PI * 9 * (1 - contextRatio)}
                  strokeLinecap="round"
                  transform="rotate(-90 12 12)"
                  style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
                />
              </svg>
            </button>
            {isRunning ? (
              <button className="send-btn cancel" onClick={handleCancel}>
                <Square size={18} />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={(!input.trim() && draftImages.length === 0) || imagesProcessing}
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </footer>
      </div>

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

      {/* 上下文占用弹窗 */}
      {showContextModal && (
        <Sheet title="上下文占用" onClose={() => setShowContextModal(false)}>
          {hasContextUsage ? (
            <div className="context-usage">
              <div className="context-usage-figure">
                <span className="context-usage-used">{contextUsed.toLocaleString()}</span>
                <span className="context-usage-total">/ {contextWindow.toLocaleString()}</span>
              </div>
              <div className="context-usage-bar">
                <div
                  className="context-usage-bar-fill"
                  style={{
                    width: `${contextPercent}%`,
                    background: contextRatio > 0.8 ? "var(--orange)" : "var(--accent)",
                  }}
                />
              </div>
              <div className="context-usage-percent">{contextPercent}% 已使用</div>
            </div>
          ) : (
            <div className="context-usage-empty">暂无上下文占用数据</div>
          )}
        </Sheet>
      )}

      {/* 工具/diff 详情页浮层：叠在会话页之上，右侧滑入 */}
      <DetailOverlay route={detailRoute} onBack={() => setDetailRoute(null)} />

      {/* 图片预览：全屏浮层经 Portal 逃逸父级 transform 裁剪 */}
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
