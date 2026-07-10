import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 把子节点渲染到 document.body，脱离 HomePager 的 transform 容器。
 * transform 会成为 fixed/absolute 后代的包含块，导致浮层错位或被裁剪，
 * 因此所有全屏浮层（Sheet / FAB）都需经此逃逸到 body。
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
