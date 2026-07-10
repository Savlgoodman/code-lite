import type { ReactNode } from "react";
import { Portal } from "./Portal";

interface SheetProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（通常放取消 / 确认按钮） */
  footer?: ReactNode;
  /** 附加到 .modal-sheet 的类名，如 dir-browser */
  className?: string;
  /** header 与 body 之间插入的额外内容（如目录浏览器的路径栏） */
  beforeBody?: ReactNode;
  /** body 上的附加类名 */
  bodyClassName?: string;
}

/** 底部抽屉式弹层：统一 overlay + 滑入动画 + 头部关闭按钮。 */
export function Sheet({ title, onClose, children, footer, className = "", beforeBody, bodyClassName = "" }: SheetProps) {
  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className={`modal-sheet ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="modal-close" onClick={onClose} aria-label="关闭">✕</button>
          </div>
          {beforeBody}
          <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
