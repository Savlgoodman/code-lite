import { useState, useEffect, useRef } from "react";
import { AiChatPage } from "../pages/AiChatPage";

interface AiChatOverlayProps {
  /** 当前查看的 AI 对话 id；为 null 时执行退出动画后卸载 */
  conversationId: string | null;
  onBack: () => void;
}

/** AI 对话页浮层：与 ChatOverlay 相同的右侧滑入/推出动画。 */
export function AiChatOverlay({ conversationId, onBack }: AiChatOverlayProps) {
  const [renderedId, setRenderedId] = useState<string | null>(conversationId);
  const [phase, setPhase] = useState<"enter" | "shown" | "exit">(conversationId ? "shown" : "enter");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (conversationId) {
      setRenderedId(conversationId);
      setPhase("enter");
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => setPhase("shown"));
      });
    } else {
      setPhase("exit");
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [conversationId]);

  if (!renderedId) return null;

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget) return;
    if (phase === "exit") setRenderedId(null);
  };

  const phaseClass = phase === "shown" ? "" : phase;

  return (
    <div
      className={`chat-overlay ${phaseClass}`.trim()}
      onTransitionEnd={handleTransitionEnd}
    >
      <AiChatPage conversationId={renderedId} onBack={onBack} />
    </div>
  );
}
