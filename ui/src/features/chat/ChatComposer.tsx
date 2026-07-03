import { useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown, ChevronRight, Paperclip, Send, ShieldCheck, Square } from "lucide-react";

import type {
  AgentSummary,
  ApprovalRequest,
  ChatModelOption,
  SessionConfigOption,
  SessionMode,
} from "../../types";
import { ApprovalCard } from "./ApprovalCard";

interface ChatComposerProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  configOptions: SessionConfigOption[];
  draft: string;
  models: ChatModelOption[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: string) => void;
  onDraftChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  reasoningEffort: string;
  selectedConfig: Record<string, string | number | boolean>;
  selectedModelId: string | null;
}

export function ChatComposer({
  accessMode,
  activeTurnId,
  agent,
  configOptions,
  draft,
  models,
  modes,
  onAccessModeChange,
  onConfigChange,
  onDraftChange,
  onModelChange,
  onReasoningEffortChange,
  onResolveApproval,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  reasoningEffort,
  selectedConfig,
  selectedModelId
}: ChatComposerProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? null;
  const hasModes = modes.length > 1;
  const hasConfigOptions = configOptions.length > 0;
  const hasModelPicker = models.length > 0;
  const hasAnyControls = hasModes || hasConfigOptions || hasModelPicker;
  const providerGroups = useMemo(() => {
    const groups: Array<{ id: string; name: string; models: ChatModelOption[] }> = [];
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
          {hasAnyControls ? (
            <div className="composer-actions">
              <div className="composer-left">
                <button className="icon-button" aria-label="添加附件">
                  <Paperclip size={17} />
                </button>
                {/* 权限模式 —— 由 capabilities.modes 动态渲染 */}
                {hasModes && (
                  <label className="composer-select-control">
                    <ShieldCheck size={15} />
                    <select
                      onChange={(event) => onAccessModeChange(event.target.value)}
                      title={`${agent?.label ?? "Agent"} 访问权限`}
                      value={accessMode}
                    >
                      {modes.map((mode) => (
                        <option key={mode.id} value={mode.id}>{mode.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="composer-right">
                {/* 配置选项 —— 由 capabilities.configOptions 动态渲染 */}
                {configOptions.map((option) => (
                  <ConfigOptionControl
                    key={option.id}
                    option={option}
                    value={String(selectedConfig[option.id] ?? option.currentValue ?? "")}
                    onChange={(value) => {
                      onConfigChange(option.id, value);
                      if (option.id === "reasoning_effort") {
                        onReasoningEffortChange(value);
                      }
                    }}
                  />
                ))}
                {/* 模型选择 —— 由 capabilities.models 动态渲染 */}
                {hasModelPicker ? (
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
                ) : null}
                <button
                  className={`send-button ${activeTurnId ? "stop" : ""}`}
                  onClick={activeTurnId ? onStopTurn : onSendMessage}
                  aria-label={activeTurnId ? "停止" : "发送"}
                >
                  {activeTurnId ? <Square size={13} /> : <Send size={17} />}
                </button>
              </div>
            </div>
          ) : (
            <div className="composer-actions">
              <div className="composer-left">
                <button className="icon-button" aria-label="添加附件">
                  <Paperclip size={17} />
                </button>
              </div>
              <div className="composer-right">
                <button
                  className={`send-button ${activeTurnId ? "stop" : ""}`}
                  onClick={activeTurnId ? onStopTurn : onSendMessage}
                  aria-label={activeTurnId ? "停止" : "发送"}
                >
                  {activeTurnId ? <Square size={13} /> : <Send size={17} />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 通用配置选项控件 —— 根据 SessionConfigOption 动态渲染 */
function ConfigOptionControl({
  option,
  value,
  onChange,
}: {
  option: SessionConfigOption;
  value: string;
  onChange: (value: string) => void;
}) {
  if (option.type === "enum" && option.values && option.values.length > 0) {
    return (
      <label className="composer-select-control">
        <select
          onChange={(event) => onChange(event.target.value)}
          title={option.label}
          value={value}
        >
          {option.values.map((v) => (
            <option key={v} value={v}>
              {option.valueLabels?.[v] ?? v}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (option.type === "boolean") {
    return (
      <label className="composer-select-control">
        <select
          onChange={(event) => onChange(event.target.value)}
          title={option.label}
          value={value}
        >
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </label>
    );
  }

  return null;
}
