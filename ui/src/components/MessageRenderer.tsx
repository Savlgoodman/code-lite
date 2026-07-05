import { memo, type ComponentProps } from "react";
import { code } from "@streamdown/code";
import { Streamdown, type AnimateOptions, type Components, type ControlsConfig, type ExtraProps } from "streamdown";

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
        plugins={{ code }}
      >
        {content}
      </Streamdown>
    </div>
  );
});
