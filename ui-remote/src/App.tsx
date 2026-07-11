import { useState, useEffect, useCallback, useRef } from "react";
import { Radio, Sparkles, Network, Settings } from "lucide-react";
import type { TransportStatus } from "@code-lite/transport";
import { RemoteTab } from "./tabs/RemoteTab";
import { AiTab } from "./tabs/AiTab";
import { DevicesTab } from "./tabs/DevicesTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { connectionManager } from "./services/ConnectionManager";
import { deviceStore, type DeviceRecord } from "./services/DeviceStore";
import { AddDeviceSheet } from "./sheets/AddDeviceSheet";
import { HomePager } from "./components/HomePager";
import { ChatOverlay } from "./components/ChatOverlay";
import { AiChatOverlay } from "./components/AiChatOverlay";

type TabId = "remote" | "ai" | "devices" | "settings";

interface TabItem {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

/** Tab 顺序即横向分页顺序（索引 = 面板位置）。 */
const TABS: TabItem[] = [
  { id: "remote", label: "远程", icon: <Radio size={24} /> },
  { id: "ai", label: "AI", icon: <Sparkles size={24} /> },
  { id: "devices", label: "设备", icon: <Network size={24} /> },
  { id: "settings", label: "设置", icon: <Settings size={24} /> },
];

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("remote");
  const [connected, setConnected] = useState(false);
  const [transportStatus, setTransportStatus] = useState<TransportStatus>("idle");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeAiConversationId, setActiveAiConversationId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<DeviceRecord | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 用 ref 避免回调闭包捕获过期的 activeDeviceId
  const activeDeviceIdRef = useRef(activeDeviceId);
  activeDeviceIdRef.current = activeDeviceId;

  const refreshDevices = useCallback(async () => {
    const list = await deviceStore.loadAll();
    setDevices(list);
    const id = await deviceStore.getActiveDeviceId();
    setActiveDeviceId(id);
  }, []);

  useEffect(() => {
    // 启动: 迁移 legacy 数据 → 加载设备列表 → 自动连接活跃设备
    (async () => {
      await deviceStore.migrate();
      await refreshDevices();

      const active = await deviceStore.getActiveDevice();
      if (active) {
        setDeviceName(active.name);
        connectionManager.connect({
          relayUrl: active.relayUrl,
          pairKey: active.pairKey,
          deviceName: active.name,
        }).then(() => {
          setConnected(true);
        }).catch((err) => {
          console.error("[App] Auto-connect failed:", err);
        });
      }
    })();

    // 设置 host 状态回调 + 传输层状态回调（使用 ref 避免闭包过期）
    connectionManager.setHostStatusCallback((online) => {
      setConnected(online);
      const id = activeDeviceIdRef.current;
      if (id) {
        deviceStore.updateDeviceOnline(id, online);
        refreshDevices();
      }
    });
    connectionManager.setStatusCallback((status) => {
      setTransportStatus(status);
    });
  }, [refreshDevices]);

  const showError = (msg: string) => {
    setErrorToast(msg);
    setTimeout(() => setErrorToast(null), 3000);
  };

  const handleSwitchDevice = useCallback(async (id: string) => {
    const device = devices.find((d) => d.id === id);
    if (!device) return;

    connectionManager.disconnect();
    setConnected(false);
    setTransportStatus("idle");

    await deviceStore.setActiveDeviceId(id);
    setDeviceName(device.name);
    setActiveDeviceId(id);

    try {
      await connectionManager.connect({
        relayUrl: device.relayUrl,
        pairKey: device.pairKey,
        deviceName: device.name,
      });
      // connected/transportStatus 由回调设置
      setActiveSessionId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError("切换设备失败: " + msg);
      // 回滚到之前的设备
      await refreshDevices();
    }
  }, [devices, refreshDevices]);

  const handleDeleteDevice = useCallback(async (id: string) => {
    if (id === activeDeviceId) {
      connectionManager.disconnect();
      setConnected(false);
      setTransportStatus("idle");
      setDeviceName("");
    }
    await deviceStore.removeDevice(id);
    await refreshDevices();
  }, [activeDeviceId, refreshDevices]);

  const handleReconnect = useCallback(async () => {
    try {
      await connectionManager.reconnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError("重连失败: " + msg);
    }
  }, []);

  const handleAddDevice = useCallback(async (name: string, relayUrl: string, pairKey: string) => {
    const record: DeviceRecord = {
      id: crypto.randomUUID(),
      name,
      relayUrl,
      pairKey,
      online: false,
      lastSeen: Date.now(),
    };
    await deviceStore.saveDevice(record);
    await refreshDevices();
  }, [refreshDevices]);

  const handleEditDevice = useCallback(async (id: string, name: string, relayUrl: string, pairKey: string) => {
    const devices2 = await deviceStore.loadAll();
    const device = devices2.find((d) => d.id === id);
    if (!device) return;
    device.name = name;
    device.relayUrl = relayUrl;
    device.pairKey = pairKey;
    await deviceStore.saveDevice(device);
    if (id === activeDeviceIdRef.current) {
      setDeviceName(name);
    }
    await refreshDevices();
  }, [refreshDevices]);

  const chatOpen = activeSessionId !== null || activeAiConversationId !== null;
  const activeIndex = TABS.findIndex((t) => t.id === activeTab);

  const panes = [
    <RemoteTab
      key="remote"
      connected={connected}
      transportStatus={transportStatus}
      deviceName={deviceName}
      onOpenSession={setActiveSessionId}
      onReconnect={handleReconnect}
    />,
    <AiTab key="ai" onOpenConversation={setActiveAiConversationId} />,
    <DevicesTab
      key="devices"
      devices={devices}
      activeDeviceId={activeDeviceId}
      onSwitch={handleSwitchDevice}
      onDelete={handleDeleteDevice}
      onAdd={handleAddDevice}
      onEdit={handleEditDevice}
    />,
    <SettingsTab key="settings" />,
  ];

  return (
    <div className="app-shell">
      <HomePager
        index={activeIndex}
        onIndexChange={(i) => setActiveTab(TABS[i].id)}
        panes={panes}
        behind={chatOpen}
      />

      <ChatOverlay sessionId={activeSessionId} onBack={() => setActiveSessionId(null)} />

      <AiChatOverlay conversationId={activeAiConversationId} onBack={() => setActiveAiConversationId(null)} />

      {!chatOpen && (
        <nav className="bottom-tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
        </nav>
      )}

      {/* 编辑设备 Modal Sheet */}
      {editingDevice && (
        <AddDeviceSheet
          initial={editingDevice}
          onClose={() => setEditingDevice(null)}
          onSave={(name, relayUrl, pairKey) => {
            handleEditDevice(editingDevice.id, name, relayUrl, pairKey);
            setEditingDevice(null);
          }}
        />
      )}

      {/* 错误提示 Toast */}
      {errorToast && (
        <div className="error-toast-overlay" onClick={() => setErrorToast(null)}>
          <div className="error-toast" onClick={(e) => e.stopPropagation()}>
            <span className="error-toast-icon"></span>
            <span className="error-toast-text">{errorToast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
