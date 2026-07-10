import { useEffect, useMemo, useRef, useState, Fragment } from "react";

import {
  Ban,
  Check,
  ChevronDown,
  FastForward,
  Image,
  FileText,
  Hand,
  Loader2,
  Plus,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  X
} from "lucide-react";

import type {
  AgentSummary,
  ApprovalRequest,
  BillingPricesResult,
  ChatMessage,
  InputRequest,
  PlanSnapshot,
  SessionConfigOption,
  SessionModel,
  SessionMode,
  SlashCommand,
  UsageStats,
} from "../../types";
import { groupModelsByFamily, type ModelFamily as ModelFamilyGrouping } from "@code-lite/chat-core";
import { loadBillingPrices } from "../../services/billingStore";
import { ApprovalCard } from "./ApprovalCard";
import { buildSessionBillingSummary } from "./billing";
import { ContextRing } from "./ContextRing";
import { InputRequestCard } from "./InputRequestCard";
import { PlanProgressPanel } from "./PlanProgressPanel";
import { TokenUsageModal } from "./TokenUsageModal";
import type { ChatConfigValue } from "./chatTypes";
import { IMAGE_ACCEPT, type DraftImage } from "./draftImages";
import { ImagePreview, type PreviewImage } from "./ImagePreview";
import "./ChatComposer.css";

/**  模型族（向后兼容原 parseModelId 生成的 ModelFamily 接口，桌面版内部引用）*/
interface ModelFamily {
  id: string;
  label: string;
  models: SessionModel[];
}

const STATUS_MENU_ANIMATION_MS = 180;
const STATUS_SECTION_ANIMATION_MS = 160;

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
  configLoading: boolean;
  contextUsage: UsageStats | null;
  draft: string;
  draftImageError: string | null;
  draftImages: DraftImage[];
  imagesProcessing: boolean;
  messages: ChatMessage[];
  models: SessionModel[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: ChatConfigValue) => void;
  onDraftChange: (value: string) => void;
  onDraftImagesAdd: (files: File[]) => void;
  onDraftImageRemove: (id: string) => void;
  onModelFamilyChange: (familyId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onResolveInput: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  pendingInput: InputRequest | null;
  plan: PlanSnapshot | null;
  reasoningEffort: string;
  sendDisabled: boolean;
  selectedConfig: Record<string, ChatConfigValue>;
  selectedModelFamily: string;
}

function isLogoutCommand(command: SlashCommand) {
  const id = command.id.trim().toLowerCase();
  const slashCommand = command.command.trim().toLowerCase();
  const label = command.label.trim().toLowerCase();
  const description = command.description.trim().toLowerCase();
  return (
    id === "logout"
    || slashCommand === "/logout"
    || slashCommand === "logout"
    || label === "登出"
    || label === "退出登录"
    || description === "登出"
    || description === "退出登录"
  );
}

export function ChatComposer({
  accessMode,
  activeTurnId,
  agent,
  commands,
  configOptions,
  configLoading,
  contextUsage,
  draft,
  draftImageError,
  draftImages,
  imagesProcessing,
  messages,
  models,
  modes,
  onAccessModeChange,
  onConfigChange,
  onDraftChange,
  onDraftImagesAdd,
  onDraftImageRemove,
  onModelFamilyChange,
  onReasoningEffortChange,
  onResolveApproval,
  onResolveInput,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  pendingInput,
  plan,
  reasoningEffort,
  sendDisabled,
  selectedConfig,
  selectedModelFamily,
}: ChatComposerProps) {
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);
  const [isStatusMenuRendered, setIsStatusMenuRendered] = useState(false);
  const [isStatusMenuClosing, setIsStatusMenuClosing] = useState(false);
  const [isAccessMenuOpen, setIsAccessMenuOpen] = useState(false);
  const [expandedStatusSection, setExpandedStatusSection] = useState<"model" | "speed" | null>(null);
  const [closingStatusSection, setClosingStatusSection] = useState<"model" | "speed" | null>(null);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [composerLayoutVersion, setComposerLayoutVersion] = useState(0);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [billingPrices, setBillingPrices] = useState<BillingPricesResult | null>(null);
  const accessMenuRef = useRef<HTMLDivElement | null>(null);
  const commandMenuRef = useRef<HTMLDivElement | null>(null);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const statusMenuCloseTimerRef = useRef<number | null>(null);
  const statusSectionCloseTimerRef = useRef<number | null>(null);

  // 从 models 分组：Codex 用 family[effort]（chat-core 自动拆分），Claude Code 直接用 id。
  const grouping = useMemo(() => groupModelsByFamily(models), [models]);
  const modelFamilies: ModelFamily[] = useMemo(() => {
    return grouping.families.map((f) => ({
      id: f.familyId,
      label: f.label,
      models: models.filter((m) => {
        const mFam = m.id.includes("[") ? m.id.split("[")[0].trim() : m.id;
        return mFam === f.familyId;
      }),
    }));
  }, [grouping.families, models]);

  // 当前选中的模型族
  const currentFamily = modelFamilies.find((f) => f.id === selectedModelFamily) ?? modelFamilies[0] ?? null;
  // 当前族支持的 reasoning 列表：分组模式（isGrouped）用 family.efforts（动态），否则回退 configOptions（固定）。
  const familyGroupingEntry = grouping.families.find((f) => f.familyId === selectedModelFamily);
  const reasoningValuesFromFamily = familyGroupingEntry?.efforts ?? [];
  const reasoningConfig = configOptions.find((o) => o.id === "reasoning_effort") ?? null;
  const reasoningValuesFromConfig = reasoningConfig?.values ?? [];
  const reasoningValues = grouping.isGrouped && reasoningValuesFromFamily.length > 0
    ? reasoningValuesFromFamily
    : reasoningValuesFromConfig;
  const visibleCommands = useMemo(() => commands.filter((command) => !isLogoutCommand(command)), [commands]);
  const fastModeConfig = configOptions.find((o) => o.id === "fast_mode" || o.id === "fast-mode" || o.id === "fast") ?? null;
  const hasFastModePicker = Boolean(fastModeConfig);
  const fastModeValue = normalizeFastModeValue(selectedConfig.fast_mode ?? selectedConfig.fastMode ?? selectedConfig["fast-mode"] ?? selectedConfig.fast ?? fastModeConfig?.currentValue);
  const isFastModeOn = fastModeValue === "on";

  const hasModes = modes.length > 1;
  const hasModelPicker = modelFamilies.length > 0;
  const hasReasoningPicker = reasoningValues.length > 0;
  const hasAnyControls = hasModelPicker || hasReasoningPicker || hasFastModePicker;
  const isModelListOpen = expandedStatusSection === "model";
  const isSpeedListOpen = expandedStatusSection === "speed";
  const currentMode = modes.find((mode) => mode.id === accessMode) ?? modes.find((mode) => mode.isDefault) ?? modes[0];
  const runtimeTone = agentRuntimeTone(agent);
  const billingSummary = useMemo(
    () => buildSessionBillingSummary(messages, billingPrices),
    [messages, billingPrices],
  );

  useEffect(() => {
    let cancelled = false;
    void loadBillingPrices()
      .then((prices) => {
        if (!cancelled) {
          setBillingPrices(prices);
        }
      })
      .catch((error) => console.error("Failed to load billing prices:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isAccessMenuOpen && !isStatusMenuOpen && !isCommandMenuOpen) return;

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (isAccessMenuOpen && !accessMenuRef.current?.contains(target)) {
        setIsAccessMenuOpen(false);
      }
      if (isStatusMenuOpen && !statusMenuRef.current?.contains(target)) {
        closeStatusMenu();
      }
      if (isCommandMenuOpen && !commandMenuRef.current?.contains(target)) {
        setIsCommandMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [expandedStatusSection, isAccessMenuOpen, isStatusMenuOpen, isCommandMenuOpen, isStatusMenuRendered]);

  useEffect(() => {
    return () => {
      if (statusMenuCloseTimerRef.current !== null) {
        window.clearTimeout(statusMenuCloseTimerRef.current);
      }
      if (statusSectionCloseTimerRef.current !== null) {
        window.clearTimeout(statusSectionCloseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!configLoading && !hasFastModePicker && isFastModeOn) {
      onConfigChange("fast_mode", "off");
    }
  }, [configLoading, hasFastModePicker, isFastModeOn, onConfigChange]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const composer = composerRef.current;
    if (!textarea || !composer) {
      return;
    }

    const workspace = composer.closest(".chat-workspace") as HTMLElement | null;
    const workspaceHeight = workspace?.clientHeight ?? window.innerHeight;
    const maxComposerHeight = Math.max(156, Math.floor(workspaceHeight / 2));
    composer.style.maxHeight = `${maxComposerHeight}px`;
    textarea.style.height = "auto";
    const fixedHeight = composer.scrollHeight - textarea.scrollHeight;
    const maxTextareaHeight = Math.max(48, maxComposerHeight - fixedHeight);
    const nextHeight = Math.min(textarea.scrollHeight, maxTextareaHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
    workspace?.style.setProperty("--chat-composer-current-height", `${composer.offsetHeight}px`);
  }, [composerLayoutVersion, draft, draftImages.length, draftImageError, imagesProcessing, pendingApproval, pendingInput, plan]);

  useEffect(() => {
    const handleResize = () => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
      }
      setComposerLayoutVersion((value) => value + 1);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function filesFromList(fileList: FileList | null) {
    return Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/"));
  }

  function addFiles(fileList: FileList | null) {
    const files = filesFromList(fileList);
    if (files.length > 0) {
      onDraftImagesAdd(files);
    }
  }

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
    closeStatusMenu();
  }

  function selectFamily(familyId: string) {
    // 切换模型族时，若当前 effort 不在新族支持列表中,重置为新族的首个。
    const targetFamily = grouping.families.find((f) => f.familyId === familyId);
    if (grouping.isGrouped && targetFamily && targetFamily.efforts.length > 0) {
      if (!targetFamily.efforts.includes(reasoningEffort)) {
        onReasoningEffortChange(targetFamily.efforts[0]);
        onConfigChange("reasoning_effort", targetFamily.efforts[0]);
      }
    }
    onModelFamilyChange(familyId);
    closeStatusMenu();
  }

  function selectReasoning(value: string) {
    onReasoningEffortChange(value);
    onConfigChange("reasoning_effort", value);
    closeStatusMenu();
  }

  function selectFastMode(value: "off" | "on") {
    onConfigChange("fast_mode", value);
    closeStatusMenu();
  }

  function toggleStatusMenu() {
    if (isStatusMenuOpen) {
      closeStatusMenu();
      return;
    }
    if (statusMenuCloseTimerRef.current !== null) {
      window.clearTimeout(statusMenuCloseTimerRef.current);
      statusMenuCloseTimerRef.current = null;
    }
    if (statusSectionCloseTimerRef.current !== null) {
      window.clearTimeout(statusSectionCloseTimerRef.current);
      statusSectionCloseTimerRef.current = null;
    }
    setIsAccessMenuOpen(false);
    setIsCommandMenuOpen(false);
    setClosingStatusSection(null);
    setIsStatusMenuRendered(true);
    setIsStatusMenuClosing(false);
    setIsStatusMenuOpen(true);
  }

  function toggleStatusSection(section: "model" | "speed") {
    if (expandedStatusSection === section) {
      closeStatusSection(section);
      return;
    }
    if (statusSectionCloseTimerRef.current !== null) {
      window.clearTimeout(statusSectionCloseTimerRef.current);
      statusSectionCloseTimerRef.current = null;
    }
    setClosingStatusSection(null);
    setExpandedStatusSection(section);
  }

  function closeStatusMenu() {
    const activeSection = expandedStatusSection;

    if (statusMenuCloseTimerRef.current !== null) {
      window.clearTimeout(statusMenuCloseTimerRef.current);
      statusMenuCloseTimerRef.current = null;
    }
    if (statusSectionCloseTimerRef.current !== null) {
      window.clearTimeout(statusSectionCloseTimerRef.current);
      statusSectionCloseTimerRef.current = null;
    }

    setIsStatusMenuOpen(false);
    setExpandedStatusSection(null);
    setClosingStatusSection(activeSection);

    if (!isStatusMenuRendered) {
      setIsStatusMenuClosing(false);
      setClosingStatusSection(null);
      return;
    }

    setIsStatusMenuClosing(true);
    statusMenuCloseTimerRef.current = window.setTimeout(() => {
      setIsStatusMenuRendered(false);
      setIsStatusMenuClosing(false);
      setClosingStatusSection(null);
      statusMenuCloseTimerRef.current = null;
    }, STATUS_MENU_ANIMATION_MS);
  }

  function closeStatusSection(section: "model" | "speed") {
    if (statusSectionCloseTimerRef.current !== null) {
      window.clearTimeout(statusSectionCloseTimerRef.current);
      statusSectionCloseTimerRef.current = null;
    }
    setExpandedStatusSection(null);
    setClosingStatusSection(section);
    statusSectionCloseTimerRef.current = window.setTimeout(() => {
      setClosingStatusSection(null);
      statusSectionCloseTimerRef.current = null;
    }, STATUS_SECTION_ANIMATION_MS);
  }

  const statusLabel = [
    currentFamily?.label,
    hasReasoningPicker ? reasoningEffort : null,
  ].filter(Boolean).join(" ") || (hasFastModePicker ? "速率" : hasReasoningPicker ? "推理" : "模型");

  function reasoningOptionLabel(value: string) {
    return ({ low: "低", medium: "中", high: "高", xhigh: "超高", none: "无" } as Record<string, string>)[value]
      ?? reasoningConfig?.valueLabels?.[value]
      ?? value;
  }

  function normalizeFastModeValue(value: ChatConfigValue | null | undefined): "off" | "on" {
    if (typeof value === "boolean") {
      return value ? "on" : "off";
    }
    const normalized = String(value ?? "").trim().toLowerCase();
    if (["on", "true", "fast", "1.5x", "1"].includes(normalized)) {
      return "on";
    }
    return "off";
  }

  return (
    <Fragment>
    <div className="composer-wrap">
      <div className="composer-stack">
        <PlanProgressPanel plan={plan} />
        {pendingApproval ? <ApprovalCard approval={pendingApproval} onResolve={onResolveApproval} /> : null}
        {pendingInput ? (
          <InputRequestCard
            key={pendingInput.inputRequestId}
            request={pendingInput}
            onResolve={onResolveInput}
          />
        ) : null}

        <div
          className="composer"
          onDragOver={(event) => {
            if (activeTurnId) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            if (activeTurnId) return;
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
          ref={composerRef}
        >
          {draftImages.length > 0 ? (
            <div className="composer-image-strip" aria-label="待发送图片">
              {draftImages.map((image) => (
                <div className="composer-image-thumb" key={image.id}>
                  <button
                    aria-label={`预览图片 ${image.name}`}
                    className="composer-image-preview"
                    onClick={() => setPreviewImage({ name: image.name, url: image.objectUrl })}
                    title={image.name}
                    type="button"
                  >
                    <img alt={image.name} src={image.objectUrl} />
                  </button>
                  <button
                    aria-label={`移除图片 ${image.name}`}
                    className="composer-image-remove"
                    onClick={() => onDraftImageRemove(image.id)}
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {draftImageError ? <div className="composer-image-error">{draftImageError}</div> : null}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!sendDisabled) {
                  onSendMessage();
                }
              }
            }}
            onPaste={(event) => {
              const files = filesFromList(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                onDraftImagesAdd(files);
              }
            }}
            placeholder="随心输入"
            rows={2}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <input
                accept={IMAGE_ACCEPT}
                hidden
                multiple
                onChange={(event) => {
                  addFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className="icon-button"
                aria-label="添加图片"
                disabled={Boolean(activeTurnId) || imagesProcessing}
                onClick={() => fileInputRef.current?.click()}
                title="添加图片"
                type="button"
              >
                {imagesProcessing ? <Loader2 className="composer-spin" size={17} /> : <Image size={17} />}
              </button>
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
                    closeStatusMenu();
                  }}
                >
                  <Plus size={17} />
                </button>
                {isCommandMenuOpen && visibleCommands.length > 0 ? (
                  <div className="command-menu" role="menu">
                    {visibleCommands.map(cmd => (
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
              {configLoading ? (
                <div className="composer-config-skeleton" aria-label="正在加载会话配置">
                  <span className="composer-skeleton-chip short" />
                </div>
              ) : hasModes ? (
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
              ) : null}
            </div>

            <div className="composer-right">
              {/* 上下文使用圆环 */}
              <ContextRing
                billingSummary={billingSummary}
                fastModeOn={isFastModeOn}
                usage={contextUsage}
                onTokenDetailsClick={() => setIsTokenModalOpen(true)}
              />

              {/* 底部状态栏：模型族 + 推理强度 */}
              {configLoading ? (
                <div className="composer-config-skeleton" aria-label="正在加载模型和思考强度">
                  <span className="composer-skeleton-chip medium" />
                  <span className="composer-skeleton-chip tiny" />
                </div>
              ) : hasAnyControls ? (
                <div className="composer-status-bar">
                  {(hasModelPicker || hasReasoningPicker || hasFastModePicker) && (
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
                      {isStatusMenuRendered && (
                        <div
                          className={[
                            "status-menu-panels",
                            expandedStatusSection ? "section-open" : "",
                            isStatusMenuClosing ? "closing" : "",
                          ].filter(Boolean).join(" ")}
                        >
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
                                {hasFastModePicker ? (
                                  <>
                                    <div className="status-dropdown-divider" />
                                    <button
                                      aria-expanded={isSpeedListOpen}
                                      className={`status-dropdown-item status-model-trigger ${isSpeedListOpen ? "expanded" : ""}`}
                                      onClick={() => toggleStatusSection("speed")}
                                      role="menuitem"
                                      type="button"
                                    >
                                      <span>速率</span>
                                      <ChevronDown size={14} />
                                    </button>
                                    {isSpeedListOpen || closingStatusSection === "speed" ? (
                                      <div
                                        className={`status-model-list ${!isSpeedListOpen ? "closing" : ""}`}
                                        role="group"
                                        aria-label="速率"
                                      >
                                        <div className="status-model-list-title">速率</div>
                                        {[
                                          { value: "off" as const, label: "1x 普通速率" },
                                          { value: "on" as const, label: "1.5x 高速" },
                                        ].map((option) => (
                                          <button
                                            key={option.value}
                                            className={`status-dropdown-item ${option.value === fastModeValue ? "selected" : ""}`}
                                            onClick={() => selectFastMode(option.value)}
                                            role="menuitem"
                                            type="button"
                                          >
                                            <span>{option.label}</span>
                                            {option.value === fastModeValue ? <Check size={14} /> : null}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                  </>
                                ) : null}
                                {currentFamily ? (
                                  <>
                                    <div className="status-dropdown-divider" />
                                    <button
                                      aria-expanded={isModelListOpen}
                                      className={`status-dropdown-item status-model-trigger ${isModelListOpen ? "expanded" : ""}`}
                                      onClick={() => toggleStatusSection("model")}
                                      role="menuitem"
                                      type="button"
                                    >
                                      <span>{currentFamily.label}</span>
                                      <ChevronDown size={14} />
                                    </button>
                                    {isModelListOpen || closingStatusSection === "model" ? (
                                      <div
                                        className={`status-model-list ${!isModelListOpen ? "closing" : ""}`}
                                        role="group"
                                        aria-label="模型"
                                      >
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
                                {hasFastModePicker ? (
                                  <>
                                    <button
                                      aria-expanded={isSpeedListOpen}
                                      className={`status-dropdown-item status-model-trigger ${isSpeedListOpen ? "expanded" : ""}`}
                                      onClick={() => toggleStatusSection("speed")}
                                      role="menuitem"
                                      type="button"
                                    >
                                      <span>速率</span>
                                      <ChevronDown size={14} />
                                    </button>
                                    {isSpeedListOpen || closingStatusSection === "speed" ? (
                                      <div
                                        className={`status-model-list ${!isSpeedListOpen ? "closing" : ""}`}
                                        role="group"
                                        aria-label="速率"
                                      >
                                        <div className="status-model-list-title">速率</div>
                                        {[
                                          { value: "off" as const, label: "1x 普通速率" },
                                          { value: "on" as const, label: "1.5x 高速" },
                                        ].map((option) => (
                                          <button
                                            key={option.value}
                                            className={`status-dropdown-item ${option.value === fastModeValue ? "selected" : ""}`}
                                            onClick={() => selectFastMode(option.value)}
                                            role="menuitem"
                                            type="button"
                                          >
                                            <span>{option.label}</span>
                                            {option.value === fastModeValue ? <Check size={14} /> : null}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                    {currentFamily ? <div className="status-dropdown-divider" /> : null}
                                  </>
                                ) : null}
                                {currentFamily ? (
                                  <>
                                    <button
                                      aria-expanded={isModelListOpen}
                                      className={`status-dropdown-item status-model-trigger ${isModelListOpen ? "expanded" : ""}`}
                                      onClick={() => toggleStatusSection("model")}
                                      role="menuitem"
                                      type="button"
                                    >
                                      <span>{currentFamily.label}</span>
                                      <ChevronDown size={14} />
                                    </button>
                                    {isModelListOpen || closingStatusSection === "model" ? (
                                      <div
                                        className={`status-model-list ${!isModelListOpen ? "closing" : ""}`}
                                        role="group"
                                        aria-label="模型"
                                      >
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
                disabled={!activeTurnId && sendDisabled}
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
      billingSummary={billingSummary}
      contextUsage={contextUsage}
      open={isTokenModalOpen}
      onClose={() => setIsTokenModalOpen(false)}
    />
    <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />
    </Fragment>
  );
}
