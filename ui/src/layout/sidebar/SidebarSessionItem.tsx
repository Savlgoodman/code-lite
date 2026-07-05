import { Archive } from "lucide-react";
import { useState, type FocusEvent } from "react";

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
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  function selectSession() {
    setConfirmingArchive(false);
    onSelect();
  }

  function handleArchiveClick() {
    if (!confirmingArchive) {
      setConfirmingArchive(true);
      return;
    }

    setConfirmingArchive(false);
    onArchive();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setConfirmingArchive(false);
    }
  }

  return (
    <div
      className={`sidebar-session-row ${active ? "active" : ""} ${confirmingArchive ? "confirming-archive" : ""}`}
      onBlur={handleBlur}
    >
      <button
        className="sidebar-session-select"
        onClick={selectSession}
        title={session.title}
        type="button"
      >
        <AgentIcon agent={session.agent} className="sidebar-session-agent" size="sm" />
        <span className="sidebar-session-title">{session.title}</span>
        <span className="sidebar-session-time">{formatTimeLabel(session.updatedAt)}</span>
      </button>
      <button
        aria-label={confirmingArchive ? `确认归档对话：${session.title}` : `归档对话：${session.title}`}
        className="sidebar-session-archive"
        onClick={handleArchiveClick}
        title={confirmingArchive ? "确认归档" : "归档对话"}
        type="button"
      >
        {confirmingArchive ? <span>归档</span> : <Archive size={15} />}
      </button>
    </div>
  );
}
