import { useEffect, useState } from "react";
import { Monitor, RefreshCw, Wifi, WifiOff, Shield, ShieldCheck, Eye, User, X } from "lucide-react";
import { getLocalTransport } from "../../services/agentClient";
import "./RemoteControlSettings.css";

interface RemoteConfig {
  enabled: boolean;
  pairKey: string;
  relayUrl: string;
  roomId: string;
  defaultReadonly?: boolean;
}

interface RemotePeer {
  peerId: string;
  role: string;
  connectedAt: number;
}

export function RemoteControlSettings() {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [peers, setPeers] = useState<RemotePeer[]>([]);

  const refreshPeers = async () => {
    try {
      const transport = getLocalTransport();
      const result = await transport.request<{ peers: RemotePeer[] }>("remote.peers.list", {});
      setPeers(result.peers ?? []);
    } catch {
      /* 后端未就绪时忽略 */
    }
  };

  useEffect(() => {
    (async () => {
      const transport = getLocalTransport();
      await transport.connect();
      const result = await transport.request<RemoteConfig>("remote.config.get", {});
      setConfig(result);
      setRelayUrl(result.relayUrl || "ws://localhost:18766/ws");
      setLoading(false);
      await refreshPeers();
    })();
  }, []);

  useEffect(() => {
    const transport = getLocalTransport();
    const unsub = transport.onEvent((event) => {
      const type = (event as unknown as { type?: string }).type;
      if (type === "remote.peer.joined" || type === "remote.peer.pending" || type === "remote.peer.left") {
        void refreshPeers();
      }
    });
    return unsub;
  }, []);

  const handleAuthorize = async (peerId: string, role: string) => {
    const transport = getLocalTransport();
    await transport.request("remote.peer.authorize", { peerId, role });
    await refreshPeers();
  };

  const handleKick = async (peerId: string) => {
    const transport = getLocalTransport();
    await transport.request("remote.peer.kick", { peerId });
    await refreshPeers();
  };

  const handleDefaultReadonly = async (defaultReadonly: boolean) => {
    const transport = getLocalTransport();
    const result = await transport.request<RemoteConfig>("remote.config.update", {
      enabled: config?.enabled ?? true,
      relayUrl: relayUrl || config?.relayUrl || "",
      pairKey: config?.pairKey || "",
      defaultReadonly,
    });
    setConfig(result);
  };

  const handleSave = async () => {
    setSaving(true);
    const transport = getLocalTransport();
    const result = await transport.request<RemoteConfig>("remote.config.update", {
      enabled: true,
      relayUrl,
      pairKey: config?.pairKey || "",
    });
    setConfig(result);
    setSaving(false);
  };

  const handleGenerateKey = async () => {
    setSaving(true);
    const transport = getLocalTransport();
    const result = await transport.request<{ pairKey: string; roomId: string }>("remote.config.generate_key", {});
    setConfig((prev) => prev ? { ...prev, pairKey: result.pairKey, roomId: result.roomId, enabled: true } : null);
    setSaving(false);
  };

  const handleToggle = async (enabled: boolean) => {
    const transport = getLocalTransport();
    const result = await transport.request<RemoteConfig>("remote.config.update", {
      enabled,
      relayUrl: relayUrl || config?.relayUrl || "",
      pairKey: config?.pairKey || "",
    });
    setConfig(result);
  };

  const pairUrl = config?.pairKey
    ? `${relayUrl.replace("ws://", "code-lite://pair?relay=").replace("wss://", "code-lites://pair?relay=")}&key=${config.pairKey}`
    : "";

  if (loading) return <div style={{ padding: 20, color: "var(--text-muted)" }}>加载中...</div>;

  const getRoleIcon = (role: string) => {
    if (role === "pending") return <Shield size={14} />;
    if (role === "operator") return <User size={14} />;
    return <Eye size={14} />;
  };

  const getRoleLabel = (role: string) => {
    if (role === "pending") return "待确认";
    if (role === "operator") return "可操作";
    return "只读";
  };

  const getRoleClass = (role: string) => {
    if (role === "pending") return "rc-peer-role-pending";
    if (role === "operator") return "rc-peer-role-operator";
    return "";
  };

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">连接设置</span>
        <h1>远程控制</h1>
      </div>

      {/* ─── 启用开关 ─── */}
      <div className="settings-card">
        <div className="settings-toggle-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={config?.enabled || false}
              onChange={(e) => handleToggle(e.target.checked)}
            />
            <span>启用远程控制</span>
          </label>
        </div>
      </div>

      {config?.enabled && (
        <>
          {/* ─── 中继配置 ─── */}
          <div className="settings-card">
            <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
              中继服务器
            </h3>
            <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
              配置 WebSocket 中继地址，用于桌面端与移动端之间的通信
            </p>

            <div className="settings-field">
              <span>中继地址</span>
              <input
                type="text"
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                placeholder="ws://localhost:18766/ws"
              />
            </div>

            <div className="settings-field" style={{ marginTop: "12px" }}>
              <span>Pair Key</span>
              <div className="settings-form-grid" style={{ gridTemplateColumns: "1fr auto" }}>
                <input
                  type="text"
                  value={config.pairKey}
                  readOnly
                  placeholder="点击下方按钮生成配对码"
                  style={{ background: "var(--bg-tertiary)", color: "var(--text-muted)" }}
                />
                <button
                  className="settings-secondary-button"
                  onClick={handleGenerateKey}
                  disabled={saving}
                  type="button"
                >
                  <RefreshCw size={14} />
                  {config.pairKey ? "重新生成" : "生成配对码"}
                </button>
              </div>
            </div>

            {config.pairKey && (
              <div className="settings-field" style={{ marginTop: "12px" }}>
                <span>Room ID</span>
                <div
                  style={{
                    padding: "8px 12px",
                    background: "var(--bg-tertiary)",
                    borderRadius: "var(--radius-md)",
                    color: "var(--text-muted)",
                    fontSize: "13px",
                    fontFamily: "var(--font-family-mono)",
                    wordBreak: "break-all",
                  }}
                >
                  {config.roomId}
                </div>
              </div>
            )}

            <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
              <button
                className="settings-primary-button"
                onClick={handleSave}
                disabled={saving}
                type="button"
              >
                {saving ? "保存中..." : "保存设置"}
              </button>
            </div>
          </div>

          {/* ─── 配对 ── */}
          {pairUrl && (
            <div className="settings-card">
              <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
                手机配对
              </h3>
              <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
                在手机浏览器中打开 ui-remote，输入中继地址和 Pair Key 进行配对
              </p>

              <div
                style={{
                  padding: "16px",
                  background: "var(--bg-tertiary)",
                  borderRadius: "var(--radius-md)",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-family-mono)",
                    fontSize: "11px",
                    wordBreak: "break-all",
                    color: "var(--text-muted)",
                  }}
                >
                  {pairUrl}
                </div>
              </div>
            </div>
          )}

          {/* ─── 默认权限 ─── */}
          <div className="settings-card">
            <div className="settings-toggle-row">
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={config?.defaultReadonly || false}
                  onChange={(e) => handleDefaultReadonly(e.target.checked)}
                />
                <span>新接入设备默认只读</span>
              </label>
            </div>
            <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: "12px" }}>
              开启后，新设备接入需在下方手动授予"可操作"权限；关闭则确认后默认可操作。
            </p>
          </div>

          {/* ─── 已接入设备 ─── */}
          <div className="settings-card">
            <div className="settings-page-heading" style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ margin: 0, color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
                  已接入设备
                </h3>
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    background: "var(--bg-tertiary)",
                    padding: "2px 8px",
                    borderRadius: "var(--radius-full)",
                  }}
                >
                  {peers.length} 台
                </span>
              </div>
              <button
                className="settings-icon-button"
                onClick={() => void refreshPeers()}
                type="button"
                title="刷新设备列表"
              >
                <RefreshCw size={16} />
              </button>
            </div>

            {peers.length === 0 ? (
              <div className="settings-empty">暂无设备接入</div>
            ) : (
              <div className="rc-peer-list">
                {peers.map((peer) => (
                  <div key={peer.peerId} className="rc-peer-item">
                    <div className="rc-peer-info">
                      <div className="rc-peer-icon">
                        {getRoleIcon(peer.role)}
                      </div>
                      <div className="rc-peer-details">
                        <span className="rc-peer-id">{peer.peerId}</span>
                        <span className={`rc-peer-role ${getRoleClass(peer.role)}`}>
                          {getRoleIcon(peer.role)}
                          {getRoleLabel(peer.role)}
                        </span>
                      </div>
                    </div>
                    <div className="rc-peer-actions">
                      {peer.role === "pending" && (
                        <>
                          <button
                            className="settings-secondary-button"
                            onClick={() => handleAuthorize(peer.peerId, "operator")}
                            type="button"
                            style={{ fontSize: "12px", minHeight: "28px" }}
                          >
                            <ShieldCheck size={13} />
                            允许操作
                          </button>
                          <button
                            className="settings-secondary-button"
                            onClick={() => handleAuthorize(peer.peerId, "viewer")}
                            type="button"
                            style={{ fontSize: "12px", minHeight: "28px" }}
                          >
                            <Eye size={13} />
                            仅只读
                          </button>
                        </>
                      )}
                      {peer.role === "viewer" && (
                        <button
                          className="settings-secondary-button"
                          onClick={() => handleAuthorize(peer.peerId, "operator")}
                          type="button"
                          style={{ fontSize: "12px", minHeight: "28px" }}
                        >
                          <User size={13} />
                          升为可操作
                        </button>
                      )}
                      {peer.role === "operator" && (
                        <button
                          className="settings-secondary-button"
                          onClick={() => handleAuthorize(peer.peerId, "viewer")}
                          type="button"
                          style={{ fontSize: "12px", minHeight: "28px" }}
                        >
                          <Eye size={13} />
                          降为只读
                        </button>
                      )}
                      <button
                        className="settings-icon-button"
                        onClick={() => handleKick(peer.peerId)}
                        type="button"
                        title="踢出设备"
                        style={{ color: "var(--accent-danger)" }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
