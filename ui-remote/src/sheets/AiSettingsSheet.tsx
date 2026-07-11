import { useState } from "react";
import { Plus, Trash2, Pencil, RefreshCw, Check, ChevronLeft, Server, Cpu } from "lucide-react";
import { Sheet, Button, Select } from "../components/ui";
import { useAiProviders } from "../hooks/useAiProviders";
import {
  aiProviderStore,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type AiProvider,
  type AiProtocol,
  type AiModel,
} from "../services/AiProviderStore";
import { fetchModels } from "../services/aiClient";

interface AiSettingsSheetProps {
  onClose: () => void;
}

type View =
  | { kind: "list" }
  | { kind: "provider-form"; provider: AiProvider | null }
  | { kind: "pick-models"; provider: AiProvider };

const PROTOCOL_OPTIONS = [
  { value: "chat_completions", label: "/v1/chat/completions" },
  { value: "responses", label: "/v1/responses" },
];

export function AiSettingsSheet({ onClose }: AiSettingsSheetProps) {
  const { providers, models } = useAiProviders();
  const [view, setView] = useState<View>({ kind: "list" });

  const title =
    view.kind === "list" ? (
      <><Server size={18} style={{ verticalAlign: "-3px", marginRight: 6 }} />模型供应商配置</>
    ) : view.kind === "provider-form" ? (
      <>{view.provider ? "编辑供应商" : "添加供应商"}</>
    ) : (
      <>选择模型</>
    );

  return (
    <Sheet title={title} onClose={onClose} className="ai-settings-sheet">
      {view.kind === "list" && (
        <ProviderListView
          providers={providers}
          models={models}
          onAddProvider={() => setView({ kind: "provider-form", provider: null })}
          onEditProvider={(p) => setView({ kind: "provider-form", provider: p })}
          onPickModels={(p) => setView({ kind: "pick-models", provider: p })}
        />
      )}
      {view.kind === "provider-form" && (
        <ProviderFormView
          provider={view.provider}
          onBack={() => setView({ kind: "list" })}
          onSaved={(p) => setView({ kind: "pick-models", provider: p })}
        />
      )}
      {view.kind === "pick-models" && (
        <PickModelsView provider={view.provider} onBack={() => setView({ kind: "list" })} />
      )}
    </Sheet>
  );
}

// ── 供应商列表 + 已添加模型 ──

function ProviderListView({
  providers,
  models,
  onAddProvider,
  onEditProvider,
  onPickModels,
}: {
  providers: AiProvider[];
  models: AiModel[];
  onAddProvider: () => void;
  onEditProvider: (p: AiProvider) => void;
  onPickModels: (p: AiProvider) => void;
}) {
  return (
    <div className="ai-provider-list">
      {providers.length === 0 && (
        <p className="ai-hint">还没有供应商。添加一个供应商，输入其 URL 和 API Key，再获取并选择模型。</p>
      )}
      {providers.map((provider) => {
        const providerModels = models.filter((m) => m.providerId === provider.id);
        return (
          <div key={provider.id} className="ai-provider-card">
            <div className="ai-provider-head">
              <div className="ai-provider-meta">
                <span className="ai-provider-name">{provider.name}</span>
                <span className="ai-provider-url">{provider.baseUrl}</span>
              </div>
              <div className="ai-provider-actions">
                <button className="ai-icon-btn" aria-label="编辑" onClick={() => onEditProvider(provider)}>
                  <Pencil size={16} />
                </button>
                <button
                  className="ai-icon-btn danger"
                  aria-label="删除"
                  onClick={() => void aiProviderStore.removeProvider(provider.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <div className="ai-model-chips">
              {providerModels.length === 0 ? (
                <span className="ai-hint-inline">未添加模型</span>
              ) : (
                providerModels.map((model) => (
                  <ModelRow key={model.id} model={model} />
                ))
              )}
            </div>
            <Button variant="secondary" block onClick={() => onPickModels(provider)}>
              <Cpu size={15} /> 获取并添加模型
            </Button>
          </div>
        );
      })}
      <Button variant="primary" block onClick={onAddProvider}>
        <Plus size={16} /> 添加供应商
      </Button>
    </div>
  );
}

// ── 已添加模型行（可编辑上下文/最大输出/多模态） ──

function ModelRow({ model }: { model: AiModel }) {
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState(String(model.contextTokens));
  const [maxOutput, setMaxOutput] = useState(String(model.maxOutputTokens));
  const [multimodal, setMultimodal] = useState(model.multimodal);

  const save = () => {
    void aiProviderStore.saveModel({
      ...model,
      contextTokens: Number(context) || DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: Number(maxOutput) || DEFAULT_MAX_OUTPUT_TOKENS,
      multimodal,
    });
    setExpanded(false);
  };

  return (
    <div className="ai-model-row">
      <div className="ai-model-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="ai-model-label">{model.label}</span>
        <div className="ai-model-row-actions">
          {model.multimodal && <span className="ai-model-badge">多模态</span>}
          <button
            className="ai-icon-btn danger"
            aria-label="移除模型"
            onClick={(e) => {
              e.stopPropagation();
              void aiProviderStore.removeModel(model.id);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="ai-model-editor">
          <label>
            上下文长度
            <input
              className="form-input"
              inputMode="numeric"
              value={context}
              onChange={(e) => setContext(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label>
            最大输出
            <input
              className="form-input"
              inputMode="numeric"
              value={maxOutput}
              onChange={(e) => setMaxOutput(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <button className="ai-checkbox-row" onClick={() => setMultimodal((v) => !v)} type="button">
            <span className={`ai-checkbox${multimodal ? " on" : ""}`}>{multimodal && <Check size={13} />}</span>
            支持多模态（图片）
          </button>
          <Button variant="primary" block onClick={save}>保存</Button>
        </div>
      )}
    </div>
  );
}

// ── 供应商表单 ──

function ProviderFormView({
  provider,
  onBack,
  onSaved,
}: {
  provider: AiProvider | null;
  onBack: () => void;
  onSaved: (p: AiProvider) => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [protocol, setProtocol] = useState<AiProtocol>(provider?.protocol ?? "chat_completions");

  const canSave = name.trim() && baseUrl.trim();

  const handleSave = async () => {
    const record: AiProvider = {
      id: provider?.id ?? crypto.randomUUID(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      protocol,
    };
    await aiProviderStore.saveProvider(record);
    onSaved(record);
  };

  return (
    <div className="ai-provider-form">
      <button className="ai-back-btn" onClick={onBack}><ChevronLeft size={16} /> 返回</button>
      <div className="field">
        <label>名称</label>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 OpenAI / 本地模型" />
      </div>
      <div className="field">
        <label>Base URL</label>
        <input
          className="form-input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
          autoCapitalize="none"
        />
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          className="form-input"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          spellCheck={false}
          autoCapitalize="none"
          type="password"
        />
      </div>
      <div className="field">
        <label>协议</label>
        <Select value={protocol} onChange={(v) => setProtocol(v as AiProtocol)} options={PROTOCOL_OPTIONS} />
      </div>
      <Button variant="primary" block disabled={!canSave} onClick={handleSave}>保存并获取模型</Button>
    </div>
  );
}

// ── 拉取并勾选模型 ──

function PickModelsView({ provider, onBack }: { provider: AiProvider; onBack: () => void }) {
  const { models } = useAiProviders();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [manualInput, setManualInput] = useState("");

  const existingModelIds = new Set(
    models.filter((m) => m.providerId === provider.id).map((m) => m.modelId),
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const ids = await fetchModels(provider);
      setAvailable(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const addSelected = async () => {
    await aiProviderStore.addModels(provider.id, Array.from(selected));
    setSelected(new Set());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addManual = async () => {
    const id = manualInput.trim();
    if (!id) return;
    await aiProviderStore.addModels(provider.id, [id]);
    setManualInput("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="ai-pick-models">
      <button className="ai-back-btn" onClick={onBack}><ChevronLeft size={16} /> 返回</button>
      <p className="ai-hint">供应商：{provider.name}</p>

      {/* 手动输入模型名称 */}
      <div className="ai-manual-add">
        <label className="ai-manual-label">手动添加模型</label>
        <div className="ai-manual-row">
          <input
            className="form-input"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="输入模型名称，如 gpt-4o"
            spellCheck={false}
            autoCapitalize="none"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addManual(); } }}
          />
          <Button variant="primary" disabled={!manualInput.trim()} onClick={addManual}>
            <Plus size={15} /> 添加
          </Button>
        </div>
      </div>

      {/* 自动获取模型列表 */}
      {available === null ? (
        <Button variant="primary" block disabled={loading} onClick={load}>
          <RefreshCw size={15} className={loading ? "ai-spin" : ""} /> {loading ? "获取中…" : "获取模型列表"}
        </Button>
      ) : (
        <>
          <div className="ai-available-list">
            {available.length === 0 && <p className="ai-hint">未获取到模型。</p>}
            {available.map((modelId) => {
              const already = existingModelIds.has(modelId);
              const checked = selected.has(modelId);
              return (
                <button
                  key={modelId}
                  type="button"
                  className={`ai-available-row${already ? " already" : ""}`}
                  disabled={already}
                  onClick={() => toggle(modelId)}
                >
                  <span className={`ai-checkbox${checked ? " on" : ""}`}>
                    {(checked || already) && <Check size={13} />}
                  </span>
                  <span className="ai-available-id">{modelId}</span>
                  {already && <span className="ai-model-badge">已添加</span>}
                </button>
              );
            })}
          </div>
          <div className="ai-pick-actions">
            <Button variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw size={15} className={loading ? "ai-spin" : ""} /> 刷新
            </Button>
            <Button variant="primary" disabled={selected.size === 0} onClick={addSelected}>
              {saved ? "已添加" : `添加所选 (${selected.size})`}
            </Button>
          </div>
        </>
      )}
      {error && <div className="test-result fail">{error}</div>}
    </div>
  );
}
