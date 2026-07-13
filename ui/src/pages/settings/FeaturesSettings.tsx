import { useEffect, useMemo, useRef, useState } from "react";

import { Loader2, RotateCcw } from "lucide-react";

import type { ConfiguredModel, PromptOptimizeSettings } from "../../types";

import { loadPromptOptimizeSettings, updatePromptOptimizeSettings } from "../../services/featureStore";
import { loadModelSettings } from "../../services/settingsStore";
import { SettingsSelect } from "./components/SettingsSelect";

const CODE_PROMPT_HINT =
  "可使用占位符 {AGENTS.md} 与 {CLAUDE.md}，优化时会自动替换为项目根目录对应文档内容，帮助模型了解项目情况。";

const SETTINGS_HEADING_STYLE = { margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 } as const;
const SETTINGS_DESC_STYLE = { margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" } as const;
const PROMPT_TEXTAREA_STYLE = {
  width: "100%",
  minHeight: "140px",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-elevated)",
  padding: "10px 12px",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "var(--font-family-mono)",
  lineHeight: 1.6,
  outline: "none",
  resize: "vertical" as const
} as const;

export function FeaturesSettings() {
  const [settings, setSettings] = useState<PromptOptimizeSettings | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setLoading(true);
      setError(null);
      try {
        const [loadedSettings, modelSettings] = await Promise.all([
          loadPromptOptimizeSettings(),
          loadModelSettings().catch(() => null)
        ]);
        if (cancelled) {
          return;
        }
        setSettings(loadedSettings);
        setModels((modelSettings?.models ?? []).filter((model) => model.enabled));
      } catch (bootError) {
        if (!cancelled) {
          setError(bootError instanceof Error ? bootError.message : String(bootError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
      }
    };
  }, []);

  const modelOptions = useMemo(
    () => models.map((model) => ({ value: model.id, label: model.label, title: model.model })),
    [models]
  );

  // 立即更新本地态，防抖持久化到后端（文本编辑连续触发时只保存最后一次）。
  function applyChange(patch: Partial<PromptOptimizeSettings>, debounce = false) {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setError(null);
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const persist = () => void save(patch);
    if (debounce) {
      saveTimerRef.current = window.setTimeout(persist, 600);
    } else {
      persist();
    }
  }

  async function save(patch: Partial<PromptOptimizeSettings>) {
    setSaving(true);
    setError(null);
    try {
      const next = await updatePromptOptimizeSettings(patch);
      setSettings(next);
      setSavedHint(true);
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
      }
      hintTimerRef.current = window.setTimeout(() => setSavedHint(false), 1600);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings) {
    return (
      <section className="settings-content-column">
        <div className="settings-page-heading">
          <span className="eyebrow">偏好设置</span>
          <h1>功能</h1>
        </div>
        <div className="settings-card" style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text-muted)" }}>
          <Loader2 className="composer-spin" size={16} />
          <span>加载中...</span>
        </div>
      </section>
    );
  }

  const noModels = modelOptions.length === 0;

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">偏好设置</span>
        <h1>功能</h1>
      </div>

      <div className="settings-card">
        <h3 style={SETTINGS_HEADING_STYLE}>提示词优化</h3>
        <p style={SETTINGS_DESC_STYLE}>
          用已配置的文本模型润色提示词。生图提示词优化默认开启；开启 code agent 提示词优化后，聊天输入框会显示魔法棒按钮，可一键优化输入内容。
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <label className="settings-check">
            <input
              checked={settings.imageEnabled}
              onChange={(event) => applyChange({ imageEnabled: event.target.checked })}
              type="checkbox"
            />
            <span>生图提示词优化</span>
          </label>
          <label className="settings-check">
            <input
              checked={settings.codeEnabled}
              onChange={(event) => applyChange({ codeEnabled: event.target.checked })}
              type="checkbox"
            />
            <span>code agent 提示词优化（在聊天输入框显示魔法棒）</span>
          </label>
        </div>

        <div className="settings-field" style={{ marginTop: "16px" }}>
          <span>优化使用的模型</span>
          {noModels ? (
            <div style={{ fontSize: "13px", color: "var(--color-warning)" }}>
              暂无可用文本模型，请先在“模型提供商配置”中添加并启用模型。
            </div>
          ) : (
            <SettingsSelect
              onChange={(value) => applyChange({ modelId: value })}
              options={modelOptions}
              value={settings.modelId || modelOptions[0]?.value || ""}
            />
          )}
        </div>
      </div>

      <div className="settings-card">
        <h3 style={SETTINGS_HEADING_STYLE}>生图提示词优化 Prompt</h3>
        <p style={SETTINGS_DESC_STYLE}>用于生图提示词优化的系统提示词，控制优化风格与输出要求。</p>
        <textarea
          onChange={(event) => applyChange({ imagePrompt: event.target.value }, true)}
          spellCheck={false}
          style={PROMPT_TEXTAREA_STYLE}
          value={settings.imagePrompt}
        />
      </div>

      <div className="settings-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <h3 style={SETTINGS_HEADING_STYLE}>code 提示词优化 Prompt</h3>
          <button
            className="settings-secondary-button"
            onClick={() => applyChange({ codePrompt: "" })}
            title="恢复默认模板"
            type="button"
          >
            <RotateCcw size={14} />
            <span>恢复默认</span>
          </button>
        </div>
        <p style={SETTINGS_DESC_STYLE}>{CODE_PROMPT_HINT}</p>
        <textarea
          onChange={(event) => applyChange({ codePrompt: event.target.value }, true)}
          spellCheck={false}
          style={PROMPT_TEXTAREA_STYLE}
          value={settings.codePrompt}
        />
      </div>

      <div style={{ minHeight: "20px", fontSize: "12px" }}>
        {error ? (
          <span style={{ color: "var(--color-error)" }}>{error}</span>
        ) : saving ? (
          <span style={{ color: "var(--text-muted)" }}>保存中...</span>
        ) : savedHint ? (
          <span style={{ color: "var(--color-success)" }}>已保存</span>
        ) : null}
      </div>
    </section>
  );
}
