import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { FileDiffArtifact } from "@code-lite/protocol";
import {
  buildDiffLines,
  fileChangeLabel,
  type FileDiffContent,
  type FileDiffViewSummary,
} from "@code-lite/chat-render";
import { connectionManager } from "../services/ConnectionManager";

interface DiffDetailPageProps {
  diff: FileDiffViewSummary;
  conversationId: string;
  onBack: () => void;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

function artifactToContent(artifact: FileDiffArtifact): FileDiffContent {
  return {
    newText: artifact.newText,
    oldText: artifact.oldText,
    path: artifact.path,
    type: "diff",
  };
}

/** 文件 diff 详情页：懒加载完整 diff（diff.get RPC）并渲染行级 diff。 */
export function DiffDetailPage({ diff, conversationId, onBack }: DiffDetailPageProps) {
  const [content, setContent] = useState<FileDiffContent | null>(diff.legacyContent ?? null);
  const [state, setState] = useState<LoadState>(diff.legacyContent ? "loaded" : "idle");

  useEffect(() => {
    if (diff.legacyContent) return;
    const client = connectionManager.getClient();
    if (!client) {
      setState("error");
      return;
    }
    let cancelled = false;
    setState("loading");
    client
      .request<{ diff: FileDiffArtifact }>("diff.get", { conversationId, diffId: diff.diffId })
      .then((result) => {
        if (cancelled) return;
        setContent(artifactToContent(result.diff));
        setState("loaded");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
    // 仅按会话/diff 标识触发；state 不入依赖，否则内部 setState("loading")
    // 会重跑本 effect，其 cleanup 置 cancelled=true 丢弃刚到的响应。
  }, [conversationId, diff.diffId, diff.legacyContent]);

  const lines = content ? buildDiffLines(content) : [];
  const fileName = diff.path.split(/[\\/]/).pop() || diff.path;

  return (
    <div className="detail-page">
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title" title={diff.path}>
          {fileName}
        </h1>
        <div className="header-spacer" />
      </header>

      <div className="detail-body">
        <div className="detail-meta-row">
          <span className="detail-chip">{fileChangeLabel(diff.changeType)}</span>
          <span className="detail-chip">
            <span className="m-diff-add">+{diff.added}</span>{" "}
            <span className="m-diff-remove">-{diff.removed}</span>
          </span>
        </div>
        <div className="detail-path" title={diff.path}>
          {diff.path}
        </div>

        {state === "loading" ? (
          <div className="detail-state">正在加载 diff...</div>
        ) : state === "error" ? (
          <div className="detail-state error">diff 加载失败</div>
        ) : (
          <pre className="detail-diff">
            {lines.map((line, index) => (
              <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}`}>
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                {line.text || " "}
              </span>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
