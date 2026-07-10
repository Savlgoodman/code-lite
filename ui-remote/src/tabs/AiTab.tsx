import { EmptyState, Button } from "../components/ui";

export function AiTab() {
  return (
    <div className="tab-page">
      <EmptyState icon="✦" title="AI 对话">
        直接调用大模型 API 进行对话
      </EmptyState>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Button variant="primary">开始新对话</Button>
      </div>
    </div>
  );
}
