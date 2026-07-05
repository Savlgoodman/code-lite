import { Archive } from "lucide-react";

import { AgentIcon } from "../../components/AgentIcon";
import { formatTimeLabel } from "../../lib/formatters";
import type { Session } from "../../types";
import "./SidebarSessionItem.css";

interface SidebarSessionItemProps {
  active: boolean;
  onArchive: () => void;
  onSelect: () => void;
  session: Session;
}

export function SidebarSessionItem({
  active,
  onArchive,
  onSelect,
  session
}: SidebarSessionItemProps) {
  return (
    <div className={`sidebar-session-row ${active ? "active" : ""}`}>
      <button
        className="sidebar-session-select"
        onClick={onSelect}
        title={session.title}
        type="button"
      >
        <AgentIcon agent={session.agent} className="sidebar-session-agent" size="sm" />
        <span className="sidebar-session-title">{session.title}</span>
        <span className="sidebar-session-time">{formatTimeLabel(session.updatedAt)}</span>
      </button>
      <button
        aria-label={`归档对话：${session.title}`}
        className="sidebar-session-archive"
        onClick={onArchive}
        title="归档对话"
        type="button"
      >
        <Archive size={15} />
      </button>
    </div>
  );
}
