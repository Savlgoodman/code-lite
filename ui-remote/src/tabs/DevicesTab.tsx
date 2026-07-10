import { useState } from "react";
import { Plus } from "lucide-react";

interface Device {
  id: string;
  name: string;
  relayUrl: string;
  pairKey: string;
  lastActive: string;
  online: boolean;
}

export function DevicesTab() {
  const [devices] = useState<Device[]>([]);

  const addDevice = () => {
    // TODO: 打开添加设备对话框
    alert("添加设备功能待实现");
  };

  return (
    <div className="tab-page">
      <h2 className="page-title">我的设备</h2>
      <div className="device-list">
        {devices.map((device) => (
          <div key={device.id} className="device-card">
            <div className="device-info">
              <h3>{device.name}</h3>
              <p className="device-url">{device.relayUrl}</p>
              <p className="device-pair">pair_key: ****{device.pairKey.slice(-4)}</p>
            </div>
            <div className="device-status">
              <span className={`status-indicator ${device.online ? "online" : "offline"}`}>
                {device.online ? "● 在线" : "○ 离线"}
              </span>
            </div>
          </div>
        ))}
        {devices.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">⊞</div>
            <h2>暂无设备</h2>
            <p>添加你的第一台 code-lite 设备</p>
          </div>
        )}
      </div>
      <button className="floating-action-button" onClick={addDevice}>
        <Plus size={24} />
      </button>
    </div>
  );
}
