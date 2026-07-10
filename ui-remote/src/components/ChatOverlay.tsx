import { useState, useEffect, useRef } from "react";
import { ChatPage } from "../pages/ChatPage";

interface ChatOverlayProps {
  /** 当前查看的会话 id；为 null 时执行退出动画后卸载 */
  sessionId: string | null;
  onBack: () => void;
}

/**
 * 会话页浮层：sessionId 出现时从右侧滑入，
 * 变为 null 时向右推出并在动画结束后卸载。
 */
export function ChatOverlay({ sessionId, onBack }: ChatOverlayProps) {
  // renderedId 在退出动画期间保留，避免内容提前消失
  const [renderedId, setRenderedId] = useState<string | null>(sessionId);
  const [phase, setPhase] = useState<"enter" | "shown" | "exit">(sessionId ? "shown" : "enter");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (sessionId) {
      setRenderedId(sessionId);
      setPhase("enter"); // 先停在屏幕右侧外
      // 双 rAF 确保初始位置已提交，再触发滑入过渡
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => setPhase("shown"));
      });
    } else {
      setPhase("exit");
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [sessionId]);

  if (!renderedId) return null;

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    // 仅响应浮层自身的 transform 过渡，忽略子元素冒泡
    if (e.target !== e.currentTarget) return;
    if (phase === "exit") setRenderedId(null);
  };

  const phaseClass = phase === "shown" ? "" : phase;

  return (
    <div
      className={`chat-overlay ${phaseClass}`.trim()}
      onTransitionEnd={handleTransitionEnd}
    >
      <ChatPage sessionId={renderedId} onBack={onBack} />
    </div>
  );
}
