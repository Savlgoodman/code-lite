import { AlertTriangle, CheckCircle2, Circle, FileCode2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { FileDiffArtifact, ToolCallItem } from "../../types";
import { formatRisk } from "../../lib/formatters";
import { loadConversationDiff } from "../../services/conversationStore";
import {
  buildDiffLines,
  fileChangeLabel,
  fileDiffSummariesFromTool,
  mergeDiffStats,
  type FileDiffContent,
  type FileDiffViewSummary,
} from "./fileDiffs";
import "./ToolCallViews.css";

interface DiffStats {
  added: number;
  removed: number;
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

function artifactToContent(artifact: FileDiffArtifact): FileDiffContent {
  return {
    newText: artifact.newText,
    oldText: artifact.oldText,
    path: artifact.path,
    type: "diff",
  };
}

function FileDiffPreview({
  conversationId,
  diff,
}: {
  conversationId: string;
  diff: FileDiffViewSummary;
}) {
  const [open, setOpen] = useState(false);
  const [loadedDiff, setLoadedDiff] = useState<FileDiffContent | null>(diff.legacyContent ?? null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">(diff.legacyContent ? "loaded" : "idle");
  const lines = loadedDiff ? buildDiffLines(loadedDiff) : [];
  const stats = { added: diff.added, removed: diff.removed };

  useEffect(() => {
    if (!open || loadedDiff || loadState !== "idle" || diff.legacyContent) {
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    loadConversationDiff(conversationId, diff.diffId)
      .then((artifact) => {
        if (!cancelled) {
          setLoadedDiff(artifactToContent(artifact));
          setLoadState("loaded");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, diff.diffId, diff.legacyContent, loadedDiff, open]);

  return (
    <details
      className="tool-file-diff"
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen && loadState === "error") {
          setLoadState("idle");
        }
      }}
    >
      <summary className="tool-file-diff-head">
        <span className="tool-file-diff-icon"><FileCode2 size={14} /></span>
        <strong title={diff.path}>{diff.path}</strong>
        <em>{fileChangeLabel(diff.changeType)}</em>
        <DiffStatsLabel label="本次修改" stats={stats} />
      </summary>
      {open ? (
        loadState === "loading" ? (
          <div className="tool-file-diff-state">正在加载 diff</div>
        ) : loadState === "error" ? (
          <div className="tool-file-diff-state error">diff 加载失败，请收起后重试</div>
        ) : (
          <pre className="tool-file-diff-preview">
            {lines.map((line, index) => (
              <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}-${line.text}`}>
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                {line.text || " "}
              </span>
            ))}
          </pre>
        )
      ) : null}
    </details>
  );
}

/** 折叠高度阈值（px）：超过则默认截断，显示展开按钮。约 4 行代码高。 */
const COLLAPSED_PRE_MAX_HEIGHT = 92;

/**
 * 工具调用入参/输出的代码块：默认按高度截断，超出时点击展开全部。
 * 收起态用 max-height 限高并渐隐底部，避免长命令/长输出撑坏排版；
 * 竖向溢出用 hidden 防止卡片自身变成滚动容器抢走页面滚轮。
 */
function CollapsiblePre({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = preRef.current;
    if (!element) {
      return;
    }
    setOverflowing(element.scrollHeight > COLLAPSED_PRE_MAX_HEIGHT + 4);
  }, [text]);

  const collapsed = overflowing && !expanded;

  return (
    <div className="tool-call-pre-wrap">
      <div className={`tool-call-pre-scroll${collapsed ? " collapsed" : ""}`}>
        <pre
          ref={preRef}
          className="tool-call-pre"
          style={collapsed ? { maxHeight: COLLAPSED_PRE_MAX_HEIGHT } : undefined}
        >
          {text}
        </pre>
      </div>
      {overflowing ? (
        <button
          type="button"
          className="tool-call-pre-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开全部"}
        </button>
      ) : null}
    </div>
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
        <strong className="tool-call-name" title={tool.name}>{tool.name}</strong>
        {tool.status === "complete" ? <em>{toolResultSummary(tool)}</em> : null}
        <span className="tool-call-risk">{formatRisk(tool.risk)}</span>
      </summary>
      <div className="tool-call-detail">
        <span>入参</span>
        <CollapsiblePre text={tool.argumentsText} />
        {tool.resultText || tool.error ? (
          <>
            <span>{tool.error ? "错误" : "输出"}</span>
            <CollapsiblePre text={tool.error ?? tool.resultText ?? ""} />
          </>
        ) : null}
      </div>
    </details>
  );
}

export function FileEditGroup({ conversationId, tools }: { conversationId: string; tools: ToolCallItem[] }) {
  const diffs = tools.flatMap(fileDiffSummariesFromTool);
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
          <FileDiffPreview conversationId={conversationId} diff={diff} key={`${diff.diffId}-${diff.path}-${index}`} />
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
