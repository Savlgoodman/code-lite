import { useId } from "react";

import type { UsageStats } from "../../types";
import "./ContextRing.css";

interface ContextRingProps {
  usage: UsageStats | null;
}

function getUsageColor(ratio: number): string {
  if (ratio > 0.8) return "var(--color-danger, #e53e3e)";
  if (ratio > 0.5) return "var(--color-warning, #dd6b20)";
  return "var(--color-accent, #3182ce)";
}

export function ContextRing({ usage }: ContextRingProps) {
  const tooltipId = useId();
  const used = usage?.contextUsedTokens ?? usage?.totalTokens;
  const total = usage?.contextWindowTokens;

  if (!used || !total || total === 0) {
    return null;
  }

  const ratio = Math.min(used / total, 1);
  const percent = Math.round(ratio * 100);
  const color = getUsageColor(ratio);

  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  const usedLabel = used.toLocaleString();
  const totalLabel = total.toLocaleString();

  return (
    <div
      className="context-ring"
      role="img"
      tabIndex={0}
      aria-describedby={tooltipId}
      aria-label={`上下文使用 ${percent}%`}
    >
      <svg width="24" height="24" viewBox="0 0 24 24">
        {/* 底环 */}
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="var(--color-border, #e2e8f0)"
          strokeWidth="2.5"
        />
        {/* 填充弧 */}
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
        />
      </svg>
      <span
        className="context-ring-label"
        style={{ color }}
      >
        {percent}
      </span>
      <span className="context-ring-tooltip" id={tooltipId} role="tooltip">
        <strong>上下文窗口</strong>
        <span>{percent}% 已使用</span>
        <small>{usedLabel} / {totalLabel} tokens</small>
      </span>
    </div>
  );
}
