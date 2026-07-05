import { useMemo, useState } from "react";

import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  LayoutDashboard,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Settings,
  Wrench
} from "lucide-react";

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

const GENERAL_GROUP_KEY = "__general__";

interface SessionGroup {
  key: string;
  kind: "general" | "project";
  label: string;
  workspace: string;
  sessions: Session[];
  latestActivity: number;
}

/** 从工作区路径提取文件夹名（兼容 Windows / POSIX 分隔符）。 */
function workspaceBasename(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || "项目";
}

function groupSessions(sessions: Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const session of sessions) {
    const isProject = session.workspaceKind === "project" && Boolean(session.workspace);
    const key = isProject ? (session.workspace as string) : GENERAL_GROUP_KEY;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind: isProject ? "project" : "general",
        label: isProject ? workspaceBasename(session.workspace as string) : "普通会话",
        workspace: isProject ? (session.workspace as string) : "",
        sessions: [],
        latestActivity: 0
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.latestActivity = Math.max(group.latestActivity, session.updatedAt || 0);
  }

  return [...groups.values()].sort((a, b) => {
    // 普通会话始终置底，项目组按最近活动降序
    if (a.kind !== b.kind) {
      return a.kind === "general" ? 1 : -1;
    }
    return b.latestActivity - a.latestActivity;
  });
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  function selectSession(sessionId: string) {
    setArchiveTargetId(null);
    onSelectSession(sessionId);
  }

  function archiveSession(sessionId: string) {
    setArchiveTargetId(null);
    onArchiveSession(sessionId);
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function renderSession(session: Session) {
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
        {groups.map((group) => {
          const collapsed = collapsedGroups.has(group.key);
          return (
            <div className="session-group" key={group.key}>
              <button
                className="session-group-header"
                onClick={() => toggleGroup(group.key)}
                title={group.workspace || "普通会话（~/.code-lite/workspace）"}
                type="button"
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {group.kind === "project" ? <Folder size={14} /> : <MessageSquare size={14} />}
                <span className="session-group-label">{group.label}</span>
                <span className="session-group-count">{group.sessions.length}</span>
              </button>
              {collapsed ? null : (
                <div className="session-group-body">
                  {group.sessions.map(renderSession)}
                </div>
              )}
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
