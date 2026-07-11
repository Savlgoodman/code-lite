import { useState, useCallback, useRef, type ReactNode } from "react";
import { Portal } from "./Portal";

/**
 * 供 footer / children 调用的带离场动画的关闭函数。
 * 可选传入 after：离场动画结束后执行该回调（如保存），否则执行默认 onClose。
 */
export type SheetClose = (after?: () => void) => void;

interface SheetProps {
  title: ReactNode;
  /** 离场动画结束后触发（父组件在此卸载 Sheet） */
  onClose: () => void;
  /** children 可为节点，或接收 close 的渲染函数（用于自定义关闭时机） */
  children: ReactNode | ((close: SheetClose) => ReactNode);
  /** 底部操作区；可为节点，或接收 close 的渲染函数 */
  footer?: ReactNode | ((close: SheetClose) => ReactNode);
  /** 附加到 .modal-sheet 的类名，如 dir-browser */
  className?: string;
  /** header 与 body 之间插入的额外内容（如目录浏览器的路径栏） */
  beforeBody?: ReactNode;
  /** body 上的附加类名 */
  bodyClassName?: string;
}

/**
 * 底部抽屉式弹层：统一 overlay + 滑入/滑出动画 + 头部关闭按钮。
 *
 * 内部维护 closing 状态：任一关闭动作先播下滑离场动画，
 * onAnimationEnd 后再调用父级 onClose 卸载。footer / children 可用
 * 渲染函数形式拿到 close，使自定义按钮（取消/确认）也走离场动画。
 */
export function Sheet({ title, onClose, children, footer, className = "", beforeBody, bodyClassName = "" }: SheetProps) {
  const [closing, setClosing] = useState(false);
  const afterRef = useRef<(() => void) | null>(null);

  const close = useCallback<SheetClose>((after) => {
    afterRef.current = after ?? null;
    setClosing(true);
  }, []);

  const handleAnimEnd = (e: React.AnimationEvent) => {
    // 只响应抽屉自身的滑出动画，忽略子元素冒泡（如加载 spinner、流光）
    if (e.target !== e.currentTarget) return;
    if (!closing) return;
    // 有 after 回调则执行它，否则走默认卸载
    if (afterRef.current) afterRef.current();
    else onClose();
  };

  const renderedChildren = typeof children === "function" ? children(close) : children;
  const renderedFooter = typeof footer === "function" ? footer(close) : footer;

  return (
    <Portal>
      <div
        className={`modal-overlay${closing ? " closing" : ""}`}
        onClick={() => close()}
      >
        <div
          className={`modal-sheet ${className}`.trim()}
          onClick={(e) => e.stopPropagation()}
          onAnimationEnd={handleAnimEnd}
        >
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="modal-close" onClick={() => close()} aria-label="关闭">✕</button>
          </div>
          {beforeBody}
          <div className={`modal-body ${bodyClassName}`.trim()}>{renderedChildren}</div>
          {renderedFooter && <div className="modal-footer">{renderedFooter}</div>}
        </div>
      </div>
    </Portal>
  );
}
