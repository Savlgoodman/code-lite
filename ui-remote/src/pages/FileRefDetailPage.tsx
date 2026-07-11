import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { FileRef } from "@code-lite/chat-render";
import type { FileReadResult } from "@code-lite/chat-core";
import { connectionManager } from "../services/ConnectionManager";
import { MessageRenderer } from "../components/MessageRenderer";

interface FileRefDetailPageProps {
  fileRef: FileRef;
  conversationId: string;
  onBack: () => void;
}

type LoadState = "loading" | "loaded" | "error";

/** 把文本按代码围栏包裹，交给 MessageRenderer 做语法高亮。 */
function fencedCode(text: string, language?: string) {
  const lang = language ?? "";
  return `\`\`\`\`${lang}\n${text}\n\`\`\`\``;
}

/** 文件引用详情页（移动端）：文本/代码高亮、Markdown 渲染、图片预览。 */
export function FileRefDetailPage({ fileRef, conversationId, onBack }: FileRefDetailPageProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [result, setResult] = useState<FileReadResult | null>(null);

  useEffect(() => {
    const client = connectionManager.getClient();
    if (!client) {
      setState("error");
      return;
    }
    let cancelled = false;
    setState("loading");
    setResult(null);
    client
      .readFile(conversationId, fileRef.path)
      .then((res) => {
        if (cancelled) return;
        setResult(res);
        setState("loaded");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, fileRef.path]);

  const fileName = fileRef.path.split(/[\\/]/).pop() || fileRef.path;

  return (
    <div className="detail-page">
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title" title={fileRef.path}>
          {fileName}
        </h1>
        <div className="header-spacer" />
      </header>

      <div className="detail-body">
        {state === "loading" ? (
          <div className="detail-file-state">正在加载...</div>
        ) : state === "error" || !result ? (
          <div className="detail-file-state error">文件加载失败</div>
        ) : result.kind === "image" ? (
          <img
            className="detail-file-image"
            src={`data:${result.mimeType};base64,${result.content}`}
            alt={fileName}
          />
        ) : fileRef.kind === "markdown" ? (
          <div className="detail-file-markdown">
            <MessageRenderer content={result.content} />
          </div>
        ) : (
          <MessageRenderer content={fencedCode(result.content, fileRef.language)} />
        )}
        {result?.truncated ? (
          <div className="detail-file-truncated">内容较大，已截断显示</div>
        ) : null}
      </div>
    </div>
  );
}
