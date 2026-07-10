import { useState } from "react";
import { Folder } from "lucide-react";
import type { Session } from "@code-lite/protocol";
import { useConversationState } from "../useConversations";
import { connectionManager } from "../services/ConnectionManager";
import { ChatPage } from "../ChatPage";

export function RemoteTab({ connected, deviceName, activeSessionId, setActiveSessionId }: {
  connected: boolean;
  deviceName: string;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}) {
  const client = connectionManager.getClient();
  const { sessions } = useConversationState(client);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

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

  const toggleProject = (name: string) => {
    setExpandedProjects((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const title = deviceName ? `${deviceName} 的远程会话` : "远程会话";

  if (!connected) {
    return (
      <div className="tab-page">
        <h2 className="page-title">{title}</h2>
        <div className="empty-state">
          <div className="empty-icon">◎</div>
          <h2>未连接</h2>
          <p>请在"设备"页面添加并连接一台设备</p>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="tab-page">
        <h2 className="page-title">{title}</h2>
        <div className="empty-state">
          <div className="empty-icon">☺</div>
          <h2>收件箱为空</h2>
          <p>与好友建立连接，开始共享会话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-page">
      <h2 className="page-title">{title}</h2>
      <div className="session-list">
        {Object.entries(projects).map(([project, projectSessions]) => {
          const isExpanded = expandedProjects[project] ?? true;
          const LIMIT = 5;
          const visibleSessions = isExpanded ? projectSessions : projectSessions.slice(0, LIMIT);
          const hasMore = projectSessions.length > LIMIT;

          return (
            <div key={project} className="project-group">
              <div className="project-header" onClick={() => toggleProject(project)}>
                <Folder size={16} />
                <span>{project}</span>
              </div>
              <ul className="session-items">
                {visibleSessions.map((session) => (
                  <li
                    key={session.id}
                    className="session-item"
                    onClick={() => setActiveSessionId(session.id)}
                  >
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
    </div>
  );
}
