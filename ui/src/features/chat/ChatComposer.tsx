import { useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown, ChevronRight, Paperclip, Send, ShieldCheck, Square } from "lucide-react";

import type { AgentSummary, ApprovalRequest, ConfiguredModel } from "../../types";
import { ApprovalCard } from "./ApprovalCard";

interface ChatComposerProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  draft: string;
  models: ConfiguredModel[];
  onAccessModeChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  reasoningEffort: string;
  selectedModelId: string | null;
}

export function ChatComposer({
  accessMode,
  activeTurnId,
  agent,
  draft,
  models,
  onAccessModeChange,
  onDraftChange,
  onModelChange,
  onReasoningEffortChange,
  onResolveApproval,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  reasoningEffort,
  selectedModelId
}: ChatComposerProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? null;
  const providerGroups = useMemo(() => {
    const groups: Array<{ id: string; name: string; models: ConfiguredModel[] }> = [];
    const indexes = new Map<string, number>();
    for (const model of models) {
      const providerId = model.providerId || "unknown";
      const providerName = model.providerName || "未命名供应商";
      const index = indexes.get(providerId);
      if (index === undefined) {
        indexes.set(providerId, groups.length);
        groups.push({ id: providerId, name: providerName, models: [model] });
      } else {
        groups[index].models.push(model);
      }
    }
    return groups;
  }, [models]);
  const activeProvider =
    providerGroups.find((provider) => provider.id === activeProviderId) ??
    providerGroups.find((provider) => provider.id === selectedModel?.providerId) ??
    providerGroups[0] ??
    null;

  useEffect(() => {
    if (!isModelMenuOpen) {
      return undefined;
    }

    setActiveProviderId(selectedModel?.providerId ?? providerGroups[0]?.id ?? null);

    function closeOnOutside(event: MouseEvent) {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isModelMenuOpen, providerGroups, selectedModel?.providerId]);

  function selectModel(modelId: string) {
    onModelChange(modelId);
    setIsModelMenuOpen(false);
  }

  const isCodex = agent?.id === "codex";

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {pendingApproval ? <ApprovalCard approval={pendingApproval} onResolve={onResolveApproval} /> : null}

        <div className="composer">
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSendMessage();
              }
            }}
            placeholder="描述电脑问题，或要求继续变更"
            rows={2}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <button className="icon-button" aria-label="添加附件">
                <Paperclip size={17} />
              </button>
              <label className="composer-select-control">
                <ShieldCheck size={15} />
                <select
                  disabled={!isCodex}
                  onChange={(event) => onAccessModeChange(event.target.value)}
                  title={isCodex ? "Codex 访问权限" : "当前 agent 暂不支持这里切换权限"}
                  value={accessMode}
                >
                  <option value="read-only">只读</option>
                  <option value="agent">Agent</option>
                  <option value="agent-full-access">完全访问</option>
                </select>
              </label>
            </div>
            <div className="composer-right">
              <label className="composer-select-control">
                <select
                  disabled={!isCodex}
                  onChange={(event) => onReasoningEffortChange(event.target.value)}
                  title={isCodex ? "Codex 思考强度" : "当前 agent 暂不支持这里切换思考强度"}
                  value={reasoningEffort}
                >
                  <option value="none">无思考</option>
                  <option value="low">低思考</option>
                  <option value="medium">中思考</option>
                  <option value="high">高思考</option>
                  <option value="xhigh">超高思考</option>
                </select>
              </label>
              <div className="model-picker" ref={modelMenuRef}>
                <button
                  aria-expanded={isModelMenuOpen}
                  aria-haspopup="menu"
                  className="model-chip"
                  disabled={models.length === 0}
                  onClick={() => setIsModelMenuOpen((current) => !current)}
                  title={selectedModel?.providerName ? `${selectedModel.providerName} / ${selectedModel.label}` : selectedModel?.label}
                  type="button"
                >
                  <span>{selectedModel?.label ?? "未配置模型"}</span>
                  <ChevronDown size={14} />
                </button>
                {isModelMenuOpen ? (
                  <>
                    <div className="model-menu" role="menu">
                      {providerGroups.map((provider) => (
                        <button
                          className={`model-provider-label ${provider.id === activeProvider?.id ? "active" : ""}`}
                          key={provider.id}
                          onClick={() => setActiveProviderId(provider.id)}
                          onMouseEnter={() => setActiveProviderId(provider.id)}
                          type="button"
                        >
                          <span>{provider.name}</span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                    </div>
                    <div className="model-submenu" role="menu">
                      {(activeProvider?.models ?? []).map((model) => (
                        <button
                          className={`model-menu-item ${model.id === selectedModelId ? "selected" : ""}`}
                          key={model.id}
                          onClick={() => selectModel(model.id)}
                          role="menuitem"
                          type="button"
                        >
                          <span>{model.label}</span>
                          {model.id === selectedModelId ? <Check size={14} /> : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
              <button
                className={`send-button ${activeTurnId ? "stop" : ""}`}
                onClick={activeTurnId ? onStopTurn : onSendMessage}
                aria-label={activeTurnId ? "停止" : "发送"}
              >
                {activeTurnId ? <Square size={13} /> : <Send size={17} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
