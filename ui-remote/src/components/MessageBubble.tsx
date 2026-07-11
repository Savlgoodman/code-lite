import { useEffect, useRef, useState } from "react";
import type { ChatMessage, MessageAttachment } from "@code-lite/protocol";
import { connectionManager } from "../services/ConnectionManager";
import { MessageRenderer } from "./MessageRenderer";
import { AssistantToolFlow, type DiffDetailTarget, type ToolDetailTarget } from "./AssistantToolFlow";
import { formatMessageTime, formatFullDateTime } from "../lib/formatters";

interface MessageBubbleProps {
  message: ChatMessage;
  conversationId: string;
  showTimestamp?: boolean;
  onPreviewImage?: (url: string, name: string) => void;
  onOpenTool?: (target: ToolDetailTarget) => void;
  onOpenDiff?: (target: DiffDetailTarget) => void;
}

/**
 * 历史消息中的图片附件：远端无 HTTP 通道，经 attachment.get RPC 拉 base64 渲染。
 * 拉到的 data URL 用组件级缓存（模块外 Map）避免同一附件重复请求。
 */
const attachmentUrlCache = new Map<string, string>();

function MessageAttachments({
  attachments,
  conversationId,
  onPreviewImage,
}: {
  attachments: MessageAttachment[];
  conversationId: string;
  onPreviewImage?: (url: string, name: string) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const client = connectionManager.getClient();
    if (!client) return;

    async function loadOne(attachment: MessageAttachment) {
      const cacheKey = `${conversationId}:${attachment.id}`;
      const cached = attachmentUrlCache.get(cacheKey);
      if (cached) {
        setUrls((prev) => (prev[attachment.id] ? prev : { ...prev, [attachment.id]: cached }));
        return;
      }
      try {
        const result = await client!.getAttachment(conversationId, attachment.id);
        const url = `data:${result.mimeType};base64,${result.data}`;
        attachmentUrlCache.set(cacheKey, url);
        if (!cancelledRef.current) {
          setUrls((prev) => ({ ...prev, [attachment.id]: url }));
        }
      } catch (err) {
        console.error("[MessageBubble] getAttachment failed:", err);
      }
    }

    for (const attachment of attachments) void loadOne(attachment);
    return () => {
      cancelledRef.current = true;
    };
  }, [attachments, conversationId]);

  return (
    <div className="message-attachment-strip">
      {attachments.map((attachment) => {
        const url = urls[attachment.id];
        return (
          <button
            className="message-attachment-thumb"
            key={attachment.id}
            disabled={!url}
            title={attachment.name}
            onClick={() => url && onPreviewImage?.(url, attachment.name || "图片")}
            type="button"
          >
            {url ? <img alt={attachment.name} src={url} /> : <span className="message-attachment-loading" />}
          </button>
        );
      })}
    </div>
  );
}

export function MessageBubble({
  message,
  conversationId,
  showTimestamp,
  onPreviewImage,
  onOpenTool,
  onOpenDiff,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const turnEndTime = message.updatedAt ?? message.createdAt;
  const imageAttachments = (message.attachments ?? []).filter((a) => a.kind === "image");

  return (
    <>
      <div className={`message-row ${isUser ? "user" : "assistant"}`}>
        {isUser ? (
          <div className="user-message-column">
            {imageAttachments.length > 0 && (
              <MessageAttachments
                attachments={imageAttachments}
                conversationId={conversationId}
                onPreviewImage={onPreviewImage}
              />
            )}
            {message.content && <div className="user-bubble">{message.content}</div>}
          </div>
        ) : (
          <div className="assistant-content">
            {message.reasoning && (
              <details className="reasoning-details">
                <summary>思考过程</summary>
                <div className="reasoning-text">{message.reasoning}</div>
              </details>
            )}
            {message.toolCalls.length > 0 ? (
              <AssistantToolFlow
                content={message.content}
                toolCalls={message.toolCalls}
                streaming={message.streaming}
                conversationId={conversationId}
                onOpenTool={(t) => onOpenTool?.(t)}
                onOpenDiff={(t) => onOpenDiff?.(t)}
              />
            ) : (
              <MessageRenderer content={message.content} streaming={message.streaming} />
            )}
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
