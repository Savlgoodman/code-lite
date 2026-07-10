import { useEffect, useState } from "react";
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

  // 首连确认/设备上下线事件走全局频道 presence，收到则刷新设备列表。
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

  if (loading) return <div style={{ padding: 20, color: "var(--muted)" }}>加载中...</div>;

  return (
    <div className="remote-control-settings">
      <h2>远程控制</h2>

      <div className="rc-section">
        <label className="rc-toggle">
          <input
            type="checkbox"
            checked={config?.enabled || false}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          <span>启用远程控制</span>
        </label>
      </div>

      {config?.enabled && (
        <>
          <div className="rc-section">
            <label className="rc-label">中继服务器地址</label>
            <input
              className="rc-input"
              type="text"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="ws://localhost:18766/ws"
            />
          </div>

          <div className="rc-section">
            <label className="rc-label">Pair Key</label>
            <div className="rc-pair-key-row">
              <input
                className="rc-input rc-pair-key"
                type="text"
                value={config.pairKey}
                readOnly
                placeholder="点击下方按钮生成"
              />
              <button className="rc-btn" onClick={handleGenerateKey} disabled={saving}>
                {config.pairKey ? "重新生成" : "生成配对码"}
              </button>
            </div>
          </div>

          {config.pairKey && (
            <div className="rc-section">
              <label className="rc-label">Room ID</label>
              <div className="rc-room-id">{config.roomId}</div>
            </div>
          )}

          {pairUrl && (
            <div className="rc-section">
              <label className="rc-label">手机扫码配对</label>
              <div className="rc-qr-placeholder">
                {/* 这里可以集成 QR 码库 */}
                <div className="rc-qr-text">{pairUrl}</div>
              </div>
              <p className="rc-hint">
                在手机浏览器中打开 ui-remote，输入上面的中继地址和 Pair Key 进行配对
              </p>
            </div>
          )}

          <div className="rc-section">
            <label className="rc-toggle">
              <input
                type="checkbox"
                checked={config?.defaultReadonly || false}
                onChange={(e) => handleDefaultReadonly(e.target.checked)}
              />
              <span>新接入设备默认只读</span>
            </label>
            <p className="rc-hint">
              开启后，新设备接入需在下方手动授予"可操作"权限；关闭则确认后默认可操作。
            </p>
          </div>

          <div className="rc-section">
            <label className="rc-label">已接入设备</label>
            {peers.length === 0 ? (
              <p className="rc-hint">暂无设备接入</p>
            ) : (
              <div className="rc-peer-list">
                {peers.map((peer) => (
                  <div key={peer.peerId} className="rc-peer-item">
                    <div className="rc-peer-info">
                      <span className="rc-peer-id">{peer.peerId}</span>
                      <span className={`rc-peer-role rc-peer-role-${peer.role}`}>
                        {peer.role === "pending" ? "待确认" : peer.role === "operator" ? "可操作" : "只读"}
                      </span>
                    </div>
                    <div className="rc-peer-actions">
                      {peer.role === "pending" && (
                        <>
                          <button className="rc-btn rc-btn-sm" onClick={() => handleAuthorize(peer.peerId, "operator")}>
                            允许操作
                          </button>
                          <button className="rc-btn rc-btn-sm" onClick={() => handleAuthorize(peer.peerId, "viewer")}>
                            仅只读
                          </button>
                        </>
                      )}
                      {peer.role === "viewer" && (
                        <button className="rc-btn rc-btn-sm" onClick={() => handleAuthorize(peer.peerId, "operator")}>
                          升为可操作
                        </button>
                      )}
                      {peer.role === "operator" && (
                        <button className="rc-btn rc-btn-sm" onClick={() => handleAuthorize(peer.peerId, "viewer")}>
                          降为只读
                        </button>
                      )}
                      <button className="rc-btn rc-btn-sm rc-btn-danger" onClick={() => handleKick(peer.peerId)}>
                        踢出
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rc-section">
            <button className="rc-btn rc-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
