import type { ChatMessage } from "@code-lite/protocol";
import { MessageRenderer } from "./MessageRenderer";
import { formatMessageTime, formatFullDateTime } from "../lib/formatters";

interface MessageBubbleProps {
  message: ChatMessage;
  showTimestamp?: boolean;
}

export function MessageBubble({ message, showTimestamp }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const turnEndTime = message.updatedAt ?? message.createdAt;

  return (
    <>
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
            <MessageRenderer content={message.content} streaming={message.streaming} />
          </div>
        )}
      </div>
      {showTimestamp && !isUser && !message.streaming && (
        <div className="message-time" title={formatFullDateTime(turnEndTime)}>
          {formatMessageTime(turnEndTime)}
        </div>
      )}
    </>
  );
}
