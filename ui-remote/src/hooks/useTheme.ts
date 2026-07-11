import { useState, useEffect, useCallback } from "react";

export type ThemeName = "mono" | "warm";
export type ThemeMode = "light" | "dark";

const LS_THEME = "code-lite-theme";
const LS_MODE = "code-lite-mode";

export const THEME_LABELS: Record<ThemeName, string> = {
  mono: "黑白",
  warm: "暖阳",
};

function readTheme(): ThemeName {
  const v = localStorage.getItem(LS_THEME);
  return v === "warm" ? "warm" : "mono";
}

function readMode(): ThemeMode {
  const v = localStorage.getItem(LS_MODE);
  if (v === "dark" || v === "light") return v;
  // 无存储时跟随系统
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme: ThemeName, mode: ThemeMode) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-mode", mode);
  // 同步移动端状态栏配色为当前背景色
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }
}

/** 主题（配色方案）与明暗模式：读写 localStorage 并同步到 <html> 属性。 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(readTheme);
  const [mode, setModeState] = useState<ThemeMode>(readMode);

  useEffect(() => {
    apply(theme, mode);
  }, [theme, mode]);

  const setTheme = useCallback((t: ThemeName) => {
    localStorage.setItem(LS_THEME, t);
    setThemeState(t);
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    localStorage.setItem(LS_MODE, m);
    setModeState(m);
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  return { theme, mode, setTheme, setMode, toggleMode };
}
