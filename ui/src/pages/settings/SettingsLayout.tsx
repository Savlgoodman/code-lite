import { ArchiveRestore, ArrowLeft, Bot, Database, FileText, Image, Info, Package, Palette, Radio } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { SettingsSection } from "./types";

const settingsMenu = [
  { id: "appearance", icon: Palette, label: "外观" },
  { id: "agents", icon: Package, label: "Agent Runtime" },
  { id: "acp", icon: Database, label: "ACP 连接管理" },
  { id: "providers", icon: Bot, label: "模型提供商配置" },
  { id: "imageProviders", icon: Image, label: "图片生成供应商" },
  { id: "logs", icon: FileText, label: "日志" },
  { id: "archive", icon: ArchiveRestore, label: "归档会话" },
  { id: "remote", icon: Radio, label: "远程控制" },
  { id: "about", icon: Info, label: "关于" }
] satisfies Array<{ id: SettingsSection; icon: LucideIcon; label: string }>;

interface SettingsLayoutProps {
  activeSection: SettingsSection;
  children: ReactNode;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
}

export function SettingsLayout({ activeSection, children, onBack, onSectionChange }: SettingsLayoutProps) {
  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <button className="settings-back-button" onClick={onBack} type="button">
          <ArrowLeft size={17} />
          <span>返回应用</span>
        </button>

        <nav className="settings-nav" aria-label="设置菜单">
          {settingsMenu.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={["settings-nav-item", activeSection === item.id ? "active" : ""].filter(Boolean).join(" ")}
                key={item.id}
                onClick={() => onSectionChange(item.id)}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="settings-main">{children}</main>
    </div>
  );
}
