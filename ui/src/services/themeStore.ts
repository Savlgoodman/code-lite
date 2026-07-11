/**
 * 主题与外观状态管理
 * 支持：主题模式（浅色/深色/跟随系统）、字体切换、字体大小调整
 */

import { useEffect, useState, useCallback } from "react";

// ─── 类型定义 ───

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface FontPreset {
  id: string;
  label: string;
  family: string;
}

export interface FontSizeOption {
  id: string;
  label: string;
  size: number;
}

export type ModelSelectorStyle = "classic" | "slider";

export interface AppearanceState {
  themeMode: ThemeMode;
  fontFamilyId: string;
  customFontFamily: string;
  fontSizeId: string;
  modelSelectorStyle: ModelSelectorStyle;
}

// ─── 常量 ───

const STORAGE_KEY = "code-lite-appearance";

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "default",
    label: "默认 (Inter)",
    family: 'Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
  },
  {
    id: "system",
    label: "系统字体",
    family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: '"JetBrains Mono", "Fira Code", Consolas, "Cascadia Mono", monospace',
  },
  {
    id: "nano-sans",
    label: "Noto Sans",
    family: '"Noto Sans", "Nano Sans", "Segoe UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "source-han",
    label: "思源黑体",
    family: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: "custom",
    label: "自定义",
    family: "",
  },
];

export const FONT_SIZE_OPTIONS: FontSizeOption[] = [
  { id: "small", label: "小 (13px)", size: 13 },
  { id: "medium", label: "中 (14px)", size: 14 },
  { id: "large", label: "大 (15px)", size: 15 },
  { id: "xlarge", label: "特大 (16px)", size: 16 },
];

const DEFAULT_STATE: AppearanceState = {
  themeMode: "system",
  fontFamilyId: "default",
  customFontFamily: "",
  fontSizeId: "medium",
  modelSelectorStyle: "classic",
};

// ─── 状态管理 ───

let currentState: AppearanceState = loadState();
const listeners = new Set<() => void>();

function loadState(): AppearanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      themeMode: parsed.themeMode ?? DEFAULT_STATE.themeMode,
      fontFamilyId: parsed.fontFamilyId ?? DEFAULT_STATE.fontFamilyId,
      customFontFamily: parsed.customFontFamily ?? DEFAULT_STATE.customFontFamily,
      fontSizeId: parsed.fontSizeId ?? DEFAULT_STATE.fontSizeId,
      modelSelectorStyle: parsed.modelSelectorStyle ?? DEFAULT_STATE.modelSelectorStyle,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: AppearanceState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用时静默失败
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ─── 系统主题检测 ───

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return getSystemTheme();
  return mode;
}

// ─── DOM 应用 ───

function applyThemeToDOM(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

function applyFontToDOM(state: AppearanceState): void {
  const preset = FONT_PRESETS.find((p) => p.id === state.fontFamilyId);
  let family: string;

  if (state.fontFamilyId === "custom" && state.customFontFamily) {
    family = state.customFontFamily;
  } else if (preset) {
    family = preset.family;
  } else {
    family = FONT_PRESETS[0].family;
  }

  document.documentElement.style.setProperty("--font-family-base", family);
}

function applyFontSizeToDOM(state: AppearanceState): void {
  const option = FONT_SIZE_OPTIONS.find((o) => o.id === state.fontSizeId);
  const size = option?.size ?? 14;
  document.documentElement.style.setProperty("--font-size-base", `${size}px`);
}

function applyAll(state: AppearanceState): void {
  const resolved = resolveTheme(state.themeMode);
  applyThemeToDOM(resolved);
  applyFontToDOM(state);
  applyFontSizeToDOM(state);
}

// ─── 系统主题变化监听 ───

let systemThemeUnsubscribe: (() => void) | null = null;

function setupSystemThemeListener(): void {
  if (systemThemeUnsubscribe) return;
  if (typeof window === "undefined" || !window.matchMedia) return;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (currentState.themeMode === "system") {
      const resolved = getSystemTheme();
      applyThemeToDOM(resolved);
      notifyListeners();
    }
  };

  mediaQuery.addEventListener("change", handler);
  systemThemeUnsubscribe = () => mediaQuery.removeEventListener("change", handler);
}

// ─── 公共 API ───

export function initializeTheme(): void {
  applyAll(currentState);
  setupSystemThemeListener();
}

export function getAppearanceState(): AppearanceState {
  return { ...currentState };
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(currentState.themeMode);
}

export function setThemeMode(mode: ThemeMode): void {
  currentState = { ...currentState, themeMode: mode };
  saveState(currentState);
  const resolved = resolveTheme(mode);
  applyThemeToDOM(resolved);
  notifyListeners();
}

export function setFontFamily(fontId: string, customFamily?: string): void {
  currentState = {
    ...currentState,
    fontFamilyId: fontId,
    customFontFamily: customFamily ?? currentState.customFontFamily,
  };
  saveState(currentState);
  applyFontToDOM(currentState);
  notifyListeners();
}

export function setFontSize(sizeId: string): void {
  currentState = { ...currentState, fontSizeId: sizeId };
  saveState(currentState);
  applyFontSizeToDOM(currentState);
  notifyListeners();
}

export function setModelSelectorStyle(style: ModelSelectorStyle): void {
  currentState = { ...currentState, modelSelectorStyle: style };
  saveState(currentState);
  notifyListeners();
}

// ─── React Hooks ───

export function useAppearance(): AppearanceState {
  const [state, setState] = useState<AppearanceState>(currentState);

  useEffect(() => {
    const listener = () => setState({ ...currentState });
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return state;
}

export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme } {
  const state = useAppearance();
  return {
    mode: state.themeMode,
    resolved: resolveTheme(state.themeMode),
  };
}

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const { mode } = useTheme();
  const setMode = useCallback((newMode: ThemeMode) => {
    setThemeMode(newMode);
  }, []);
  return [mode, setMode];
}

export function useResolvedTheme(): ResolvedTheme {
  const { resolved } = useTheme();
  return resolved;
}
