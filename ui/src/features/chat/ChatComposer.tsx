import { useEffect, useMemo, useRef, useState } from "react";

import {
  Ban,
  Check,
  ChevronDown,
  FastForward,
  FileText,
  Hand,
  Plus,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square
} from "lucide-react";

import type {
  AgentSummary,
  ApprovalRequest,
  SessionConfigOption,
  SessionModel,
  SessionMode,
  SlashCommand,
  UsageStats,
} from "../../types";
import { ApprovalCard } from "./ApprovalCard";
import { ContextRing } from "./ContextRing";
import { TokenUsageModal } from "./TokenUsageModal";
import type { ChatConfigValue } from "./chatTypes";
import "./ChatComposer.css";

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

type RuntimeTone = "claude" | "codex" | "default";

type AccessModeTone =
  | "claude-accept-edits"
  | "claude-auto"
  | "claude-bypass-permissions"
  | "claude-dont-ask"
  | "claude-plan"
  | "codex-full-access"
  | "default";

interface ChatComposerProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  commands: SlashCommand[];
  configOptions: SessionConfigOption[];
  contextUsage: UsageStats | null;
  draft: string;
  models: SessionModel[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: ChatConfigValue) => void;
  onDraftChange: (value: string) => void;
  onModelFamilyChange: (familyId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  reasoningEffort: string;
  selectedConfig: Record<string, ChatConfigValue>;
  selectedModelFamily: string;
}

export function ChatComposer({
  accessMode,
  activeTurnId,
  agent,
  commands,
  configOptions,
  contextUsage,
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
  const [isAccessMenuOpen, setIsAccessMenuOpen] = useState(false);
  const [isModelListOpen, setIsModelListOpen] = useState(false);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const accessMenuRef = useRef<HTMLDivElement | null>(null);
  const commandMenuRef = useRef<HTMLDivElement | null>(null);
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
  const currentMode = modes.find((mode) => mode.id === accessMode) ?? modes.find((mode) => mode.isDefault) ?? modes[0];
  const runtimeTone = agentRuntimeTone(agent);

  useEffect(() => {
    if (!isAccessMenuOpen && !isStatusMenuOpen && !isCommandMenuOpen) return;

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (isAccessMenuOpen && !accessMenuRef.current?.contains(target)) {
        setIsAccessMenuOpen(false);
      }
      if (isStatusMenuOpen && !statusMenuRef.current?.contains(target)) {
        setIsStatusMenuOpen(false);
        setIsModelListOpen(false);
      }
      if (isCommandMenuOpen && !commandMenuRef.current?.contains(target)) {
        setIsCommandMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isAccessMenuOpen, isStatusMenuOpen, isCommandMenuOpen]);

  function accessModeLabel(mode: SessionMode | undefined) {
    const labels: Record<string, string> = {
      "agent-full-access": "完全访问权限",
      agent: "自动审查",
      "read-only": "默认权限",
    };
    return mode ? labels[mode.id] ?? mode.label : "权限";
  }

  function agentRuntimeTone(agentInfo?: AgentSummary | null): RuntimeTone {
    const value = `${agentInfo?.runtimeId ?? ""} ${agentInfo?.id ?? ""} ${agentInfo?.label ?? ""}`.toLowerCase();
    if (value.includes("claude")) {
      return "claude";
    }
    if (value.includes("codex") || value.includes("openai")) {
      return "codex";
    }
    return "default";
  }

  function normalizeAccessMode(mode: SessionMode | string | undefined) {
    const id = typeof mode === "string" ? mode : mode?.id ?? "";
    const label = typeof mode === "string" ? "" : mode?.label ?? "";
    const text = `${id} ${label}`.toLowerCase();
    const compact = text.replace(/[\s_-]+/g, "");

    if (id === "agent-full-access" || compact.includes("agentfullaccess") || compact.includes("fullaccess")) {
      return "full-access";
    }
    if (id === "agent") {
      return "agent";
    }
    if (id === "read-only" || compact.includes("readonly")) {
      return "read-only";
    }
    if (compact.includes("bypasspermissions") || text.includes("bypass permission")) {
      return "bypass-permissions";
    }
    if (compact.includes("acceptedits") || text.includes("accept edit")) {
      return "accept-edits";
    }
    if (compact === "plan" || compact.includes("planmode") || text.includes("plan mode")) {
      return "plan";
    }
    if (compact.includes("dontask") || compact.includes("donotask") || text.includes("don't ask")) {
      return "dont-ask";
    }
    if (compact === "auto" || compact.includes("automode")) {
      return "auto";
    }
    if (compact === "default") {
      return "default";
    }
    return id || "default";
  }

  function accessModeTone(mode: SessionMode | string | undefined): AccessModeTone {
    const normalized = normalizeAccessMode(mode);
    if (runtimeTone === "claude") {
      if (normalized === "accept-edits") {
        return "claude-accept-edits";
      }
      if (normalized === "bypass-permissions") {
        return "claude-bypass-permissions";
      }
      if (normalized === "plan") {
        return "claude-plan";
      }
      if (normalized === "dont-ask") {
        return "claude-dont-ask";
      }
      if (normalized === "auto") {
        return "claude-auto";
      }
      return "default";
    }
    if (runtimeTone === "codex" && normalized === "full-access") {
      return "codex-full-access";
    }
    return "default";
  }

  function accessModeClass(mode: SessionMode | string | undefined) {
    return `access-mode-tone-${accessModeTone(mode)}`;
  }

  function accessModeIcon(mode: SessionMode | string | undefined, size = 15) {
    const normalized = normalizeAccessMode(mode);
    if (runtimeTone === "claude") {
      if (normalized === "accept-edits") {
        return <FastForward size={size} />;
      }
      if (normalized === "bypass-permissions") {
        return <ShieldAlert size={size} />;
      }
      if (normalized === "plan") {
        return <FileText size={size} />;
      }
      if (normalized === "dont-ask") {
        return <Ban size={size} />;
      }
      if (normalized === "auto") {
        return <Sparkles size={size} />;
      }
      return <Hand size={size} />;
    }
    if (normalized === "full-access") {
      return <ShieldAlert size={size} />;
    }
    if (normalized === "agent") {
      return <ShieldCheck size={size} />;
    }
    return <Hand size={size} />;
  }

  function selectAccessMode(modeId: string) {
    onAccessModeChange(modeId);
    setIsAccessMenuOpen(false);
  }

  function toggleAccessMenu() {
    setIsAccessMenuOpen((open) => !open);
    setIsStatusMenuOpen(false);
    setIsModelListOpen(false);
  }

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
              {/* 快捷指令 */}
              <div className="command-picker" ref={commandMenuRef}>
                <button
                  className="icon-button"
                  aria-label="快捷指令"
                  aria-expanded={isCommandMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => {
                    setIsCommandMenuOpen(open => !open);
                    setIsAccessMenuOpen(false);
                    setIsStatusMenuOpen(false);
                  }}
                >
                  <Plus size={17} />
                </button>
                {isCommandMenuOpen && commands.length > 0 ? (
                  <div className="command-menu" role="menu">
                    {commands.map(cmd => (
                      <button
                        key={cmd.id}
                        className="command-menu-item"
                        onClick={() => {
                          onDraftChange(cmd.command);
                          setIsCommandMenuOpen(false);
                        }}
                        role="menuitem"
                      >
                        <span className="command-label">{cmd.label}</span>
                        <span className="command-description">{cmd.description}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {/* 权限模式 */}
              {hasModes && (
                <div className="access-mode-picker" ref={accessMenuRef}>
                  <button
                    aria-expanded={isAccessMenuOpen}
                    aria-haspopup="menu"
                    className={`access-mode-chip ${accessModeClass(currentMode ?? accessMode)}`}
                    onClick={toggleAccessMenu}
                    title={`${agent?.label ?? "Agent"} 访问权限`}
                    type="button"
                  >
                    {accessModeIcon(currentMode ?? accessMode)}
                    <span>{accessModeLabel(currentMode)}</span>
                    <ChevronDown size={13} />
                  </button>
                  {isAccessMenuOpen ? (
                    <div className="access-mode-menu" role="menu">
                      {modes.map((mode) => (
                        <button
                          key={mode.id}
                          className={`access-mode-item ${accessModeClass(mode)} ${mode.id === accessMode ? "selected" : ""}`}
                          onClick={() => selectAccessMode(mode.id)}
                          role="menuitem"
                          type="button"
                        >
                          {accessModeIcon(mode, 16)}
                          <span>{accessModeLabel(mode)}</span>
                          {mode.id === accessMode ? <Check size={14} /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="composer-right">
              {/* 上下文使用圆环 */}
              <ContextRing
                usage={contextUsage}
                onTokenDetailsClick={() => setIsTokenModalOpen(true)}
              />

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
    <TokenUsageModal
      usage={contextUsage}
      open={isTokenModalOpen}
      onClose={() => setIsTokenModalOpen(false)}
    />
  );
}
