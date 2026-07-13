/**
 * useSystemBack -- Android back button / browser popstate -> navStore.back()
 *
 * Called once in App. Priority: dismiss top Sheet/preview -> pop nav stack.
 * At root with nothing to close: require double-tap within 2s to exit,
 * preventing accidental exit when a sheet is open.
 *
 * Native (Capacitor Android): listens to @capacitor/app backButton.
 * Browser / PWA: sentinel history entry absorbs the first back gesture.
 */

import { useEffect, useRef } from "react";
import { navStore } from "../services/navStore";

const SENTINEL_STATE = { __codeliteNavSentinel: true } as const;
const EXIT_CONFIRM_WINDOW = 2000;

function pushSentinel() {
  history.pushState(SENTINEL_STATE, "");
}

export function useSystemBack(): void {
  const exitPressedRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;

    const showExitToast = () => {
      let toast = document.getElementById("__exit-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "__exit-toast";
        toast.className = "exit-confirm-toast";
        toast.textContent = "再按一次退出应用";
        document.body.appendChild(toast);
      }
      toast.classList.add("visible");
      setTimeout(() => toast!.classList.remove("visible"), EXIT_CONFIRM_WINDOW);
    };

    const tryExitOrConfirm = (exitApp: () => void) => {
      if (exitPressedRef.current) {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
        exitPressedRef.current = false;
        exitApp();
      } else {
        exitPressedRef.current = true;
        showExitToast();
        exitTimerRef.current = setTimeout(() => {
          exitPressedRef.current = false;
        }, EXIT_CONFIRM_WINDOW);
      }
    };

    pushSentinel();

    const onPopState = () => {
      if (disposed) return;
      if (navStore.canGoBack()) {
        navStore.back();
        pushSentinel();
      }
    };
    window.addEventListener("popstate", onPopState);

    let removeNativeListener: (() => void) | null = null;
    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("backButton", () => {
          if (navStore.canGoBack()) {
            navStore.back();
          } else {
            tryExitOrConfirm(() => void App.exitApp());
          }
        });
        if (disposed) {
          void handle.remove();
        } else {
          removeNativeListener = () => void handle.remove();
        }
      } catch {
        // Not a native environment or plugin unavailable.
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      if (removeNativeListener) removeNativeListener();
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);
}
