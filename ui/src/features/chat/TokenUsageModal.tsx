import { useEffect, useRef } from "react";

import { X } from "lucide-react";

import type { SessionBillingSummary } from "./billing";
import { formatNumber, formatUsd } from "./billing";
import type { UsageStats } from "../../types";
import "./TokenUsageModal.css";

interface TokenUsageModalProps {
  billingSummary: SessionBillingSummary;
  contextUsage: UsageStats | null;
  open: boolean;
  onClose: () => void;
}

const TOKEN_COLORS: Record<string, string> = {
  input: "#3182ce",
  output: "#38a169",
  cachedRead: "#805ad5",
  cachedWrite: "#dd6b20",
  thought: "#319795",
};

export function TokenUsageModal({ billingSummary, contextUsage, open, onClose }: TokenUsageModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const modelUsages = billingSummary.modelUsages;
  const hasBreakdown = billingSummary.hasBreakdown;
  const grandTotal = billingSummary.grandTotal;

  const used = contextUsage?.contextUsedTokens ?? contextUsage?.totalTokens;
  const total = contextUsage?.contextWindowTokens;

  if (!open) return null;

  return (
    <div className="token-modal-overlay" ref={overlayRef} onClick={onClose}>
      <div className="token-modal" onClick={e => e.stopPropagation()}>
        <div className="token-modal-header">
          <h3>会话 Token 统计</h3>
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

          {/* 按模型分组的 Token 明细 */}
          {hasBreakdown ? (
            <>
              <div className="token-divider" />

              {modelUsages.map(mu => (
                <div key={mu.usageKey} className="token-section token-model-section">
                  <div className="token-model-header">
                    <span className="token-model-label">{mu.modelLabel}</span>
                    <span className="token-model-turns">{mu.turnCount} 轮</span>
                  </div>
                  <div className="token-cost-line">
                    <span>费用</span>
                    <strong>{mu.cost ? formatUsd(mu.cost.totalCostUsd) : "价格未知"}</strong>
                  </div>
                  {mu.cost && mu.cost.billingMultiplier > 1 ? (
                    <div className="token-cost-note">
                      Fast mode 计费倍率 {mu.cost.billingMultiplier}x，基础费用 {formatUsd(mu.cost.baseTotalCostUsd)}。
                    </div>
                  ) : null}

                  <div className="token-rows">
                    {mu.inputTokens > 0 ? (
                      <div className="token-row">
                        <span className="token-row-dot" style={{ backgroundColor: TOKEN_COLORS.input }} />
                        <span className="token-row-label">Input</span>
                        <span className="token-row-value" style={{ color: TOKEN_COLORS.input }}>
                          {formatNumber(mu.inputTokens)}
                        </span>
                      </div>
                    ) : null}
                    {mu.outputTokens > 0 ? (
                      <div className="token-row">
                        <span className="token-row-dot" style={{ backgroundColor: TOKEN_COLORS.output }} />
                        <span className="token-row-label">Output</span>
                        <span className="token-row-value" style={{ color: TOKEN_COLORS.output }}>
                          {formatNumber(mu.outputTokens)}
                        </span>
                      </div>
                    ) : null}
                    {mu.cachedReadTokens > 0 ? (
                      <div className="token-row">
                        <span className="token-row-dot" style={{ backgroundColor: TOKEN_COLORS.cachedRead }} />
                        <span className="token-row-label">Cache Read</span>
                        <span className="token-row-value" style={{ color: TOKEN_COLORS.cachedRead }}>
                          {formatNumber(mu.cachedReadTokens)}
                        </span>
                      </div>
                    ) : null}
                    {mu.cachedWriteTokens > 0 ? (
                      <div className="token-row">
                        <span className="token-row-dot" style={{ backgroundColor: TOKEN_COLORS.cachedWrite }} />
                        <span className="token-row-label">Cache Write</span>
                        <span className="token-row-value" style={{ color: TOKEN_COLORS.cachedWrite }}>
                          {formatNumber(mu.cachedWriteTokens)}
                        </span>
                      </div>
                    ) : null}
                    {mu.thoughtTokens > 0 ? (
                      <div className="token-row">
                        <span className="token-row-dot" style={{ backgroundColor: TOKEN_COLORS.thought }} />
                        <span className="token-row-label">Thought</span>
                        <span className="token-row-value" style={{ color: TOKEN_COLORS.thought }}>
                          {formatNumber(mu.thoughtTokens)}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div className="token-model-total">
                    <span>{formatNumber(mu.totalTokens)} tokens</span>
                    {mu.cost?.priceModelId ? <small>{mu.cost.priceModelId}</small> : null}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div className="token-empty">暂无 Token 分项数据</div>
          )}

          {/* 会话总计 */}
          {hasBreakdown ? (
            <>
              <div className="token-divider" />
              <div className="token-section">
                <div className="token-section-title">会话总计</div>
                <div className="token-rows">
                  <div className="token-row token-row-total">
                    <span className="token-row-label">Input</span>
                    <span className="token-row-value">{formatNumber(grandTotal.input)}</span>
                  </div>
                  <div className="token-row token-row-total">
                    <span className="token-row-label">Output</span>
                    <span className="token-row-value">{formatNumber(grandTotal.output)}</span>
                  </div>
                  {grandTotal.cachedRead > 0 ? (
                    <div className="token-row token-row-total">
                      <span className="token-row-label">Cache Read</span>
                      <span className="token-row-value">{formatNumber(grandTotal.cachedRead)}</span>
                    </div>
                  ) : null}
                  {grandTotal.cachedWrite > 0 ? (
                    <div className="token-row token-row-total">
                      <span className="token-row-label">Cache Write</span>
                      <span className="token-row-value">{formatNumber(grandTotal.cachedWrite)}</span>
                    </div>
                  ) : null}
                  {grandTotal.thought > 0 ? (
                    <div className="token-row token-row-total">
                      <span className="token-row-label">Thought</span>
                      <span className="token-row-value">{formatNumber(grandTotal.thought)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="token-grand-total">
                  <span>{formatNumber(grandTotal.total)} tokens</span>
                  <strong>{formatUsd(billingSummary.totalCostUsd)}</strong>
                </div>
                {billingSummary.unknownCostModelCount > 0 ? (
                  <div className="token-cost-note">
                    {billingSummary.unknownCostModelCount} 个模型暂未匹配到价格，未计入总费用。
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
