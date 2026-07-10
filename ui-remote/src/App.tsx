import { useState, useEffect } from "react";
import { Radio, Sparkles, Network, Settings } from "lucide-react";
import { RemoteTab } from "./tabs/RemoteTab";
import { AiTab } from "./tabs/AiTab";
import { DevicesTab } from "./tabs/DevicesTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { connectionManager } from "./services/ConnectionManager";

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

  useEffect(() => {
    // 启动时尝试自动连接
    connectionManager.loadStoredConfig().then((config) => {
      if (config) {
        setDeviceName(config.deviceName || "");
        connectionManager.connect(config).then(() => {
          setConnected(true);
        }).catch((err) => {
          console.error("[App] Auto-connect failed:", err);
        });
      }
    });
  }, []);

  const showTabBar = activeSessionId === null;

  return (
    <div className="app-shell">
      <main className={showTabBar ? "tab-content" : "tab-content full"}>
        {activeTab === "remote" && <RemoteTab connected={connected} deviceName={deviceName} activeSessionId={activeSessionId} setActiveSessionId={setActiveSessionId} />}
        {activeTab === "ai" && <AiTab />}
        {activeTab === "devices" && <DevicesTab />}
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
