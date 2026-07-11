import type { CSSProperties } from "react";

import type { AgentSummary } from "../types";

import "./AgentIcon.css";

const agentIconSources = {
  claude_code: {
    kind: "mask",
    src: new URL("../assets/agents/claude.svg", import.meta.url).href
  },
  codex: {
    kind: "mask",
    src: new URL("../assets/agents/openai.svg", import.meta.url).href
  },
  nanobot: {
    kind: "image",
    src: new URL("../assets/agents/nanobot_favicon_32.png", import.meta.url).href
  },
  opencode: {
    kind: "mask",
    src: new URL("../assets/agents/opencode.svg", import.meta.url).href
  }
} as const;

type KnownAgentId = keyof typeof agentIconSources;

interface AgentIconProps {
  agent?: AgentSummary | null;
  className?: string;
  label?: string;
  runtimeId?: string | null;
  size?: "sm" | "md" | "lg";
}

function normalizeAgentId(value: string | null | undefined): KnownAgentId | null {
  if (!value) {
    return null;
  }

  if (value in agentIconSources) {
    return value as KnownAgentId;
  }

  const lowered = value.toLowerCase();
  if (lowered.includes("claude")) {
    return "claude_code";
  }
  if (lowered.includes("codex") || lowered.includes("openai") || lowered.includes("chatgpt")) {
    return "codex";
  }
  if (lowered.includes("opencode")) {
    return "opencode";
  }
  if (lowered.includes("nanobot")) {
    return "nanobot";
  }
  return null;
}

export function resolveAgentIconId(agent?: AgentSummary | null, runtimeId?: string | null): KnownAgentId | null {
  return normalizeAgentId(runtimeId)
    ?? normalizeAgentId(agent?.runtimeId)
    ?? normalizeAgentId(agent?.id)
    ?? normalizeAgentId(agent?.label);
}

export function agentInitials(value: string | null | undefined) {
  const label = value?.trim();
  if (!label) {
    return "Ag";
  }

  const parts = label.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return label.slice(0, 2).toUpperCase();
}

export function AgentIcon({
  agent,
  className = "",
  label,
  runtimeId,
  size = "md"
}: AgentIconProps) {
  const iconId = resolveAgentIconId(agent, runtimeId);
  const accessibleLabel = label ?? agent?.label ?? runtimeId ?? "Agent";
  const classes = ["agent-icon", `agent-icon-${size}`, iconId ? `agent-icon-${iconId}` : "", className]
    .filter(Boolean)
    .join(" ");

  if (!iconId) {
    return (
      <span aria-label={accessibleLabel} className={classes} role="img">
        {agentInitials(accessibleLabel)}
      </span>
    );
  }

  const iconAsset = agentIconSources[iconId];
  if (iconAsset.kind === "image") {
    return (
      <span aria-label={accessibleLabel} className={classes} role="img">
        <img alt="" aria-hidden="true" className="agent-icon-image" src={iconAsset.src} />
      </span>
    );
  }

  return (
    <span aria-label={accessibleLabel} className={classes} role="img">
      <span
        aria-hidden="true"
        className="agent-icon-mask"
        style={{ "--agent-icon-url": `url("${iconAsset.src}")` } as CSSProperties}
      />
    </span>
  );
}
