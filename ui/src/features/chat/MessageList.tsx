import { ArrowDown, ChevronRight, Minimize2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { MessageRenderer } from "../../components/MessageRenderer";
import { formatConversationBoundaryTime } from "../../lib/formatters";
import { attachmentImageUrl } from "../../services/agentClient";
import type { ChatMessage } from "../../types";
import { ImagePreview, type PreviewImage } from "./ImagePreview";
import { buildAssistantInlineEntries } from "./messageTools";
import { FileEditGroup, ToolCallGroup } from "./ToolCallViews";
import "./MessageList.css";

const COMPACT_SIGNALS = [
  "context compacted",
  "compacting",
  "context compressed",
  "上下文已压缩",
];

function isCompactedMessage(message: ChatMessage): boolean {
  const content = message.content.toLowerCase();
  return COMPACT_SIGNALS.some(signal => content.includes(signal));
}

function isCompactPrompt(value?: string): boolean {
  return /^\/compact(?:\s|$)/i.test((value ?? "").trim());
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

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

function formatFullDateTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function AssistantMessageContent({
  isCompactTurn,
  message,
  sessionId,
}: {
  isCompactTurn: boolean;
  message: ChatMessage;
  sessionId: string;
}) {
  if (isCompactTurn && !message.error) {
    return null;
  }

  const entries = buildAssistantInlineEntries(message.content, message.toolCalls);

  if (entries.length === 0) {
    return <MessageRenderer content={message.content} streaming={message.streaming} />;
  }

  const lastTextEntryIndex = entries.reduce(
    (lastIndex, entry, index) => (entry.content.trim() ? index : lastIndex),
    -1
  );

  return (
    <div className="assistant-flow">
      {entries.map((entry, index) => (
        <div className="assistant-flow-block" key={`${message.id}-${entry.key}`}>
          {entry.content.trim() ? (
            <MessageRenderer
              content={entry.content}
              streaming={message.streaming && index === lastTextEntryIndex}
            />
          ) : null}

          {entry.fileEditGroups.length > 0 || entry.toolGroups.length > 0 ? (
            <div className="tool-call-list inline-tool-call-list">
              {entry.fileEditGroups.map((tools) => (
                <FileEditGroup
                  conversationId={sessionId}
                  key={`file-edit-${tools.map((tool) => tool.id).join("-")}`}
                  tools={tools}
                />
              ))}
              {entry.toolGroups.map((tools) => (
                <ToolCallGroup
                  collapseWhenFollowedByText={entries.slice(index + 1).some((nextEntry) => nextEntry.content.trim())}
                  key={tools.map((tool) => tool.id).join("-")}
                  tools={tools}
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function UserMessageAttachments({
  message,
  onPreviewImage,
  sessionId,
}: {
  message: ChatMessage;
  onPreviewImage: (image: PreviewImage) => void;
  sessionId: string;
}) {
  const attachments = useMemo(
    () => (message.attachments ?? []).filter((attachment) => attachment.kind === "image"),
    [message.attachments],
  );
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadUrls() {
      const entries = await Promise.all(
        attachments.map(async (attachment) => [
          attachment.id,
          attachment.previewUrl ?? await attachmentImageUrl(sessionId, attachment.id),
        ] as const),
      );
      if (!cancelled) {
        setUrls(Object.fromEntries(entries));
      }
    }
    if (attachments.length > 0) {
      void loadUrls();
    } else {
      setUrls({});
    }
    return () => {
      cancelled = true;
    };
  }, [attachments, sessionId]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="user-attachment-strip">
      {attachments.map((attachment) => (
        <button
          className="user-attachment-thumb"
          disabled={!urls[attachment.id]}
          key={attachment.id}
          onClick={() => {
            const url = urls[attachment.id];
            if (url) {
              onPreviewImage({ name: attachment.name || "图片预览", url });
            }
          }}
          title={attachment.name}
        >
          {urls[attachment.id] ? <img alt={attachment.name} src={urls[attachment.id]} /> : null}
        </button>
      ))}
    </div>
  );
}

function shouldShowTurnEndTime(message: ChatMessage, index: number, messages: ChatMessage[], isRunning: boolean) {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }

  return !isRunning || index < messages.length - 1;
}

const MessageItem = memo(function MessageItem({
  isCompactTurn,
  message,
  onPreviewImage,
  sessionId,
  showTurnEndTime,
  turnEndTime
}: {
  isCompactTurn: boolean;
  message: ChatMessage;
  onPreviewImage: (image: PreviewImage) => void;
  sessionId: string;
  showTurnEndTime: boolean;
  turnEndTime: number;
}) {
  const showCompactionIndicator =
    message.role === "assistant" && !message.streaming && !message.error && (isCompactTurn || isCompactedMessage(message));

  return (
    <article className={`message ${message.role}`}>
      <div className="message-body">
        {message.role === "assistant" && message.reasoning ? (
          <details className="reasoning-block">
            <summary className="reasoning-summary">
              <span>思考过程</span>
              <ChevronRight aria-hidden="true" className="reasoning-summary-icon" size={13} strokeWidth={2.2} />
            </summary>
            <div className="reasoning-content">
              <MessageRenderer content={message.reasoning} />
            </div>
          </details>
        ) : null}

        {message.role === "assistant" ? (
          <AssistantMessageContent isCompactTurn={isCompactTurn} message={message} sessionId={sessionId} />
        ) : (
          <div className="user-message-stack">
            <UserMessageAttachments message={message} onPreviewImage={onPreviewImage} sessionId={sessionId} />
            {message.content ? <p className="user-message-text">{message.content}</p> : null}
          </div>
        )}

        {message.error ? <p className="message-error">{message.error}</p> : null}

        {showCompactionIndicator ? (
          <div className="compaction-indicator">
            <Minimize2 aria-hidden="true" size={14} strokeWidth={1.9} />
            <span>上下文已压缩</span>
          </div>
        ) : null}

        {showTurnEndTime && !isCompactTurn ? (
          <div className="conversation-boundary-time" title={formatFullDateTime(turnEndTime)}>
            {formatConversationBoundaryTime(turnEndTime)}
          </div>
        ) : null}
      </div>
    </article>
  );
});

interface MessageListProps {
  isRunning: boolean;
  isWaitingForUser?: boolean;
  messages: ChatMessage[];
  sessionId: string;
  updatedAt: number;
}

export function MessageList({ isRunning, isWaitingForUser = false, messages, sessionId, updatedAt }: MessageListProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const isPinnedToBottomRef = useRef(true);
  const smoothScrollFrameRef = useRef<number | null>(null);
  const smoothScrollActiveRef = useRef(false);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showRunningThinking, setShowRunningThinking] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [scrollbarState, setScrollbarState] = useState({
    thumbHeight: 100,
    thumbTop: 0,
    visible: false
  });
  const latestStreamingAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.streaming) {
        return index;
      }
    }
    return -1;
  }, [messages]);
  const latestStreamingAssistant = latestStreamingAssistantIndex >= 0 ? messages[latestStreamingAssistantIndex] : null;
  const compactSourceMessage =
    latestStreamingAssistantIndex >= 0 ? messages[latestStreamingAssistantIndex - 1] : messages[messages.length - 1];
  const runningThinkingText = isCompactPrompt(compactSourceMessage?.content) ? "正在压缩" : "正在思考";
  const canShowRunningThinking = isRunning && !isWaitingForUser;
  const shouldShowThinkingImmediately = canShowRunningThinking && (!latestStreamingAssistant || !latestStreamingAssistant.content.trim());

  isPinnedToBottomRef.current = isPinnedToBottom;

  function isAtBottom(element: HTMLElement) {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
  }

  function updateScrollbarState(element: HTMLElement) {
    const scrollRange = element.scrollHeight - element.clientHeight;
    const visible = scrollRange > 1;
    if (!visible) {
      setScrollbarState({ thumbHeight: 100, thumbTop: 0, visible: false });
      return;
    }

    const thumbHeight = Math.max(8, (element.clientHeight / element.scrollHeight) * 100);
    const thumbTop = Math.min(100 - thumbHeight, (element.scrollTop / scrollRange) * (100 - thumbHeight));
    setScrollbarState({ thumbHeight, thumbTop, visible: true });
  }

  function cancelSmoothScroll() {
    if (smoothScrollFrameRef.current !== null) {
      cancelAnimationFrame(smoothScrollFrameRef.current);
      smoothScrollFrameRef.current = null;
    }
    smoothScrollActiveRef.current = false;
  }

  function animateScrollToBottom(element: HTMLElement) {
    cancelSmoothScroll();

    const startTop = element.scrollTop;
    const targetTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const distance = targetTop - startTop;
    if (distance <= 1) {
      element.scrollTop = targetTop;
      setIsPinnedToBottom(true);
      setShowScrollToBottom(false);
      updateScrollbarState(element);
      return;
    }

    const duration = clamp(Math.round(distance / 1.8), 360, 860);
    const startTime = performance.now();
    smoothScrollActiveRef.current = true;

    const step = (now: number) => {
      const progress = clamp((now - startTime) / duration, 0, 1);
      const latestTargetTop = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = startTop + (latestTargetTop - startTop) * scrollCruiseProgress(progress);

      if (progress < 1) {
        smoothScrollFrameRef.current = requestAnimationFrame(step);
        return;
      }

      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      smoothScrollFrameRef.current = null;
      smoothScrollActiveRef.current = false;
      setIsPinnedToBottom(true);
      setShowScrollToBottom(false);
      updateScrollbarState(element);
    };

    smoothScrollFrameRef.current = requestAnimationFrame(step);
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    if (behavior === "smooth") {
      animateScrollToBottom(element);
      return;
    }
    cancelSmoothScroll();
    element.scrollTo({
      behavior,
      top: element.scrollHeight
    });
  }

  useEffect(() => {
    if (!canShowRunningThinking) {
      setShowRunningThinking(false);
      return undefined;
    }
    if (shouldShowThinkingImmediately) {
      setShowRunningThinking(true);
      return undefined;
    }

    setShowRunningThinking(false);
    const timer = window.setTimeout(() => setShowRunningThinking(true), 1200);
    return () => window.clearTimeout(timer);
  }, [
    canShowRunningThinking,
    latestStreamingAssistant?.content,
    latestStreamingAssistant?.id,
    shouldShowThinkingImmediately
  ]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const handleScroll = () => {
      const nextIsAtBottom = isAtBottom(element);
      setIsPinnedToBottom(nextIsAtBottom);
      if (smoothScrollActiveRef.current) {
        setShowScrollToBottom(false);
        updateScrollbarState(element);
        return;
      }
      setShowScrollToBottom(!nextIsAtBottom);
      updateScrollbarState(element);
    };
    const cancelOnUserScroll = () => cancelSmoothScroll();

    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    element.addEventListener("touchstart", cancelOnUserScroll, { passive: true });
    element.addEventListener("wheel", cancelOnUserScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      cancelSmoothScroll();
      element.removeEventListener("scroll", handleScroll);
      element.removeEventListener("touchstart", cancelOnUserScroll);
      element.removeEventListener("wheel", cancelOnUserScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [sessionId]);

  // 内容高度变化（如工具调用卡片展开/收起、图片加载）时重算磁吸与滚动条，
  // 避免展开的卡片撑高后贴底位置错位、把页面滚动"卡住"。
  useEffect(() => {
    const content = contentRef.current;
    const element = scrollRef.current;
    if (!content || !element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (isPinnedToBottomRef.current && !smoothScrollActiveRef.current) {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      }
      updateScrollbarState(element);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId]);

  useEffect(() => {
    if (isPinnedToBottom) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    }
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) {
        updateScrollbarState(element);
      }
    });
  }, [isPinnedToBottom, messages, showRunningThinking]);

  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [sessionId]);

  return (
    <>
      <section className="chat-scroll" ref={scrollRef}>
        <div className="chat-content" ref={contentRef}>
          {messages.map((message, index) => (
            <MessageItem
              isCompactTurn={message.role === "assistant" && isCompactPrompt(messages[index - 1]?.content)}
              key={`${sessionId}-${message.id}`}
              message={message}
              onPreviewImage={setPreviewImage}
              sessionId={sessionId}
              showTurnEndTime={shouldShowTurnEndTime(message, index, messages, isRunning)}
              turnEndTime={message.updatedAt ?? (index === messages.length - 1 ? updatedAt : message.createdAt)}
            />
          ))}
          {showRunningThinking ? (
            <div className="chat-running-thinking" role="status" aria-live="polite">
              <span className="thinking-indicator" data-text={runningThinkingText}>
                {runningThinkingText}
              </span>
            </div>
          ) : null}
        </div>
      </section>
      {scrollbarState.visible ? (
        <div className="chat-scrollbar" aria-hidden="true">
          <i style={{ height: `${scrollbarState.thumbHeight}%`, top: `${scrollbarState.thumbTop}%` }} />
        </div>
      ) : null}
      {showScrollToBottom ? (
        <button
          className="scroll-bottom-button"
          aria-label="回到底部"
          onClick={() => {
            setShowScrollToBottom(false);
            scrollToBottom("smooth");
          }}
        >
          <ArrowDown size={17} />
        </button>
      ) : null}
      <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />
    </>
  );
}
