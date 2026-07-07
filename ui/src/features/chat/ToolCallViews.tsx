import { AlertTriangle, CheckCircle2, Circle, FileCode2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatRisk } from "../../lib/formatters";
import type { ToolCallItem } from "../../types";
import "./ToolCallViews.css";

interface FileDiffContent {
  newText: string;
  oldText?: string | null;
  path: string;
  type: "diff";
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
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

function diffContentFromTool(tool: ToolCallItem): FileDiffContent[] {
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

function summarizeDiff(diff: FileDiffContent) {
  const oldLines = (diff.oldText ?? "").split(/\r?\n/);
  const newLines = diff.newText.split(/\r?\n/);
  const removed = oldLines.length === 1 && oldLines[0] === "" ? 0 : oldLines.length;
  const added = newLines.length === 1 && newLines[0] === "" ? 0 : newLines.length;
  return diff.oldText == null ? `${added} 行` : `${added} 行 / 原 ${removed} 行`;
}

function buildPreviewLines(diff: FileDiffContent): DiffLine[] {
  const oldLines = (diff.oldText ?? "").split(/\r?\n/).filter((line, index, list) => line || index < list.length - 1);
  const newLines = diff.newText.split(/\r?\n/).filter((line, index, list) => line || index < list.length - 1);
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

function toolResultSummary(tool: ToolCallItem) {
  const diffs = diffContentFromTool(tool);
  if (diffs.length > 0) {
    return diffs.length === 1 ? `${fileChangeLabel(diffs[0])} ${diffs[0].path}` : `${diffs.length} 个文件变更`;
  }
  const value = tool.error ?? tool.resultText ?? "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return tool.status === "approval" ? "等待确认" : "运行中";
  }
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function FileDiffPreview({ diff }: { diff: FileDiffContent }) {
  const previewLines = buildPreviewLines(diff);

  return (
    <section className="tool-file-diff">
      <header className="tool-file-diff-head">
        <span className="tool-file-diff-icon"><FileCode2 size={14} /></span>
        <strong title={diff.path}>{diff.path}</strong>
        <em>{fileChangeLabel(diff)}</em>
        <small>{summarizeDiff(diff)}</small>
      </header>
      <pre className="tool-file-diff-preview">
        {previewLines.map((line, index) => (
          <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}-${line.text}`}>
            {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
            {line.text || " "}
          </span>
        ))}
      </pre>
    </section>
  );
}

export function ToolCallCard({ tool }: { tool: ToolCallItem }) {
  const diffs = diffContentFromTool(tool);
  const defaultOpen = tool.status !== "complete" || diffs.length > 0;

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
        {diffs.length > 0 ? (
          <div className="tool-file-diff-list">
            {diffs.map((diff, index) => (
              <FileDiffPreview diff={diff} key={`${diff.path}-${index}`} />
            ))}
          </div>
        ) : null}
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

export function ToolCallGroup({
  collapseWhenFollowedByText,
  tools
}: {
  collapseWhenFollowedByText?: boolean;
  tools: ToolCallItem[];
}) {
  const hasActiveTools = tools.some((tool) => tool.status === "running" || tool.status === "approval" || tool.status === "error");
  const hasFileDiffs = tools.some((tool) => diffContentFromTool(tool).length > 0);
  const shouldAutoOpen = hasFileDiffs || (tools.length === 1 && tools[0]?.status !== "complete");
  const [open, setOpen] = useState(hasActiveTools || shouldAutoOpen);
  const isAutoControlledRef = useRef(true);

  useEffect(() => {
    if (!isAutoControlledRef.current) {
      return;
    }
    if (collapseWhenFollowedByText && !hasFileDiffs) {
      setOpen(false);
      return;
    }
    setOpen(hasActiveTools || shouldAutoOpen);
  }, [collapseWhenFollowedByText, hasActiveTools, hasFileDiffs, shouldAutoOpen]);

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
