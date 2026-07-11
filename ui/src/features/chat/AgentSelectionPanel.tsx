import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Bot, ChevronRight, FolderOpen, Loader2, Shield, ShieldAlert, ShieldCheck, Zap } from "lucide-react";

import { AgentIcon } from "../../components/AgentIcon";
import "./AgentSelectionPanel.css";

interface AgentOption {
  id: string;
  label: string;
  status: "available" | "experimental" | "planned" | "needs_setup";
  description: string;
  defaultMode?: string;
}

interface AgentSelectionPanelProps {
  availableAgents: AgentOption[];
  initialWorkspace?: string;
  onSelect: (agentId: string, workspace: string) => void;
  onCancel: () => void;
}

function agentIcon(status: string) {
  if (status === "available") return <ShieldCheck size={14} />;
  if (status === "experimental") return <Zap size={14} />;
  if (status === "needs_setup") return <ShieldAlert size={14} />;
  return <Shield size={14} />;
}

function statusLabel(status: string) {
  switch (status) {
    case "available":
      return "可用";
    case "experimental":
      return "实验性";
    case "needs_setup":
      return "需配置";
    case "planned":
      return "待接入";
    default:
      return status;
  }
}

export function AgentSelectionPanel({
  availableAgents,
  initialWorkspace = "",
  onSelect,
  onCancel
}: AgentSelectionPanelProps) {
  const [selectedId, setSelectedId] = useState<string>(
    availableAgents.find((a) => a.status === "available")?.id
    ?? availableAgents[0]?.id
    ?? ""
  );
  const [workspace, setWorkspace] = useState<string>(initialWorkspace);
  const [workspacePickerError, setWorkspacePickerError] = useState<string | null>(null);
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);

  useEffect(() => {
    setWorkspace(initialWorkspace);
  }, [initialWorkspace]);

  const selected = availableAgents.find((a) => a.id === selectedId);
  const canStart = Boolean(selectedId) && selected?.status !== "needs_setup" && selected?.status !== "planned";

  function handleStart() {
    if (!canStart) {
      return;
    }
    onSelect(selectedId, workspace.trim());
  }

  async function pickWorkspaceDirectory() {
    setWorkspacePickerError(null);
    setIsPickingWorkspace(true);
    try {
      const selectedWorkspace = await invoke<string | null>("pick_workspace_directory");
      if (selectedWorkspace) {
        setWorkspace(selectedWorkspace);
      }
    } catch (error) {
      console.error("Failed to pick workspace directory:", error);
      setWorkspacePickerError("当前环境无法打开目录选择器，请手动输入目录。");
    } finally {
      setIsPickingWorkspace(false);
    }
  }

  return (
    <div className="agent-selection-overlay" onClick={onCancel}>
      <div className="agent-selection-panel" onClick={(e) => e.stopPropagation()}>
        <div className="agent-selection-header">
          <Bot size={20} />
          <h2>选择 Agent 开始新会话</h2>
        </div>

        <div className="agent-selection-grid">
          {availableAgents.map((agent) => (
            <button
              key={agent.id}
              className={`agent-selection-card ${agent.id === selectedId ? "selected" : ""} ${agent.status === "needs_setup" || agent.status === "planned" ? "disabled" : ""}`}
              disabled={agent.status === "needs_setup" || agent.status === "planned"}
              onClick={() => setSelectedId(agent.id)}
              type="button"
            >
              <AgentIcon
                className="agent-card-glyph"
                label={agent.label}
                runtimeId={agent.id}
                size="md"
              />
              <div className="agent-card-info">
                <strong>{agent.label}</strong>
                <span className={`agent-card-status ${agent.status}`}>
                  {agentIcon(agent.status)}
                  {statusLabel(agent.status)}
                </span>
              </div>
            </button>
          ))}
        </div>

        {selected ? (
          <p className="agent-selection-description">{selected.description}</p>
        ) : null}

        <label className="agent-selection-workspace">
          <span className="workspace-label">
            <FolderOpen size={14} />
            工作区路径
          </span>
          <div className="workspace-input-row">
            <input
              value={workspace}
              onChange={(event) => {
                setWorkspace(event.target.value);
                setWorkspacePickerError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleStart();
                }
              }}
              placeholder="留空则为普通会话（~/.code-lite/workspace）"
              spellCheck={false}
            />
            <button
              className="workspace-browse-button"
              disabled={isPickingWorkspace}
              onClick={pickWorkspaceDirectory}
              type="button"
            >
              {isPickingWorkspace ? <Loader2 size={14} /> : <FolderOpen size={14} />}
              浏览
            </button>
          </div>
          {workspacePickerError ? <span className="workspace-error">{workspacePickerError}</span> : null}
          <span className="workspace-hint">
            可浏览选择目录，也可手动输入绝对路径；指定后，此会话会按工作区在侧栏归类。
          </span>
        </label>

        <div className="agent-selection-footer">
          <button
            className="agent-selection-cancel"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="agent-selection-confirm"
            disabled={!canStart}
            onClick={handleStart}
            type="button"
          >
            开始会话
            <ChevronRight size={14} />
          </button>
        </div>

        <p className="agent-selection-note">
          选择后此会话将始终使用该 Agent，创建后不可更改。
        </p>
      </div>
    </div>
  );
}
