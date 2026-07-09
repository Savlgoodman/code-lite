import { useEffect, useState } from "react";

import { RefreshCw, X } from "lucide-react";

import { formatTimeLabel } from "../../lib/formatters";
import { cleanupAcpRuntimes, loadAcpRuntimeStatus } from "../../services/settingsStore";
import type { AcpRuntimeConnectionStatus, AcpRuntimeStatus } from "../../types";

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

export function AcpConnectionSettings() {
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
