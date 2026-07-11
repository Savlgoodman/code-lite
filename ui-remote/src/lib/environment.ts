/**
 * 运行环境判定 —— AI 功能可用性的唯一判定处。
 *
 * 三种环境：
 * - 原生 App（Capacitor Android/iOS）：AI 可用。
 * - 开发环境（Vite dev）：AI 可用，请求经 /ai-proxy 中间件转发绕开 CORS。
 * - PWA / 静态部署（生产浏览器）：AI 不可用。静态托管没有 /ai-proxy 转发，
 *   而多数大模型供应商不返回 CORS 头，浏览器无法直连；故整体禁用并提示“仅 App 可用”。
 *
 * 详见 AGENTS.md「AI 功能的环境可用性」。
 */

/** 是否运行在 Capacitor 原生壳内（Android / iOS）。 */
export function isNativeApp(): boolean {
  const cap = (window as any).Capacitor;
  if (!cap) return false;
  const platform = cap.getPlatform?.() ?? cap.platform;
  return platform === "android" || platform === "ios";
}

/** 是否为 Vite 开发环境。 */
export function isDevEnvironment(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * AI 对话功能当前是否可用。
 * 原生 App 或开发环境可用；PWA / 生产静态部署不可用。
 */
export function isAiAvailable(): boolean {
  return isNativeApp() || isDevEnvironment();
}

/** 运行环境类别。 */
export type RuntimeKind = "native" | "dev" | "pwa" | "web";

/**
 * 是否以 PWA（standalone / 已安装）方式运行。
 * 通过 display-mode 媒体查询与 iOS 的 navigator.standalone 判定。
 */
export function isStandalonePwa(): boolean {
  const mm = window.matchMedia;
  const standalone =
    (mm && (mm("(display-mode: standalone)").matches || mm("(display-mode: fullscreen)").matches)) ||
    (navigator as any).standalone === true;
  return Boolean(standalone);
}

/** 判定当前运行环境类别。 */
export function runtimeKind(): RuntimeKind {
  if (isNativeApp()) return "native";
  if (isDevEnvironment()) return "dev";
  if (isStandalonePwa()) return "pwa";
  return "web";
}

export interface EnvironmentInfo {
  kind: RuntimeKind;
  /** 环境中文标签 */
  label: string;
  /** Capacitor 平台：android / ios / web */
  platform: string;
  /** 是否为独立 PWA 运行 */
  standalone: boolean;
  /** AI 功能是否可用 */
  aiAvailable: boolean;
  /** 构建模式：development / production */
  buildMode: string;
}

const KIND_LABELS: Record<RuntimeKind, string> = {
  native: "原生 App",
  dev: "开发环境",
  pwa: "PWA（已安装）",
  web: "网页浏览器",
};

/** 汇总当前运行环境信息，供“关于”页展示与排障。 */
export function getEnvironmentInfo(): EnvironmentInfo {
  const cap = (window as any).Capacitor;
  const platform = cap?.getPlatform?.() ?? cap?.platform ?? "web";
  const kind = runtimeKind();
  return {
    kind,
    label: KIND_LABELS[kind],
    platform,
    standalone: isStandalonePwa(),
    aiAvailable: isAiAvailable(),
    buildMode: import.meta.env.MODE,
  };
}
