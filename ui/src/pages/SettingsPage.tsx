import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import {
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  FolderOpen,
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

import { AgentIcon } from "../components/AgentIcon";
import { formatTimeLabel } from "../lib/formatters";
import {
  addProviderModels,
  cleanupAcpRuntimes,
  createModelProvider,
  deleteConfiguredModel,
  deleteModelProvider,
  installAcpPackages,
  loadAgentRuntimeSettings,
  loadAcpPackageSettings,
  loadAcpRuntimeStatus,
  loadAppAbout,
  loadLogFiles,
  loadLogTail,
  loadModelSettings,
  refreshModelProviderModels,
  updateAcpPackageDir,
  updateAgentRuntime,
  updateConfiguredModel,
  updateDefaultModel,
  updateModelProvider
} from "../services/settingsStore";
import type {
  AcpPackageInfo,
  AcpPackageSettingsState,
  AcpRuntimeConnectionStatus,
  AcpRuntimeStatus,
  AcpRuntimeVersionInfo,
  AgentRuntimeConfig,
  AgentRuntimeSettingsState,
  AppAboutInfo,
  ConfiguredModel,
  ConfiguredModelProvider,
  ModelCapabilities,
  ModelProtocol,
  LogEntry,
  LogFileInfo,
  ModelSettingsState,
  RuntimeExecutableInfo,
  RuntimeExecutableOption,
  Session
} from "../types";
import "./SettingsPage.css";

type SettingsSection = "agents" | "acp" | "providers" | "logs" | "archive" | "about";

interface SettingsPageProps {
  archivedSessions: Session[];
  onBack: () => void;
  onDeleteArchivedSession: (sessionId: string) => Promise<void>;
  onRestoreArchivedSession: (sessionId: string) => void;
}

const settingsMenu = [
  { id: "agents", icon: Package, label: "Agent Runtime" },
  { id: "acp", icon: Database, label: "ACP 连接管理" },
  { id: "providers", icon: Bot, label: "模型提供商配置" },
  { id: "logs", icon: FileText, label: "日志" },
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

function acpPackageStateLabel(installed: boolean, needsUpdate: boolean) {
  if (needsUpdate) {
    return "可更新";
  }
  return installed ? "已安装" : "未安装";
}

function executableSourceLabel(source: string) {
  if (source === "sdk") {
    return "SDK 内置";
  }
  if (source === "system") {
    return "本机";
  }
  return source || "自动";
}

function runtimeExecutableOptionLabel(option: RuntimeExecutableOption) {
  const source = option.kind === "sdk" ? "SDK 内置" : option.source;
  const version = option.version ? ` · ${option.version}` : "";
  if (option.kind === "sdk") {
    return `${source}${version}`;
  }
  return `${source} · ${option.path}${version}`;
}

function acpConnectionModeLabel(value: string) {
  if (value === "multi-session" || value === "runtime-shared" || value === "shared") {
    return "单连接多 session";
  }
  if (value === "per-conversation") {
    return "每会话独立连接";
  }
  if (value === "unavailable") {
    return "不可用";
  }
  return value || "未知";
}

function acpReadyLabel(connection: AcpRuntimeConnectionStatus) {
  return connection.ready ? "ready" : "starting";
}

function formatAcpActivity(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "未知";
  }
  return formatTimeLabel(value * 1000);
}

function compactIdentifier(value: string) {
  if (!value) {
    return "-";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

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

function runtimeChecks(
  runtime: AgentRuntimeConfig,
  runtimeSettings: AgentRuntimeSettingsState | null,
  packageInfo: AcpPackageInfo | null,
  runtimeVersion: AcpRuntimeVersionInfo | null,
  executableInfo: RuntimeExecutableInfo | null
): Array<{ detail: string; label: string; ok: boolean; value: string }> {
  const nodeOk = Boolean(runtimeSettings?.nodeDetected.ok);
  const npmOk = Boolean(runtimeSettings?.npmDetected.ok);
  const packageVersion = packageInfo?.installedVersion ?? runtime.managedPackage?.installedVersion;
  const runtimeVersionDetail = executableInfo?.selectedPath || runtimeVersion?.command.join(" ") || commandText(runtime);
  const runtimeVersionValue = executableInfo?.selectedVersion ?? runtimeVersion?.version;
  return [
    {
      detail: runtime.detected.detail ?? commandText(runtime),
      label: "运行状态",
      ok: runtime.detected.ok,
      value: runtimeStatusLabel(runtime)
    },
    {
      detail: runtime.id === "opencode" ? "opencode 使用 system command。" : runtime.id === "nanobot" ? "nanobot 由 Python backend 内置。" : "ACP npm 包需要 Node/npm。",
      label: "Node/npm",
      ok: runtime.id === "opencode" || runtime.id === "nanobot" || (nodeOk && npmOk),
      value: runtime.id === "opencode" || runtime.id === "nanobot" || (nodeOk && npmOk) ? "pass" : "fail"
    },
    {
      detail: runtime.detected.command?.length ? runtime.detected.command.join(" ") : commandText(runtime),
      label: "Runtime launcher",
      ok: runtime.detected.ok,
      value: runtime.detected.source ?? runtime.distribution
    },
    {
      detail: runtime.managedPackage
        ? `${runtime.managedPackage.name}${packageVersion ? `@${packageVersion}` : ""}`
        : "无需托管 ACP 包。",
      label: "托管包",
      ok: !runtime.managedPackage || Boolean(packageVersion) || runtime.detected.ok,
      value: packageVersion ?? (runtime.managedPackage ? "未安装" : "pass")
    },
    {
      detail: runtimeVersionDetail,
      label: "Runtime 版本",
      ok: runtime.id === "opencode" || runtime.id === "nanobot" || Boolean(runtimeVersionValue),
      value: runtimeVersionValue ?? (runtime.id === "opencode" || runtime.id === "nanobot" ? "无需检测" : "未检测到")
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
  const [runtimeSettings, setRuntimeSettings] = useState<AgentRuntimeSettingsState | null>(null);
  const [packageSettings, setPackageSettings] = useState<AcpPackageSettingsState | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState("codex");
  const [packageDirDrafts, setPackageDirDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshSettings(options: { check?: boolean } = {}) {
    setIsLoading(true);
    setError(null);
    try {
      const [nextRuntimes, nextPackages] = await Promise.all([
        loadAgentRuntimeSettings(),
        loadAcpPackageSettings(options)
      ]);
      setRuntimeSettings(nextRuntimes);
      setPackageSettings(nextPackages);
      setPackageDirDrafts(Object.fromEntries(nextPackages.packages.map((item) => [item.runtimeId, item.packageDir])));
      const selected = nextRuntimes.runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? nextRuntimes.runtimes[0];
      if (selected) {
        setSelectedRuntimeId(selected.id);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function savePackageDir(runtimeId: string, nextDir: string) {
    const trimmedDir = nextDir.trim();
    if (!trimmedDir) {
      setError("ACP 包目录不能为空");
      return;
    }
    setBusyId(`${runtimeId}-package-dir`);
    setError(null);
    try {
      const next = await updateAcpPackageDir(runtimeId, trimmedDir);
      setPackageSettings(next);
      setPackageDirDrafts(Object.fromEntries(next.packages.map((item) => [item.runtimeId, item.packageDir])));
      setRuntimeSettings(await loadAgentRuntimeSettings());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function browsePackageDir(runtimeId: string) {
    setBusyId(`${runtimeId}-browse`);
    setError(null);
    try {
      const selected = await invoke<string | null>("pick_acp_package_directory");
      if (selected) {
        await savePackageDir(runtimeId, selected);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function primaryPackageAction(runtimeId: string) {
    const item = packageSettings?.packages.find((packageItem) => packageItem.runtimeId === runtimeId);
    if (!item?.installed || item.packageDirIsEmpty) {
      setBusyId(`${runtimeId}-install`);
      setError(null);
      try {
        const next = await installAcpPackages({ runtimeId });
        setPackageSettings(next);
        setPackageDirDrafts(Object.fromEntries(next.packages.map((packageItem) => [packageItem.runtimeId, packageItem.packageDir])));
        setRuntimeSettings(await loadAgentRuntimeSettings());
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        setBusyId(null);
      }
      return;
    }
    await refreshSettings({ check: true });
  }

  async function updatePackage(runtimeId: string) {
    setBusyId(`${runtimeId}-update`);
    setError(null);
    try {
      const next = await installAcpPackages({ runtimeId, update: true });
      setPackageSettings(next);
      setPackageDirDrafts(Object.fromEntries(next.packages.map((item) => [item.runtimeId, item.packageDir])));
      setRuntimeSettings(await loadAgentRuntimeSettings());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function selectRuntimeExecutable(runtimeId: string, optionId: string) {
    const executable = packageSettings?.runtimeExecutables?.find((item) => item.runtimeId === runtimeId);
    const option = executable?.options.find((item) => item.id === optionId);
    if (!option) {
      setError("未找到可用的 Runtime 可执行文件选项");
      return;
    }
    setBusyId(`${runtimeId}-runtime-executable`);
    setError(null);
    try {
      await updateAgentRuntime(runtimeId, {
        runtimeExecutable: {
          source: option.kind === "sdk" ? "sdk" : "system",
          selectedPath: option.kind === "sdk" ? "" : option.path
        }
      });
      const [nextRuntimes, nextPackages] = await Promise.all([
        loadAgentRuntimeSettings(),
        loadAcpPackageSettings()
      ]);
      setRuntimeSettings(nextRuntimes);
      setPackageSettings(nextPackages);
      setPackageDirDrafts(Object.fromEntries(nextPackages.packages.map((item) => [item.runtimeId, item.packageDir])));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  const runtimes = runtimeSettings?.runtimes ?? [];
  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? runtimes[0] ?? null;
  const selectedPackage = selectedRuntime
    ? packageSettings?.packages.find((item) => item.runtimeId === selectedRuntime.id) ?? null
    : null;
  const selectedRuntimeVersion = selectedRuntime
    ? packageSettings?.runtimeVersions.find((item) => item.runtimeId === selectedRuntime.id) ?? null
    : null;
  const selectedExecutable = selectedRuntime
    ? packageSettings?.runtimeExecutables?.find((item) => item.runtimeId === selectedRuntime.id) ?? null
    : null;
  const executableOptions = selectedExecutable?.options.map((item) => ({
    label: runtimeExecutableOptionLabel(item),
    value: item.id
  })) ?? [];
  const checks = selectedRuntime
    ? runtimeChecks(selectedRuntime, runtimeSettings, selectedPackage, selectedRuntimeVersion, selectedExecutable)
    : [];
  const packageDraft = selectedPackage ? packageDirDrafts[selectedPackage.runtimeId] ?? selectedPackage.packageDir : "";
  const primaryIsInstall = Boolean(selectedPackage && (!selectedPackage.installed || selectedPackage.packageDirIsEmpty));
  const canManagePackage = Boolean(selectedPackage);

  return (
    <section className="settings-content-column">
      <div className="settings-runtime-switcher" aria-label="Agent runtime 切换">
        {runtimes.map((runtime) => (
          <button
            aria-label={runtime.label}
            aria-pressed={runtime.id === selectedRuntime?.id}
            className={`runtime-tab ${runtime.id === selectedRuntime?.id ? "active" : ""}`}
            key={runtime.id}
            onClick={() => setSelectedRuntimeId(runtime.id)}
            title={runtime.label}
            type="button"
          >
            <AgentIcon label={runtime.label} runtimeId={runtime.id} size="sm" />
            <i className={runtime.detected.ok ? "ok" : ""} />
          </button>
        ))}
        <button className="runtime-refresh" disabled={isLoading} onClick={() => void refreshSettings()} title="刷新" type="button">
          <RefreshCw className={isLoading ? "spin-icon" : ""} size={16} />
        </button>
      </div>

      {error ? <div className="settings-inline-error">Agent Runtime 设置失败：{error}</div> : null}

      {selectedRuntime ? (
        <div className="settings-runtime-title-row">
          <AgentIcon
            className="runtime-large-icon"
            label={selectedRuntime.label}
            runtimeId={selectedRuntime.id}
            size="lg"
          />
          <div>
            <div className="settings-runtime-title">
              <h1>{selectedRuntime.label}</h1>
              <span className={selectedRuntime.detected.ok ? "pass" : "fail"}>{runtimeStatusLabel(selectedRuntime)}</span>
            </div>
            <p>
              {selectedPackage?.packageName ?? selectedRuntime.managedPackage?.name ?? selectedRuntime.distribution}
              {selectedRuntime.managedPackage?.requestedVersion ? ` @ ${selectedRuntime.managedPackage.requestedVersion}` : ""}
            </p>
          </div>
        </div>
      ) : null}

      {canManagePackage && selectedPackage ? (
        <div className="settings-card acp-runtime-package-card">
          <div className="settings-runtime-section-head">
            <div>
              <span>ACP 包目录</span>
              <strong>{selectedPackage.packageDir}</strong>
            </div>
            <i className={`acp-package-status ${selectedPackage.installed ? "pass" : "fail"}`}>
              {acpPackageStateLabel(selectedPackage.installed, selectedPackage.needsUpdate)}
            </i>
          </div>
          <div className={`acp-package-root-row ${selectedPackage.needsUpdate ? "has-update" : ""}`}>
            <input
              autoComplete="off"
              onBlur={() => {
                const draft = packageDraft.trim();
                if (draft && draft !== selectedPackage.packageDir) {
                  void savePackageDir(selectedPackage.runtimeId, draft);
                }
              }}
              onChange={(event) =>
                setPackageDirDrafts((drafts) => ({ ...drafts, [selectedPackage.runtimeId]: event.target.value }))
              }
              value={packageDraft}
            />
            <button
              className="settings-primary-button"
              disabled={isLoading || busyId !== null}
              onClick={() => void primaryPackageAction(selectedPackage.runtimeId)}
              type="button"
            >
              {primaryIsInstall ? <Package size={14} /> : <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />}
              <span>
                {busyId === `${selectedPackage.runtimeId}-install`
                  ? "安装中"
                  : isLoading && !primaryIsInstall
                    ? "检查中"
                    : primaryIsInstall
                      ? "安装 ACP"
                      : "检查更新"}
              </span>
            </button>
            {selectedPackage.needsUpdate ? (
              <button
                className="settings-secondary-button"
                disabled={busyId !== null}
                onClick={() => void updatePackage(selectedPackage.runtimeId)}
                type="button"
              >
                <RefreshCw className={busyId === `${selectedPackage.runtimeId}-update` ? "spin-icon" : ""} size={14} />
                <span>{busyId === `${selectedPackage.runtimeId}-update` ? "更新中" : "更新 ACP"}</span>
              </button>
            ) : null}
            <button
              className="settings-secondary-button"
              disabled={busyId !== null || isLoading}
              onClick={() => void browsePackageDir(selectedPackage.runtimeId)}
              type="button"
            >
              <FolderOpen size={14} />
              <span>手动浏览</span>
            </button>
          </div>
          <div className="settings-runtime-detail acp-package-detail">
            <div>
              <span>ACP 版本</span>
              <strong>{selectedPackage.installedVersion ?? "未安装"}</strong>
            </div>
            <div>
              <span>最新版本</span>
              <strong>{selectedPackage.latestVersion ?? "未检查"}</strong>
            </div>
            <div>
              <span>包名</span>
              <strong>{selectedPackage.packageName}</strong>
            </div>
          </div>
        </div>
      ) : selectedRuntime ? (
        <div className="settings-card acp-runtime-package-card">
          <div className="settings-runtime-section-head">
            <div>
              <span>ACP 包目录</span>
              <strong>当前 runtime 无需托管 ACP npm 包</strong>
            </div>
          </div>
        </div>
      ) : null}

      {selectedExecutable ? (
        <div className="settings-card acp-runtime-package-card runtime-executable-card">
          <div className="settings-runtime-section-head">
            <div>
              <span>底层 Runtime 可执行文件</span>
              <strong>{selectedExecutable.selectedPath || "等待安装 ACP 包后检测 SDK 内置路径"}</strong>
            </div>
            <i className={`acp-package-status ${selectedExecutable.selectedPath ? "pass" : "fail"}`}>
              {executableSourceLabel(selectedExecutable.selectedSource)}
            </i>
          </div>
          <div className="runtime-executable-row">
            {executableOptions.length > 0 ? (
              <SettingsSelect
                disabled={busyId !== null || isLoading}
                onChange={(value) => void selectRuntimeExecutable(selectedExecutable.runtimeId, value)}
                options={executableOptions}
                value={selectedExecutable.selectedId}
              />
            ) : (
              <div className="runtime-executable-empty">未找到可用 Runtime executable</div>
            )}
            <button
              className="settings-secondary-button"
              disabled={isLoading}
              onClick={() => void refreshSettings({ check: true })}
              type="button"
            >
              <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
              <span>检查版本</span>
            </button>
          </div>
          <div className="settings-runtime-detail acp-package-detail runtime-executable-detail">
            <div>
              <span>当前版本</span>
              <strong>{selectedExecutable.selectedVersion ?? "未检测到"}</strong>
            </div>
            <div>
              <span>SDK 版本</span>
              <strong>{selectedExecutable.sdkVersion ?? "未安装"}</strong>
            </div>
            <div>
              <span>最新 runtime 包</span>
              <strong>{selectedExecutable.latestVersion ?? "未检查"}</strong>
            </div>
          </div>
        </div>
      ) : null}

      <div className="settings-card runtime-check-card">
        <div className="settings-runtime-section-head">
          <div>
            <span>预检查</span>
            <strong>{selectedRuntime?.detected.detail ?? "等待检测"}</strong>
          </div>
          <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshSettings({ check: true })} type="button">
            <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
            <span>立即检查</span>
          </button>
        </div>
        <div className="runtime-check-list">
          {checks.map((item) => (
            <div className="runtime-check-row" key={item.label}>
              <span className={item.ok ? "pass" : "fail"}>{item.ok ? <Check size={14} /> : <X size={14} />}</span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
              <i className={item.ok ? "pass" : "fail"}>{item.value}</i>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AcpConnectionSettings() {
  const [status, setStatus] = useState<AcpRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  async function refreshStatus() {
    setIsLoading(true);
    setError(null);
    try {
      setStatus(await loadAcpRuntimeStatus());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function cleanupConnections() {
    setIsCleaning(true);
    setError(null);
    setCleanupMessage(null);
    try {
      const result = await cleanupAcpRuntimes();
      const summary = result.summary;
      setCleanupMessage(
        `已断开 ${summary.closedConnections} 个 ACP 连接，失败 ${summary.failedConnections} 个。`
      );
      await refreshStatus();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsCleaning(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  const connections = status?.connections ?? [];
  const sessionCount = connections.reduce((sum, connection) => sum + connection.activeSessions, 0);
  const activePromptCount = connections.reduce(
    (sum, connection) => sum + connection.sessions.filter((session) => session.activePrompt).length,
    0
  );
  const connectionMode = acpConnectionModeLabel(status?.connectionMode ?? "unavailable");

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">运行态</span>
          <h1>ACP 连接管理</h1>
        </div>
        <div className="settings-heading-actions">
          <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshStatus()} type="button">
            <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
            <span>刷新状态</span>
          </button>
          <button
            className="settings-danger-button"
            disabled={isCleaning || connections.length === 0}
            onClick={() => void cleanupConnections()}
            type="button"
          >
            <X size={14} />
            <span>{isCleaning ? "断开中" : "彻底断开全部连接"}</span>
          </button>
        </div>
      </div>

      {error ? <div className="settings-inline-error">ACP 连接状态获取失败：{error}</div> : null}
      {cleanupMessage ? <div className="settings-inline-success">{cleanupMessage}</div> : null}

      <div className="acp-status-summary">
        <div>
          <span>连接策略</span>
          <strong>{connectionMode}</strong>
        </div>
        <div>
          <span>ACP 进程</span>
          <strong>{connections.length}</strong>
        </div>
        <div>
          <span>绑定 session</span>
          <strong>{sessionCount}</strong>
        </div>
        <div>
          <span>运行中 prompt</span>
          <strong>{activePromptCount}</strong>
        </div>
      </div>

      <div className="acp-connection-list">
        {connections.length === 0 ? (
          <div className="settings-empty">暂无 ACP 连接</div>
        ) : (
          connections.map((connection) => (
            <article
              className="settings-card acp-connection-card"
              key={`${connection.runtime}-${connection.acpServerKind}-${connection.workspace}-${connection.pid ?? "no-pid"}`}
            >
              <div className="acp-connection-head">
                <div>
                  <strong>{connection.runtime}</strong>
                  <span>{connection.acpServerKind}</span>
                </div>
                <div className="acp-connection-meta">
                  <span className={connection.ready ? "ready" : "starting"}>{acpReadyLabel(connection)}</span>
                  <span>{connection.pid ? `PID ${connection.pid}` : "PID -"}</span>
                  <span>{connection.activeSessions} session</span>
                  <span>{formatAcpActivity(connection.latestActivityAt)}</span>
                </div>
              </div>

              <div className="acp-connection-paths">
                <div>
                  <span>workspace</span>
                  <strong>{connection.workspace || "-"}</strong>
                </div>
                <div>
                  <span>config</span>
                  <strong>{connection.configMode || "-"}</strong>
                </div>
                <div>
                  <span>connection key</span>
                  <strong>{connection.conversationKey || "shared"}</strong>
                </div>
              </div>

              {connection.sessions.length > 0 ? (
                <div className="acp-session-table">
                  <div className="acp-session-row acp-session-header">
                    <span>conversation</span>
                    <span>native session</span>
                    <span>state</span>
                    <span>prompt</span>
                  </div>
                  {connection.sessions.map((session) => (
                    <div className="acp-session-row" key={`${session.conversationId}-${session.nativeSessionId}`}>
                      <strong title={session.conversationId}>{compactIdentifier(session.conversationId)}</strong>
                      <strong title={session.nativeSessionId}>{compactIdentifier(session.nativeSessionId)}</strong>
                      <span>{session.state || "-"}</span>
                      <span>{session.activePrompt ? "running" : "idle"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="settings-empty compact">暂无绑定 session</div>
              )}
            </article>
          ))
        )}
      </div>
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
  const [deleteRequest, setDeleteRequest] = useState<
    { kind: "all"; sessions: Session[] } | { kind: "single"; session: Session } | null
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());

  const isDeleting = deletingIds.size > 0;
  const deleteCount = deleteRequest?.kind === "all" ? deleteRequest.sessions.length : deleteRequest ? 1 : 0;
  const deleteTitle = deleteRequest?.kind === "single" ? deleteRequest.session.title : "";

  function requestDeleteAll() {
    if (archivedSessions.length === 0 || isDeleting) {
      return;
    }
    setDeleteError(null);
    setDeleteRequest({ kind: "all", sessions: archivedSessions });
  }

  async function confirmDeleteRequest() {
    if (!deleteRequest) {
      return;
    }

    const sessionsToDelete = deleteRequest.kind === "all" ? deleteRequest.sessions : [deleteRequest.session];
    setDeletingIds(new Set(sessionsToDelete.map((session) => session.id)));
    setDeleteError(null);
    try {
      for (const session of sessionsToDelete) {
        await onDeleteArchivedSession(session.id);
      }
      setDeleteRequest(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingIds(new Set());
    }
  }

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">会话</span>
          <h1>归档会话</h1>
        </div>
        <button
          className="settings-danger-button"
          disabled={archivedSessions.length === 0 || isDeleting}
          onClick={requestDeleteAll}
          type="button"
        >
          <Trash2 size={14} />
          <span>全部删除</span>
        </button>
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
                <button
                  className="settings-secondary-button"
                  disabled={isDeleting}
                  onClick={() => onRestoreArchivedSession(session.id)}
                  type="button"
                >
                  <RotateCcw size={14} />
                  <span>恢复</span>
                </button>
                <button
                  className="settings-danger-button"
                  disabled={isDeleting}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteRequest({ kind: "single", session });
                  }}
                  type="button"
                >
                  <Trash2 size={14} />
                  <span>{deletingIds.has(session.id) ? "删除中" : "彻底删除"}</span>
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      {deleteRequest ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal settings-delete-dialog" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">危险操作</span>
                <h2>{deleteRequest.kind === "all" ? "彻底删除全部归档会话" : "彻底删除会话"}</h2>
              </div>
              <button
                aria-label="关闭"
                className="settings-icon-button"
                disabled={isDeleting}
                onClick={() => setDeleteRequest(null)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-delete-dialog-body">
              {deleteRequest.kind === "all" ? (
                <p>将永久删除 {deleteCount} 个归档会话，删除后无法恢复。</p>
              ) : (
                <p>
                  将永久删除会话<strong>“{deleteTitle}”</strong>，删除后无法恢复。
                </p>
              )}
            </div>
            <div className="settings-modal-actions">
              <button
                className="settings-secondary-button"
                disabled={isDeleting}
                onClick={() => setDeleteRequest(null)}
                type="button"
              >
                <span>取消</span>
              </button>
              <button
                className="settings-danger-button solid"
                disabled={isDeleting}
                onClick={() => void confirmDeleteRequest()}
                type="button"
              >
                <Trash2 size={14} />
                <span>{isDeleting ? "删除中" : "确认删除"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
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

const logCategoryOptions = [
  { label: "全部", value: "all" },
  { label: "ACP", value: "acp" },
  { label: "API", value: "api" },
  { label: "Python", value: "python" },
  { label: "Runtime stderr", value: "runtime.stderr" },
  { label: "诊断", value: "diagnostic" }
] satisfies Array<SettingsSelectOption<string>>;

const logLevelOptions = [
  { label: "全部", value: "all" },
  { label: "Error", value: "error" },
  { label: "Warning", value: "warning" },
  { label: "Info", value: "info" },
  { label: "Debug", value: "debug" }
] satisfies Array<SettingsSelectOption<string>>;

function logCategoryLabel(value?: string) {
  return logCategoryOptions.find((item) => item.value === value)?.label ?? value ?? "日志";
}

function logCategoryClass(value?: string) {
  const normalized = (value ?? "python").replace(".", "-");
  return `log-category-${normalized}`;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const category = entry.category ?? "python";
  return (
    <article className={`settings-log-entry ${logCategoryClass(category)}`}>
      <button className="settings-log-entry-main" onClick={() => setExpanded((current) => !current)} type="button">
        <span className="settings-log-time">{entry.timestamp ?? "--"}</span>
        <span className="settings-log-level">{entry.level ?? "info"}</span>
        <span className="settings-log-category">{logCategoryLabel(category)}</span>
        <span className="settings-log-message">{entry.message ?? ""}</span>
        <ChevronRight className={expanded ? "expanded" : ""} size={14} />
      </button>
      <div className="settings-log-meta">
        {entry.runtime ? <span>runtime: {entry.runtime}</span> : null}
        {entry.stage ? <span>stage: {entry.stage}</span> : null}
        {entry.conversationId ? <span>conversation: {entry.conversationId}</span> : null}
        {entry.turnId ? <span>turn: {entry.turnId}</span> : null}
      </div>
      {expanded ? (
        <pre className="settings-log-detail">{compactJson(entry)}</pre>
      ) : null}
    </article>
  );
}

function LogFilePill({ file }: { file: LogFileInfo }) {
  return (
    <div className={`settings-log-file ${logCategoryClass(file.category)}`}>
      <span>{logCategoryLabel(file.category)}</span>
      <strong>{file.exists ? file.size : "未生成"}</strong>
    </div>
  );
}

function LogsSettings() {
  const [category, setCategory] = useState("all");
  const [level, setLevel] = useState("all");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logsDir, setLogsDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refreshLogs() {
    setIsLoading(true);
    setError(null);
    try {
      const [nextFiles, tail] = await Promise.all([
        loadLogFiles(),
        loadLogTail({ category, level, query, limit: 500 })
      ]);
      setFiles(nextFiles.files);
      setLogsDir(tail.logsDir || nextFiles.logsDir);
      setEntries(tail.entries);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshLogs();
  }, []);

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">诊断</span>
          <h1>日志</h1>
        </div>
        <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshLogs()} type="button">
          <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
          <span>刷新</span>
        </button>
      </div>

      {error ? <div className="settings-inline-error">日志读取失败：{error}</div> : null}

      <div className="settings-card settings-log-toolbar">
        <label className="settings-field">
          <span>分类</span>
          <SettingsSelect onChange={setCategory} options={logCategoryOptions} value={category} />
        </label>
        <label className="settings-field">
          <span>等级</span>
          <SettingsSelect onChange={setLevel} options={logLevelOptions} value={level} />
        </label>
        <label className="settings-field settings-field-wide">
          <span>搜索</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="conversationId / turnId / stage / message" value={query} />
        </label>
        <button className="settings-primary-button" disabled={isLoading} onClick={() => void refreshLogs()} type="button">
          <span>应用筛选</span>
        </button>
      </div>

      <div className="settings-card">
        <div className="settings-storage-head">
          <FileText size={16} />
          <strong>日志目录</strong>
          <span>{logsDir || "待检测"}</span>
        </div>
        <div className="settings-log-files">
          {files.map((file) => <LogFilePill file={file} key={file.category} />)}
        </div>
      </div>

      <div className="settings-log-list">
        {entries.length === 0 ? (
          <div className="settings-empty">暂无日志</div>
        ) : entries.map((entry, index) => (
          <LogEntryRow entry={entry} key={entry.id ?? `${entry.timestamp}-${index}`} />
        ))}
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
        {activeSection === "acp" ? <AcpConnectionSettings /> : null}
        {activeSection === "providers" ? <ModelProvidersSettings /> : null}
        {activeSection === "logs" ? <LogsSettings /> : null}
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
