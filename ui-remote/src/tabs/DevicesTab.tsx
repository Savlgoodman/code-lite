import { useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import type { DeviceRecord } from "../services/DeviceStore";
import { AddDeviceSheet } from "../sheets/AddDeviceSheet";
import { Fab, EmptyState } from "../components/ui";

interface DevicesTabProps {
  devices: DeviceRecord[];
  activeDeviceId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (name: string, relayUrl: string, pairKey: string) => void;
  onEdit: (id: string, name: string, relayUrl: string, pairKey: string) => void;
  /** 由 HomePager 注入：仅激活 Tab 渲染 FAB，避免跨页叠加 */
  active?: boolean;
}

export function DevicesTab({ devices, activeDeviceId, onSwitch, onDelete, onAdd, onEdit, active = true }: DevicesTabProps) {
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceRecord | null>(null);

  const handleSave = (name: string, relayUrl: string, pairKey: string) => {
    onAdd(name, relayUrl, pairKey);
    setShowAddSheet(false);
  };

  const handleEdit = (e: React.MouseEvent, device: DeviceRecord) => {
    e.stopPropagation();
    setEditingDevice(device);
  };

  const handleDelete = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (window.confirm(`删除设备 "${name}"？`)) {
      onDelete(id);
    }
  };

  const handleCardClick = (device: DeviceRecord) => {
    if (device.id === activeDeviceId) return;
    onSwitch(device.id);
  };

  return (
    <div className="tab-page">
      <h2 className="page-title">我的设备</h2>

      {devices.length === 0 ? (
        <EmptyState icon="⊞">暂无设备，点击右下角按钮添加</EmptyState>
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
                    <>
                      <button
                        className="device-action-btn"
                        onClick={(e) => handleEdit(e, device)}
                        aria-label={`编辑 ${device.name}`}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="device-delete-btn"
                        onClick={(e) => handleDelete(e, device.id, device.name)}
                        aria-label={`删除 ${device.name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {active && (
        <Fab onClick={() => setShowAddSheet(true)} aria-label="添加设备">
          <Plus size={24} />
        </Fab>
      )}

      {showAddSheet && <AddDeviceSheet onClose={() => setShowAddSheet(false)} onSave={handleSave} />}
      {editingDevice && (
        <AddDeviceSheet
          initial={editingDevice}
          onClose={() => setEditingDevice(null)}
          onSave={(name, relayUrl, pairKey) => {
            onEdit(editingDevice.id, name, relayUrl, pairKey);
            setEditingDevice(null);
          }}
        />
      )}
    </div>
  );
}
