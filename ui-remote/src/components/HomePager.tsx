import { useState, useRef, cloneElement, isValidElement, type ReactElement } from "react";

interface HomePagerProps {
  /** 当前激活面板索引（0..panes.length-1） */
  index: number;
  /** 切换到的目标索引（滑动/点击提交时回调） */
  onIndexChange: (index: number) => void;
  panes: ReactElement[];
  /** chat 打开时底层后退，形成层级纵深 */
  behind?: boolean;
}

/** 提交切页的滑动阈值：超过视宽 22% 或甩动速度够快即换页。 */
const COMMIT_RATIO = 0.22;

/**
 * 主界面横向分页容器：把各 Tab 排成一条横向轨道，
 * 支持点击 Tab 与手指拖拽两种方式在面板间平移切换。
 *
 * 会向每个 pane 注入 `active` 布尔，供其决定是否渲染 FAB 等
 * 全屏浮层——所有面板同时挂载，若不 gate 会互相叠加。
 */
export function HomePager({ index, onIndexChange, panes, behind = false }: HomePagerProps) {
  const count = panes.length;
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖拽偏移（px）；null 表示未在拖拽，走 CSS 过渡
  const [dragDx, setDragDx] = useState<number | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const width = useRef(0);
  const axisLocked = useRef<"h" | "v" | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    if (behind) return; // chat 打开时不响应
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    width.current = trackRef.current?.clientWidth ?? window.innerWidth;
    axisLocked.current = null;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (behind) return;
    const t = e.touches[0];
    const dx = t.clientX - startX.current;
    const dy = t.clientY - startY.current;

    // 首次移动判定主轴：纵向滚动优先，避免与列表滚动冲突
    if (axisLocked.current === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axisLocked.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (axisLocked.current !== "h") return;

    // 边缘阻尼：第一页右滑 / 末页左滑时位移减半
    let adj = dx;
    if ((index === 0 && dx > 0) || (index === count - 1 && dx < 0)) {
      adj = dx * 0.35;
    }
    setDragDx(adj);
  };

  const onTouchEnd = () => {
    if (dragDx === null) {
      axisLocked.current = null;
      return;
    }
    const threshold = width.current * COMMIT_RATIO;
    let next = index;
    if (dragDx <= -threshold && index < count - 1) next = index + 1;
    else if (dragDx >= threshold && index > 0) next = index - 1;

    setDragDx(null);
    axisLocked.current = null;
    if (next !== index) onIndexChange(next);
  };

  // 基础位移（%）叠加拖拽位移（px），拖拽时禁用过渡以跟手
  const basePct = -index * 100;
  const dragging = dragDx !== null;
  const transform = dragging
    ? `translateX(calc(${basePct}% + ${dragDx}px))`
    : `translateX(${basePct}%)`;

  return (
    <div className={`home-pager${behind ? " behind" : ""}`}>
      <div
        ref={trackRef}
        className={`home-track${dragging ? " dragging" : ""}`}
        style={{ transform }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {panes.map((pane, i) => {
          const active = i === index;
          const child = isValidElement(pane)
            ? cloneElement(pane as ReactElement<{ active?: boolean }>, { active })
            : pane;
          return (
            <section className="home-pane" key={pane.key ?? i} aria-hidden={!active}>
              {child}
            </section>
          );
        })}
      </div>
    </div>
  );
}
