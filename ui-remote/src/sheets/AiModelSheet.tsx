import { Check } from "lucide-react";
import { Sheet, Button } from "../components/ui";
import { useAiProviders } from "../hooks/useAiProviders";

interface AiModelSheetProps {
  /** 当前选中的模型 ref id */
  value: string;
  onClose: () => void;
  onSelect: (modelRefId: string) => void;
}

/** 对话内模型选择：来源于所有供应商的已添加模型，按供应商分组。 */
export function AiModelSheet({ value, onClose, onSelect }: AiModelSheetProps) {
  const { providers, models } = useAiProviders();

  return (
    <Sheet title="选择模型" onClose={onClose}>
      {(close) => (
        <div className="ai-model-picker">
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
                  const isSel = model.id === value;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`ai-model-option${isSel ? " selected" : ""}`}
                      onClick={() => close(() => onSelect(model.id))}
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
          <Button variant="secondary" block onClick={() => close()}>关闭</Button>
        </div>
      )}
    </Sheet>
  );
}
