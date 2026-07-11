import { Palette, Sun, Moon, Monitor, SlidersHorizontal, List } from "lucide-react";
import {
  useAppearance,
  setThemeMode,
  setFontFamily,
  setFontSize,
  setModelSelectorStyle,
  FONT_PRESETS,
  FONT_SIZE_OPTIONS,
  type ThemeMode,
  type ModelSelectorStyle,
} from "../../services/themeStore";

const THEME_OPTIONS: { id: ThemeMode; label: string; description: string; icon: typeof Sun }[] = [
  { id: "light", label: "浅色", description: "始终使用浅色主题", icon: Sun },
  { id: "dark", label: "深色", description: "始终使用深色主题", icon: Moon },
  { id: "system", label: "跟随系统", description: "自动匹配操作系统主题", icon: Monitor },
];

const MODEL_SELECTOR_OPTIONS: { id: ModelSelectorStyle; label: string; description: string; icon: typeof Sun }[] = [
  { id: "classic", label: "经典下拉", description: "紧凑的下拉菜单，逐项选择模型与思考强度", icon: List },
  { id: "slider", label: "火焰拖动条", description: "加宽面板，思考强度以拖动条呈现，最高挡点燃火焰特效", icon: SlidersHorizontal },
];

export function AppearanceSettings() {
  const appearance = useAppearance();

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">偏好设置</span>
        <h1>外观</h1>
      </div>

      {/* ─── 主题模式 ─── */}
      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          主题模式
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          选择应用的外观主题，或跟随操作系统自动切换
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isActive = appearance.themeMode === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setThemeMode(option.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px 14px",
                  border: `1px solid ${isActive ? "var(--accent-primary)" : "var(--border-secondary)"}`,
                  borderRadius: "var(--radius-md)",
                  background: isActive ? "var(--accent-secondary)" : "var(--bg-elevated)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all var(--transition-base)",
                  color: "var(--text-primary)",
                }}
              >
                <Icon
                  size={18}
                  style={{
                    color: isActive ? "var(--accent-primary)" : "var(--text-muted)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>{option.label}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                    {option.description}
                  </div>
                </div>
                <div
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "50%",
                    border: `2px solid ${isActive ? "var(--accent-primary)" : "var(--border-primary)"}`,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {isActive && (
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: "var(--accent-primary)",
                      }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── 模型选择框样式 ─── */}
      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          模型选择框样式
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          选择输入框底部模型选择框的呈现方式
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {MODEL_SELECTOR_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isActive = appearance.modelSelectorStyle === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setModelSelectorStyle(option.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px 14px",
                  border: `1px solid ${isActive ? "var(--accent-primary)" : "var(--border-secondary)"}`,
                  borderRadius: "var(--radius-md)",
                  background: isActive ? "var(--accent-secondary)" : "var(--bg-elevated)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all var(--transition-base)",
                  color: "var(--text-primary)",
                }}
              >
                <Icon
                  size={18}
                  style={{
                    color: isActive ? "var(--accent-primary)" : "var(--text-muted)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>{option.label}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                    {option.description}
                  </div>
                </div>
                <div
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "50%",
                    border: `2px solid ${isActive ? "var(--accent-primary)" : "var(--border-primary)"}`,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {isActive && (
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: "var(--accent-primary)",
                      }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── 字体设置 ─── */}
      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          字体
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          选择应用界面使用的字体，或输入自定义字体名称
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* 字体选择 */}
          <div className="settings-field">
            <span>字体族</span>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {FONT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setFontFamily(preset.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 12px",
                    border: `1px solid ${appearance.fontFamilyId === preset.id ? "var(--accent-primary)" : "var(--border-secondary)"}`,
                    borderRadius: "var(--radius-md)",
                    background: appearance.fontFamilyId === preset.id ? "var(--accent-secondary)" : "var(--bg-elevated)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "13px",
                    color: "var(--text-primary)",
                    transition: "all var(--transition-base)",
                  }}
                >
                  <span style={{ fontWeight: appearance.fontFamilyId === preset.id ? 600 : 400 }}>
                    {preset.label}
                  </span>
                  {preset.id !== "custom" && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        fontFamily: preset.family,
                        maxWidth: "200px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      AaBbCc 你好
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 自定义字体输入 */}
          {appearance.fontFamilyId === "custom" && (
            <div className="settings-field">
              <span>自定义字体名称</span>
              <input
                type="text"
                value={appearance.customFontFamily}
                onChange={(e) => setFontFamily("custom", e.target.value)}
                placeholder='输入字体名称，如 "Arial, sans-serif"'
                style={{
                  height: "38px",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-elevated)",
                  padding: "0 11px",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                输入 CSS font-family 值，多个字体用逗号分隔。需要字体已安装在系统中。
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ─── 字体大小 ─── */}
      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          字体大小
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          调整应用界面的基础字体大小
        </p>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {FONT_SIZE_OPTIONS.map((option) => {
            const isActive = appearance.fontSizeId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setFontSize(option.id)}
                style={{
                  padding: "8px 16px",
                  border: `1px solid ${isActive ? "var(--accent-primary)" : "var(--border-secondary)"}`,
                  borderRadius: "var(--radius-md)",
                  background: isActive ? "var(--accent-secondary)" : "var(--bg-elevated)",
                  cursor: "pointer",
                  fontSize: `${option.size}px`,
                  color: "var(--text-primary)",
                  fontWeight: isActive ? 600 : 400,
                  transition: "all var(--transition-base)",
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── 配色方案（预留） ─── */}
      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          配色方案
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          当前使用 Happy Hues Palette 11 配色方案
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "12px 14px",
            border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-elevated)",
          }}
        >
          <Palette size={18} style={{ color: "var(--text-muted)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--text-primary)" }}>
              Happy Hues Palette 11
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
              暖色调配色方案，以米白、棕色为主，红色作为强调色
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {["#f9f4ef", "#020826", "#716040", "#8c7851", "#eaddcf", "#f25042"].map((color) => (
              <div
                key={color}
                title={color}
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "var(--radius-sm)",
                  background: color,
                  border: "1px solid var(--border-primary)",
                }}
              />
            ))}
          </div>
        </div>

        <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--text-tertiary)" }}>
          更多配色方案将在后续版本中添加
        </p>
      </div>
    </section>
  );
}
