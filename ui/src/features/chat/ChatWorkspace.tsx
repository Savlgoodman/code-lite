import { useCallback, useRef } from "react";

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
  onOptimizePrompt?: () => void;
  optimizePromptEnabled?: boolean;
  optimizePromptCanUndo?: boolean;
  optimizingPrompt?: boolean;
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
  workspace?: string;
}

function workspaceBasename(workspace?: string): string {
  const trimmed = (workspace ?? "").replace(/[\\/]+$/, "");
  if (!trimmed) {
    return "code-lite";
  }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "code-lite";
}

function useEventCallback<Args extends unknown[]>(callback: (...args: Args) => void) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function useBillableMessages(messages: ChatMessage[]): ChatMessage[] {
  const cachedRef = useRef<ChatMessage[]>([]);
  const next = messages.filter((message) => message.role === "assistant" && message.usage);
  const cached = cachedRef.current;
  const changed = cached.length !== next.length || next.some((message, index) => (
    cached[index]?.id !== message.id
    || cached[index]?.model !== message.model
    || cached[index]?.usage !== message.usage
  ));
  if (changed) {
    cachedRef.current = next;
  }
  return cachedRef.current;
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
  onOptimizePrompt,
  optimizePromptEnabled,
  optimizePromptCanUndo,
  optimizingPrompt,
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
  updatedAt,
  workspace
}: ChatWorkspaceProps) {
  const activePlan = latestMergedPlanFromMessages(messages) ?? null;
  const billableMessages = useBillableMessages(messages);
  const showEmptyWelcome = messages.length === 0 && !isRunning && !pendingApproval && !pendingInput;
  const workspaceName = workspaceBasename(workspace);
  const handleAccessModeChange = useEventCallback(onAccessModeChange);
  const handleConfigChange = useEventCallback(onConfigChange);
  const handleDraftChange = useEventCallback(onDraftChange);
  const handleDraftImagesAdd = useEventCallback(onDraftImagesAdd);
  const handleDraftImageRemove = useEventCallback(onDraftImageRemove);
  const handleModelFamilyChange = useEventCallback(onModelFamilyChange);
  const handleOptimizePrompt = useEventCallback(() => onOptimizePrompt?.());
  const handleReasoningEffortChange = useEventCallback(onReasoningEffortChange);
  const handleResolveApproval = useEventCallback(onResolveApproval);
  const handleResolveInput = useEventCallback(onResolveInput);
  const handleSendMessage = useEventCallback(onSendMessage);
  const handleStopTurn = useEventCallback(onStopTurn);

  return (
    <main className={`chat-workspace ${showEmptyWelcome ? "empty-chat" : ""}`}>
      <ConversationHeader agent={agent} isRunning={isRunning} title={title} />
      <section className="empty-chat-welcome" aria-hidden={!showEmptyWelcome}>
        <h2>我们应该在 {workspaceName} 中构建什么？</h2>
      </section>
      <MessageList
        isRunning={isRunning}
        isWaitingForUser={Boolean(pendingApproval || pendingInput)}
        messages={messages}
        sessionId={sessionId}
        updatedAt={updatedAt}
      />
      <ChatComposer
        accessMode={accessMode}
        activeTurnId={activeTurnId}
        agent={agent}
        billingMessages={billableMessages}
        commands={commands}
        configOptions={configOptions}
        configLoading={configLoading}
        contextUsage={contextUsage}
        draft={draft}
        draftImageError={draftImageError}
        draftImages={draftImages}
        imagesProcessing={imagesProcessing}
        sendDisabled={sendDisabled}
        modes={modes}
        models={models}
        onAccessModeChange={handleAccessModeChange}
        onConfigChange={handleConfigChange}
        onDraftChange={handleDraftChange}
        onDraftImagesAdd={handleDraftImagesAdd}
        onDraftImageRemove={handleDraftImageRemove}
        onModelFamilyChange={handleModelFamilyChange}
        onOptimizePrompt={handleOptimizePrompt}
        optimizePromptEnabled={optimizePromptEnabled}
        optimizePromptCanUndo={optimizePromptCanUndo}
        optimizingPrompt={optimizingPrompt}
        onReasoningEffortChange={handleReasoningEffortChange}
        onResolveApproval={handleResolveApproval}
        onResolveInput={handleResolveInput}
        onSendMessage={handleSendMessage}
        onStopTurn={handleStopTurn}
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
