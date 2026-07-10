import {
  Ban,
  FastForward,
  FileText,
  Hand,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AgentSummary } from "@code-lite/protocol";

type RuntimeTone = "claude" | "codex" | "default";

/** 依据 agent 运行时判断配色体系（claude / codex）。 */
function agentRuntimeTone(agent?: AgentSummary | null): RuntimeTone {
  const value = `${agent?.runtimeId ?? ""} ${agent?.id ?? ""} ${agent?.label ?? ""}`.toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex") || value.includes("openai")) return "codex";
  return "default";
}

/** 把 accessMode 的 id/label 归一为稳定的语义键，供图标与配色映射使用。 */
function normalizeAccessMode(id: string, label: string): string {
  const text = `${id} ${label}`.toLowerCase();
  const compact = text.replace(/[\s_-]+/g, "");
  if (id === "agent-full-access" || compact.includes("agentfullaccess") || compact.includes("fullaccess")) {
    return "full-access";
  }
  if (id === "agent") return "agent";
  if (id === "read-only" || compact.includes("readonly")) return "read-only";
  if (compact.includes("bypasspermissions") || text.includes("bypass permission")) return "bypass-permissions";
  if (compact.includes("acceptedits") || text.includes("accept edit")) return "accept-edits";
  if (compact === "plan" || compact.includes("planmode") || text.includes("plan mode")) return "plan";
  if (compact.includes("dontask") || compact.includes("donotask") || text.includes("don't ask")) return "dont-ask";
  if (compact === "auto" || compact.includes("automode")) return "auto";
  if (compact === "default") return "default";
  return id || "default";
}

/** accessMode → tone 类名后缀（与桌面端 access-mode-tone-* 配色一致）。 */
function accessModeTone(runtime: RuntimeTone, normalized: string): string {
  if (runtime === "claude") {
    if (normalized === "accept-edits") return "claude-accept-edits";
    if (normalized === "bypass-permissions") return "claude-bypass-permissions";
    if (normalized === "plan") return "claude-plan";
    if (normalized === "dont-ask") return "claude-dont-ask";
    if (normalized === "auto") return "claude-auto";
    return "default";
  }
  if (runtime === "codex" && normalized === "full-access") return "codex-full-access";
  return "default";
}

function accessModeIcon(runtime: RuntimeTone, normalized: string, size = 13) {
  if (runtime === "claude") {
    if (normalized === "accept-edits") return <FastForward size={size} />;
    if (normalized === "bypass-permissions") return <ShieldAlert size={size} />;
    if (normalized === "plan") return <FileText size={size} />;
    if (normalized === "dont-ask") return <Ban size={size} />;
    if (normalized === "auto") return <Sparkles size={size} />;
    return <Hand size={size} />;
  }
  if (normalized === "full-access") return <ShieldAlert size={size} />;
  if (normalized === "agent") return <ShieldCheck size={size} />;
  return <Hand size={size} />;
}

/** 思考深度配色档位：xhigh 橙 / max 红 / ultra 紫（流光）。 */
function effortTone(effort: string): string {
  const e = effort.toLowerCase();
  if (e === "xhigh") return "xhigh";
  if (e === "max") return "max";
  if (e === "ultra") return "ultra";
  return "default";
}

interface ConfigBarProps {
  agent?: AgentSummary | null;
  accessModeId: string;
  accessModeLabel: string;
  modelLabel: string;
  effort: string;
  effortLabel: string;
}

export function ConfigBar({
  agent,
  accessModeId,
  accessModeLabel,
  modelLabel,
  effort,
  effortLabel,
}: ConfigBarProps) {
  const runtime = agentRuntimeTone(agent);
  const normalized = normalizeAccessMode(accessModeId, accessModeLabel);
  const accessTone = accessModeTone(runtime, normalized);
  const eTone = effortTone(effort);

  return (
    <div className="chat-config-bar">
      <span className={`config-chip access-mode-tone-${accessTone}`}>
        {accessModeIcon(runtime, normalized)}
        <span>{accessModeLabel}</span>
      </span>
      <span className="config-bar-sep">·</span>
      <span className="config-chip config-model">{modelLabel}</span>
      <span className="config-bar-sep">·</span>
      <span className={`config-chip effort-tone-${eTone}`} data-text={effortLabel}>
        {effortLabel}
      </span>
    </div>
  );
}
