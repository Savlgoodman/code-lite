import { useRef, useMemo, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";

/** 弹幕道数量：星河被切成若干水平条，各自随机时长/延迟填入，形成参差的填充锋面。 */
const LANES = 7;

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
 * 思考强度拖动条。
 *
 * 几何：白色圆滑块直径 = 轨道高度，其圆心在 [r, 宽度-r] 内移动
 * （首尾挡位各内缩一个半径 r），保证圆能贴合两端。挡位断点数量
 * 由 options 长度决定，位置按索引均匀计算。
 *
 * 视觉：默认仅用纯色填充到滑块处；仅当拖到最高挡位时，整条滑槽
 * 由右向左渐进铺满暖→紫渐变，叠加星光流动，右端半圆带漏光。
 */
export function EffortSlider({ value, options, onChange }: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // 每条弹幕道随机延迟/时长，只算一次；填充整体偏慢（3.4~5.4s）
  const lanes = useMemo(
    () =>
      Array.from({ length: LANES }, () => ({
        delay: Math.random() * 1.6,
        duration: 3.4 + Math.random() * 2,
      })),
    []
  );

  const count = options.length;
  const index = Math.max(0, options.indexOf(value));
  const ratio = count > 1 ? index / (count - 1) : 0;
  const isMax = count > 1 && index === count - 1;

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
        className={`effort-track${isMax ? " max" : ""}`}
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
        {/* 纯色填充：到滑块中心；最高挡由 CSS 覆盖为整槽 */}
        <div className="effort-fill">
          {/* 星河：切成多条弹幕道，各自随机从右向左填入，锋面参差 */}
          <div className="effort-galaxy">
            {lanes.map((lane, i) => (
              <div
                key={i}
                className="effort-lane"
                style={{
                  "--lane-top": `${(i / LANES) * 100}%`,
                  "--lane-h": `${100 / LANES}%`,
                  "--lane-delay": `${lane.delay}s`,
                  "--lane-dur": `${lane.duration}s`,
                } as CSSProperties}
              >
                <div className="effort-grad" />
                <div className="effort-sparkle" />
              </div>
            ))}
          </div>
        </div>
        {/* 右端半圆弧形漏光，仅最高挡可见 */}
        <div className="effort-leak" />
        {options.map((opt, i) => {
          const tickRatio = count > 1 ? i / (count - 1) : 0;
          return (
            <span
              key={opt}
              className={`effort-tick${i <= index ? " passed" : ""}`}
              style={{ "--tr": tickRatio } as CSSProperties}
            />
          );
        })}
        <span className="effort-thumb" />
      </div>
      <div className="effort-caption">
        <span className={`effort-level effort-tone-${tone}`} data-text={value}>{value}</span>
      </div>
    </div>
  );
}
