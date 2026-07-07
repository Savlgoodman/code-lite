import type {
  AgentSummary,
  ApprovalRequest,
  ChatMessage,
  InputRequest,
  SessionConfigOption,
  SessionModel,
  SessionMode,
  SlashCommand,
  UsageStats
} from "../../types";
import { ChatComposer } from "./ChatComposer";
import { ConversationHeader } from "./ConversationHeader";
import { MessageList } from "./MessageList";
import type { ChatConfigValue } from "./chatTypes";
import type { DraftImage } from "./draftImages";
import { latestMergedPlanFromMessages } from "./planSnapshots";
import "./ChatWorkspace.css";

interface ChatWorkspaceProps {
  accessMode: string;
  activeTurnId: string | null;
  agent?: AgentSummary | null;
  commands: SlashCommand[];
  configOptions: SessionConfigOption[];
  contextUsage: UsageStats | null;
  configLoading: boolean;
  draft: string;
  draftImageError: string | null;
  draftImages: DraftImage[];
  imagesProcessing: boolean;
  sendDisabled: boolean;
  isRunning: boolean;
  messages: ChatMessage[];
  models: SessionModel[];
  modes: SessionMode[];
  onAccessModeChange: (value: string) => void;
  onConfigChange: (optionId: string, value: ChatConfigValue) => void;
  onDraftChange: (value: string) => void;
  onDraftImagesAdd: (files: File[]) => void;
  onDraftImageRemove: (id: string) => void;
  onModelFamilyChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onResolveApproval: (decision: "allow" | "deny") => void;
  onResolveInput: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
  onSendMessage: () => void;
  onStopTurn: () => void;
  pendingApproval: ApprovalRequest | null;
  pendingInput: InputRequest | null;
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
  commands,
  configOptions,
  contextUsage,
  configLoading,
  draft,
  draftImageError,
  draftImages,
  imagesProcessing,
  sendDisabled,
  isRunning,
  messages,
  models,
  modes,
  onAccessModeChange,
  onConfigChange,
  onDraftChange,
  onDraftImagesAdd,
  onDraftImageRemove,
  onModelFamilyChange,
  onReasoningEffortChange,
  onResolveApproval,
  onResolveInput,
  onSendMessage,
  onStopTurn,
  pendingApproval,
  pendingInput,
  reasoningEffort,
  selectedConfig,
  selectedModelFamily,
  sessionId,
  title,
  updatedAt
}: ChatWorkspaceProps) {
  const activePlan = latestMergedPlanFromMessages(messages) ?? null;
  const showEmptyWelcome = messages.length === 0 && !isRunning && !pendingApproval && !pendingInput;

  return (
    <main className={`chat-workspace ${showEmptyWelcome ? "empty-chat" : ""}`}>
      <ConversationHeader agent={agent} isRunning={isRunning} title={title} />
      <section className="empty-chat-welcome" aria-hidden={!showEmptyWelcome}>
        <h2>我们应该在 code-lite 中构建什么？</h2>
      </section>
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
        commands={commands}
        configOptions={configOptions}
        configLoading={configLoading}
        contextUsage={contextUsage}
        draft={draft}
        draftImageError={draftImageError}
        draftImages={draftImages}
        imagesProcessing={imagesProcessing}
        sendDisabled={sendDisabled}
        messages={messages}
        modes={modes}
        models={models}
        onAccessModeChange={onAccessModeChange}
        onConfigChange={onConfigChange}
        onDraftChange={onDraftChange}
        onDraftImagesAdd={onDraftImagesAdd}
        onDraftImageRemove={onDraftImageRemove}
        onModelFamilyChange={onModelFamilyChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onResolveApproval={onResolveApproval}
        onResolveInput={onResolveInput}
        onSendMessage={onSendMessage}
        onStopTurn={onStopTurn}
        pendingApproval={pendingApproval}
        pendingInput={pendingInput}
        plan={activePlan}
        reasoningEffort={reasoningEffort}
        selectedConfig={selectedConfig}
        selectedModelFamily={selectedModelFamily}
      />
    </main>
  );
}
