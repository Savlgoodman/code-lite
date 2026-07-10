import type { CSSProperties } from "react";
import type { AgentSummary } from "@code-lite/protocol";

const agentIconSources = {
  claude_code: { src: new URL("../assets/agents/claude.svg", import.meta.url).href, color: "#d97757" },
  codex:       { src: new URL("../assets/agents/openai.svg", import.meta.url).href, color: "var(--text)" },
  opencode:    { src: new URL("../assets/agents/opencode.svg", import.meta.url).href, color: "#211e1e" },
  nanobot:     { src: new URL("../assets/agents/nanobot_favicon_32.png", import.meta.url).href, color: "#3d6f9f" },
} as const;

type KnownAgentId = keyof typeof agentIconSources;

function normalizeAgentId(value: string | null | undefined): KnownAgentId | null {
  if (!value) return null;
  if (value in agentIconSources) return value as KnownAgentId;
  const lower = value.toLowerCase();
  if (lower.includes("claude")) return "claude_code";
  if (lower.includes("codex") || lower.includes("openai") || lower.includes("chatgpt")) return "codex";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("nanobot")) return "nanobot";
  return null;
}

function resolveAgentIconId(agent?: AgentSummary | null): KnownAgentId | null {
  return normalizeAgentId(agent?.runtimeId)
    ?? normalizeAgentId(agent?.id)
    ?? normalizeAgentId(agent?.label);
}

/** 从 agent label 中提取首字母作为 fallback */
function agentInitials(value: string | null | undefined) {
  const label = value?.trim();
  if (!label) return "Ag";
  const parts = label.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

interface AgentIconProps {
  agent?: AgentSummary | null;
  className?: string;
}

export function AgentIcon({ agent, className = "" }: AgentIconProps) {
  const iconId = resolveAgentIconId(agent);
  const accessibleLabel = agent?.label ?? "Agent";
  const classes = ["session-agent-icon", iconId ? `agent-${iconId}` : "", className].filter(Boolean).join(" ");

  if (!iconId) {
    return (
      <span aria-label={accessibleLabel} className={classes}>
        {agentInitials(accessibleLabel)}
      </span>
    );
  }

  const asset = agentIconSources[iconId];

  // nanobot 用 png，需要 img 标签
  if (iconId === "nanobot") {
    return (
      <span aria-label={accessibleLabel} className={classes}>
        <img alt="" aria-hidden="true" className="session-agent-icon-img" src={asset.src} />
      </span>
    );
  }

  return (
    <span aria-label={accessibleLabel} className={classes}>
      <span
        aria-hidden="true"
        className="session-agent-icon-mask"
        style={{ "--agent-icon-url": `url("${asset.src}")` } as CSSProperties}
      />
    </span>
  );
}
