import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Github, Minus, PanelLeft, Square, X } from "lucide-react";

import "./AppTitlebar.css";

const REPOSITORY_URL = "https://github.com/Savlgoodman/code-lite";
const AUTHOR_URL = "https://github.com/Savlgoodman";
const AUTHOR_NAME = "Kevin Roo";

async function handleWindowAction(action: "minimize" | "maximize" | "close") {
  const hasTauri = "__TAURI_INTERNALS__" in window;
  if (!hasTauri) {
    return;
  }

  if (action === "minimize") {
    await invoke("minimize_window");
  } else if (action === "maximize") {
    await invoke("toggle_maximize_window");
  } else {
    await invoke("shutdown_app");
  }
}

async function openExternalUrl(url: string) {
  const hasTauri = "__TAURI_INTERNALS__" in window;
  if (hasTauri) {
    await invoke("open_about_url", { url });
    return;
  }
  window.open(url, "_blank", "noreferrer");
}

export function AppTitlebar() {
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const helpMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isHelpMenuOpen) {
      return;
    }

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!helpMenuRef.current?.contains(target)) {
        setIsHelpMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isHelpMenuOpen]);

  useEffect(() => {
    if (!isAboutOpen) {
      return;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAboutOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isAboutOpen]);

  return (
    <>
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-drag-surface" data-tauri-drag-region aria-hidden="true" />
        <div className="titlebar-left">
          <button className="icon-button" aria-label="侧边栏">
            <PanelLeft size={16} />
          </button>
          <nav className="title-menu" aria-label="应用菜单">
            <button>文件</button>
            <button>编辑</button>
            <button>视图</button>
            <div className="title-menu-group" ref={helpMenuRef}>
              <button
                aria-expanded={isHelpMenuOpen}
                aria-haspopup="menu"
                className={isHelpMenuOpen ? "active" : ""}
                onClick={() => setIsHelpMenuOpen((open) => !open)}
                type="button"
              >
                帮助
              </button>
              {isHelpMenuOpen ? (
                <div className="title-dropdown-menu" role="menu">
                  <button
                    onClick={() => {
                      setIsHelpMenuOpen(false);
                      setIsAboutOpen(true);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    关于
                  </button>
                </div>
              ) : null}
            </div>
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

      {isAboutOpen ? (
        <div className="about-dialog-backdrop" onMouseDown={() => setIsAboutOpen(false)}>
          <section
            aria-labelledby="about-dialog-title"
            aria-modal="true"
            className="about-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="about-dialog-header">
              <div>
                <span>关于</span>
                <h2 id="about-dialog-title">Code Lite</h2>
              </div>
              <button aria-label="关闭关于" className="icon-button" onClick={() => setIsAboutOpen(false)} type="button">
                <X size={15} />
              </button>
            </div>
            <p className="about-dialog-description">
              code-lite 是一个桌面端多 Agent 工作台，用于接入 Codex、Claude Code、opencode 等 agent runtime。
            </p>
            <div className="about-dialog-list">
              <div>
                <span>根仓库</span>
                <button onClick={() => void openExternalUrl(REPOSITORY_URL)} type="button">
                  <Github size={15} />
                  <strong>{REPOSITORY_URL}</strong>
                  <ExternalLink size={13} />
                </button>
              </div>
              <div>
                <span>作者</span>
                <button onClick={() => void openExternalUrl(AUTHOR_URL)} type="button">
                  <Github size={15} />
                  <strong>{AUTHOR_NAME}</strong>
                  <ExternalLink size={13} />
                </button>
              </div>
              <div>
                <span>作者主页</span>
                <button onClick={() => void openExternalUrl(AUTHOR_URL)} type="button">
                  <Github size={15} />
                  <strong>{AUTHOR_URL}</strong>
                  <ExternalLink size={13} />
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
