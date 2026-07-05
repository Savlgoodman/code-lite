import { useEffect, useRef } from "react";

import { X } from "lucide-react";

import type { UsageStats } from "../../types";
import "./TokenUsageModal.css";

interface TokenUsageModalProps {
  usage: UsageStats | null;
  open: boolean;
  onClose: () => void;
}

interface TokenRow {
  label: string;
  value: number | undefined;
  color: string;
}

function buildTokenRows(usage: UsageStats | null): TokenRow[] {
  if (!usage) return [];
  return [
    { label: "Input Tokens", value: usage.inputTokens, color: "#3182ce" },
    { label: "Output Tokens", value: usage.outputTokens, color: "#38a169" },
    { label: "Cache Read", value: usage.cachedReadTokens, color: "#805ad5" },
    { label: "Cache Write", value: usage.cachedWriteTokens, color: "#dd6b20" },
    { label: "Thought Tokens", value: usage.thoughtTokens, color: "#319795" },
  ].filter(row => row.value !== undefined && row.value > 0);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function TokenUsageModal({ usage, open, onClose }: TokenUsageModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open || !usage) return null;

  const used = usage.contextUsedTokens ?? usage.totalTokens;
  const total = usage.contextWindowTokens;
  const hasBreakdown = usage.inputTokens !== undefined || usage.outputTokens !== undefined;

  return (
    <div className="token-modal-overlay" ref={overlayRef} onClick={onClose}>
      <div className="token-modal" onClick={e => e.stopPropagation()}>
        <div className="token-modal-header">
          <h3>Token 使用详情</h3>
          <button className="token-modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="token-modal-body">
          {/* Context Window */}
          {used && total ? (
            <div className="token-section">
              <div className="token-section-title">上下文窗口</div>
              <div className="token-progress-bar">
                <div
                  className="token-progress-fill"
                  style={{ width: `${Math.min((used / total) * 100, 100)}%` }}
                />
              </div>
              <div className="token-section-value">
                <span>{formatNumber(used)} / {formatNumber(total)}</span>
                <span className="token-section-percent">
                  {Math.round((used / total) * 100)}%
                </span>
              </div>
            </div>
          ) : null}

          {/* Per-Turn Breakdown */}
          {hasBreakdown ? (
            <>
              <div className="token-divider" />
              <div className="token-section">
                <div className="token-section-title">Token 明细</div>
                <div className="token-rows">
                  {buildTokenRows(usage).map(row => (
                    <div key={row.label} className="token-row">
                      <span className="token-row-dot" style={{ backgroundColor: row.color }} />
                      <span className="token-row-label">{row.label}</span>
                      <span className="token-row-value" style={{ color: row.color }}>
                        {formatNumber(row.value!)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {/* Total */}
          {usage.totalTokens !== undefined ? (
            <>
              <div className="token-divider" />
              <div className="token-section">
                <div className="token-section-title">总计</div>
                <div className="token-total">{formatNumber(usage.totalTokens)} tokens</div>
              </div>
            </>
          ) : null}

          {/* Source */}
          {usage.source ? (
            <div className="token-source">{usage.source}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
