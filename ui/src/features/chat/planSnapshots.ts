import type { ChatMessage, PlanSnapshot } from "../../types";

export function hasVisiblePlan(plan: PlanSnapshot | undefined | null): plan is PlanSnapshot {
  return Boolean(
    plan
      && ((plan.entries?.length ?? 0) > 0 || hasMarkdownPlanEntries(plan.markdown))
  );
}

function hasMarkdownPlanEntries(markdown: string | undefined) {
  if (!markdown?.trim()) {
    return false;
  }
  return markdown.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return /^[-*]\s+\[[ xX]\]\s+.+$/.test(text)
      || /^(?:\d+|[一二三四五六七八九十]+)[.、]\s+.+$/.test(text)
      || /^#{2,6}\s+(?:步骤|Step|Task)\s*[\w一二三四五六七八九十]*[：:.\-\s]*.+$/i.test(text);
  });
}

export function mergePlanSnapshot(
  current: PlanSnapshot | undefined | null,
  next: PlanSnapshot | undefined | null,
): PlanSnapshot | undefined | null {
  if (next?.source === "acp.plan") {
    return hasVisiblePlan(next) ? next : null;
  }
  if (!hasVisiblePlan(next)) {
    return current ?? undefined;
  }
  return next;
}

export function latestMergedPlanFromMessages(items: ChatMessage[] | undefined, excludeMessageId?: string) {
  let current: PlanSnapshot | undefined | null;
  for (const message of items ?? []) {
    if (message.id === excludeMessageId) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    if (message.plan === null) {
      current = null;
      continue;
    }
    current = mergePlanSnapshot(current, message.plan);
  }
  return hasVisiblePlan(current) ? current : null;
}
