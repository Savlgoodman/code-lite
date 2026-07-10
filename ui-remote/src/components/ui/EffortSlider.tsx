import { useRef, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

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

/** 高强度挡位的语义 tone，用于标签配色。 */
function effortTone(value: string): string {
  const v = value.toLowerCase();
  if (v === "xhigh") return "xhigh";
  if (v === "max") return "max";
  if (v === "ultra") return "ultra";
  return "default";
}

/**
 * 思考强度拖动条：渐变轨道（暖 → 紫）+ 挡位断点 + 白色圆滑块。
 * 拖动或点击轨道就近吸附到某一挡位，越高强度越偏紫并带星点流光。
 */
export function EffortSlider({ value, options, onChange }: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  const draggingRef = useRef(false);

  const count = options.length;
  const index = Math.max(0, options.indexOf(value));
  const pct = count > 1 ? (index / (count - 1)) * 100 : 0;

  // 测量轨道宽度，供内层渐变对齐（渐变始终按整条轨道铺满，再由 fill 裁剪）
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || count < 2) return;
    const rect = el.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const idx = Math.round(ratio * (count - 1));
    const next = options[idx];
    if (next && next !== value) onChange(next);
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

  const tone = effortTone(value);

  return (
    <div className="effort-slider">
      <div
        className="effort-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={value}
      >
        <div className="effort-fill" style={{ width: `${pct}%` }}>
          <div className="effort-grad" style={{ width: trackW || "100%" }} />
          <div className="effort-sparkle" style={{ width: trackW || "100%" }} />
        </div>
        {options.map((opt, i) => (
          <span
            key={opt}
            className={`effort-tick${i <= index ? " passed" : ""}`}
            style={{ left: `${count > 1 ? (i / (count - 1)) * 100 : 0}%` }}
          />
        ))}
        <span className="effort-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="effort-caption">
        <span className={`effort-level effort-tone-${tone}`} data-text={value}>{value}</span>
      </div>
    </div>
  );
}
