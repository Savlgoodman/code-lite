import { memo, type ComponentProps } from "react";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown, type AnimateOptions, type Components, type ControlsConfig, type ExtraProps } from "streamdown";
import "katex/dist/katex.min.css";

import "./MessageRenderer.css";

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
  return (
    <a className="markdown-link" rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  table: MarkdownTable
};

const streamdownControls: ControlsConfig = {
  code: {
    copy: true,
    download: false
  },
  table: false
};

const streamdownAnimation: AnimateOptions = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease",
  sep: "word",
  stagger: 24
};

export const MessageRenderer = memo(function MessageRenderer({ content, streaming }: MessageRendererProps) {
  const isStreaming = Boolean(streaming);
  const normalized = normalizeMathDelimiters(content);

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
