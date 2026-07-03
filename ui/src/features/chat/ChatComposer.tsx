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
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isReasoningMenuOpen, setIsReasoningMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const reasoningMenuRef = useRef<HTMLDivElement | null>(null);

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

  // 当前完整模型 ID = 模型族[推理强度]
  const currentFullModelId = currentFamily && reasoningEffort
    ? `${currentFamily.id}[${reasoningEffort}]`
    : null;

  const hasModes = modes.length > 1;
  const hasModelPicker = modelFamilies.length > 0;
  const hasReasoningPicker = reasoningValues.length > 0;
  const hasAnyControls = hasModes || hasModelPicker || hasReasoningPicker;

  // 当前选中的模型（完整 ID 匹配）
  const selectedFullModel = models.find((m) => m.id === currentFullModelId) ?? null;

  useEffect(() => {
    if (!isModelMenuOpen && !isReasoningMenuOpen) return;

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (isModelMenuOpen && !modelMenuRef.current?.contains(target)) {
        setIsModelMenuOpen(false);
      }
      if (isReasoningMenuOpen && !reasoningMenuRef.current?.contains(target)) {
        setIsReasoningMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isModelMenuOpen, isReasoningMenuOpen]);

  function selectFamily(familyId: string) {
    onModelFamilyChange(familyId);
    setIsModelMenuOpen(false);
  }

  function selectReasoning(value: string) {
    onReasoningEffortChange(value);
    setIsReasoningMenuOpen(false);
  }

  // 推理强度展示名
  const reasoningLabel = useMemo(() => {
    const labelMap: Record<string, string> = {
      low: "低", medium: "中", high: "高", xhigh: "超高", none: "无",
    };
    return reasoningConfig?.valueLabels?.[reasoningEffort]
      ?? labelMap[reasoningEffort]
      ?? reasoningEffort;
  }, [reasoningEffort, reasoningConfig]);

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
                  {/* 模型族选择 */}
                  {hasModelPicker && (
                    <div className="status-model-picker" ref={modelMenuRef}>
                      <button
                        className="status-chip"
                        onClick={() => { setIsModelMenuOpen(!isModelMenuOpen); setIsReasoningMenuOpen(false); }}
                        type="button"
                      >
                        <span>{currentFamily?.label ?? "模型"}</span>
                        <ChevronDown size={12} />
                      </button>
                      {isModelMenuOpen && (
                        <div className="status-dropdown" role="menu">
                          {modelFamilies.map((family) => (
                            <button
                              key={family.id}
                              className={`status-dropdown-item ${family.id === selectedModelFamily ? "selected" : ""}`}
                              onClick={() => selectFamily(family.id)}
                              role="menuitem"
                              type="button"
                            >
                              <span>{family.label}</span>
                              {family.id === selectedModelFamily ? <Check size={14} /> : null}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 推理强度选择 */}
                  {hasReasoningPicker && (
                    <div className="status-reasoning-picker" ref={reasoningMenuRef}>
                      <button
                        className="status-chip"
                        onClick={() => { setIsReasoningMenuOpen(!isReasoningMenuOpen); setIsModelMenuOpen(false); }}
                        type="button"
                      >
                        <span>{reasoningLabel}</span>
                        <ChevronDown size={12} />
                      </button>
                      {isReasoningMenuOpen && (
                        <div className="status-dropdown" role="menu">
                          {reasoningValues.map((v) => {
                            const label = reasoningConfig?.valueLabels?.[v]
                              ?? ({ low: "低", medium: "中", high: "高", xhigh: "超高", none: "无" } as Record<string, string>)[v]
                              ?? v;
                            return (
                              <button
                                key={v}
                                className={`status-dropdown-item ${v === reasoningEffort ? "selected" : ""}`}
                                onClick={() => selectReasoning(v)}
                                role="menuitem"
                                type="button"
                              >
                                <span>{label}</span>
                                {v === reasoningEffort ? <Check size={14} /> : null}
                              </button>
                            );
                          })}
                          {/* 分隔线后显示模型族信息 */}
                          {currentFamily && (
                            <>
                              <div className="status-dropdown-divider" />
                              <button
                                className="status-dropdown-item family-info"
                                onClick={() => { setIsReasoningMenuOpen(false); setIsModelMenuOpen(true); }}
                                type="button"
                              >
                                <span>{currentFamily.label}</span>
                                <ChevronDown size={12} />
                              </button>
                            </>
                          )}
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
