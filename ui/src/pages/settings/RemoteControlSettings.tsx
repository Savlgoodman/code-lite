import { useEffect, useState } from "react";
import { getLocalTransport } from "../../services/agentClient";
import "./RemoteControlSettings.css";

interface RemoteConfig {
  enabled: boolean;
  pairKey: string;
  relayUrl: string;
  roomId: string;
}

export function RemoteControlSettings() {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const transport = getLocalTransport();
      await transport.connect();
      const result = await transport.request<RemoteConfig>("remote.config.get", {});
      setConfig(result);
      setRelayUrl(result.relayUrl || "ws://localhost:18766/ws");
      setLoading(false);
    })();
  }, []);

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
            <button className="rc-btn rc-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
