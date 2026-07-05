import { memo, type ComponentProps } from "react";
import { Streamdown, type AnimateOptions, type Components, type ExtraProps } from "streamdown";

import "./MessageRenderer.css";

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

const markdownComponents: Components = {
  table: MarkdownTable
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

  return (
    <div className="streamdown-shell">
      <Streamdown
        animated={streamdownAnimation}
        caret={isStreaming ? "block" : undefined}
        className="streamdown-body"
        components={markdownComponents}
        isAnimating={isStreaming}
        mode="streaming"
      >
        {content}
      </Streamdown>
    </div>
  );
});
