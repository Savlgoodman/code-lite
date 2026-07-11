import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FileRef } from "@code-lite/chat-render";
import { loadWorkspaceFile, type WorkspaceFileResult } from "../../services/conversationStore";
import { MessageRenderer } from "../../components/MessageRenderer";
import "./FileRefModal.css";

interface FileRefModalProps {
  conversationId: string;
  fileRef: FileRef;
  onClose: () => void;
}

type LoadState = "loading" | "loaded" | "error";

/** 把文本按代码围栏包裹，交给 MessageRenderer 做语法高亮。 */
function fencedCode(text: string, language?: string) {
  const lang = language ?? "";
  // 避免正文里的围栏冲突：用四个反引号包裹。
  return `\`\`\`\`${lang}\n${text}\n\`\`\`\``;
}

/** 桌面文件引用查看弹窗：文本/代码高亮、Markdown 渲染、图片预览。 */
export function FileRefModal({ conversationId, fileRef, onClose }: FileRefModalProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [result, setResult] = useState<WorkspaceFileResult | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setResult(null);
    loadWorkspaceFile(conversationId, fileRef.path)
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
    <div className="file-ref-overlay" ref={overlayRef} onClick={onClose}>
      <div className="file-ref-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-ref-modal-header">
          <span className="file-ref-modal-title" title={fileRef.path}>
            {fileName}
          </span>
          <button className="file-ref-modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="file-ref-modal-body">
          {state === "loading" ? (
            <div className="file-ref-modal-state">正在加载...</div>
          ) : state === "error" || !result ? (
            <div className="file-ref-modal-state error">文件加载失败</div>
          ) : result.kind === "image" ? (
            <img
              className="file-ref-modal-image"
              src={`data:${result.mimeType};base64,${result.content}`}
              alt={fileName}
            />
          ) : fileRef.kind === "markdown" ? (
            <div className="file-ref-modal-markdown">
              <MessageRenderer content={result.content} />
            </div>
          ) : (
            <MessageRenderer content={fencedCode(result.content, fileRef.language)} />
          )}
        </div>
      </div>
    </div>
  );
}
