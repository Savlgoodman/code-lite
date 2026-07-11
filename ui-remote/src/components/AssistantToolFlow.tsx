import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Circle, FileCode2 } from "lucide-react";
import type { ToolCallItem } from "@code-lite/protocol";
import {
  buildAssistantInlineEntries,
  fileDiffSummariesFromTool,
  mergeDiffStats,
  type FileDiffViewSummary,
} from "@code-lite/chat-render";
import { MessageRenderer } from "./MessageRenderer";
import { formatRisk } from "../lib/formatters";

export interface ToolDetailTarget {
  tool: ToolCallItem;
}

export interface DiffDetailTarget {
  diff: FileDiffViewSummary;
  conversationId: string;
}

interface AssistantToolFlowProps {
  content: string;
  toolCalls: ToolCallItem[];
  streaming?: boolean;
  conversationId: string;
  onOpenTool: (target: ToolDetailTarget) => void;
  onOpenDiff: (target: DiffDetailTarget) => void;
}

function ToolStatusIcon({ status }: { status: ToolCallItem["status"] }) {
  if (status === "complete") return <CheckCircle2 size={14} />;
  if (status === "error") return <AlertTriangle size={14} />;
  return <Circle size={14} className={status === "running" ? "tool-spin" : ""} />;
}

/** 移动版工具组：折叠只显示「已调用 N 个工具」，展开每个工具一行，点击跳详情页。 */
function ToolCallGroup({
  tools,
  collapseWhenFollowedByText,
  onOpenTool,
}: {
  tools: ToolCallItem[];
  collapseWhenFollowedByText: boolean;
  onOpenTool: (target: ToolDetailTarget) => void;
}) {
  const hasActiveTools = tools.some(
    (tool) => tool.status === "running" || tool.status === "approval" || tool.status === "error",
  );
  const [open, setOpen] = useState(hasActiveTools && !collapseWhenFollowedByText);

  return (
    <div className={`m-tool-group ${open ? "open" : ""}`}>
      <button className="m-tool-group-head" onClick={() => setOpen((v) => !v)} type="button">
        <ChevronRight className="m-tool-group-caret" size={15} />
        <span>已调用 {tools.length} 个工具</span>
      </button>
      {open && (
        <div className="m-tool-group-list">
          {tools.map((tool) => (
            <button
              className={`m-tool-row ${tool.status}`}
              key={tool.id}
              onClick={() => onOpenTool({ tool })}
              type="button"
            >
              <span className="m-tool-row-icon">
                <ToolStatusIcon status={tool.status} />
              </span>
              <span className="m-tool-row-name" title={tool.name}>
                {tool.name}
              </span>
              <span className="m-tool-row-risk">{formatRisk(tool.risk)}</span>
              <ChevronRight className="m-tool-row-arrow" size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 移动版文件编辑组：折叠显示「已完成 N 个文件」，展开每个文件一行，点击跳 diff 详情页。 */
function FileEditGroup({
  tools,
  conversationId,
  onOpenDiff,
}: {
  tools: ToolCallItem[];
  conversationId: string;
  onOpenDiff: (target: DiffDetailTarget) => void;
}) {
  const diffs = tools.flatMap(fileDiffSummariesFromTool);
  const [open, setOpen] = useState(true);
  if (diffs.length === 0) return null;

  const fileCount = new Set(diffs.map((diff) => diff.path)).size;
  const stats = mergeDiffStats(diffs);

  return (
    <div className={`m-file-group ${open ? "open" : ""}`}>
      <button className="m-file-group-head" onClick={() => setOpen((v) => !v)} type="button">
        <ChevronRight className="m-tool-group-caret" size={15} />
        <span className="m-file-group-icon">
          <FileCode2 size={14} />
        </span>
        <span className="m-file-group-title">已完成 {fileCount} 个文件的编辑</span>
        <span className="m-diff-stats">
          <span className="m-diff-add">+{stats.added}</span>
          <span className="m-diff-remove">-{stats.removed}</span>
        </span>
      </button>
      {open && (
        <div className="m-file-group-list">
          {diffs.map((diff, index) => (
            <button
              className="m-file-row"
              key={`${diff.diffId}-${index}`}
              onClick={() => onOpenDiff({ diff, conversationId })}
              type="button"
            >
              <span className="m-file-row-icon">
                <FileCode2 size={14} />
              </span>
              <span className="m-file-row-path" title={diff.path}>
                {diff.path}
              </span>
              <span className="m-diff-stats">
                <span className="m-diff-add">+{diff.added}</span>
                <span className="m-diff-remove">-{diff.removed}</span>
              </span>
              <ChevronRight className="m-tool-row-arrow" size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** assistant 消息正文 + 内联工具组/文件编辑组（按 anchorOffset 分段，两端共享分组逻辑）。 */
export function AssistantToolFlow({
  content,
  toolCalls,
  streaming,
  conversationId,
  onOpenTool,
  onOpenDiff,
}: AssistantToolFlowProps) {
  const entries = buildAssistantInlineEntries(content, toolCalls);

  if (entries.length === 0) {
    return <MessageRenderer content={content} streaming={streaming} />;
  }

  const lastTextEntryIndex = entries.reduce(
    (lastIndex, entry, index) => (entry.content.trim() ? index : lastIndex),
    -1,
  );

  return (
    <div className="m-assistant-flow">
      {entries.map((entry, index) => (
        <div className="m-assistant-flow-block" key={entry.key}>
          {entry.content.trim() ? (
            <MessageRenderer
              content={entry.content}
              streaming={streaming && index === lastTextEntryIndex}
            />
          ) : null}
          {entry.fileEditGroups.map((tools, gi) => (
            <FileEditGroup
              key={`file-${gi}`}
              tools={tools}
              conversationId={conversationId}
              onOpenDiff={onOpenDiff}
            />
          ))}
          {entry.toolGroups.map((tools, gi) => (
            <ToolCallGroup
              key={`tools-${gi}`}
              tools={tools}
              collapseWhenFollowedByText={entries.slice(index + 1).some((e) => e.content.trim())}
              onOpenTool={onOpenTool}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
