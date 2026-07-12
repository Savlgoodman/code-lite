import { useState } from "react";
import { ArrowLeft, Plus, Trash2, Pencil, RefreshCw, Check, Cpu } from "lucide-react";
import { Button, Select, Input } from "../components/ui";
import { useAiProviders } from "../hooks/useAiProviders";
import { useNav } from "../hooks/useNav";
import {
  aiProviderStore,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type AiProvider,
  type AiProtocol,
  type AiModel,
} from "../services/AiProviderStore";
import { fetchModels } from "../services/aiClient";

const PROTOCOL_OPTIONS = [
  { value: "chat_completions", label: "/v1/chat/completions" },
  { value: "responses", label: "/v1/responses" },
];

/** 复用的页面头部：返回键 + 标题。返回统一 pop 一级栈。 */
function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="settings-page-header">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={24} />
      </button>
      <h1 className="settings-page-title">{title}</h1>
      <div className="header-spacer" />
    </header>
  );
}

/** 供应商列表页（模型供应商配置的根）。 */
export function AiSettingsListPage({ onBack }: { onBack: () => void }) {
  const { providers, models } = useAiProviders();
  const nav = useNav();

  return (
    <div className="settings-page">
      <PageHeader title="模型供应商配置" onBack={onBack} />
      <div className="settings-page-body">
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
                    <button
                      className="ai-icon-btn"
                      aria-label="编辑"
                      onClick={() => nav.push({ kind: "aiSettingsProviderForm", provider })}
                    >
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
                    providerModels.map((model) => <ModelRow key={model.id} model={model} />)
                  )}
                </div>
                <Button
                  variant="secondary"
                  block
                  onClick={() => nav.push({ kind: "aiSettingsPickModels", provider })}
                >
                  <Cpu size={15} /> 获取并添加模型
                </Button>
              </div>
            );
          })}
          <Button
            variant="primary"
            block
            onClick={() => nav.push({ kind: "aiSettingsProviderForm", provider: null })}
          >
            <Plus size={16} /> 添加供应商
          </Button>
        </div>
      </div>
    </div>
  );
}

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
            <Input
              inputMode="numeric"
              value={context}
              onValueChange={(v) => setContext(v.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label>
            最大输出
            <Input
              inputMode="numeric"
              value={maxOutput}
              onValueChange={(v) => setMaxOutput(v.replace(/[^0-9]/g, ""))}
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

/** 供应商表单页（新增/编辑）。保存后替换栈顶为选模型页。 */
export function AiProviderFormPage({
  provider,
  onBack,
}: {
  provider: AiProvider | null;
  onBack: () => void;
}) {
  const nav = useNav();
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [protocol, setProtocol] = useState<AiProtocol>(provider?.protocol ?? "chat_completions");

  const canSave = Boolean(name.trim() && baseUrl.trim());

  const handleSave = async () => {
    const record: AiProvider = {
      id: provider?.id ?? crypto.randomUUID(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      protocol,
    };
    await aiProviderStore.saveProvider(record);
    nav.replaceTop({ kind: "aiSettingsPickModels", provider: record });
  };

  return (
    <div className="settings-page">
      <PageHeader title={provider ? "编辑供应商" : "添加供应商"} onBack={onBack} />
      <div className="settings-page-body">
        <div className="ai-provider-form">
          <div className="field">
            <label>名称</label>
            <Input value={name} onValueChange={setName} placeholder="如 OpenAI / 本地模型" />
          </div>
          <div className="field">
            <label>Base URL</label>
            <Input
              value={baseUrl}
              onValueChange={setBaseUrl}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              autoCapitalize="none"
            />
          </div>
          <div className="field">
            <label>API Key</label>
            <Input
              value={apiKey}
              onValueChange={setApiKey}
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
      </div>
    </div>
  );
}

/** 获取并添加模型页。 */
export function AiPickModelsPage({ provider, onBack }: { provider: AiProvider; onBack: () => void }) {
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
    <div className="settings-page">
      <PageHeader title="选择模型" onBack={onBack} />
      <div className="settings-page-body">
        <div className="ai-pick-models">
          <p className="ai-hint">供应商：{provider.name}</p>

          <div className="ai-manual-add">
            <label className="ai-manual-label">手动添加模型</label>
            <div className="ai-manual-row">
              <Input
                value={manualInput}
                onValueChange={setManualInput}
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

          {available === null ? (
            <Button variant="primary" block disabled={loading} onClick={load}>
              <RefreshCw size={15} className={loading ? "ai-spin" : ""} /> {loading ? "获取中..." : "获取模型列表"}
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
      </div>
    </div>
  );
}
