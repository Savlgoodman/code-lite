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
import { NavHost } from "./components/NavHost";
import { useNav } from "./hooks/useNav";
import { useSystemBack } from "./hooks/useSystemBack";

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
  const [transportStatus, setTransportStatus] = useState<TransportStatus>("idle");
  const [deviceName, setDeviceName] = useState<string>("");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<DeviceRecord | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const nav = useNav();
  // 安卓返回键 / 浏览器 popstate 单点接线到导航栈
  useSystemBack();
  // 全屏层级（会话/AI 对话/设置子页/详情）打开时，主界面后退形成纵深、隐藏 Tab 栏
  const navOpen = nav.depth > 0;

  const activeDeviceIdRef = useRef(activeDeviceId);
  activeDeviceIdRef.current = activeDeviceId;

  const refreshDevices = useCallback(async () => {
    const list = await deviceStore.loadAll();
    setDevices(list);
    const id = await deviceStore.getActiveDeviceId();
    setActiveDeviceId(id);
  }, []);

  useEffect(() => {
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
      nav.reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError("切换设备失败: " + msg);
      await refreshDevices();
    }
  }, [devices, refreshDevices, nav]);

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

  const activeIndex = TABS.findIndex((t) => t.id === activeTab);

  const panes = [
    <RemoteTab
      key="remote"
      connected={connected}
      transportStatus={transportStatus}
      deviceName={deviceName}
      onOpenSession={(id) => nav.push({ kind: "chat", sessionId: id })}
      onReconnect={handleReconnect}
    />,
    <AiTab
      key="ai"
      onOpenConversation={(id) => nav.push({ kind: "aiChat", conversationId: id })}
      onOpenImageRecord={(id) => nav.push({ kind: "imageGen", recordId: id })}
    />,
    <DevicesTab
      key="devices"
      devices={devices}
      activeDeviceId={activeDeviceId}
      onSwitch={handleSwitchDevice}
      onDelete={handleDeleteDevice}
      onAdd={handleAddDevice}
      onEdit={handleEditDevice}
    />,
    <SettingsTab
      key="settings"
      onOpenAiSettings={() => nav.push({ kind: "aiSettings" })}
      onOpenAiArchived={() => nav.push({ kind: "aiArchived" })}
      onOpenImageProviders={() => nav.push({ kind: "imageProviders" })}
    />,
  ];

  return (
    <div className="app-shell">
      <HomePager
        index={activeIndex}
        onIndexChange={(i) => setActiveTab(TABS[i].id)}
        panes={panes}
        behind={navOpen}
      />

      <NavHost />

      {!navOpen && (
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
