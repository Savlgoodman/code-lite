import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import type { PlanEntry, PlanSnapshot } from "../../types";
import "./PlanProgressPanel.css";

interface PlanProgressPanelProps {
  plan: PlanSnapshot | null;
}

function normalizeEntries(plan: PlanSnapshot): PlanEntry[] {
  if (plan.entries?.length) {
    return plan.entries.filter((entry) => entry.content?.trim());
  }
  return markdownEntries(plan.markdown ?? "");
}

function markdownEntries(markdown: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    const checkbox = text.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const numbered = text.match(/^(?:\d+|[一二三四五六七八九十]+)[.、]\s+(.+)$/);
    const stepHeading = text.match(/^#{2,6}\s+(?:步骤|Step|Task)\s*[\w一二三四五六七八九十]*[：:.\-\s]*(.+)$/i);
    let content = "";
    let status: PlanEntry["status"] = "pending";
    if (checkbox) {
      status = checkbox[1].toLowerCase() === "x" ? "completed" : "pending";
      content = checkbox[2];
    } else if (numbered) {
      content = numbered[1];
    } else if (stepHeading) {
      content = stepHeading[1];
    }
    content = cleanPlanText(content);
    if (content) {
      entries.push({
        id: `markdown-plan-${entries.length}`,
        content,
        priority: "medium",
        status,
      });
    }
  }
  return entries;
}

function cleanPlanText(value: string) {
  return value
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .trim();
}

function planSummary(entries: PlanEntry[]) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  if (entries.length === 0) {
    return "";
  }
  return `${completed}/${entries.length}`;
}

function collapsedEntry(entries: PlanEntry[]) {
  return entries.find((entry) => entry.status === "in_progress")
    ?? entries.find((entry) => entry.status !== "completed")
    ?? entries[0];
}

export function PlanProgressPanel({ plan }: PlanProgressPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => (plan ? normalizeEntries(plan) : []), [plan]);

  if (!plan || entries.length === 0) {
    return null;
  }

  const primaryEntry = collapsedEntry(entries);
  const visibleEntries = expanded ? entries : primaryEntry ? [primaryEntry] : [];

  function toggleExpanded() {
    setExpanded((open) => !open);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpanded();
    }
  }

  return (
    <section
      aria-expanded={expanded}
      aria-label="计划进度"
      className={`plan-progress-panel ${expanded ? "expanded" : "collapsed"}`}
      onClick={toggleExpanded}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div
        className="plan-progress-header"
      >
        <span>进度</span>
        <span className="plan-progress-count">{planSummary(entries)}</span>
        <ChevronDown className="plan-progress-chevron" size={15} strokeWidth={2} />
      </div>
      <ol className="plan-progress-list">
        {visibleEntries.map((entry, index) => (
          <li className={`plan-progress-item ${entry.status}`} key={entry.id ?? `${entry.content}-${index}`}>
            <span className="plan-progress-marker" aria-hidden="true">
              {entry.status === "completed" ? <Check size={11} strokeWidth={2.8} /> : null}
            </span>
            <span className="plan-progress-text">{entry.content}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
