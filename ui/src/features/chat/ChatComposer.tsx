import { useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown, Paperclip, Send, ShieldCheck, Square } from "lucide-react";

import type {
  AgentSummary,
  ApprovalRequest,
  SessionConfigOption,
  SessionModel,
  SessionMode,
} from "../../types";
import { ApprovalCard } from "./ApprovalCard";

/** 从模型 ID 提取模型族和推理强度 */
function parseModelId(modelId: string): { family: string; effort: string | null } {
  const match = modelId.match(/^(.*?)\[(.*?)\]$/);
  if (match) {
    return { family: match[1].trim(), effort: match[2].trim() };
  }
  return { family: modelId.trim(), effort: null };
}

/** 模型族选项 */
interface ModelFamily {
  id: string;        // 如 "gpt-5.5"
  label: string;     // 如 "GPT-5.5"
  models: SessionModel[];
}

interface ChatComposerProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  configOptions: SessionConfigOption[];
  draft: string;
  models: SessionModel[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: string) => void;
  onDraftChange: (value: string) => void;
  onModelFamilyChange: (familyId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  reasoningEffort: string;
  selectedConfig: Record<string, string | number | boolean>;
  selectedModelFamily: string;
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
  onModelFamilyChange,
  onReasoningEffortChange,
  onResolveApproval,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  reasoningEffort,
  selectedConfig,
  selectedModelFamily,
}: ChatComposerProps) {
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);
  const [isModelListOpen, setIsModelListOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);

  // 从 models 中提取模型族
  const modelFamilies = useMemo(() => {
    const familyMap = new Map<string, ModelFamily>();
    for (const model of models) {
      const { family } = parseModelId(model.id);
      if (!familyMap.has(family)) {
        // 从 label 提取展示名：取第一个 [ 之前的部分，去掉尾部空格
        const labelMatch = model.label.match(/^(.*?)\s*(?:\(|\[)/);
        const familyLabel = labelMatch ? labelMatch[1].trim() : family;
        familyMap.set(family, { id: family, label: familyLabel, models: [] });
      }
      familyMap.get(family)!.models.push(model);
    }
    return Array.from(familyMap.values());
  }, [models]);

  // 当前选中的模型族
  const currentFamily = modelFamilies.find((f) => f.id === selectedModelFamily) ?? modelFamilies[0] ?? null;

  // 推理强度选项 —— 从 configOptions 中提取
  const reasoningConfig = configOptions.find((o) => o.id === "reasoning_effort") ?? null;
  const reasoningValues = reasoningConfig?.values ?? [];

  const hasModes = modes.length > 1;
  const hasModelPicker = modelFamilies.length > 0;
  const hasReasoningPicker = reasoningValues.length > 0;
  const hasAnyControls = hasModelPicker || hasReasoningPicker;

  useEffect(() => {
    if (!isStatusMenuOpen) return;

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!statusMenuRef.current?.contains(target)) {
        setIsStatusMenuOpen(false);
        setIsModelListOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isStatusMenuOpen]);

  function selectFamily(familyId: string) {
    onModelFamilyChange(familyId);
    setIsStatusMenuOpen(false);
    setIsModelListOpen(false);
  }

  function selectReasoning(value: string) {
    onReasoningEffortChange(value);
    onConfigChange("reasoning_effort", value);
    setIsStatusMenuOpen(false);
    setIsModelListOpen(false);
  }

  function toggleStatusMenu() {
    const nextOpen = !isStatusMenuOpen;
    setIsStatusMenuOpen(nextOpen);
    if (!nextOpen) {
      setIsModelListOpen(false);
    }
  }

  const statusLabel = [
    currentFamily?.label,
    hasReasoningPicker ? reasoningEffort : null,
  ].filter(Boolean).join(" ") || (hasReasoningPicker ? "推理" : "模型");

  function reasoningOptionLabel(value: string) {
    return ({ low: "低", medium: "中", high: "高", xhigh: "超高", none: "无" } as Record<string, string>)[value]
      ?? reasoningConfig?.valueLabels?.[value]
      ?? value;
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
          <div className="composer-actions">
            <div className="composer-left">
              <button className="icon-button" aria-label="添加附件">
                <Paperclip size={17} />
              </button>
              {/* 权限模式 */}
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
              {/* 底部状态栏：模型族 + 推理强度 */}
              {hasAnyControls ? (
                <div className="composer-status-bar">
                  {(hasModelPicker || hasReasoningPicker) && (
                    <div className="status-combined-picker" ref={statusMenuRef}>
                      <button
                        className="status-chip"
                        aria-expanded={isStatusMenuOpen}
                        aria-haspopup="menu"
                        onClick={toggleStatusMenu}
                        type="button"
                        title={statusLabel}
                      >
                        <span>{statusLabel}</span>
                        <ChevronDown size={13} />
                      </button>
                      {isStatusMenuOpen && (
                        <div className={`status-menu-panels ${isModelListOpen ? "model-open" : ""}`}>
                          <div className="status-menu-panel status-primary-menu" role="menu">
                            {hasReasoningPicker ? (
                              <>
                                <div className="status-menu-title">推理</div>
                                {reasoningValues.map((value) => (
                                  <button
                                    key={value}
                                    className={`status-dropdown-item ${value === reasoningEffort ? "selected" : ""}`}
                                    onClick={() => selectReasoning(value)}
                                    role="menuitem"
                                    type="button"
                                  >
                                    <span>{reasoningOptionLabel(value)}</span>
                                    {value === reasoningEffort ? <Check size={14} /> : null}
                                  </button>
                                ))}
                                {currentFamily ? (
                                  <>
                                    <div className="status-dropdown-divider" />
                                    <button
                                      aria-expanded={isModelListOpen}
                                      className={`status-dropdown-item status-model-trigger ${isModelListOpen ? "expanded" : ""}`}
                                      onClick={() => setIsModelListOpen((open) => !open)}
                                      role="menuitem"
                                      type="button"
                                    >
                                      <span>{currentFamily.label}</span>
                                      <ChevronDown size={14} />
                                    </button>
                                    {isModelListOpen ? (
                                      <div className="status-model-list" role="group" aria-label="模型">
                                        <div className="status-model-list-title">模型</div>
                                        {modelFamilies.map((family) => (
                                          <button
                                            key={family.id}
                                            className={`status-dropdown-item ${family.id === currentFamily?.id ? "selected" : ""}`}
                                            onClick={() => selectFamily(family.id)}
                                            role="menuitem"
                                            type="button"
                                          >
                                            <span>{family.label}</span>
                                            {family.id === currentFamily?.id ? <Check size={14} /> : null}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                  </>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <div className="status-menu-title">模型</div>
                                {modelFamilies.map((family) => (
                                  <button
                                    key={family.id}
                                    className={`status-dropdown-item ${family.id === currentFamily?.id ? "selected" : ""}`}
                                    onClick={() => selectFamily(family.id)}
                                    role="menuitem"
                                    type="button"
                                  >
                                    <span>{family.label}</span>
                                    {family.id === currentFamily?.id ? <Check size={14} /> : null}
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
        </div>
      </div>
    </div>
  );
}
