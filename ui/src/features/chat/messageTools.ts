import type { ToolCallItem } from "../../types";
import { fileDiffSummariesFromTool } from "./fileDiffs";

export interface AssistantInlineEntry {
  content: string;
  fileEditGroups: ToolCallItem[][];
  key: string;
  toolGroups: ToolCallItem[][];
}

interface TextRange {
  end: number;
  start: number;
}

function getLineRanges(content: string) {
  const lines: Array<TextRange & { text: string }> = [];
  let start = 0;

  while (start < content.length) {
    const nextLineBreak = content.indexOf("\n", start);
    const end = nextLineBreak >= 0 ? nextLineBreak + 1 : content.length;
    lines.push({
      end,
      start,
      text: content.slice(start, end)
    });
    start = end;
  }

  return lines;
}

function isMarkdownTableDivider(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }

  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return Boolean(trimmed) && trimmed.includes("|") && !trimmed.startsWith("```");
}

function findMarkdownTableRanges(content: string): TextRange[] {
  const lines = getLineRanges(content);
  const ranges: TextRange[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    if (!isMarkdownTableDivider(lines[index].text) || !isMarkdownTableRow(lines[index - 1].text)) {
      continue;
    }

    let startIndex = index - 1;
    let endIndex = index + 1;

    while (startIndex > 0 && isMarkdownTableRow(lines[startIndex - 1].text)) {
      startIndex -= 1;
    }

    while (endIndex < lines.length && isMarkdownTableRow(lines[endIndex].text)) {
      endIndex += 1;
    }

    ranges.push({
      end: lines[endIndex - 1].end,
      start: lines[startIndex].start
    });
  }

  return ranges;
}

function moveOffsetAfterMarkdownTable(offset: number, tableRanges: TextRange[]) {
  for (const range of tableRanges) {
    if (offset > range.start && offset < range.end) {
      return range.end;
    }
  }

  return offset;
}

function hasFileDiffContent(tool: ToolCallItem) {
  return fileDiffSummariesFromTool(tool).length > 0;
}

export function buildAssistantInlineEntries(content: string, toolCalls: ToolCallItem[]) {
  const entries: AssistantInlineEntry[] = [];
  const contentLength = content.length;
  const tableRanges = findMarkdownTableRanges(content);
  const toolsByOffset = new Map<number, ToolCallItem[]>();

  for (const tool of toolCalls) {
    const rawOffset = typeof tool.anchorOffset === "number" ? tool.anchorOffset : contentLength;
    const boundedOffset = Math.max(0, Math.min(rawOffset, contentLength));
    const offset = moveOffsetAfterMarkdownTable(boundedOffset, tableRanges);
    toolsByOffset.set(offset, [...(toolsByOffset.get(offset) ?? []), tool]);
  }

  let cursor = 0;
  const offsets = [...toolsByOffset.keys()].sort((a, b) => a - b);

  for (const offset of offsets) {
    const text = content.slice(cursor, offset);
    if (text.trim()) {
      entries.push({
        content: text,
        fileEditGroups: [],
        key: `text-${cursor}`,
        toolGroups: []
      });
    }

    const tools = toolsByOffset.get(offset) ?? [];
    const fileEditTools = tools.filter(hasFileDiffContent);
    const regularTools = tools.filter((tool) => !hasFileDiffContent(tool));

    entries.push({
      content: "",
      fileEditGroups: fileEditTools.length > 0 ? [fileEditTools] : [],
      key: `tools-${offset}`,
      toolGroups: regularTools.length > 0 ? [regularTools] : []
    });
    cursor = offset;
  }

  const tail = content.slice(cursor);
  if (tail.trim()) {
    entries.push({
      content: tail,
      fileEditGroups: [],
      key: `text-${cursor}`,
      toolGroups: []
    });
  }

  return entries;
}
