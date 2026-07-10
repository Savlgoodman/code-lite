import type { ChatMessage } from "@code-lite/protocol";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
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
          <div className="assistant-text">{message.content}</div>
        </div>
      )}
    </div>
  );
}
