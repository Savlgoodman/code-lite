import { AlertTriangle, CheckCircle2, Circle, FileCode2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ToolCallItem } from "../../types";
import { formatRisk } from "../../lib/formatters";
import "./ToolCallViews.css";

export interface FileDiffContent {
  newText: string;
  oldText?: string | null;
  path: string;
  type: "diff";
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

interface DiffStats {
  added: number;
  removed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function diffContentFromTool(tool: ToolCallItem): FileDiffContent[] {
  const rawUpdate = isRecord(tool.metadata) ? tool.metadata.rawUpdate : null;
  const content = isRecord(rawUpdate) ? rawUpdate.content : null;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isFileDiffContent);
}

function fileChangeLabel(diff: FileDiffContent) {
  if (diff.oldText == null) {
    return "创建";
  }
  if (!diff.newText) {
    return "清空";
  }
  return "修改";
}

function splitVisibleLines(value: string) {
  return value.split(/\r?\n/).filter((line, index, list) => line || index < list.length - 1);
}

function buildPreviewLines(diff: FileDiffContent): DiffLine[] {
  const oldLines = splitVisibleLines(diff.oldText ?? "");
  const newLines = splitVisibleLines(diff.newText);
  if (diff.oldText == null) {
    return newLines.slice(0, 12).map((text) => ({ kind: "add", text }));
  }

  const preview: DiffLine[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maxLines && preview.length < 14; index += 1) {
    const oldText = oldLines[index];
    const newText = newLines[index];
    if (oldText === newText && oldText != null) {
      preview.push({ kind: "context", text: oldText });
      continue;
    }
    if (oldText != null) {
      preview.push({ kind: "remove", text: oldText });
    }
    if (newText != null && preview.length < 14) {
      preview.push({ kind: "add", text: newText });
    }
  }
  return preview;
}

function diffStats(diff: FileDiffContent): DiffStats {
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

function mergeDiffStats(diffs: FileDiffContent[]): DiffStats {
  return diffs.reduce(
    (total, diff) => {
      const current = diffStats(diff);
      return {
        added: total.added + current.added,
        removed: total.removed + current.removed,
      };
    },
    { added: 0, removed: 0 },
  );
}

function DiffStatsLabel({ label, stats }: { label: string; stats: DiffStats }) {
  return (
    <span className="diff-stats" aria-label={`新增 ${stats.added} 行，删除 ${stats.removed} 行`}>
      <span className="diff-stats-label">{label}</span>
      <span className="diff-stats-add">+{stats.added} 行</span>
      <span className="diff-stats-remove">-{stats.removed} 行</span>
    </span>
  );
}

function toolResultSummary(tool: ToolCallItem) {
  const value = tool.error ?? tool.resultText ?? "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return tool.status === "approval" ? "等待确认" : "运行中";
  }
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function FileDiffPreview({ diff }: { diff: FileDiffContent }) {
  const previewLines = buildPreviewLines(diff);
  const stats = diffStats(diff);
  const [open, setOpen] = useState(true);

  return (
    <details
      className="tool-file-diff"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="tool-file-diff-head">
        <span className="tool-file-diff-icon"><FileCode2 size={14} /></span>
        <strong title={diff.path}>{diff.path}</strong>
        <em>{fileChangeLabel(diff)}</em>
        <DiffStatsLabel label="本次修改" stats={stats} />
      </summary>
      <pre className="tool-file-diff-preview">
        {previewLines.map((line, index) => (
          <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}-${line.text}`}>
            {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
            {line.text || " "}
          </span>
        ))}
      </pre>
    </details>
  );
}

export function ToolCallCard({ tool }: { tool: ToolCallItem }) {
  const defaultOpen = tool.status !== "complete";

  return (
    <details className={`tool-call-card ${tool.status}`} open={defaultOpen}>
      <summary className="tool-call-head">
        <span className="tool-call-icon">
          {tool.status === "complete" ? (
            <CheckCircle2 size={14} />
          ) : tool.status === "error" ? (
            <AlertTriangle size={14} />
          ) : (
            <Circle size={14} className={tool.status === "running" ? "spin-dot" : ""} />
          )}
        </span>
        <strong>{tool.name}</strong>
        <span>{formatRisk(tool.risk)}</span>
        {tool.status === "complete" ? <em>{toolResultSummary(tool)}</em> : null}
      </summary>
      <div className="tool-call-detail">
        <span>入参</span>
        <pre>{tool.argumentsText}</pre>
        {tool.resultText || tool.error ? (
          <>
            <span>{tool.error ? "错误" : "输出"}</span>
            <pre>{tool.error ?? tool.resultText}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

export function FileEditGroup({ tools }: { tools: ToolCallItem[] }) {
  const diffs = tools.flatMap(diffContentFromTool);
  const [open, setOpen] = useState(true);

  if (diffs.length === 0) {
    return null;
  }

  const fileCount = new Set(diffs.map((diff) => diff.path)).size;
  const stats = mergeDiffStats(diffs);

  return (
    <details
      className="file-edit-group"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="file-edit-group-head">
        <span className="tool-file-diff-icon"><FileCode2 size={14} /></span>
        <strong>已完成 {fileCount} 个文件的编辑与创建</strong>
        <DiffStatsLabel label="本次修改总计" stats={stats} />
      </summary>
      <div className="tool-file-diff-list">
        {diffs.map((diff, index) => (
          <FileDiffPreview diff={diff} key={`${diff.path}-${index}`} />
        ))}
      </div>
    </details>
  );
}

export function ToolCallGroup({
  collapseWhenFollowedByText,
  tools
}: {
  collapseWhenFollowedByText?: boolean;
  tools: ToolCallItem[];
}) {
  const hasActiveTools = tools.some((tool) => tool.status === "running" || tool.status === "approval" || tool.status === "error");
  const shouldAutoOpen = tools.length === 1 && tools[0]?.status !== "complete";
  const [open, setOpen] = useState(hasActiveTools || shouldAutoOpen);
  const isAutoControlledRef = useRef(true);

  useEffect(() => {
    if (!isAutoControlledRef.current) {
      return;
    }
    if (collapseWhenFollowedByText) {
      setOpen(false);
      return;
    }
    setOpen(hasActiveTools || shouldAutoOpen);
  }, [collapseWhenFollowedByText, hasActiveTools, shouldAutoOpen]);

  return (
    <details
      className="tool-call-group"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="tool-call-group-head" onClick={() => {
        isAutoControlledRef.current = false;
      }}>
        已调用 {tools.length} 个工具
      </summary>
      <div className="tool-call-list">
        {tools.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}
      </div>
    </details>
  );
}
