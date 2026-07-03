import { useState } from "react";

import { Archive, LayoutDashboard, MessageSquarePlus, Search, Settings, Wrench } from "lucide-react";

import { formatTimeLabel } from "../lib/formatters";
import type { Session } from "../types";
import "./Sidebar.css";

interface SidebarProps {
  activeSessionId: string;
  activeView: "chat" | "overview";
  onCreateSession: () => void;
  onArchiveSession: (sessionId: string) => void;
  onOpenOverview: () => void;
  onOpenSettings: () => void;
  onSearchTextChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  searchText: string;
  sessions: Session[];
}

export function Sidebar({
  activeSessionId,
  activeView,
  onArchiveSession,
  onCreateSession,
  onOpenOverview,
  onOpenSettings,
  onSearchTextChange,
  onSelectSession,
  searchText,
  sessions
}: SidebarProps) {
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null);

  function selectSession(sessionId: string) {
    setArchiveTargetId(null);
    onSelectSession(sessionId);
  }

  function archiveSession(sessionId: string) {
    setArchiveTargetId(null);
    onArchiveSession(sessionId);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button
          className={`nav-command ${activeView === "overview" ? "active" : ""}`}
          onClick={onOpenOverview}
          type="button"
        >
          <LayoutDashboard size={16} />
          <span>总览</span>
        </button>
        <button className="nav-command primary" onClick={onCreateSession}>
          <MessageSquarePlus size={16} />
          <span>新对话</span>
        </button>
        <label className="search-box">
          <Search size={15} />
          <input
            value={searchText}
            onChange={(event) => onSearchTextChange(event.target.value)}
            placeholder="搜索会话"
          />
        </label>
        <button className="nav-command">
          <Wrench size={16} />
          <span>技能</span>
        </button>
      </div>

      <div className="session-list" aria-label="会话列表">
        {sessions.map((session) => {
          const isArchiveOpen = archiveTargetId === session.id;

          return (
            <div
              key={session.id}
              className={`session-row ${isArchiveOpen ? "archive-open" : ""}`}
            >
              <button
                className="session-archive-action"
                onClick={() => archiveSession(session.id)}
                type="button"
              >
                <Archive size={14} />
                <span>归档</span>
              </button>
              <div
                className={`session-item ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => selectSession(session.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSession(session.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className={`status-dot ${session.status}`} />
                <span className="session-copy">
                  <span className="session-title">{session.title}</span>
                  {session.preview.trim() ? <span className="session-preview">{session.preview}</span> : null}
                </span>
                <button
                  className="session-time"
                  onClick={(event) => {
                    event.stopPropagation();
                    setArchiveTargetId(isArchiveOpen ? null : session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      setArchiveTargetId(isArchiveOpen ? null : session.id);
                    }
                  }}
                  type="button"
                >
                  {formatTimeLabel(session.updatedAt)}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button className="nav-command" onClick={onOpenSettings} type="button">
          <Settings size={16} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
