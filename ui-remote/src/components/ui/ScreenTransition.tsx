import { useState, useEffect, useRef, type ReactNode } from "react";

/**
 * ScreenTransition — 统一的整页进出场转场原语。
 *
 * 收敛了历史上 ChatOverlay / AiChatOverlay / SettingsOverlay / DetailOverlay 四处
 * 重复的 rAF 相位机：进入前先停在屏幕外，双 rAF 提交初始位后再过渡到位；
 * `show` 变 false 时播离场过渡，`transitionend` 后回调 onExited 让父级卸载。
 *
 * 视觉与令牌不变：沿用 navigation.css 里 `.screen-layer` 的 transform 过渡
 * （由 from 决定初始位方向）。新增整页一律经此原语，不要再各写一套动画。
 */

export type TransitionFrom = "right" | "bottom";

interface ScreenTransitionProps {
  /** 是否应处于「显示」状态；false 触发离场。 */
  show: boolean;
  /** 离场过渡结束后触发（父组件在此卸载）。 */
  onExited: () => void;
  /** 初始/离场停靠方向。默认从右（整页），bottom 用于底部滑入语义。 */
  from?: TransitionFrom;
  /** 附加类名（如 chat-layer / detail-layer 用于层级 z-index）。 */
  className?: string;
  children: ReactNode;
}

export function ScreenTransition({
  show,
  onExited,
  from = "right",
  className = "",
  children,
}: ScreenTransitionProps) {
  const [phase, setPhase] = useState<"enter" | "shown" | "exit">(show ? "shown" : "enter");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (show) {
      setPhase("enter"); // 先停在屏幕外
      // 双 rAF 确保初始位已提交，再触发滑入过渡
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => setPhase("shown"));
      });
    } else {
      setPhase("exit");
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [show]);

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    // 仅响应本层自身的 transform 过渡，忽略子元素冒泡
    if (e.target !== e.currentTarget) return;
    if (phase === "exit") onExited();
  };

  const phaseClass = phase === "shown" ? "" : phase;

  return (
    <div
      className={`screen-layer from-${from} ${className} ${phaseClass}`.replace(/\s+/g, " ").trim()}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </div>
  );
}
