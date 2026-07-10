import { useRef, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { useWebglFire } from "./useWebglFire";

interface EffortSliderProps {
  /** 当前挡位值 */
  value: string;
  /** 有序挡位列表（低 → 高） */
  options: string[];
  onChange: (value: string) => void;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/**
 * 思考强度拖动条。移植自 254558/claude-range-slider：暗色轨道 + 挡位点 +
 * 白色发光滑块；拖到最高挡（Ultracode）时 canvas 用 WebGL2 shader 烧起火焰，
 * 滑块与状态文字染上紫色辉光。
 *
 * 几何：滑块直径 = 轨道高度，圆心在 [r, 宽-r] 内移动（首尾挡位内缩一个半径）。
 * 火焰按 canvas 的 mask 只在已填充区（0→滑块处）显示。
 */
export function EffortSlider({ value, options, onChange }: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  const count = options.length;
  const index = Math.max(0, options.indexOf(value));
  const ratio = count > 1 ? index / (count - 1) : 0;
  const isMax = count > 1 && index === count - 1;

  // 供 WebGL 渲染循环读取的实时值（避免每帧重渲染）
  const sliderRef = useRef(ratio);
  const activeRef = useRef(isMax);
  const kickRef = useRef<(() => void) | null>(null);
  sliderRef.current = ratio;
  activeRef.current = isMax;

  useWebglFire(canvasRef, sliderRef, activeRef, kickRef);

  // 指针位置 → 就近挡位。命中区间按 [r, 宽度-r] 反算，与滑块可达范围一致。
  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || count < 2) return;
    const rect = el.getBoundingClientRect();
    const r = rect.height / 2;
    const span = rect.width - 2 * r;
    const rel = clamp(clientX - rect.left - r, 0, span);
    const idx = span > 0 ? Math.round((rel / span) * (count - 1)) : 0;
    const next = options[idx];
    if (next && next !== value) {
      onChange(next);
      // 进入最高挡时启动火焰渲染循环
      if (idx === count - 1) kickRef.current?.();
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (count < 2) return;
    draggingRef.current = true;
    trackRef.current?.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setFromClientX(e.clientX);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    trackRef.current?.releasePointerCapture(e.pointerId);
  };

  // canvas mask：只显示 0→滑块处的火焰（多留 2% 让锋面盖住滑块）
  const maskPct = Math.min(ratio * 100 + 2, 100);
  const canvasMask: CSSProperties = {
    maskImage: `linear-gradient(to right, black 0%, black ${maskPct}%, transparent ${maskPct}%)`,
    WebkitMaskImage: `linear-gradient(to right, black 0%, black ${maskPct}%, transparent ${maskPct}%)`,
  };

  return (
    <div className={`effort-slider${isMax ? " max" : ""}`}>
      <div
        className="effort-track"
        ref={trackRef}
        style={{ "--ratio": ratio } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={value}
      >
        <div className="effort-track-bg" />
        <div className="effort-fill" />
        <div className="effort-dots">
          {options.map((opt, i) => (
            <span
              key={opt}
              className="effort-dot"
              style={{ "--tr": count > 1 ? i / (count - 1) : 0 } as CSSProperties}
            />
          ))}
        </div>
        <canvas ref={canvasRef} className="effort-canvas" style={canvasMask} />
        <span className="effort-thumb" />
      </div>
      <div className="effort-caption">
        <span className="effort-level" data-text={value}>{value}</span>
      </div>
    </div>
  );
}
