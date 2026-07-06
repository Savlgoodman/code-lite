import type { ChatMessage, PlanEntry, PlanSnapshot } from "../../types";

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

function findPlanEntryIndex(currentEntries: PlanEntry[], nextEntry: PlanEntry) {
  if (!nextEntry.id) {
    return -1;
  }
  return currentEntries.findIndex((entry) => entry.id === nextEntry.id);
}

function mergePlanEntries(currentEntries: PlanEntry[], nextEntries: PlanEntry[]) {
  const merged = currentEntries.map((entry) => ({ ...entry }));
  for (const entry of nextEntries) {
    const existingIndex = findPlanEntryIndex(merged, entry);
    if (existingIndex < 0) {
      merged.push({ ...entry });
      continue;
    }
    merged[existingIndex] = {
      ...merged[existingIndex],
      ...entry,
      id: merged[existingIndex].id,
    };
  }
  return merged;
}

function hasMatchingPlanEntry(currentEntries: PlanEntry[], nextEntries: PlanEntry[]) {
  return nextEntries.some((entry) => findPlanEntryIndex(currentEntries, entry) >= 0);
}

function isPartialPlanUpdate(currentEntries: PlanEntry[], nextEntries: PlanEntry[], next: PlanSnapshot) {
  return currentEntries.length > 1
    && nextEntries.length > 0
    && nextEntries.length < currentEntries.length
    && next.source === "acp.plan"
    && hasMatchingPlanEntry(currentEntries, nextEntries);
}

export function mergePlanSnapshot(
  current: PlanSnapshot | undefined | null,
  next: PlanSnapshot | undefined | null,
): PlanSnapshot | undefined {
  if (!hasVisiblePlan(next)) {
    return current ?? undefined;
  }
  const nextPlan = next;
  if (!current || !hasVisiblePlan(current)) {
    return nextPlan;
  }

  const currentEntries = current.entries ?? [];
  const nextEntries = nextPlan.entries ?? [];
  if (isPartialPlanUpdate(currentEntries, nextEntries, nextPlan)) {
    return {
      ...current,
      ...nextPlan,
      entries: mergePlanEntries(currentEntries, nextEntries),
      markdown: nextPlan.markdown ?? current.markdown,
      title: nextPlan.title ?? current.title,
      uri: nextPlan.uri ?? current.uri,
    };
  }
  return nextPlan;
}

export function latestMergedPlanFromMessages(items: ChatMessage[] | undefined, excludeMessageId?: string) {
  let current: PlanSnapshot | undefined;
  for (const message of items ?? []) {
    if (message.id === excludeMessageId) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    current = mergePlanSnapshot(current, message.plan);
  }
  return hasVisiblePlan(current) ? current : null;
}
