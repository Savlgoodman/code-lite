import { ShieldAlert } from "lucide-react";
import type { ApprovalRequest } from "@code-lite/protocol";
import { formatRisk } from "../lib/formatters";

interface ApprovalCardProps {
  approval: ApprovalRequest;
  disabled?: boolean;
  onResolve: (decision: "allow" | "deny") => void;
}

/** 参数摘要：对象取前 3 个键，否则压缩为单行短文本。 */
function summarizeArguments(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 3);
      const summary = entries.map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join(", ");
      return summary.length > 100 ? `${summary.slice(0, 100)}...` : summary || "{}";
    }
  } catch {
    // 落到纯文本摘要。
  }
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 100)}...` : compact || "{}";
}

/** 移动版审批卡片：渲染在输入框上方，不进消息历史。同意/拒绝走 resolveApproval。 */
export function ApprovalCard({ approval, disabled, onResolve }: ApprovalCardProps) {
  return (
    <div className={`m-approval-card risk-${approval.risk}`}>
      <div className="m-approval-head">
        <span className="m-approval-icon">
          <ShieldAlert size={16} />
        </span>
        <span className="m-approval-eyebrow">需要确认</span>
        <span className="m-approval-risk">{formatRisk(approval.risk)}</span>
      </div>
      <div className="m-approval-name" title={approval.name}>
        {approval.name}
      </div>
      {approval.purpose ? <p className="m-approval-purpose">{approval.purpose}</p> : null}
      <div className="m-approval-args" title={approval.argumentsText}>
        {summarizeArguments(approval.argumentsText)}
      </div>
      <div className="m-approval-actions">
        <button
          className="m-approval-btn deny"
          disabled={disabled}
          onClick={() => onResolve("deny")}
          type="button"
        >
          拒绝
        </button>
        <button
          className="m-approval-btn allow"
          disabled={disabled}
          onClick={() => onResolve("allow")}
          type="button"
        >
          允许
        </button>
      </div>
    </div>
  );
}
