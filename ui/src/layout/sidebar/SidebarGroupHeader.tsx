import { Archive, Folder, FolderOpen, MessageSquare, SquarePen } from "lucide-react";
import { useState, type FocusEvent } from "react";

import "./SidebarGroupHeader.css";

interface SidebarGroupHeaderProps {
  collapsed: boolean;
  kind: "general" | "project";
  label: string;
  onArchiveGroup: () => void;
  onCreateSession: () => void;
  onToggle: () => void;
  workspace: string;
}

export function SidebarGroupHeader({
  collapsed,
  kind,
  label,
  onArchiveGroup,
  onCreateSession,
  onToggle,
  workspace
}: SidebarGroupHeaderProps) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const isProject = kind === "project";
  const title = workspace || "普通会话（~/.code-lite/workspace）";
  const createLabel = isProject ? `在 ${label} 新建会话` : "新建普通会话";
  const archiveLabel = confirmingArchive ? `确认归档 ${label} 全部会话` : `归档 ${label} 全部会话`;
  const FolderIcon = collapsed ? Folder : FolderOpen;

  function handleArchiveClick(event: React.MouseEvent) {
    event.stopPropagation();
    if (!confirmingArchive) {
      setConfirmingArchive(true);
      return;
    }
    setConfirmingArchive(false);
    onArchiveGroup();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setConfirmingArchive(false);
    }
  }

  return (
    <div
      className={`sidebar-group-header ${confirmingArchive ? "confirming-archive" : ""}`}
      title={title}
      onBlur={handleBlur}
    >
      <button
        aria-expanded={!collapsed}
        className="sidebar-group-label-button"
        onClick={onToggle}
        type="button"
      >
        {isProject ? <FolderIcon size={16} /> : <MessageSquare size={15} />}
        <span className="sidebar-group-label">{label}</span>
      </button>
      <div className="sidebar-group-actions">
        <button
          aria-label={archiveLabel}
          className="sidebar-group-archive"
          onClick={handleArchiveClick}
          title={archiveLabel}
          type="button"
        >
          {confirmingArchive ? <span>归档</span> : <Archive size={14} />}
        </button>
        <button
          aria-label={createLabel}
          className="sidebar-group-new-session"
          onClick={(event) => {
            event.stopPropagation();
            onCreateSession();
          }}
          title={createLabel}
          type="button"
        >
          <SquarePen size={15} />
        </button>
      </div>
    </div>
  );
}
