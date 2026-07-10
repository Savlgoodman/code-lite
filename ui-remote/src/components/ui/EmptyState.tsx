import type { ReactNode } from "react";

interface EmptyStateProps {
  /** 大号图标（emoji 或节点） */
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}

/** 空状态占位：居中图标 + 标题 + 说明。 */
export function EmptyState({ icon, title, children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      {title && <h2>{title}</h2>}
      {children && <p>{children}</p>}
    </div>
  );
}
