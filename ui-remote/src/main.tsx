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
// 仅在浏览器环境注册；Capacitor 原生壳内无需 SW，并主动清理历史版本可能留下的注册与缓存。
// dev 环境不注册，并主动注销已存在的 SW：SW 对带 hash 的 JS 走 cache-first，
// 会缓存住旧 bundle，导致改代码后前端仍跑旧逻辑（改动看不到、日志不出现）。
(function registerServiceWorker() {
  const cap = (window as any).Capacitor;
  const platform = cap?.getPlatform?.() ?? cap?.platform;
  const isNative = platform === "android" || platform === "ios";
  if (!("serviceWorker" in navigator)) return;

  if (isNative) {
    // 覆盖安装会保留 WebView 数据；旧版本若曾在原生壳注册 SW，仅跳过新注册并不能移除它。
    // 当前页面仍受旧 worker 控制时，注销并清缓存后重载一次，确保 APK 使用内嵌的新 bundle。
    const hadController = navigator.serviceWorker.controller !== null;
    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        const results = await Promise.all(regs.map((reg) => reg.unregister()));
        if (results.some((removed) => !removed)) return;
        if (typeof caches !== "undefined") {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((key) => key.startsWith("code-lite-remote-"))
              .map((key) => caches.delete(key)),
          );
        }
        if (hadController) window.location.reload();
      } catch {
        // 清理失败不阻塞原生应用启动，下次启动继续尝试。
      }
    })();
    return;
  }

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
