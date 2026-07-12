/**
 * useSystemBack — 把安卓硬件返回键与浏览器/PWA 的 popstate 统一接到导航栈的 back()。
 *
 * 单点接线，全应用只调用一次（在 App 里）。返回优先级由 navStore.back() 决定：
 * 先关最上层瞬态层（Sheet/预览），再弹出栈顶页面；已在 Tab 根且无可关闭层时才放行退出。
 *
 * 两个平台的机制不同，这里各自对接、互不干扰：
 * - 原生（Capacitor Android）：监听 @capacitor/app 的 backButton。canGoBack 为真则 back()，
 *   否则调用 App.exitApp() 退出。iOS 无硬件返回键，此监听自然不触发。
 * - 浏览器 / PWA：用一个「哨兵」history 记录承接手势/浏览器返回。每次 popstate 说明用户
 *   触发了返回：若栈里还有可返回层，consume 掉并把哨兵重新 push 回去（保持始终有一格可退，
 *   避免直接离开页面）；否则不再拦截，允许真正后退。
 */

import { useEffect } from "react";
import { navStore } from "../services/navStore";

/** 标记当前 history 记录为本应用的返回哨兵。 */
const SENTINEL_STATE = { __codeliteNavSentinel: true } as const;

function pushSentinel() {
  history.pushState(SENTINEL_STATE, "");
}

export function useSystemBack(): void {
  useEffect(() => {
    let disposed = false;

    // ── 浏览器 / PWA：popstate 承接返回 ──
    // 首次放一格哨兵，保证用户第一次返回有东西可消费。
    pushSentinel();

    const onPopState = () => {
      if (disposed) return;
      if (navStore.canGoBack()) {
        navStore.back();
        // 消费掉这次返回后补一格哨兵，维持“总有一格可退”。
        pushSentinel();
      }
      // 栈空：不补哨兵，下一次返回将真正离开页面。
    };
    window.addEventListener("popstate", onPopState);

    // ── 原生 Android：@capacitor/app backButton ──
    // 动态 import，避免在纯 Web 环境为原生插件付出加载成本；无插件时静默跳过。
    let removeNativeListener: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("backButton", () => {
          if (navStore.canGoBack()) {
            navStore.back();
          } else {
            void App.exitApp();
          }
        });
        if (disposed) {
          void handle.remove();
        } else {
          removeNativeListener = () => void handle.remove();
        }
      } catch {
        // 非原生环境或插件不可用：忽略。
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      if (removeNativeListener) removeNativeListener();
    };
  }, []);
}
