import { useEffect, useMemo, useState } from "react";

import { Database, RefreshCw } from "lucide-react";

import { loadAppAbout } from "../../services/settingsStore";
import type { AppAboutInfo } from "../../types";

const REPOSITORY_URL = "https://github.com/Savlgoodman/code-lite";
const AUTHOR_URL = "https://github.com/Savlgoodman";
const AUTHOR_NAME = "Kevin Roo";

export function AboutSettings() {
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
        <div className="settings-about-product">
          <div>
            <span>产品描述</span>
            <strong>code-lite 是一个桌面端多 Agent 工作台，用于接入 Codex、Claude Code、opencode 等 agent runtime。</strong>
          </div>
          <div>
            <span>根仓库</span>
            <a href={REPOSITORY_URL} rel="noreferrer" target="_blank">{REPOSITORY_URL}</a>
          </div>
          <div>
            <span>作者</span>
            <a href={AUTHOR_URL} rel="noreferrer" target="_blank">{AUTHOR_NAME}</a>
          </div>
          <div>
            <span>作者主页</span>
            <a href={AUTHOR_URL} rel="noreferrer" target="_blank">{AUTHOR_URL}</a>
          </div>
        </div>
      </div>

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
