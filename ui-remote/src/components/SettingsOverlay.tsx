import { useState, useEffect, useRef } from "react";

interface SettingsOverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * 设置子页面浮层：与 ChatOverlay 相同的右侧滑入/推出动画。
 * open=true 时从右侧滑入，open=false 时向右推出并在动画结束后卸载内容。
 */
export function SettingsOverlay({ open, onClose, children }: SettingsOverlayProps) {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<"enter" | "shown" | "exit">(open ? "shown" : "enter");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setPhase("enter");
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => setPhase("shown"));
      });
    } else if (mounted) {
      setPhase("exit");
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [open, mounted]);

  if (!mounted) return null;

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget) return;
    if (phase === "exit") {
      setMounted(false);
      onClose();
    }
  };

  const phaseClass = phase === "shown" ? "" : phase;

  return (
    <div
      className={`chat-overlay ${phaseClass}`.trim()}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </div>
  );
}
