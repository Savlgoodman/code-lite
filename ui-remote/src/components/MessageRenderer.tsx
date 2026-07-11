import { createContext, memo, useContext, useEffect, useState, type ComponentProps } from "react";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown, type AnimateOptions, type Components, type ControlsConfig, type ExtraProps } from "streamdown";
import { FileText } from "lucide-react";
import { classifyHref, decodeFileRefSentinel, rewriteFileRefsForRender, type FileRef } from "@code-lite/chat-render";
import "katex/dist/katex.min.css";

/** 文件引用上下文：让 streamdown 的 a 组件拿到点击回调（跳详情页）与图片加载器。 */
interface FileRefContextValue {
  onOpenFileRef?: (ref: FileRef) => void;
  /** 加载图片文件引用内容，返回可用于 <img src> 的 data URL。 */
  loadImage?: (ref: FileRef) => Promise<string>;
}

const FileRefContext = createContext<FileRefContextValue>({});

export function FileRefProvider({
  children,
  onOpenFileRef,
  loadImage,
}: {
  children: React.ReactNode;
  onOpenFileRef?: (ref: FileRef) => void;
  loadImage?: (ref: FileRef) => Promise<string>;
}) {
  return (
    <FileRefContext.Provider value={{ onOpenFileRef, loadImage }}>{children}</FileRefContext.Provider>
  );
}

// 同时支持 $$...$$ 块级公式与 $...$ 内联公式（多数模型用单美元符输出内联公式）。
const math = createMathPlugin({ singleDollarTextMath: true });

/**
 * 把 LaTeX 括号定界符归一为美元符，remark-math 才能识别：
 *   \[...\] → $$...$$（块级）    \(...\) → $...$（内联）
 * 需跳过代码块 / 行内代码，避免误伤其中的括号。
 */
function normalizeMathDelimiters(input: string): string {
  if (input.indexOf("\\[") === -1 && input.indexOf("\\(") === -1) return input;

  // 以围栏代码块(```...```)和行内代码(`...`)为分段边界，只在“非代码”段做替换。
  const segments = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((seg, i) => {
      // 奇数下标是被捕获的代码段，原样保留
      if (i % 2 === 1) return seg;
      return seg
        .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`);
    })
    .join("");
}

interface MessageRendererProps {
  content: string;
  streaming?: boolean;
}

function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="markdown-table-scroll">
      <table {...props}>{children}</table>
    </div>
  );
}

function MarkdownLink({ children, node: _node, ...props }: ComponentProps<"a"> & ExtraProps) {
  const { onOpenFileRef } = useContext(FileRefContext);
  const rawHref = typeof props.href === "string" ? props.href : "";
  // harden 会把本地文件链接改写成 [blocked]；渲染前已用哨兵 URL 绕过，这里还原真实路径。
  const href = decodeFileRefSentinel(rawHref) ?? rawHref;
  const label = typeof children === "string" ? children : href;
  const fileRef = href ? classifyHref(href, label) : null;

  // 本地文件引用：图片内联渲染，其余渲染为可点击 chip（移动端点击跳详情页）。
  if (fileRef && fileRef.kind !== "external") {
    if (fileRef.kind === "image") {
      return <FileRefImage fileRef={fileRef} />;
    }
    return (
      <button
        type="button"
        className="file-ref-chip"
        title={fileRef.path}
        onClick={() => onOpenFileRef?.(fileRef)}
      >
        <FileText aria-hidden="true" size={13} className="file-ref-chip-icon" />
        <span className="file-ref-chip-label">{label || fileRef.path}</span>
      </button>
    );
  }

  return (
    <a className="markdown-link" rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
}

const fileRefImageCache = new Map<string, string>();

/** 正文中的图片文件引用：经 fs.readFile 取内容内联渲染，失败退化为 chip。 */
function FileRefImage({ fileRef }: { fileRef: FileRef }) {
  const { loadImage, onOpenFileRef } = useContext(FileRefContext);
  const [src, setSrc] = useState<string | undefined>(() => fileRefImageCache.get(fileRef.path));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src || !loadImage) return;
    let cancelled = false;
    loadImage(fileRef)
      .then((url) => {
        fileRefImageCache.set(fileRef.path, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fileRef, loadImage, src]);

  if (src) {
    return (
      <img
        className="file-ref-image"
        src={src}
        alt={fileRef.label || fileRef.path}
        title={fileRef.path}
        onClick={() => onOpenFileRef?.(fileRef)}
      />
    );
  }

  return (
    <button
      type="button"
      className={`file-ref-chip${failed ? " failed" : ""}`}
      title={fileRef.path}
      onClick={() => onOpenFileRef?.(fileRef)}
    >
      <FileText aria-hidden="true" size={13} className="file-ref-chip-icon" />
      <span className="file-ref-chip-label">{fileRef.label || fileRef.path}</span>
    </button>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  table: MarkdownTable,
};

const streamdownControls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
};

const streamdownAnimation: AnimateOptions = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease",
  sep: "word",
  stagger: 24,
};

export const MessageRenderer = memo(function MessageRenderer({ content, streaming }: MessageRendererProps) {
  const isStreaming = Boolean(streaming);
  // 先把本地文件链接改写成哨兵 URL（绕过 harden），再做数学定界归一。
  const normalized = normalizeMathDelimiters(rewriteFileRefsForRender(content));

  return (
    <div className="streamdown-shell">
      <Streamdown
        animated={streamdownAnimation}
        caret={isStreaming ? "block" : undefined}
        className="streamdown-body"
        components={markdownComponents}
        controls={streamdownControls}
        isAnimating={isStreaming}
        lineNumbers={false}
        mode="streaming"
        plugins={{ code, math }}
      >
        {normalized}
      </Streamdown>
    </div>
  );
});
