import { ArrowDown } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { MessageRenderer } from "../../components/MessageRenderer";
import { formatConversationBoundaryTime } from "../../lib/formatters";
import type { ChatMessage } from "../../types";
import { buildAssistantInlineEntries } from "./messageTools";
import { ToolCallGroup } from "./ToolCallViews";
import "./MessageList.css";

function AssistantMessageContent({ message }: { message: ChatMessage }) {
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

          {entry.toolGroups.length > 0 ? (
            <div className="tool-call-list inline-tool-call-list">
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

function shouldShowTurnEndTime(message: ChatMessage, index: number, messages: ChatMessage[], isRunning: boolean) {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }

  return !isRunning || index < messages.length - 1;
}

const MessageItem = memo(function MessageItem({
  message,
  showTurnEndTime,
  turnEndTime
}: {
  message: ChatMessage;
  showTurnEndTime: boolean;
  turnEndTime: number;
}) {
  const isThinking = message.role === "assistant" && Boolean(message.streaming) && !message.content.trim();

  return (
    <article className={`message ${message.role}`}>
      <div className="message-body">
        {message.role === "assistant" ? (
          <AssistantMessageContent message={message} />
        ) : (
          <p className="user-message-text">{message.content}</p>
        )}

        {isThinking ? (
          <div className="thinking-indicator" aria-live="polite" data-text="正在思考">
            正在思考
          </div>
        ) : null}

        {message.reasoning ? (
          <details className="reasoning-block">
            <summary>思考过程</summary>
            <p>{message.reasoning}</p>
          </details>
        ) : null}

        {message.error ? <p className="message-error">{message.error}</p> : null}

        {showTurnEndTime ? (
          <div className="conversation-boundary-time">
            {formatConversationBoundaryTime(turnEndTime)}
          </div>
        ) : null}
      </div>
    </article>
  );
});

interface MessageListProps {
  isRunning: boolean;
  messages: ChatMessage[];
  sessionId: string;
  updatedAt: number;
}

export function MessageList({ isRunning, messages, sessionId, updatedAt }: MessageListProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [scrollbarState, setScrollbarState] = useState({
    thumbHeight: 100,
    thumbTop: 0,
    visible: false
  });

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

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({
      behavior,
      top: element.scrollHeight
    });
  }

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const handleScroll = () => {
      const nextIsAtBottom = isAtBottom(element);
      setIsPinnedToBottom(nextIsAtBottom);
      setShowScrollToBottom(!nextIsAtBottom);
      updateScrollbarState(element);
    };

    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      element.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
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
  }, [isPinnedToBottom, messages]);

  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [sessionId]);

  return (
    <>
      <section className="chat-scroll" ref={scrollRef}>
        <div className="chat-content">
          {messages.map((message, index) => (
            <MessageItem
              key={`${sessionId}-${message.id}`}
              message={message}
              showTurnEndTime={shouldShowTurnEndTime(message, index, messages, isRunning)}
              turnEndTime={message.updatedAt ?? (index === messages.length - 1 ? updatedAt : message.createdAt)}
            />
          ))}
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
            setIsPinnedToBottom(true);
            setShowScrollToBottom(false);
            scrollToBottom("smooth");
          }}
        >
          <ArrowDown size={17} />
        </button>
      ) : null}
    </>
  );
}
