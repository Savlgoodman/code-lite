import { useState } from "react";
import { Folder, ArrowDownWideNarrow, Plus, FolderPlus } from "lucide-react";
import type { Session } from "@code-lite/protocol";
import { useConversationState } from "../useConversations";
import { connectionManager } from "../services/ConnectionManager";
import { ChatPage } from "../ChatPage";
import { AgentIcon } from "../components/AgentIcon";
import { NewConversationSheet } from "../components/NewConversationSheet";

export function RemoteTab({ connected, deviceName, activeSessionId, setActiveSessionId }: {
  connected: boolean;
  deviceName: string;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}) {
  const client = connectionManager.getClient();
  const { sessions } = useConversationState(client);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  // 按最新活跃时间排序（updatedAt 降序）；关闭时保持后端返回的默认顺序
  const [sortByTime, setSortByTime] = useState(false);
  // 新建对话弹窗：null=关闭；否则携带预填工作区路径（""=自由创建）
  const [newConvWorkspace, setNewConvWorkspace] = useState<string | null>(null);

  // 如果正在查看会话，显示 ChatPage
  if (activeSessionId) {
    return <ChatPage sessionId={activeSessionId} onBack={() => setActiveSessionId(null)} />;
  }

  // 按 workspace 分组
  const projects = sessions.reduce<Record<string, Session[]>>((acc: Record<string, Session[]>, s: Session) => {
    const ws = s.workspace || "未分类";
    (acc[ws] ??= []).push(s);
    return acc;
  }, {});

  // 排序开启时：组内按 updatedAt 降序，组间按各组最新会话时间降序
  let projectEntries = Object.entries(projects);
  if (sortByTime) {
    for (const [, list] of projectEntries) {
      list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    projectEntries = projectEntries.sort(([, a], [, b]) => {
      const latest = (list: Session[]) => list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0);
      return latest(b) - latest(a);
    });
  }

  const toggleProject = (name: string) => {
    setExpandedProjects((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const title = deviceName ? `${deviceName} 的远程 code-lite` : "远程 code-lite";

  if (!connected) {
    return (
      <div className="tab-page">
        <h2 className="page-title">{title}</h2>
        <div className="page-subtitle offline">未连接</div>
        <div className="empty-state">
          <div className="empty-icon">◎</div>
          <p>请在"设备"页面添加并连接一台设备</p>
        </div>
      </div>
    );
  }

  const newConvSheet = newConvWorkspace !== null && (
    <NewConversationSheet
      client={client}
      initialWorkspace={newConvWorkspace}
      onClose={() => setNewConvWorkspace(null)}
      onCreated={(id) => {
        setNewConvWorkspace(null);
        setActiveSessionId(id);
      }}
    />
  );

  if (sessions.length === 0) {
    return (
      <div className="tab-page">
        <h2 className="page-title">{title}</h2>
        <div className="page-subtitle">已连接</div>
        <div className="empty-state">
          <div className="empty-icon">☺</div>
          <p>收件箱为空，点击右下角新建对话</p>
        </div>
        <button
          className="floating-action-button"
          onClick={() => setNewConvWorkspace("")}
          aria-label="新建对话"
          title="新建对话"
        >
          <Plus size={24} />
        </button>
        {newConvSheet}
      </div>
    );
  }

  return (
    <div className="tab-page">
      <h2 className="page-title">{title}</h2>
      <div className="page-subtitle">已连接</div>
      <div className="session-list">
        {projectEntries.map(([project, projectSessions]) => {
          const isExpanded = expandedProjects[project] ?? false;
          const LIMIT = 5;
          const visibleSessions = isExpanded ? projectSessions : projectSessions.slice(0, LIMIT);
          const hasMore = projectSessions.length > LIMIT;

          return (
            <div key={project} className="project-group">
              <div className="project-header">
                <div className="project-header-main" onClick={() => toggleProject(project)}>
                  <Folder size={16} />
                  <span>{project}</span>
                </div>
                {project !== "未分类" && (
                  <button
                    className="project-new-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewConvWorkspace(project);
                    }}
                    aria-label={`在 ${project} 新建对话`}
                    title="在此项目新建对话"
                  >
                    <FolderPlus size={16} />
                  </button>
                )}
              </div>
              <ul className="session-items">
                {visibleSessions.map((session) => (
                  <li
                    key={session.id}
                    className="session-item"
                    onClick={() => setActiveSessionId(session.id)}
                  >
                    <AgentIcon agent={session.agent} />
                    <span className="session-title">{session.title || "无标题"}</span>
                    <span className={`status-dot ${session.status === "running" ? "running" : "idle"}`} />
                  </li>
                ))}
                {hasMore && !isExpanded && (
                  <li className="session-item more" onClick={() => toggleProject(project)}>
                    <span>展开全部 ({projectSessions.length})</span>
                  </li>
                )}
                {hasMore && isExpanded && (
                  <li className="session-item more" onClick={() => toggleProject(project)}>
                    <span>收起</span>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
      <button
        className={`floating-action-button fab-sort${sortByTime ? " active" : ""}`}
        onClick={() => setSortByTime((v) => !v)}
        aria-label={sortByTime ? "按最新活跃排序（已开启）" : "按最新活跃排序"}
        title={sortByTime ? "按最新活跃排序（已开启）" : "按最新活跃排序"}
      >
        <ArrowDownWideNarrow size={24} />
      </button>
      <button
        className="floating-action-button fab-new"
        onClick={() => setNewConvWorkspace("")}
        aria-label="新建对话"
        title="新建对话（自由创建）"
      >
        <Plus size={24} />
      </button>
      {newConvSheet}
    </div>
  );
}
