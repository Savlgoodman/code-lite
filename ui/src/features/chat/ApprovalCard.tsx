import { summarizeArguments, formatRisk } from "../../lib/formatters";
import type { ApprovalRequest } from "../../types";
import "./ApprovalCard.css";

interface ApprovalCardProps {
  approval: ApprovalRequest;
  onResolve: (decision: "allow" | "deny") => void;
}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps) {
  return (
    <section className="approval-panel">
      <div className="approval-summary">
        <div>
          <span className="eyebrow">需要确认</span>
          <strong>{approval.name}</strong>
          <p>
            {formatRisk(approval.risk)}。{approval.purpose}
          </p>
          <span className="approval-args">参数：{summarizeArguments(approval.argumentsText)}</span>
        </div>
        <div className="approval-actions">
          <button onClick={() => onResolve("deny")}>拒绝</button>
          <button className="primary" onClick={() => onResolve("allow")}>
            允许
          </button>
        </div>
      </div>
      <details className="approval-detail">
        <summary>查看详情</summary>
        <dl>
          <dt>影响范围</dt>
          <dd>{approval.impact}</dd>
          <dt>回滚方式</dt>
          <dd>{approval.rollback}</dd>
        </dl>
        {approval.risks.length > 0 ? (
          <ul>
            {approval.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        ) : null}
        <pre>{approval.argumentsText}</pre>
      </details>
    </section>
  );
}
