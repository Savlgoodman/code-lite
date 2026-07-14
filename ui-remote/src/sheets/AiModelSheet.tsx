import { useState } from "react";
import { Check } from "lucide-react";
import { Sheet, Button } from "../components/ui";
import { useAiProviders } from "../hooks/useAiProviders";
import {
  AI_REASONING_EFFORTS,
  type AiReasoningEffort,
} from "../lib/aiReasoning";

export interface AiConversationConfigSelection {
  modelRefId: string;
  reasoningEffort: AiReasoningEffort | null;
  reasoningTouched: boolean;
}

interface AiModelSheetProps {
  modelRefId: string;
  reasoningEffort: AiReasoningEffort | null;
  onClose: () => void;
  onSave: (selection: AiConversationConfigSelection) => void;
}

/** 对话内配置：模型按供应商分组，思考强度按会话独立保存。 */
export function AiModelSheet({
  modelRefId,
  reasoningEffort,
  onClose,
  onSave,
}: AiModelSheetProps) {
  const { providers, models } = useAiProviders();
  const [draftModelRefId, setDraftModelRefId] = useState(modelRefId);
  const [draftReasoningEffort, setDraftReasoningEffort] = useState(reasoningEffort);
  const [reasoningTouched, setReasoningTouched] = useState(false);

  return (
    <Sheet
      title="对话设置"
      onClose={onClose}
      footer={(close) => (
        <>
          <Button variant="secondary" onClick={() => close()}>取消</Button>
          <Button
            variant="primary"
            disabled={!draftModelRefId}
            onClick={() => close(() => onSave({
              modelRefId: draftModelRefId,
              reasoningEffort: draftReasoningEffort,
              reasoningTouched,
            }))}
          >
            保存
          </Button>
        </>
      )}
    >
      <div className="ai-conversation-config">
        <section className="ai-conversation-config-section">
          <div className="ai-model-group-title">思考强度</div>
          <div className="ai-effort-options">
            {[null, ...AI_REASONING_EFFORTS].map((effort) => {
              const selected = effort === draftReasoningEffort;
              const value = effort ?? "null";
              return (
                <button
                  key={value}
                  type="button"
                  className={`ai-effort-option${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setDraftReasoningEffort(effort);
                    setReasoningTouched(true);
                  }}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </section>

        <section className="ai-conversation-config-section">
          <div className="ai-model-group-title">模型</div>
          {models.length === 0 && (
            <p className="ai-hint">还没有已添加的模型，请先在设置页配置模型供应商。</p>
          )}
          {providers.map((provider) => {
            const providerModels = models.filter((m) => m.providerId === provider.id);
            if (providerModels.length === 0) return null;
            return (
              <div key={provider.id} className="ai-model-group">
                <div className="ai-model-group-title">{provider.name}</div>
                {providerModels.map((model) => {
                  const isSel = model.id === draftModelRefId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`ai-model-option${isSel ? " selected" : ""}`}
                      onClick={() => setDraftModelRefId(model.id)}
                    >
                      <span className="ai-model-option-label">
                        {model.label}
                        {model.multimodal && <span className="ai-model-badge">多模态</span>}
                      </span>
                      {isSel && <Check size={16} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </section>
      </div>
    </Sheet>
  );
}
