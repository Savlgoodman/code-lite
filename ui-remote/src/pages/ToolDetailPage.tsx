import { ArrowLeft } from "lucide-react";
import type { ToolCallItem } from "@code-lite/protocol";
import { formatRisk } from "../lib/formatters";

interface ToolDetailPageProps {
  tool: ToolCallItem;
  onBack: () => void;
}

function statusLabel(status: ToolCallItem["status"]) {
  switch (status) {
    case "complete":
      return "已完成";
    case "error":
      return "出错";
    case "running":
      return "运行中";
    case "approval":
      return "等待确认";
    default:
      return "等待中";
  }
}

/** 工具调用详情页：展示入参、输出/错误、风险、状态。 */
export function ToolDetailPage({ tool, onBack }: ToolDetailPageProps) {
  const output = tool.error ?? tool.resultText ?? "";
  const runtime =
    tool.metadata && typeof tool.metadata === "object"
      ? String((tool.metadata as Record<string, unknown>).runtime ?? "")
      : "";

  return (
    <div className="detail-page">
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title" title={tool.name}>
          {tool.name}
        </h1>
        <div className="header-spacer" />
      </header>

      <div className="detail-body">
        <div className="detail-meta-row">
          <span className={`detail-chip status-${tool.status}`}>{statusLabel(tool.status)}</span>
          <span className="detail-chip">{formatRisk(tool.risk)}</span>
          {runtime ? <span className="detail-chip">{runtime}</span> : null}
        </div>

        <section className="detail-section">
          <h2 className="detail-section-title">入参</h2>
          <pre className="detail-code">{tool.argumentsText || "{}"}</pre>
        </section>

        {output ? (
          <section className="detail-section">
            <h2 className="detail-section-title">{tool.error ? "错误" : "输出"}</h2>
            <pre className={`detail-code ${tool.error ? "error" : ""}`}>{output}</pre>
          </section>
        ) : null}
      </div>
    </div>
  );
}
