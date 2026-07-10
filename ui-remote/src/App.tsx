import { useState, useEffect, useCallback } from "react";
import { Radio, Sparkles, Network, Settings } from "lucide-react";
import { RemoteTab } from "./tabs/RemoteTab";
import { AiTab } from "./tabs/AiTab";
import { DevicesTab } from "./tabs/DevicesTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { connectionManager } from "./services/ConnectionManager";
import { deviceStore, type DeviceRecord } from "./services/DeviceStore";

type TabId = "remote" | "ai" | "devices" | "settings";

interface TabItem {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabItem[] = [
  { id: "remote", label: "远程", icon: <Radio size={24} /> },
  { id: "ai", label: "AI", icon: <Sparkles size={24} /> },
  { id: "devices", label: "设备", icon: <Network size={24} /> },
  { id: "settings", label: "设置", icon: <Settings size={24} /> },
];

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("remote");
  const [connected, setConnected] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);

  // 刷新设备列表
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

    // 设置 host 状态回调
    connectionManager.setHostStatusCallback((online) => {
      setConnected(online);
      if (activeDeviceId) {
        deviceStore.updateDeviceOnline(activeDeviceId, online);
        refreshDevices();
      }
    });
  }, []);

  const handleSwitchDevice = useCallback(async (id: string) => {
    const device = devices.find((d) => d.id === id);
    if (!device) return;

    connectionManager.disconnect();
    setConnected(false);

    await deviceStore.setActiveDeviceId(id);
    setDeviceName(device.name);
    setActiveDeviceId(id);

    try {
      await connectionManager.connect({
        relayUrl: device.relayUrl,
        pairKey: device.pairKey,
        deviceName: device.name,
      });
      setConnected(true);
      setActiveSessionId(null);
    } catch (err) {
      console.error("[App] Switch device failed:", err);
      alert("切换设备失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }, [devices]);

  const handleDeleteDevice = useCallback(async (id: string) => {
    if (id === activeDeviceId) {
      // 删除当前设备需要断开连接
      connectionManager.disconnect();
      setConnected(false);
      setDeviceName("");
    }
    await deviceStore.removeDevice(id);
    await refreshDevices();
  }, [activeDeviceId, refreshDevices]);

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

  const showTabBar = activeSessionId === null;

  return (
    <div className="app-shell">
      <main className={showTabBar ? "tab-content" : "tab-content full"}>
        {activeTab === "remote" && <RemoteTab connected={connected} deviceName={deviceName} activeSessionId={activeSessionId} setActiveSessionId={setActiveSessionId} />}
        {activeTab === "ai" && <AiTab />}
        {activeTab === "devices" && <DevicesTab devices={devices} activeDeviceId={activeDeviceId} onSwitch={handleSwitchDevice} onDelete={handleDeleteDevice} onAdd={handleAddDevice} />}
        {activeTab === "settings" && <SettingsTab />}
      </main>

      {showTabBar && (
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
    </div>
  );
}
