import { useState } from "react";

import { Bot, ChevronRight, Shield, ShieldAlert, ShieldCheck, Zap } from "lucide-react";

interface AgentOption {
  id: string;
  label: string;
  glyph: string;
  status: "available" | "experimental" | "planned" | "needs_setup";
  description: string;
  defaultMode?: string;
}

interface AgentSelectionPanelProps {
  availableAgents: AgentOption[];
  onSelect: (agentId: string) => void;
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

export function AgentSelectionPanel({ availableAgents, onSelect, onCancel }: AgentSelectionPanelProps) {
  const [selectedId, setSelectedId] = useState<string>(
    availableAgents.find((a) => a.status === "available")?.id
    ?? availableAgents[0]?.id
    ?? ""
  );

  const selected = availableAgents.find((a) => a.id === selectedId);

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
              <div className="agent-card-glyph">{agent.glyph}</div>
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
            disabled={!selectedId || selected?.status === "needs_setup" || selected?.status === "planned"}
            onClick={() => onSelect(selectedId)}
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
