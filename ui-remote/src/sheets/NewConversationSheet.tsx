import { useState } from "react";
import { Bot, FolderOpen, ShieldCheck, Zap, ShieldAlert, Shield } from "lucide-react";
import type { ConversationClient } from "@code-lite/chat-core";
import { AgentIcon } from "../components/AgentIcon";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { Sheet, Button, Input } from "../components/ui";

interface AgentOption {
  id: string;
  label: string;
  status: "available" | "experimental" | "planned" | "needs_setup";
  description: string;
}

// 与桌面端 ChatPage 的 availableAgents 保持一致
const AVAILABLE_AGENTS: AgentOption[] = [
  { id: "codex", label: "Codex", status: "available", description: "OpenAI Codex CLI，通用编码 agent" },
  { id: "claude_code", label: "Claude Code", status: "available", description: "Anthropic Claude Code CLI" },
  { id: "opencode", label: "opencode", status: "planned", description: "开源编码 agent（待接入）" },
  { id: "nanobot", label: "Nanobot", status: "available", description: "内置轻量 agent" },
];

function statusLabel(status: string) {
  switch (status) {
    case "available": return "可用";
    case "experimental": return "实验性";
    case "needs_setup": return "需配置";
    case "planned": return "待接入";
    default: return status;
  }
}

function statusIcon(status: string) {
  if (status === "available") return <ShieldCheck size={12} />;
  if (status === "experimental") return <Zap size={12} />;
  if (status === "needs_setup") return <ShieldAlert size={12} />;
  return <Shield size={12} />;
}

interface NewConversationSheetProps {
  client: ConversationClient | null;
  /** 预填工作区路径（从项目文件夹的"新建"入口带入）；留空为自由创建 */
  initialWorkspace?: string;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function NewConversationSheet({
  client,
  initialWorkspace = "",
  onClose,
  onCreated,
}: NewConversationSheetProps) {
  const [selectedId, setSelectedId] = useState<string>(
    AVAILABLE_AGENTS.find((a) => a.status === "available")?.id ?? AVAILABLE_AGENTS[0].id
  );
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [showBrowser, setShowBrowser] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = AVAILABLE_AGENTS.find((a) => a.id === selectedId);
  const canCreate =
    Boolean(selectedId) &&
    selected?.status !== "planned" &&
    selected?.status !== "needs_setup" &&
    !creating;

  const handleCreate = async () => {
    if (!client || !canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const session = await client.createConversation({
        agentId: selectedId,
        workspace: workspace.trim() || undefined,
      });
      onCreated(session.id);
    } catch (err) {
      console.error("[NewConversationSheet] create failed:", err);
      setError("创建失败：" + (err instanceof Error ? err.message : String(err)));
      setCreating(false);
    }
  };

  return (
    <>
      <Sheet
        title={<><Bot size={18} style={{ verticalAlign: "-3px", marginRight: 6 }} />新建对话</>}
        onClose={onClose}
        footer={(close) => (
          <>
            <Button variant="secondary" onClick={() => close()}>取消</Button>
            <Button variant="primary" disabled={!canCreate} onClick={handleCreate}>
              {creating ? "创建中…" : "开始会话"}
            </Button>
          </>
        )}
      >
        <div className="field">
          <label>选择 Agent</label>
          <div className="agent-grid">
            {AVAILABLE_AGENTS.map((agent) => {
              const disabled = agent.status === "planned" || agent.status === "needs_setup";
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`agent-card${agent.id === selectedId ? " selected" : ""}${disabled ? " disabled" : ""}`}
                  disabled={disabled}
                  onClick={() => setSelectedId(agent.id)}
                >
                  <AgentIcon agent={{ id: agent.id, label: agent.label, runtimeId: agent.id }} />
                  <span className="agent-card-label">{agent.label}</span>
                  <span className={`agent-card-status ${agent.status}`}>
                    {statusIcon(agent.status)} {statusLabel(agent.status)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>工作区路径</label>
          <div className="workspace-row">
            <Input
              value={workspace}
              onValueChange={setWorkspace}
              placeholder="留空为普通会话（~/.code-lite/workspace）"
              spellCheck={false}
            />
            <button className="workspace-browse-btn" onClick={() => setShowBrowser(true)}>
              <FolderOpen size={16} /> 浏览
            </button>
          </div>
          <span className="workspace-hint">可手动输入绝对路径，或点击浏览远端电脑目录。</span>
        </div>

        {error && <div className="test-result fail">{error}</div>}
      </Sheet>

      {showBrowser && (
        <DirectoryBrowser
          client={client}
          initialPath={workspace.trim() || undefined}
          onSelect={(path) => {
            setWorkspace(path);
            setShowBrowser(false);
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
