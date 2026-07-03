import { useEffect, useMemo, useRef, useState } from "react";

import {
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Pencil,
  Info,
  Package,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatTimeLabel } from "../lib/formatters";
import {
  addProviderModels,
  createModelProvider,
  deleteConfiguredModel,
  deleteModelProvider,
  installAgentRuntime,
  loadAgentRuntimeSettings,
  loadAppAbout,
  loadModelSettings,
  refreshModelProviderModels,
  updateActiveAgentRuntime,
  updateAgentRuntime,
  updateConfiguredModel,
  updateDefaultModel,
  updateModelProvider
} from "../services/settingsStore";
import type {
  AppAboutInfo,
  AgentRuntimeConfig,
  AgentRuntimeSettingsState,
  ConfiguredModel,
  ConfiguredModelProvider,
  ModelCapabilities,
  ModelProtocol,
  ModelSettingsState,
  Session
} from "../types";
import "./SettingsPage.css";

type SettingsSection = "agents" | "providers" | "archive" | "about";

interface SettingsPageProps {
  archivedSessions: Session[];
  onBack: () => void;
  onDeleteArchivedSession: (sessionId: string) => Promise<void>;
  onRestoreArchivedSession: (sessionId: string) => void;
}

const settingsMenu = [
  { id: "agents", icon: Package, label: "Agent Runtime" },
  { id: "providers", icon: Bot, label: "模型提供商配置" },
  { id: "archive", icon: ArchiveRestore, label: "归档会话" },
  { id: "about", icon: Info, label: "关于" }
] satisfies Array<{ id: SettingsSection; icon: LucideIcon; label: string }>;

function providerNameFromUrl(value: string) {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

const protocolOptions: Array<{ label: string; value: ModelProtocol }> = [
  { label: "OpenAI", value: "openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "OpenAI Responses", value: "openai_responses" }
];

const defaultStrategyOptions = [
  { label: "沿用上次使用的模型", value: "last_used" },
  { label: "固定指定模型", value: "fixed" }
] satisfies Array<SettingsSelectOption<"fixed" | "last_used">>;

const reasoningEffortOptions = [
  { label: "none", value: "none" },
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" }
] satisfies Array<SettingsSelectOption<string>>;

interface ProviderEditDraft {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  id: string;
  name: string;
  protocol: ModelProtocol;
}

interface ModelEditDraft {
  capabilities: ModelCapabilities;
  contextWindowTokens: string;
  enabled: boolean;
  id: string;
  label: string;
  maxOutputTokens: string;
  protocol: ModelProtocol;
  reasoningEffort: string;
  temperature: string;
}

interface SettingsSelectOption<T extends string> {
  label: string;
  value: T;
}

interface SettingsSelectProps<T extends string> {
  disabled?: boolean;
  onChange: (value: T) => void;
  options: Array<SettingsSelectOption<T>>;
  value: T;
}

function protocolLabel(value: ModelProtocol) {
  return protocolOptions.find((item) => item.value === value)?.label ?? value;
}

function SettingsSelect<T extends string>({ disabled = false, onChange, options, value }: SettingsSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((item) => item.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isOpen]);

  function chooseOption(option: SettingsSelectOption<T>) {
    onChange(option.value);
    setIsOpen(false);
  }

  return (
    <div className={`settings-select ${isOpen ? "open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="settings-select-button"
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span>{selected?.label ?? "请选择"}</span>
        <ChevronDown size={14} />
      </button>
      {isOpen ? (
        <div className="settings-select-menu" role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={`settings-select-option ${option.value === value ? "selected" : ""}`}
              key={option.value}
              onClick={() => chooseOption(option)}
              role="option"
              type="button"
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function modelEditDraft(model: ConfiguredModel): ModelEditDraft {
  return {
    capabilities: { ...model.capabilities },
    contextWindowTokens: String(model.limits.contextWindowTokens),
    enabled: model.enabled,
    id: model.id,
    label: model.label,
    maxOutputTokens: String(model.limits.maxOutputTokens),
    protocol: model.protocol,
    reasoningEffort: model.generation.reasoningEffort,
    temperature: String(model.generation.temperature)
  };
}

const codexModeOptions = [
  { label: "read-only", value: "read-only" },
  { label: "agent", value: "agent" },
  { label: "agent-full-access", value: "agent-full-access" }
] satisfies Array<SettingsSelectOption<string>>;

const codexConfigModeOptions = [
  { label: "使用本机配置", value: "user-native" },
  { label: "使用 code-lite 隔离配置", value: "isolated" }
] satisfies Array<SettingsSelectOption<string>>;

function runtimeStatusLabel(runtime: AgentRuntimeConfig) {
  if (runtime.detected.ok) {
    return "可用";
  }
  if (runtime.status === "planned") {
    return "待接入";
  }
  return "需配置";
}

function commandText(runtime: AgentRuntimeConfig) {
  return runtime.command.length > 0 ? runtime.command.join(" ") : "默认使用托管包或 npx";
}

function effectiveCommandText(runtime: AgentRuntimeConfig) {
  return runtime.detected.command?.length ? runtime.detected.command.join(" ") : commandText(runtime);
}

function configuredCommandDetail(runtime: AgentRuntimeConfig) {
  const missing = runtime.detected.missingCommand;
  if (missing?.length) {
    return `配置命令不可用，已回退：${missing.join(" ")}`;
  }
  return commandText(runtime);
}

function runtimeGlyph(runtimeId: string) {
  if (runtimeId === "codex") {
    return "Cx";
  }
  if (runtimeId === "claude_code") {
    return "Cl";
  }
  if (runtimeId === "opencode") {
    return "Op";
  }
  if (runtimeId === "nanobot") {
    return "Nb";
  }
  return "Ag";
}

function runtimeChecks(
  runtime: AgentRuntimeConfig,
  settings: AgentRuntimeSettingsState | null,
): Array<{ detail: string; label: string; ok: boolean; value: string }> {
  const nodeOk = Boolean(settings?.nodeDetected.ok);
  const npmOk = Boolean(settings?.npmDetected.ok);
  const packageVersion = runtime.managedPackage?.installedVersion;
  return [
    {
      detail: runtime.detected.detail ?? commandText(runtime),
      label: "运行状态",
      ok: runtime.detected.ok,
      value: runtime.detected.ok ? "可用" : "需配置"
    },
    {
      detail: runtime.id === "opencode" ? "opencode 使用 system command。" : "ACP npm 包需要 Node/npm。",
      label: "Node/npm prerequisite",
      ok: runtime.id === "opencode" || runtime.id === "nanobot" || (nodeOk && npmOk),
      value: runtime.id === "opencode" || runtime.id === "nanobot" || (nodeOk && npmOk) ? "pass" : "fail"
    },
    {
      detail: effectiveCommandText(runtime),
      label: "Runtime launcher",
      ok: runtime.detected.ok,
      value: runtime.detected.source ?? runtime.distribution
    },
    {
      detail: runtime.managedPackage
        ? `${runtime.managedPackage.name}${packageVersion ? `@${packageVersion}` : ""}`
        : "无需 ACP npm 包。",
      label: "ACP adapter package",
      ok: !runtime.managedPackage || Boolean(packageVersion) || runtime.detected.ok,
      value: packageVersion ?? (runtime.managedPackage ? "未安装" : "pass")
    },
    {
      detail: runtime.configMode === "isolated" ? "使用 code-lite 隔离配置目录。" : "使用 runtime 本机配置和登录态。",
      label: "Authentication",
      ok: true,
      value: runtime.configMode
    }
  ];
}

function AgentRuntimeSettings() {
  const [settings, setSettings] = useState<AgentRuntimeSettingsState | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState("codex");
  const [codexCommand, setCodexCommand] = useState("");
  const [codexPath, setCodexPath] = useState("");
  const [codexMode, setCodexMode] = useState("read-only");
  const [codexConfigMode, setCodexConfigMode] = useState("user-native");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refreshSettings() {
    setIsLoading(true);
    setError(null);
    try {
      const next = await loadAgentRuntimeSettings();
      setSettings(next);
      const codex = next.runtimes.find((runtime) => runtime.id === "codex");
      const selected = next.runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? next.runtimes[0];
      if (selected) {
        setSelectedRuntimeId(selected.id);
      }
      if (codex) {
        setCodexCommand(codex.command.join(" "));
        setCodexPath(codex.codexPath ?? "");
        setCodexMode(codex.mode || "read-only");
        setCodexConfigMode(codex.configMode || "user-native");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  async function saveCodexRuntime() {
    setBusyId("codex");
    setError(null);
    try {
      await updateAgentRuntime("codex", {
        codexPath: codexPath.trim(),
        command: codexCommand.trim(),
        configMode: codexConfigMode,
        mode: codexMode
      });
      await refreshSettings();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function installRuntime(runtime: AgentRuntimeConfig) {
    setBusyId(`${runtime.id}-install`);
    setError(null);
    try {
      await installAgentRuntime(runtime.id);
      await refreshSettings();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  const runtimes = settings?.runtimes ?? [];
  const codex = runtimes.find((runtime) => runtime.id === "codex");
  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? runtimes[0] ?? null;
  const checks = selectedRuntime ? runtimeChecks(selectedRuntime, settings) : [];
  const selectedIsCodex = selectedRuntime?.id === "codex";

  return (
    <section className="settings-content-column">
      <div className="settings-runtime-switcher">
        {runtimes.map((runtime) => (
          <button
            className={`runtime-tab ${runtime.id === selectedRuntime?.id ? "active" : ""}`}
            key={runtime.id}
            onClick={() => setSelectedRuntimeId(runtime.id)}
            title={runtime.label}
            type="button"
          >
            <span>{runtimeGlyph(runtime.id)}</span>
            <i className={runtime.detected.ok ? "ok" : ""} />
          </button>
        ))}
        <button className="runtime-refresh" disabled={isLoading} onClick={() => void refreshSettings()} title="刷新" type="button">
          <RefreshCw className={isLoading ? "spin-icon" : ""} size={16} />
        </button>
      </div>

      {selectedRuntime ? (
        <div className="settings-runtime-title-row">
          <div className="runtime-large-icon">{runtimeGlyph(selectedRuntime.id)}</div>
          <div>
            <div className="settings-runtime-title">
              <h1>{selectedRuntime.label}</h1>
            </div>
            <p>
              {selectedRuntime.managedPackage?.name ?? selectedRuntime.distribution}
              {selectedRuntime.managedPackage?.requestedVersion ? ` @ ${selectedRuntime.managedPackage.requestedVersion}` : ""}
            </p>
          </div>
          <div className="runtime-title-actions">
            {selectedRuntime.canInstall ? (
              <button
                className="settings-secondary-button"
                disabled={busyId === `${selectedRuntime.id}-install`}
                onClick={() => void installRuntime(selectedRuntime)}
                type="button"
              >
                <Package size={14} />
                <span>{busyId === `${selectedRuntime.id}-install` ? "安装中" : "安装 ACP 包"}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="settings-card runtime-check-card">
        <div className="settings-runtime-section-head">
          <div>
            <span>预检查</span>
            <strong>{selectedRuntime?.detected.detail ?? "等待检测"}</strong>
          </div>
          <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshSettings()} type="button">
            <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
            <span>立即检查</span>
          </button>
        </div>
        <div className="runtime-check-list">
          {checks.map((item) => (
            <div className="runtime-check-row" key={item.label}>
              <span className={item.ok ? "pass" : "fail"}>{item.ok ? "✓" : "!"}</span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
              <i className={item.ok ? "pass" : "fail"}>{item.value}</i>
            </div>
          ))}
        </div>
      </div>

      {selectedIsCodex && codex ? (
        <div className="settings-card">
          <div className="settings-runtime-section-head">
            <div>
              <span>配置管理</span>
              <strong>Codex ACP</strong>
            </div>
            <button className="settings-primary-button" disabled={busyId === "codex"} onClick={() => void saveCodexRuntime()} type="button">
              <Check size={14} />
              <span>保存</span>
            </button>
          </div>
          <div className="settings-form-grid runtime-form-grid">
            <label className="settings-field">
              <span>Codex 模式</span>
              <SettingsSelect onChange={setCodexMode} options={codexModeOptions} value={codexMode} />
            </label>
            <label className="settings-field">
              <span>配置来源</span>
              <SettingsSelect onChange={setCodexConfigMode} options={codexConfigModeOptions} value={codexConfigMode} />
            </label>
            <label className="settings-field settings-field-wide">
              <span>ACP 命令</span>
              <input
                autoComplete="off"
                onChange={(event) => setCodexCommand(event.target.value)}
                placeholder="留空则使用托管 codex-acp 或 npx -y @agentclientprotocol/codex-acp"
                value={codexCommand}
              />
            </label>
            <label className="settings-field settings-field-wide">
              <span>Codex binary 路径</span>
              <input
                autoComplete="off"
                onChange={(event) => setCodexPath(event.target.value)}
                placeholder="高级配置，可留空使用 codex-acp 默认依赖"
                value={codexPath}
              />
            </label>
          </div>

          <div className="settings-runtime-detail">
            <div>
              <span>实际启动命令</span>
              <strong>{effectiveCommandText(codex)}</strong>
            </div>
            <div>
              <span>配置命令</span>
              <strong>{configuredCommandDetail(codex)}</strong>
            </div>
            <div>
              <span>ACP 包</span>
              <strong>
                {codex.managedPackage?.name ?? "@agentclientprotocol/codex-acp"}
                {codex.managedPackage?.installedVersion ? ` / ${codex.managedPackage.installedVersion}` : ""}
              </strong>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="settings-inline-error">{error}</div> : null}
    </section>
  );
}

function ModelProvidersSettings() {
  const [settings, setSettings] = useState<ModelSettingsState | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai");
  const [supportsReasoning, setSupportsReasoning] = useState(false);
  const [supportsMultimodal, setSupportsMultimodal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, Set<string>>>({});
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderEditDraft | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelEditDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshSettings() {
    setIsLoading(true);
    setError(null);
    try {
      setSettings(await loadModelSettings());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  async function addProvider() {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    if (!trimmedBaseUrl || !trimmedApiKey) {
      setError("请填写 URL 和 API Key");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const provider = await createModelProvider({
        apiKey: trimmedApiKey,
        baseUrl: trimmedBaseUrl,
        name: providerName.trim() || providerNameFromUrl(trimmedBaseUrl),
        protocol
      });
      await refreshModelProviderModels(provider.id);
      setSettings(await loadModelSettings());
      setApiKey("");
      setBaseUrl("");
      setProviderName("");
      setProtocol("openai");
      setSupportsMultimodal(false);
      setSupportsReasoning(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshProvider(providerId: string) {
    setBusyId(providerId);
    setError(null);
    try {
      const provider = await refreshModelProviderModels(providerId);
      setSettings((current) =>
        current
          ? {
              ...current,
              providers: current.providers.map((item) => (item.id === provider.id ? provider : item))
            }
          : current
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  function editProvider(provider: ConfiguredModelProvider) {
    setProviderDraft({
      apiKey: "",
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol
    });
    setError(null);
  }

  async function saveProviderDraft() {
    if (!providerDraft) {
      return;
    }
    const trimmedName = providerDraft.name.trim();
    const trimmedBaseUrl = providerDraft.baseUrl.trim();
    if (!trimmedName || !trimmedBaseUrl) {
      setError("请填写供应商名称和 URL");
      return;
    }

    setBusyId(providerDraft.id);
    setError(null);
    try {
      const patch: Parameters<typeof updateModelProvider>[1] = {
        baseUrl: trimmedBaseUrl,
        enabled: providerDraft.enabled,
        name: trimmedName,
        protocol: providerDraft.protocol
      };
      if (providerDraft.apiKey.trim()) {
        patch.apiKey = providerDraft.apiKey.trim();
      }
      await updateModelProvider(providerDraft.id, patch);
      setSettings(await loadModelSettings());
      setProviderDraft(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function addSelectedModels(provider: ConfiguredModelProvider) {
    const selected = Array.from(selectedModels[provider.id] ?? []);
    if (selected.length === 0) {
      setError("请先选择要添加的模型");
      return;
    }
    setBusyId(provider.id);
    setError(null);
    try {
      const next = await addProviderModels(
        provider.id,
        selected.map((model) => ({
          capabilities: {
            reasoning: supportsReasoning,
            vision: supportsMultimodal
          },
          generation: {
            reasoningEffort: supportsReasoning ? "medium" : "none"
          },
          limits: {
            contextWindowTokens: 65536,
            maxOutputTokens: 4096
          },
          model,
          protocol: provider.protocol
        }))
      );
      setSettings(next);
      setSelectedModels((current) => ({ ...current, [provider.id]: new Set() }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteModel(modelId: string) {
    if (!window.confirm("确定删除这个模型配置吗？")) {
      return;
    }
    setBusyId(modelId);
    setError(null);
    try {
      setSettings(await deleteConfiguredModel(modelId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  function editModel(model: ConfiguredModel) {
    setModelDraft(modelEditDraft(model));
    setError(null);
  }

  async function saveModelDraft() {
    if (!modelDraft) {
      return;
    }
    const label = modelDraft.label.trim();
    const contextWindowTokens = Number.parseInt(modelDraft.contextWindowTokens, 10);
    const maxOutputTokens = Number.parseInt(modelDraft.maxOutputTokens, 10);
    const temperature = Number.parseFloat(modelDraft.temperature);
    if (!label) {
      setError("请填写模型显示名称");
      return;
    }
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
      setError("上下文长度必须是大于 0 的整数");
      return;
    }
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
      setError("最大输出长度必须是大于 0 的整数");
      return;
    }
    if (!Number.isFinite(temperature)) {
      setError("Temperature 必须是有效数字");
      return;
    }

    setBusyId(modelDraft.id);
    setError(null);
    try {
      await updateConfiguredModel(modelDraft.id, {
        capabilities: modelDraft.capabilities,
        enabled: modelDraft.enabled,
        generation: {
          reasoningEffort: modelDraft.reasoningEffort.trim() || "none",
          temperature
        },
        label,
        limits: {
          contextWindowTokens,
          maxOutputTokens
        },
        protocol: modelDraft.protocol
      });
      setSettings(await loadModelSettings());
      setModelDraft(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProvider(provider: ConfiguredModelProvider) {
    if (!window.confirm(`确定删除供应商“${provider.name}”及其模型配置吗？`)) {
      return;
    }
    setBusyId(provider.id);
    setError(null);
    try {
      setSettings(await deleteModelProvider(provider.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function changeDefaultStrategy(value: string) {
    const defaultStrategy = value === "fixed" ? "fixed" : "last_used";
    setError(null);
    try {
      setSettings(await updateDefaultModel({
        defaultModelId: defaultStrategy === "fixed" ? settings?.effectiveDefaultModelId ?? settings?.models[0]?.id ?? null : null,
        defaultStrategy
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function setDefaultModel(modelId: string) {
    setError(null);
    try {
      setSettings(await updateDefaultModel({
        defaultModelId: modelId,
        defaultStrategy: "fixed"
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  function toggleModel(providerId: string, model: string, checked: boolean) {
    setSelectedModels((current) => {
      const nextSet = new Set(current[providerId] ?? []);
      if (checked) {
        nextSet.add(model);
      } else {
        nextSet.delete(model);
      }
      return { ...current, [providerId]: nextSet };
    });
  }

  function toggleProviderCollapse(providerId: string) {
    setCollapsedProviders((current) => ({
      ...current,
      [providerId]: !(current[providerId] ?? false)
    }));
  }

  function updateModelCapability(name: keyof ModelCapabilities, checked: boolean) {
    setModelDraft((current) =>
      current
        ? {
            ...current,
            capabilities: {
              ...current.capabilities,
              [name]: checked
            }
          }
        : current
    );
  }

  const providers = settings?.providers ?? [];
  const configuredModels = settings?.models ?? [];

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">配置</span>
        <h1>模型提供商配置</h1>
      </div>

      <div className="settings-card">
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>名称</span>
            <input
              autoComplete="off"
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="DeepSeek / OpenAI / 本地模型"
              value={providerName}
            />
          </label>
          <label className="settings-field">
            <span>URL</span>
            <input
              autoComplete="off"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              value={baseUrl}
            />
          </label>
          <label className="settings-field">
            <span>API Key</span>
            <input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              type="password"
              value={apiKey}
            />
          </label>
          <label className="settings-field">
            <span>协议</span>
            <SettingsSelect onChange={setProtocol} options={protocolOptions} value={protocol} />
          </label>
        </div>

        <div className="settings-toggle-row">
          <label className="settings-check">
            <input
              checked={supportsReasoning}
              onChange={(event) => setSupportsReasoning(event.target.checked)}
              type="checkbox"
            />
            <span>支持思考</span>
          </label>
          <label className="settings-check">
            <input
              checked={supportsMultimodal}
              onChange={(event) => setSupportsMultimodal(event.target.checked)}
              type="checkbox"
            />
            <span>支持多模态</span>
          </label>
          <button className="settings-primary-button" disabled={isLoading} onClick={() => void addProvider()} type="button">
            <RefreshCw className={isLoading ? "spin-icon" : ""} size={15} />
            <span>保存并获取模型</span>
          </button>
        </div>

        {error ? <div className="settings-inline-error">{error}</div> : null}
      </div>

      <div className="settings-card">
        <div className="settings-default-row">
          <label className="settings-field">
            <span>新会话默认模型</span>
            <SettingsSelect
              onChange={(value) => void changeDefaultStrategy(value)}
              options={defaultStrategyOptions}
              value={settings?.defaultStrategy ?? "last_used"}
            />
          </label>
          <label className="settings-field">
            <span>固定模型</span>
            <SettingsSelect
              disabled={(settings?.defaultStrategy ?? "last_used") !== "fixed" || configuredModels.length === 0}
              onChange={(value) => void setDefaultModel(value)}
              options={
                configuredModels.length === 0
                  ? [{ label: "暂无模型", value: "" }]
                  : configuredModels.map((model) => ({ label: model.label, value: model.id }))
              }
              value={settings?.effectiveDefaultModelId ?? ""}
            />
          </label>
        </div>
      </div>

      <div className="settings-list">
        {providers.length === 0 ? (
          <div className="settings-empty">暂无模型提供商</div>
        ) : (
          providers.map((provider) => {
            const isCollapsed = collapsedProviders[provider.id] ?? false;
            return (
              <article className={`settings-provider-row ${isCollapsed ? "collapsed" : ""}`} key={provider.id}>
                <div className="settings-provider-header">
                  <button
                    aria-controls={`provider-body-${provider.id}`}
                    aria-expanded={!isCollapsed}
                    className="settings-icon-button"
                    onClick={() => toggleProviderCollapse(provider.id)}
                    title={isCollapsed ? "展开供应商" : "折叠供应商"}
                    type="button"
                  >
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </button>
                  <div className="settings-provider-main">
                    <div>
                      <strong>{provider.name}</strong>
                      <span>{provider.baseUrl}</span>
                    </div>
                    <div className="settings-provider-flags">
                      <span className={provider.enabled ? "enabled" : ""}>{provider.enabled ? "启用" : "停用"}</span>
                      <span className={provider.hasApiKey ? "enabled" : ""}>
                        {provider.hasApiKey ? <Check size={13} /> : <X size={13} />}
                        密钥
                      </span>
                      <span className="enabled">{protocolLabel(provider.protocol)}</span>
                    </div>
                  </div>
                  <div className="settings-row-actions provider-actions">
                    <button className="settings-secondary-button" onClick={() => editProvider(provider)} type="button">
                      <Pencil size={14} />
                      <span>编辑</span>
                    </button>
                    <button
                      className="settings-secondary-button"
                      disabled={busyId === provider.id}
                      onClick={() => void refreshProvider(provider.id)}
                      type="button"
                    >
                      <RefreshCw className={busyId === provider.id ? "spin-icon" : ""} size={14} />
                      <span>刷新模型</span>
                    </button>
                    <button className="settings-danger-button" disabled={busyId === provider.id} onClick={() => void deleteProvider(provider)} type="button">
                      <Trash2 size={14} />
                      <span>删除供应商</span>
                    </button>
                  </div>
                </div>

                {!isCollapsed ? (
                  <div className="settings-provider-body" id={`provider-body-${provider.id}`}>
                    <div className="settings-model-cloud" aria-label="发现的模型">
                      {provider.discoveredModels.length === 0 ? (
                        <span>暂无发现模型</span>
                      ) : (
                        provider.discoveredModels.slice(0, 24).map((model) => (
                          <label className="settings-model-choice" key={model.id}>
                            <input
                              checked={selectedModels[provider.id]?.has(model.id) ?? false}
                              onChange={(event) => toggleModel(provider.id, model.id, event.target.checked)}
                              type="checkbox"
                            />
                            <span>{model.label}</span>
                          </label>
                        ))
                      )}
                      {provider.discoveredModels.length > 24 ? <span>共 {provider.discoveredModels.length} 个</span> : null}
                    </div>
                    {provider.discoveredModels.length > 0 ? (
                      <button
                        className="settings-secondary-button add-models-button"
                        disabled={busyId === provider.id}
                        onClick={() => void addSelectedModels(provider)}
                        type="button"
                      >
                        <Check size={14} />
                        <span>添加选中模型</span>
                      </button>
                    ) : null}
                    {provider.models.length > 0 ? (
                      <div className="settings-configured-models">
                        {provider.models.map((model) => (
                          <div className="settings-configured-model" key={model.id}>
                            <div>
                              <strong>{model.label}</strong>
                              <span>
                                {model.model} / {model.limits.contextWindowTokens.toLocaleString()} tokens / 输出{" "}
                                {model.limits.maxOutputTokens.toLocaleString()}
                              </span>
                            </div>
                            <div className="settings-provider-flags">
                              <span className={model.enabled ? "enabled" : ""}>{model.enabled ? "启用" : "停用"}</span>
                              <span className={model.capabilities.reasoning ? "enabled" : ""}>思考</span>
                              <span className={model.capabilities.vision ? "enabled" : ""}>多模态</span>
                              <span>{protocolLabel(model.protocol)}</span>
                            </div>
                            <div className="settings-row-actions">
                              <button className="settings-secondary-button" onClick={() => editModel(model)} type="button">
                                <SlidersHorizontal size={14} />
                                <span>参数</span>
                              </button>
                              <button className="settings-secondary-button" onClick={() => void setDefaultModel(model.id)} type="button">
                                <Check size={14} />
                                <span>{settings?.effectiveDefaultModelId === model.id ? "默认" : "设为默认"}</span>
                              </button>
                              <button className="settings-danger-button" disabled={busyId === model.id} onClick={() => void deleteModel(model.id)} type="button">
                                <Trash2 size={14} />
                                <span>删除</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {providerDraft ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">供应商</span>
                <h2>编辑供应商</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setProviderDraft(null)} title="关闭" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>名称</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })}
                  value={providerDraft.name}
                />
              </label>
              <label className="settings-field">
                <span>协议</span>
                <SettingsSelect
                  onChange={(value) => setProviderDraft({ ...providerDraft, protocol: value })}
                  options={protocolOptions}
                  value={providerDraft.protocol}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>URL</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })}
                  value={providerDraft.baseUrl}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>API Key</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })}
                  placeholder="留空则保持原密钥"
                  type="password"
                  value={providerDraft.apiKey}
                />
              </label>
            </div>
            <div className="settings-toggle-row modal-toggle-row">
              <label className="settings-check">
                <input
                  checked={providerDraft.enabled}
                  onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>启用供应商</span>
              </label>
            </div>
            {error ? <div className="settings-inline-error">{error}</div> : null}
            <div className="settings-modal-actions">
              <button className="settings-secondary-button" onClick={() => setProviderDraft(null)} type="button">
                <span>取消</span>
              </button>
              <button className="settings-primary-button" disabled={busyId === providerDraft.id} onClick={() => void saveProviderDraft()} type="button">
                <Check size={14} />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modelDraft ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal wide" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">模型</span>
                <h2>编辑模型参数</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setModelDraft(null)} title="关闭" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>显示名称</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setModelDraft({ ...modelDraft, label: event.target.value })}
                  value={modelDraft.label}
                />
              </label>
              <label className="settings-field">
                <span>协议</span>
                <SettingsSelect
                  onChange={(value) => setModelDraft({ ...modelDraft, protocol: value })}
                  options={protocolOptions}
                  value={modelDraft.protocol}
                />
              </label>
              <label className="settings-field">
                <span>上下文长度</span>
                <input
                  min={1}
                  onChange={(event) => setModelDraft({ ...modelDraft, contextWindowTokens: event.target.value })}
                  type="number"
                  value={modelDraft.contextWindowTokens}
                />
              </label>
              <label className="settings-field">
                <span>最大输出长度</span>
                <input
                  min={1}
                  onChange={(event) => setModelDraft({ ...modelDraft, maxOutputTokens: event.target.value })}
                  type="number"
                  value={modelDraft.maxOutputTokens}
                />
              </label>
              <label className="settings-field">
                <span>Temperature</span>
                <input
                  onChange={(event) => setModelDraft({ ...modelDraft, temperature: event.target.value })}
                  step="0.1"
                  type="number"
                  value={modelDraft.temperature}
                />
              </label>
              <label className="settings-field">
                <span>Reasoning Effort</span>
                <SettingsSelect
                  onChange={(value) => setModelDraft({ ...modelDraft, reasoningEffort: value })}
                  options={reasoningEffortOptions}
                  value={modelDraft.reasoningEffort}
                />
              </label>
            </div>
            <div className="settings-toggle-row modal-toggle-row wrap">
              <label className="settings-check">
                <input
                  checked={modelDraft.enabled}
                  onChange={(event) => setModelDraft({ ...modelDraft, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>启用模型</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.text}
                  onChange={(event) => updateModelCapability("text", event.target.checked)}
                  type="checkbox"
                />
                <span>文本</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.tools}
                  onChange={(event) => updateModelCapability("tools", event.target.checked)}
                  type="checkbox"
                />
                <span>工具</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.reasoning}
                  onChange={(event) => updateModelCapability("reasoning", event.target.checked)}
                  type="checkbox"
                />
                <span>思考</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.vision}
                  onChange={(event) => updateModelCapability("vision", event.target.checked)}
                  type="checkbox"
                />
                <span>多模态</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.audio}
                  onChange={(event) => updateModelCapability("audio", event.target.checked)}
                  type="checkbox"
                />
                <span>音频</span>
              </label>
            </div>
            {error ? <div className="settings-inline-error">{error}</div> : null}
            <div className="settings-modal-actions">
              <button className="settings-secondary-button" onClick={() => setModelDraft(null)} type="button">
                <span>取消</span>
              </button>
              <button className="settings-primary-button" disabled={busyId === modelDraft.id} onClick={() => void saveModelDraft()} type="button">
                <Check size={14} />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ArchivedSessionsSettings({
  archivedSessions,
  onDeleteArchivedSession,
  onRestoreArchivedSession
}: Pick<SettingsPageProps, "archivedSessions" | "onDeleteArchivedSession" | "onRestoreArchivedSession">) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteSession(session: Session) {
    if (!window.confirm(`确定彻底删除“${session.title}”吗？`)) {
      return;
    }

    setDeletingId(session.id);
    setDeleteError(null);
    try {
      await onDeleteArchivedSession(session.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">会话</span>
        <h1>归档会话</h1>
      </div>

      {deleteError ? <div className="settings-inline-error">删除失败：{deleteError}</div> : null}

      <div className="settings-list">
        {archivedSessions.length === 0 ? (
          <div className="settings-empty">暂无归档会话</div>
        ) : (
          archivedSessions.map((session) => (
            <article className="settings-archive-row" key={session.id}>
              <div>
                <strong>{session.title}</strong>
                {session.preview.trim() ? <span>{session.preview}</span> : null}
              </div>
              <time>{formatTimeLabel(session.updatedAt)}</time>
              <div className="settings-row-actions">
                <button className="settings-secondary-button" onClick={() => onRestoreArchivedSession(session.id)} type="button">
                  <RotateCcw size={14} />
                  <span>恢复</span>
                </button>
                <button
                  className="settings-danger-button"
                  disabled={deletingId === session.id}
                  onClick={() => void deleteSession(session)}
                  type="button"
                >
                  <Trash2 size={14} />
                  <span>{deletingId === session.id ? "删除中" : "彻底删除"}</span>
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function AboutSettings() {
  const [about, setAbout] = useState<AppAboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refreshAbout() {
    setIsLoading(true);
    setError(null);
    try {
      setAbout(await loadAppAbout());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshAbout();
  }, []);

  const maxUsageBytes = useMemo(() => {
    const usage = about?.dataUsage ?? [];
    return Math.max(1, ...usage.map((item) => item.bytes));
  }, [about]);

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">应用</span>
          <h1>关于</h1>
        </div>
        <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshAbout()} type="button">
          <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
          <span>刷新</span>
        </button>
      </div>

      {error ? <div className="settings-inline-error">关于信息读取失败：{error}</div> : null}

      <div className="settings-card">
        <div className="settings-about-grid">
          <div>
            <span>当前版本</span>
            <strong>{about?.appVersion ?? "待检测"}</strong>
          </div>
          <div>
            <span>Backend 版本</span>
            <strong>{about?.backendVersion ?? "待检测"}</strong>
          </div>
          <div>
            <span>运行时环境</span>
            <strong>{about?.runtimeEnv ?? "待检测"}</strong>
          </div>
          <div>
            <span>Agent Adapter</span>
            <strong>{about?.agentAdapter ?? "待检测"}</strong>
          </div>
          <div>
            <span>Git 地址</span>
            <strong>{about?.git.remote ?? "待检测"}</strong>
          </div>
          <div>
            <span>Git 版本</span>
            <strong>{about ? `${about.git.branch} / ${about.git.commit}` : "待检测"}</strong>
          </div>
          <div>
            <span>工作目录</span>
            <strong>{about?.workspace ?? "待检测"}</strong>
          </div>
          <div>
            <span>Data 目录</span>
            <strong>{about?.dataDir ?? "待检测"}</strong>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-storage-head">
          <Database size={16} />
          <strong>Data 目录占用</strong>
          <span>{about?.dataDirSize ?? "待检测"}</span>
        </div>
        <div className="settings-storage-list">
          {(about?.dataUsage ?? []).map((item) => (
            <div className="settings-storage-item" key={item.label}>
              <div>
                <strong>{item.label}</strong>
                <span>{item.path}</span>
              </div>
              <span>{item.size}</span>
              <div className="settings-storage-bar">
                <i style={{ width: `${Math.max(3, (item.bytes / maxUsageBytes) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SettingsPage({
  archivedSessions,
  onBack,
  onDeleteArchivedSession,
  onRestoreArchivedSession
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("agents");

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <button className="settings-back-button" onClick={onBack} type="button">
          <ArrowLeft size={17} />
          <span>返回应用</span>
        </button>

        <nav className="settings-nav" aria-label="设置菜单">
          {settingsMenu.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`settings-nav-item ${activeSection === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="settings-main">
        {activeSection === "agents" ? <AgentRuntimeSettings /> : null}
        {activeSection === "providers" ? <ModelProvidersSettings /> : null}
        {activeSection === "archive" ? (
          <ArchivedSessionsSettings
            archivedSessions={archivedSessions}
            onDeleteArchivedSession={onDeleteArchivedSession}
            onRestoreArchivedSession={onRestoreArchivedSession}
          />
        ) : null}
        {activeSection === "about" ? <AboutSettings /> : null}
      </main>
    </div>
  );
}
