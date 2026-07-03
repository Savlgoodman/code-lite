import { Bot, LayoutList, MoreHorizontal, SlidersHorizontal } from "lucide-react";

import type { AgentSummary } from "../../types";

interface ConversationHeaderProps {
  agent?: AgentSummary | null;
  isRunning: boolean;
  title: string;
}

export function ConversationHeader({ agent, isRunning, title }: ConversationHeaderProps) {
  return (
    <section className="conversation-header">
      <div className="conversation-title">
        <h1>{title}</h1>
        <button className="icon-button" aria-label="更多">
          <MoreHorizontal size={17} />
        </button>
      </div>
      <div className="header-actions">
        <button className="outline-action">
          <Bot size={15} />
          <span>{isRunning ? `${agent?.label ?? "Agent"} 运行中` : agent?.label ?? "Agent"}</span>
        </button>
        <button className="icon-button" aria-label="布局">
          <LayoutList size={16} />
        </button>
        <button className="icon-button" aria-label="参数">
          <SlidersHorizontal size={16} />
        </button>
      </div>
    </section>
  );
}
