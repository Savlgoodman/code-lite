import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Check, FolderOpen, Package, RefreshCw, X } from "lucide-react";

import { AgentIcon } from "../../components/AgentIcon";
import {
  installAcpPackages,
  loadAgentRuntimeSettings,
  loadAcpPackageSettings,
  updateAcpPackageDir,
  updateAgentRuntime
} from "../../services/settingsStore";
import type {
  AcpPackageInfo,
  AcpPackageSettingsState,
  AcpRuntimeVersionInfo,
  AgentRuntimeConfig,
  AgentRuntimeSettingsState,
  RuntimeExecutableInfo,
  RuntimeExecutableOption
} from "../../types";
import { SettingsSelect } from "./components/SettingsSelect";

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

export function AgentRuntimeSettings() {
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
