import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Portal } from "./Portal";

interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = 主操作（大号，屏幕底部）；secondary = 次操作（小号，堆叠其上） */
  variant?: "primary" | "secondary";
  /** 高亮激活态（如排序开启） */
  active?: boolean;
  children: ReactNode;
}

/**
 * 悬浮操作按钮。经 Portal 渲染到 body，脱离 HomePager 的 transform 容器，
 * 从而对齐视口而非轨道盒（否则各 Tab 的 FAB 会叠加在同一处）。
 */
export function Fab({ variant = "primary", active = false, className = "", children, ...rest }: FabProps) {
  const classes = ["fab", `fab-${variant}`, active ? "active" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Portal>
      <button className={classes} {...rest}>
        {children}
      </button>
    </Portal>
  );
}
