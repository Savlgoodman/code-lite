import { useEffect, useRef, useState } from "react";
import { Portal } from "./ui";
import { ToolDetailPage } from "../pages/ToolDetailPage";
import { DiffDetailPage } from "../pages/DiffDetailPage";
import type { DiffDetailTarget, ToolDetailTarget } from "./AssistantToolFlow";

export type DetailRoute =
  | { kind: "tool"; target: ToolDetailTarget }
  | { kind: "diff"; target: DiffDetailTarget };

interface DetailOverlayProps {
  /** 当前详情路由；为 null 时执行退出动画后卸载。 */
  route: DetailRoute | null;
  onBack: () => void;
}

/**
 * 会话内详情页浮层（工具/diff）：叠在 ChatOverlay 之上，从右滑入。
 * 经 Portal 逃逸 HomePager transform 裁剪；退出保留 DOM 直至动画结束。
 */
export function DetailOverlay({ route, onBack }: DetailOverlayProps) {
  const [rendered, setRendered] = useState<DetailRoute | null>(route);
  const [phase, setPhase] = useState<"enter" | "shown" | "exit">(route ? "shown" : "enter");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (route) {
      setRendered(route);
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
  }, [route]);

  if (!rendered) return null;

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget) return;
    if (phase === "exit") setRendered(null);
  };

  const phaseClass = phase === "shown" ? "" : phase;

  return (
    <Portal>
      <div className={`detail-overlay ${phaseClass}`.trim()} onTransitionEnd={handleTransitionEnd}>
        {rendered.kind === "tool" ? (
          <ToolDetailPage tool={rendered.target.tool} onBack={onBack} />
        ) : (
          <DiffDetailPage
            diff={rendered.target.diff}
            conversationId={rendered.target.conversationId}
            onBack={onBack}
          />
        )}
      </div>
    </Portal>
  );
}
