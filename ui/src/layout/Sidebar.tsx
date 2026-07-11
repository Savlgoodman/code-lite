import { useMemo, useState } from "react";

import {
  LayoutDashboard,
  MessageSquarePlus,
  Search,
  Settings,
  Wrench
} from "lucide-react";

import type { Session } from "../types";
import { SidebarGroupHeader } from "./sidebar/SidebarGroupHeader";
import { SidebarSessionItem } from "./sidebar/SidebarSessionItem";
import "./Sidebar.css";

interface SidebarProps {
  activeSessionId: string;
  activeView: "chat" | "overview";
  onCreateSession: (workspace?: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onArchiveGroup: (sessionIds: string[]) => void;
  onOpenOverview: () => void;
  onOpenSettings: () => void;
  onSearchTextChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  searchText: string;
  sessions: Session[];
}

const GENERAL_GROUP_KEY = "__general__";
const MAX_VISIBLE_PROJECT_SESSIONS = 5;

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
  onArchiveGroup,
  onCreateSession,
  onOpenOverview,
  onOpenSettings,
  onSearchTextChange,
  onSelectSession,
  searchText,
  sessions
}: SidebarProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  function selectSession(sessionId: string) {
    onSelectSession(sessionId);
  }

  function archiveSession(sessionId: string) {
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

  function toggleSessionGroup(key: string) {
    setExpandedSessionGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
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
        <button className="nav-command primary" onClick={() => onCreateSession()} type="button">
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
          const canFoldSessions = group.kind === "project" && group.sessions.length > MAX_VISIBLE_PROJECT_SESSIONS;
          const sessionsExpanded = expandedSessionGroups.has(group.key);
          const visibleSessions = canFoldSessions && !sessionsExpanded
            ? group.sessions.slice(0, MAX_VISIBLE_PROJECT_SESSIONS)
            : group.sessions;
          const hiddenSessionCount = group.sessions.length - MAX_VISIBLE_PROJECT_SESSIONS;
          return (
            <div className="session-group" key={group.key}>
              <SidebarGroupHeader
                collapsed={collapsed}
                kind={group.kind}
                label={group.label}
                onArchiveGroup={() => onArchiveGroup(group.sessions.map((session) => session.id))}
                onCreateSession={() => onCreateSession(group.kind === "project" ? group.workspace : undefined)}
                onToggle={() => toggleGroup(group.key)}
                workspace={group.workspace}
              />
              {collapsed ? null : (
                <div className="session-group-body">
                  {visibleSessions.map((session) => (
                    <SidebarSessionItem
                      active={session.id === activeSessionId}
                      key={session.id}
                      onArchive={() => archiveSession(session.id)}
                      onSelect={() => selectSession(session.id)}
                      session={session}
                    />
                  ))}
                  {canFoldSessions ? (
                    <button
                      className="session-group-more"
                      onClick={() => toggleSessionGroup(group.key)}
                      type="button"
                    >
                      {sessionsExpanded ? "收起显示" : `展开显示 ${hiddenSessionCount} 个会话`}
                    </button>
                  ) : null}
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
