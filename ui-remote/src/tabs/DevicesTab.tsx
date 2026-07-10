import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DeviceRecord } from "../services/DeviceStore";
import { AddDeviceSheet } from "../components/AddDeviceSheet";

interface DevicesTabProps {
  devices: DeviceRecord[];
  activeDeviceId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (name: string, relayUrl: string, pairKey: string) => void;
}

export function DevicesTab({ devices, activeDeviceId, onSwitch, onDelete, onAdd }: DevicesTabProps) {
  const [showAddSheet, setShowAddSheet] = useState(false);

  const handleSave = (name: string, relayUrl: string, pairKey: string) => {
    onAdd(name, relayUrl, pairKey);
    setShowAddSheet(false);
  };

  const handleCardClick = (device: DeviceRecord) => {
    if (device.id === activeDeviceId) return;
    onSwitch(device.id);
  };

  const handleDelete = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (window.confirm(`删除设备 "${name}"？`)) {
      onDelete(id);
    }
  };

  return (
    <div className="tab-page">
      <h2 className="page-title">我的设备</h2>

      {devices.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">⊞</div>
          <p>暂无设备，点击右下角按钮添加</p>
        </div>
      ) : (
        <div className="device-list">
          {devices.map((device) => {
            const isActive = device.id === activeDeviceId;
            return (
              <div
                key={device.id}
                className={`device-card ${isActive ? "active" : ""}`}
                onClick={() => handleCardClick(device)}
              >
                <div className="device-info">
                  <div className="device-card-header">
                    <h3>{device.name}</h3>
                    {isActive && <span className="device-active-badge">使用中</span>}
                  </div>
                  <p className="device-url">{device.relayUrl}</p>
                  <p className="device-pair">key: ****{device.pairKey.slice(-4)}</p>
                </div>
                <div className="device-actions">
                  <span className={`status-indicator ${device.online ? "online" : "offline"}`}>
                    {device.online ? "● 在线" : "○ 离线"}
                  </span>
                  {!isActive && (
                    <button
                      className="device-delete-btn"
                      onClick={(e) => handleDelete(e, device.id, device.name)}
                      aria-label={`删除 ${device.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button className="floating-action-button" onClick={() => setShowAddSheet(true)}>
        <Plus size={24} />
      </button>

      {showAddSheet && <AddDeviceSheet onClose={() => setShowAddSheet(false)} onSave={handleSave} />}
    </div>
  );
}
