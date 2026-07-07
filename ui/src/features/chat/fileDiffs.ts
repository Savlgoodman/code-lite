import type { FileDiffSummary, ToolCallItem } from "../../types";

export interface FileDiffContent {
  newText: string;
  oldText?: string | null;
  path: string;
  type: "diff";
}

export interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export type FileDiffViewSummary = FileDiffSummary & {
  legacyContent?: FileDiffContent;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileDiffContent(value: unknown): value is FileDiffContent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === "diff"
    && typeof value.path === "string"
    && typeof value.newText === "string"
    && (value.oldText == null || typeof value.oldText === "string")
  );
}

function isFileDiffSummary(value: unknown): value is FileDiffSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.diffId === "string"
    && typeof value.path === "string"
    && typeof value.added === "number"
    && typeof value.removed === "number"
  );
}

export function splitVisibleLines(value: string) {
  return value.split(/\r?\n/).filter((line, index, list) => line || index < list.length - 1);
}

export function diffStatsFromContent(diff: FileDiffContent): DiffStats {
  const oldLines = splitVisibleLines(diff.oldText ?? "");
  const newLines = splitVisibleLines(diff.newText);
  if (diff.oldText == null) {
    return { added: newLines.length, removed: 0 };
  }

  let added = 0;
  let removed = 0;
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const oldText = oldLines[index];
    const newText = newLines[index];
    if (oldText === newText) {
      continue;
    }
    if (oldText != null) {
      removed += 1;
    }
    if (newText != null) {
      added += 1;
    }
  }
  return { added, removed };
}

export function buildDiffLines(diff: FileDiffContent): DiffLine[] {
  const oldLines = splitVisibleLines(diff.oldText ?? "");
  const newLines = splitVisibleLines(diff.newText);
  if (diff.oldText == null) {
    return newLines.map((text) => ({ kind: "add", text }));
  }

  const lines: DiffLine[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const oldText = oldLines[index];
    const newText = newLines[index];
    if (oldText === newText && oldText != null) {
      lines.push({ kind: "context", text: oldText });
      continue;
    }
    if (oldText != null) {
      lines.push({ kind: "remove", text: oldText });
    }
    if (newText != null) {
      lines.push({ kind: "add", text: newText });
    }
  }
  return lines;
}

export function fileChangeLabel(changeType?: string) {
  switch (changeType) {
    case "create":
      return "创建";
    case "delete":
      return "删除";
    case "clear":
      return "清空";
    default:
      return "修改";
  }
}

export function fileDiffSummariesFromTool(tool: ToolCallItem): FileDiffViewSummary[] {
  const metadata = isRecord(tool.metadata) ? tool.metadata : null;
  const fileDiffs = metadata?.fileDiffs;
  if (Array.isArray(fileDiffs)) {
    return fileDiffs.filter(isFileDiffSummary).map((item) => ({
      ...item,
      toolCallId: item.toolCallId ?? tool.id,
    }));
  }

  const rawUpdate = metadata?.rawUpdate;
  const content = isRecord(rawUpdate) ? rawUpdate.content : null;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(isFileDiffContent).map((diff, index) => {
    const stats = diffStatsFromContent(diff);
    return {
      added: stats.added,
      artifactPath: undefined,
      changeType: diff.oldText == null ? "create" : diff.newText ? "modify" : "clear",
      diffId: `${tool.id}-${index}-legacy`,
      legacyContent: diff,
      path: diff.path,
      removed: stats.removed,
      toolCallId: tool.id,
    };
  });
}

export function mergeDiffStats(diffs: FileDiffViewSummary[]): DiffStats {
  return diffs.reduce(
    (total, diff) => ({
      added: total.added + diff.added,
      removed: total.removed + diff.removed,
    }),
    { added: 0, removed: 0 },
  );
}
