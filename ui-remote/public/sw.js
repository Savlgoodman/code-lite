/**
 * Service Worker — Code Lite Remote PWA
 *
 * 目标：满足可安装性（有 fetch handler）+ 应用外壳离线可用。
 * 策略：
 * - 导航请求（HTML）走 network-first：优先取最新页面，离线时回退缓存的 index.html。
 * - 同源静态资源（Vite 带 hash 的 js/css/图标）走 cache-first：命中即用，未命中取回后缓存。
 * - 其余请求（跨域 API、WebSocket 升级、/ai-proxy 等）一律直接放行，不拦截、不缓存。
 *
 * 版本号变化时会清理旧缓存。
 */

const CACHE_VERSION = "code-lite-remote-v2";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isNavigationRequest(request) {
  return request.mode === "navigate";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 只处理 GET，且仅同源；其余（POST/API、跨域、/ai-proxy、ws 升级）放行。
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 明确不缓存代理/接口路径，避免把 AI 请求缓存住
  if (url.pathname.startsWith("/ai-proxy")) return;

  // 导航请求：network-first，离线回退到缓存的外壳
  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/index.html", copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // 静态资源：cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // 仅缓存正常的、基本类型的响应
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);
    }),
  );
});
