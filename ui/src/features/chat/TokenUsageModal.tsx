import { useEffect, useMemo, useRef } from "react";

import { X } from "lucide-react";

import type { ChatMessage, UsageStats } from "../../types";
import "./TokenUsageModal.css";

interface TokenUsageModalProps {
  messages: ChatMessage[];
  contextUsage: UsageStats | null;
  open: boolean;
  onClose: () => void;
}

interface ModelUsage {
  modelId: string;
  modelLabel: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  turnCount: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** 从 messages 中按模型累计 token 用量 */
function buildModelUsage(messages: ChatMessage[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;

    // 从 model 字段提取模型 ID
    const modelInfo = msg.model as Record<string, unknown> | undefined;
    const modelId = String(modelInfo?.model ?? modelInfo?.runtimeModel ?? "unknown");
    const modelLabel = String(modelInfo?.label ?? modelId);

    const key = modelId;
    if (!map.has(key)) {
      map.set(key, {
        modelId,
        modelLabel,
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        turnCount: 0,
      });
    }

    const usage = msg.usage;
    const mu = map.get(key)!;
    mu.inputTokens += usage.inputTokens ?? 0;
    mu.outputTokens += usage.outputTokens ?? 0;
    mu.cachedReadTokens += usage.cachedReadTokens ?? 0;
    mu.cachedWriteTokens += usage.cachedWriteTokens ?? 0;
    mu.thoughtTokens += usage.thoughtTokens ?? 0;
    mu.totalTokens += usage.totalTokens ?? 0;
    mu.turnCount += 1;
  }

  return Array.from(map.values());
}

const TOKEN_COLORS: Record<string, string> = {
  input: "#3182ce",
  output: "#38a169",
  cachedRead: "#805ad5",
  cachedWrite: "#dd6b20",
  thought: "#319795",
};

export function TokenUsageModal({ messages, contextUsage, open, onClose }: TokenUsageModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const modelUsages = useMemo(() => buildModelUsage(messages), [messages]);

  const hasBreakdown = modelUsages.some(
    m => m.inputTokens > 0 || m.outputTokens > 0 || m.cachedReadTokens > 0 || m.cachedWriteTokens > 0 || m.thoughtTokens > 0,
  );

  // 会话总计
  const grandTotal = useMemo(() => {
    return modelUsages.reduce(
      (acc, m) => ({
        input: acc.input + m.inputTokens,
        output: acc.output + m.outputTokens,
        cachedRead: acc.cachedRead + m.cachedReadTokens,
        cachedWrite: acc.cachedWrite + m.cachedWriteTokens,
        thought: acc.thought + m.thoughtTokens,
        total: acc.total + m.totalTokens,
      }),
      { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0, total: 0 },
    );
  }, [modelUsages]);

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
                <div key={mu.modelId} className="token-section token-model-section">
                  <div className="token-model-header">
                    <span className="token-model-label">{mu.modelLabel}</span>
                    <span className="token-model-turns">{mu.turnCount} 轮</span>
                  </div>

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
                    {formatNumber(mu.totalTokens)} tokens
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
                  {formatNumber(grandTotal.total)} tokens
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
