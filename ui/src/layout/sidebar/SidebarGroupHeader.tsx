import { Folder, FolderOpen, MessageSquare, SquarePen } from "lucide-react";

import "./SidebarGroupHeader.css";

interface SidebarGroupHeaderProps {
  collapsed: boolean;
  kind: "general" | "project";
  label: string;
  onCreateSession: () => void;
  onToggle: () => void;
  workspace: string;
}

export function SidebarGroupHeader({
  collapsed,
  kind,
  label,
  onCreateSession,
  onToggle,
  workspace
}: SidebarGroupHeaderProps) {
  const isProject = kind === "project";
  const title = workspace || "普通会话（~/.code-lite/workspace）";
  const createLabel = isProject ? `在 ${label} 新建会话` : "新建普通会话";
  const FolderIcon = collapsed ? Folder : FolderOpen;

  return (
    <div className="sidebar-group-header" title={title}>
      <button
        aria-expanded={!collapsed}
        className="sidebar-group-label-button"
        onClick={onToggle}
        type="button"
      >
        {isProject ? <FolderIcon size={16} /> : <MessageSquare size={15} />}
        <span className="sidebar-group-label">{label}</span>
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
  );
}
