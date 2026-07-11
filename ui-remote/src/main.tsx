import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "streamdown/styles.css";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 注册 Service Worker 以支持 PWA“添加到桌面/安装”。
// 仅在浏览器环境注册；Capacitor 原生壳内跳过（原生 app 无需 SW）。
// dev 环境不注册，并主动注销已存在的 SW：SW 对带 hash 的 JS 走 cache-first，
// 会缓存住旧 bundle，导致改代码后前端仍跑旧逻辑（改动看不到、日志不出现）。
(function registerServiceWorker() {
  const cap = (window as any).Capacitor;
  const platform = cap?.getPlatform?.() ?? cap?.platform;
  const isNative = platform === "android" || platform === "ios";
  if (isNative) return;
  if (!("serviceWorker" in navigator)) return;

  if (import.meta.env.DEV) {
    // 开发环境：注销任何已注册的 SW 并清空其缓存，避免旧 bundle 干扰热更新。
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
    }).catch(() => undefined);
    if (typeof caches !== "undefined") {
      caches.keys().then((keys) => {
        for (const key of keys) caches.delete(key);
      }).catch(() => undefined);
    }
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker 注册失败:", err);
    });
  });
})();
