import type {
  AgentSummary,
  ApprovalRequest,
  ChatMessage,
  SessionConfigOption,
  SessionModel,
  SessionMode,
  UsageStats
} from "../../types";
import { ChatComposer } from "./ChatComposer";
import { ConversationHeader } from "./ConversationHeader";
import { MessageList } from "./MessageList";
import type { ChatConfigValue } from "./chatTypes";
import "./ChatWorkspace.css";

interface ChatWorkspaceProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  configOptions: SessionConfigOption[];
  contextUsage: UsageStats | null;
  draft: string;
  isRunning: boolean;
  messages: ChatMessage[];
  models: SessionModel[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: ChatConfigValue) => void;
  onDraftChange: (value: string) => void;
  onModelFamilyChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  reasoningEffort: string;
  selectedConfig: Record<string, ChatConfigValue>;
  selectedModelFamily: string;
  sessionId: string;
  title: string;
  updatedAt: number;
}

export function ChatWorkspace({
  accessMode,
  activeTurnId,
  agent,
  configOptions,
  contextUsage,
  draft,
  isRunning,
  messages,
  models,
  modes,
  onAccessModeChange,
  onConfigChange,
  onDraftChange,
  onModelFamilyChange,
  onReasoningEffortChange,
  onResolveApproval,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  reasoningEffort,
  selectedConfig,
  selectedModelFamily,
  sessionId,
  title,
  updatedAt
}: ChatWorkspaceProps) {
  return (
    <main className="chat-workspace">
      <ConversationHeader agent={agent} isRunning={isRunning} title={title} />
      <MessageList
        isRunning={isRunning}
        messages={messages}
        sessionId={sessionId}
        updatedAt={updatedAt}
      />
      <ChatComposer
        accessMode={accessMode}
        activeTurnId={activeTurnId}
        agent={agent}
        configOptions={configOptions}
        contextUsage={contextUsage}
        draft={draft}
        modes={modes}
        models={models}
        onAccessModeChange={onAccessModeChange}
        onConfigChange={onConfigChange}
        onDraftChange={onDraftChange}
        onModelFamilyChange={onModelFamilyChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onResolveApproval={onResolveApproval}
        onSendMessage={onSendMessage}
        onStopTurn={onStopTurn}
        pendingApproval={pendingApproval}
        reasoningEffort={reasoningEffort}
        selectedConfig={selectedConfig}
        selectedModelFamily={selectedModelFamily}
      />
    </main>
  );
}
