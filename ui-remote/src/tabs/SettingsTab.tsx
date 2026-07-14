import { useState } from "react";
import { Moon, Sun, Check, Server, Archive, ChevronRight, Smartphone, Info, Image as ImageIcon, Hash } from "lucide-react";
import { useTheme, THEME_LABELS, type ThemeName } from "../hooks/useTheme";
import { useAiChatSettings } from "../hooks/useAiChatSettings";
import { AboutSheet } from "../sheets/AboutSheet";
import { isAiAvailable } from "../lib/environment";

const THEME_SWATCHES: Record<ThemeName, { bg: string; accent: string; card: string }> = {
  mono: { bg: "#f6f5f3", accent: "#1f2328", card: "#ffffff" },
  warm: { bg: "#f9f4ef", accent: "#8c7851", card: "#f25042" },
};

interface SettingsTabProps {
  onOpenAiSettings?: () => void;
  onOpenAiArchived?: () => void;
  onOpenImageProviders?: () => void;
}

export function SettingsTab({ onOpenAiSettings, onOpenAiArchived, onOpenImageProviders }: SettingsTabProps) {
  const { theme, mode, setTheme, toggleMode } = useTheme();
  const {
    showTokenUsage,
    setShowTokenUsage,
  } = useAiChatSettings();
  const isDark = mode === "dark";
  const [showAbout, setShowAbout] = useState(false);
  const aiAvailable = isAiAvailable();

  return (
    <div className="tab-page">
      <h2 className="page-title">设置</h2>
      <div className="settings-list">
        <div className="settings-section">
          <h3>外观</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-row-label">主题配色</span>
            </div>
            <div className="theme-picker">
              {(Object.keys(THEME_SWATCHES) as ThemeName[]).map((name) => {
                const sw = THEME_SWATCHES[name];
                const selected = theme === name;
                return (
                  <button
                    key={name}
                    type="button"
                    className={`theme-swatch${selected ? " selected" : ""}`}
                    onClick={() => setTheme(name)}
                  >
                    <span className="theme-swatch-preview" style={{ background: sw.bg }}>
                      <span className="theme-swatch-dot" style={{ background: sw.accent }} />
                      <span className="theme-swatch-dot" style={{ background: sw.card }} />
                    </span>
                    <span className="theme-swatch-label">
                      {THEME_LABELS[name]}
                      {selected && <Check size={14} />}
                    </span>
                  </button>
                );
              })}
            </div>
            <button className="settings-row settings-row-btn" onClick={toggleMode}>
              <span className="settings-row-label">
                {isDark ? <Moon size={16} /> : <Sun size={16} />}
                深色模式
              </span>
              <span className={`toggle${isDark ? " on" : ""}`}>
                <span className="toggle-knob" />
              </span>
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>AI 对话</h3>
          {aiAvailable ? (
            <ul>
              <li className="settings-item ai-chat-token-setting">
                <button
                  type="button"
                  className="ai-chat-token-button"
                  aria-pressed={showTokenUsage}
                  onClick={() => void setShowTokenUsage(!showTokenUsage)}
                >
                  <span className="settings-item-label"><Hash size={17} /> 显示 Token 消耗</span>
                  <span className={`toggle${showTokenUsage ? " on" : ""}`}>
                    <span className="toggle-knob" />
                  </span>
                </button>
              </li>
              <li className="settings-item settings-item-nav" onClick={onOpenAiSettings}>
                <span className="settings-item-label"><Server size={17} /> 模型供应商配置</span>
                <ChevronRight size={18} />
              </li>
              <li className="settings-item settings-item-nav" onClick={onOpenImageProviders}>
                <span className="settings-item-label"><ImageIcon size={17} /> 图片生成供应商</span>
                <ChevronRight size={18} />
              </li>
              <li className="settings-item settings-item-nav" onClick={onOpenAiArchived}>
                <span className="settings-item-label"><Archive size={17} /> 已归档对话</span>
                <ChevronRight size={18} />
              </li>
            </ul>
          ) : (
            <ul>
              <li className="settings-item settings-item-nav disabled" aria-disabled="true">
                <span className="settings-item-label"><Smartphone size={17} /> AI 对话仅 App 可用</span>
              </li>
            </ul>
          )}
        </div>
        <div className="settings-section">
          <h3>远程配置</h3>
          <ul>
            <li className="settings-item">默认 Relay URL</li>
            <li className="settings-item">自动重连</li>
            <li className="settings-item">心跳间隔</li>
          </ul>
        </div>
        <div className="settings-section">
          <h3>通用</h3>
          <ul>
            <li className="settings-item">语言</li>
            <li className="settings-item">通知权限</li>
            <li className="settings-item settings-item-nav" onClick={() => setShowAbout(true)}>
              <span className="settings-item-label"><Info size={17} /> 关于 Code-Lite Remote</span>
              <ChevronRight size={18} />
            </li>
          </ul>
        </div>
      </div>

      {showAbout && <AboutSheet onClose={() => setShowAbout(false)} />}
    </div>
  );
}
