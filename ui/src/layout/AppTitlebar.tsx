import { ArrowLeft, ArrowRight, Minus, PanelLeft, Square, X } from "lucide-react";

import "./AppTitlebar.css";

async function handleWindowAction(action: "minimize" | "maximize" | "close") {
  const hasTauri = "__TAURI_INTERNALS__" in window;
  if (!hasTauri) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const currentWindow = getCurrentWindow();

  if (action === "minimize") {
    await currentWindow.minimize();
  } else if (action === "maximize") {
    await currentWindow.toggleMaximize();
  } else {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("shutdown_app");
  }
}

export function AppTitlebar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <button className="icon-button" aria-label="侧边栏">
          <PanelLeft size={16} />
        </button>
        <button className="icon-button muted" aria-label="后退">
          <ArrowLeft size={16} />
        </button>
        <button className="icon-button muted" aria-label="前进">
          <ArrowRight size={16} />
        </button>
        <nav className="title-menu" aria-label="应用菜单">
          <button>文件</button>
          <button>编辑</button>
          <button>视图</button>
          <button>帮助</button>
        </nav>
      </div>
      <div className="titlebar-center">Code Lite</div>
      <div className="window-controls">
        <button aria-label="最小化" onClick={() => void handleWindowAction("minimize")}>
          <Minus size={15} />
        </button>
        <button aria-label="最大化" onClick={() => void handleWindowAction("maximize")}>
          <Square size={13} />
        </button>
        <button aria-label="关闭" onClick={() => void handleWindowAction("close")}>
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
