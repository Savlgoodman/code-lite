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
(function registerServiceWorker() {
  const cap = (window as any).Capacitor;
  const platform = cap?.getPlatform?.() ?? cap?.platform;
  const isNative = platform === "android" || platform === "ios";
  if (isNative) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker 注册失败:", err);
    });
  });
})();
