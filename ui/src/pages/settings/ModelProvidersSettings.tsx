import { useEffect, useState } from "react";

import { Check, ChevronDown, ChevronRight, Pencil, RefreshCw, SlidersHorizontal, Trash2, X } from "lucide-react";

import {
  addProviderModels,
  createModelProvider,
  deleteConfiguredModel,
  deleteModelProvider,
  loadModelSettings,
  refreshModelProviderModels,
  updateConfiguredModel,
  updateDefaultModel,
  updateModelProvider
} from "../../services/settingsStore";
import type {
  ConfiguredModel,
  ConfiguredModelProvider,
  ModelCapabilities,
  ModelProtocol,
  ModelSettingsState
} from "../../types";
import { SettingsSelect } from "./components/SettingsSelect";
import type { SettingsSelectOption } from "./components/SettingsSelect";

function providerNameFromUrl(value: string) {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

const protocolOptions: Array<{ label: string; value: ModelProtocol }> = [
  { label: "OpenAI", value: "openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "OpenAI Responses", value: "openai_responses" }
];

const defaultStrategyOptions = [
  { label: "沿用上次使用的模型", value: "last_used" },
  { label: "固定指定模型", value: "fixed" }
] satisfies Array<SettingsSelectOption<"fixed" | "last_used">>;

const reasoningEffortOptions = [
  { label: "none", value: "none" },
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" }
] satisfies Array<SettingsSelectOption<string>>;

interface ProviderEditDraft {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  id: string;
  name: string;
  protocol: ModelProtocol;
}

interface ModelEditDraft {
  capabilities: ModelCapabilities;
  contextWindowTokens: string;
  enabled: boolean;
  id: string;
  label: string;
  maxOutputTokens: string;
  protocol: ModelProtocol;
  reasoningEffort: string;
  temperature: string;
}

function protocolLabel(value: ModelProtocol) {
  return protocolOptions.find((item) => item.value === value)?.label ?? value;
}

function modelEditDraft(model: ConfiguredModel): ModelEditDraft {
  return {
    capabilities: { ...model.capabilities },
    contextWindowTokens: String(model.limits.contextWindowTokens),
    enabled: model.enabled,
    id: model.id,
    label: model.label,
    maxOutputTokens: String(model.limits.maxOutputTokens),
    protocol: model.protocol,
    reasoningEffort: model.generation.reasoningEffort,
    temperature: String(model.generation.temperature)
  };
}

export function ModelProvidersSettings() {
  const [settings, setSettings] = useState<ModelSettingsState | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai");
  const [supportsReasoning, setSupportsReasoning] = useState(false);
  const [supportsMultimodal, setSupportsMultimodal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, Set<string>>>({});
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderEditDraft | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelEditDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshSettings() {
    setIsLoading(true);
    setError(null);
    try {
      setSettings(await loadModelSettings());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshSettings();
  }, []);

  async function addProvider() {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    if (!trimmedBaseUrl || !trimmedApiKey) {
      setError("请填写 URL 和 API Key");
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const provider = await createModelProvider({
        apiKey: trimmedApiKey,
        baseUrl: trimmedBaseUrl,
        name: providerName.trim() || providerNameFromUrl(trimmedBaseUrl),
        protocol
      });
      await refreshModelProviderModels(provider.id);
      setSettings(await loadModelSettings());
      setApiKey("");
      setBaseUrl("");
      setProviderName("");
      setProtocol("openai");
      setSupportsMultimodal(false);
      setSupportsReasoning(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshProvider(providerId: string) {
    setBusyId(providerId);
    setError(null);
    try {
      const provider = await refreshModelProviderModels(providerId);
      setSettings((current) =>
        current
          ? {
              ...current,
              providers: current.providers.map((item) => (item.id === provider.id ? provider : item))
            }
          : current
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  function editProvider(provider: ConfiguredModelProvider) {
    setProviderDraft({
      apiKey: "",
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol
    });
    setError(null);
  }

  async function saveProviderDraft() {
    if (!providerDraft) {
      return;
    }
    const trimmedName = providerDraft.name.trim();
    const trimmedBaseUrl = providerDraft.baseUrl.trim();
    if (!trimmedName || !trimmedBaseUrl) {
      setError("请填写供应商名称和 URL");
      return;
    }

    setBusyId(providerDraft.id);
    setError(null);
    try {
      const patch: Parameters<typeof updateModelProvider>[1] = {
        baseUrl: trimmedBaseUrl,
        enabled: providerDraft.enabled,
        name: trimmedName,
        protocol: providerDraft.protocol
      };
      if (providerDraft.apiKey.trim()) {
        patch.apiKey = providerDraft.apiKey.trim();
      }
      await updateModelProvider(providerDraft.id, patch);
      setSettings(await loadModelSettings());
      setProviderDraft(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function addSelectedModels(provider: ConfiguredModelProvider) {
    const selected = Array.from(selectedModels[provider.id] ?? []);
    if (selected.length === 0) {
      setError("请先选择要添加的模型");
      return;
    }
    setBusyId(provider.id);
    setError(null);
    try {
      const next = await addProviderModels(
        provider.id,
        selected.map((model) => ({
          capabilities: {
            reasoning: supportsReasoning,
            vision: supportsMultimodal
          },
          generation: {
            reasoningEffort: supportsReasoning ? "medium" : "none"
          },
          limits: {
            contextWindowTokens: 65536,
            maxOutputTokens: 4096
          },
          model,
          protocol: provider.protocol
        }))
      );
      setSettings(next);
      setSelectedModels((current) => ({ ...current, [provider.id]: new Set() }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteModel(modelId: string) {
    if (!window.confirm("确定删除这个模型配置吗？")) {
      return;
    }
    setBusyId(modelId);
    setError(null);
    try {
      setSettings(await deleteConfiguredModel(modelId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  function editModel(model: ConfiguredModel) {
    setModelDraft(modelEditDraft(model));
    setError(null);
  }

  async function saveModelDraft() {
    if (!modelDraft) {
      return;
    }
    const label = modelDraft.label.trim();
    const contextWindowTokens = Number.parseInt(modelDraft.contextWindowTokens, 10);
    const maxOutputTokens = Number.parseInt(modelDraft.maxOutputTokens, 10);
    const temperature = Number.parseFloat(modelDraft.temperature);
    if (!label) {
      setError("请填写模型显示名称");
      return;
    }
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
      setError("上下文长度必须是大于 0 的整数");
      return;
    }
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
      setError("最大输出长度必须是大于 0 的整数");
      return;
    }
    if (!Number.isFinite(temperature)) {
      setError("Temperature 必须是有效数字");
      return;
    }

    setBusyId(modelDraft.id);
    setError(null);
    try {
      await updateConfiguredModel(modelDraft.id, {
        capabilities: modelDraft.capabilities,
        enabled: modelDraft.enabled,
        generation: {
          reasoningEffort: modelDraft.reasoningEffort.trim() || "none",
          temperature
        },
        label,
        limits: {
          contextWindowTokens,
          maxOutputTokens
        },
        protocol: modelDraft.protocol
      });
      setSettings(await loadModelSettings());
      setModelDraft(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProvider(provider: ConfiguredModelProvider) {
    if (!window.confirm(`确定删除供应商“${provider.name}”及其模型配置吗？`)) {
      return;
    }
    setBusyId(provider.id);
    setError(null);
    try {
      setSettings(await deleteModelProvider(provider.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function changeDefaultStrategy(value: string) {
    const defaultStrategy = value === "fixed" ? "fixed" : "last_used";
    setError(null);
    try {
      setSettings(await updateDefaultModel({
        defaultModelId: defaultStrategy === "fixed" ? settings?.effectiveDefaultModelId ?? settings?.models[0]?.id ?? null : null,
        defaultStrategy
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function setDefaultModel(modelId: string) {
    setError(null);
    try {
      setSettings(await updateDefaultModel({
        defaultModelId: modelId,
        defaultStrategy: "fixed"
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  function toggleModel(providerId: string, model: string, checked: boolean) {
    setSelectedModels((current) => {
      const nextSet = new Set(current[providerId] ?? []);
      if (checked) {
        nextSet.add(model);
      } else {
        nextSet.delete(model);
      }
      return { ...current, [providerId]: nextSet };
    });
  }

  function toggleProviderCollapse(providerId: string) {
    setCollapsedProviders((current) => ({
      ...current,
      [providerId]: !(current[providerId] ?? false)
    }));
  }

  function updateModelCapability(name: keyof ModelCapabilities, checked: boolean) {
    setModelDraft((current) =>
      current
        ? {
            ...current,
            capabilities: {
              ...current.capabilities,
              [name]: checked
            }
          }
        : current
    );
  }

  const providers = settings?.providers ?? [];
  const configuredModels = settings?.models ?? [];

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">配置</span>
        <h1>模型提供商配置</h1>
      </div>

      <div className="settings-card">
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>名称</span>
            <input
              autoComplete="off"
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="DeepSeek / OpenAI / 本地模型"
              value={providerName}
            />
          </label>
          <label className="settings-field">
            <span>URL</span>
            <input
              autoComplete="off"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              value={baseUrl}
            />
          </label>
          <label className="settings-field">
            <span>API Key</span>
            <input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              type="password"
              value={apiKey}
            />
          </label>
          <label className="settings-field">
            <span>协议</span>
            <SettingsSelect onChange={setProtocol} options={protocolOptions} value={protocol} />
          </label>
        </div>

        <div className="settings-toggle-row">
          <label className="settings-check">
            <input
              checked={supportsReasoning}
              onChange={(event) => setSupportsReasoning(event.target.checked)}
              type="checkbox"
            />
            <span>支持思考</span>
          </label>
          <label className="settings-check">
            <input
              checked={supportsMultimodal}
              onChange={(event) => setSupportsMultimodal(event.target.checked)}
              type="checkbox"
            />
            <span>支持多模态</span>
          </label>
          <button className="settings-primary-button" disabled={isLoading} onClick={() => void addProvider()} type="button">
            <RefreshCw className={isLoading ? "spin-icon" : ""} size={15} />
            <span>保存并获取模型</span>
          </button>
        </div>

        {error ? <div className="settings-inline-error">{error}</div> : null}
      </div>

      <div className="settings-card">
        <div className="settings-default-row">
          <label className="settings-field">
            <span>新会话默认模型</span>
            <SettingsSelect
              onChange={(value) => void changeDefaultStrategy(value)}
              options={defaultStrategyOptions}
              value={settings?.defaultStrategy ?? "last_used"}
            />
          </label>
          <label className="settings-field">
            <span>固定模型</span>
            <SettingsSelect
              disabled={(settings?.defaultStrategy ?? "last_used") !== "fixed" || configuredModels.length === 0}
              onChange={(value) => void setDefaultModel(value)}
              options={
                configuredModels.length === 0
                  ? [{ label: "暂无模型", value: "" }]
                  : configuredModels.map((model) => ({ label: model.label, value: model.id }))
              }
              value={settings?.effectiveDefaultModelId ?? ""}
            />
          </label>
        </div>
      </div>

      <div className="settings-list">
        {providers.length === 0 ? (
          <div className="settings-empty">暂无模型提供商</div>
        ) : (
          providers.map((provider) => {
            const isCollapsed = collapsedProviders[provider.id] ?? false;
            return (
              <article className={`settings-provider-row ${isCollapsed ? "collapsed" : ""}`} key={provider.id}>
                <div className="settings-provider-header">
                  <button
                    aria-controls={`provider-body-${provider.id}`}
                    aria-expanded={!isCollapsed}
                    className="settings-icon-button"
                    onClick={() => toggleProviderCollapse(provider.id)}
                    title={isCollapsed ? "展开供应商" : "折叠供应商"}
                    type="button"
                  >
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </button>
                  <div className="settings-provider-main">
                    <div>
                      <strong>{provider.name}</strong>
                      <span>{provider.baseUrl}</span>
                    </div>
                    <div className="settings-provider-flags">
                      <span className={provider.enabled ? "enabled" : ""}>{provider.enabled ? "启用" : "停用"}</span>
                      <span className={provider.hasApiKey ? "enabled" : ""}>
                        {provider.hasApiKey ? <Check size={13} /> : <X size={13} />}
                        密钥
                      </span>
                      <span className="enabled">{protocolLabel(provider.protocol)}</span>
                    </div>
                  </div>
                  <div className="settings-row-actions provider-actions">
                    <button className="settings-secondary-button" onClick={() => editProvider(provider)} type="button">
                      <Pencil size={14} />
                      <span>编辑</span>
                    </button>
                    <button
                      className="settings-secondary-button"
                      disabled={busyId === provider.id}
                      onClick={() => void refreshProvider(provider.id)}
                      type="button"
                    >
                      <RefreshCw className={busyId === provider.id ? "spin-icon" : ""} size={14} />
                      <span>刷新模型</span>
                    </button>
                    <button className="settings-danger-button" disabled={busyId === provider.id} onClick={() => void deleteProvider(provider)} type="button">
                      <Trash2 size={14} />
                      <span>删除供应商</span>
                    </button>
                  </div>
                </div>

                {!isCollapsed ? (
                  <div className="settings-provider-body" id={`provider-body-${provider.id}`}>
                    <div className="settings-model-cloud" aria-label="发现的模型">
                      {provider.discoveredModels.length === 0 ? (
                        <span>暂无发现模型</span>
                      ) : (
                        provider.discoveredModels.slice(0, 24).map((model) => (
                          <label className="settings-model-choice" key={model.id}>
                            <input
                              checked={selectedModels[provider.id]?.has(model.id) ?? false}
                              onChange={(event) => toggleModel(provider.id, model.id, event.target.checked)}
                              type="checkbox"
                            />
                            <span>{model.label}</span>
                          </label>
                        ))
                      )}
                      {provider.discoveredModels.length > 24 ? <span>共 {provider.discoveredModels.length} 个</span> : null}
                    </div>
                    {provider.discoveredModels.length > 0 ? (
                      <button
                        className="settings-secondary-button add-models-button"
                        disabled={busyId === provider.id}
                        onClick={() => void addSelectedModels(provider)}
                        type="button"
                      >
                        <Check size={14} />
                        <span>添加选中模型</span>
                      </button>
                    ) : null}
                    {provider.models.length > 0 ? (
                      <div className="settings-configured-models">
                        {provider.models.map((model) => (
                          <div className="settings-configured-model" key={model.id}>
                            <div>
                              <strong>{model.label}</strong>
                              <span>
                                {model.model} / {model.limits.contextWindowTokens.toLocaleString()} tokens / 输出{" "}
                                {model.limits.maxOutputTokens.toLocaleString()}
                              </span>
                            </div>
                            <div className="settings-provider-flags">
                              <span className={model.enabled ? "enabled" : ""}>{model.enabled ? "启用" : "停用"}</span>
                              <span className={model.capabilities.reasoning ? "enabled" : ""}>思考</span>
                              <span className={model.capabilities.vision ? "enabled" : ""}>多模态</span>
                              <span>{protocolLabel(model.protocol)}</span>
                            </div>
                            <div className="settings-row-actions">
                              <button className="settings-secondary-button" onClick={() => editModel(model)} type="button">
                                <SlidersHorizontal size={14} />
                                <span>参数</span>
                              </button>
                              <button className="settings-secondary-button" onClick={() => void setDefaultModel(model.id)} type="button">
                                <Check size={14} />
                                <span>{settings?.effectiveDefaultModelId === model.id ? "默认" : "设为默认"}</span>
                              </button>
                              <button className="settings-danger-button" disabled={busyId === model.id} onClick={() => void deleteModel(model.id)} type="button">
                                <Trash2 size={14} />
                                <span>删除</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {providerDraft ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">供应商</span>
                <h2>编辑供应商</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setProviderDraft(null)} title="关闭" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>名称</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })}
                  value={providerDraft.name}
                />
              </label>
              <label className="settings-field">
                <span>协议</span>
                <SettingsSelect
                  onChange={(value) => setProviderDraft({ ...providerDraft, protocol: value })}
                  options={protocolOptions}
                  value={providerDraft.protocol}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>URL</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })}
                  value={providerDraft.baseUrl}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>API Key</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })}
                  placeholder="留空则保持原密钥"
                  type="password"
                  value={providerDraft.apiKey}
                />
              </label>
            </div>
            <div className="settings-toggle-row modal-toggle-row">
              <label className="settings-check">
                <input
                  checked={providerDraft.enabled}
                  onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>启用供应商</span>
              </label>
            </div>
            {error ? <div className="settings-inline-error">{error}</div> : null}
            <div className="settings-modal-actions">
              <button className="settings-secondary-button" onClick={() => setProviderDraft(null)} type="button">
                <span>取消</span>
              </button>
              <button className="settings-primary-button" disabled={busyId === providerDraft.id} onClick={() => void saveProviderDraft()} type="button">
                <Check size={14} />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modelDraft ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal wide" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">模型</span>
                <h2>编辑模型参数</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setModelDraft(null)} title="关闭" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>显示名称</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setModelDraft({ ...modelDraft, label: event.target.value })}
                  value={modelDraft.label}
                />
              </label>
              <label className="settings-field">
                <span>协议</span>
                <SettingsSelect
                  onChange={(value) => setModelDraft({ ...modelDraft, protocol: value })}
                  options={protocolOptions}
                  value={modelDraft.protocol}
                />
              </label>
              <label className="settings-field">
                <span>上下文长度</span>
                <input
                  min={1}
                  onChange={(event) => setModelDraft({ ...modelDraft, contextWindowTokens: event.target.value })}
                  type="number"
                  value={modelDraft.contextWindowTokens}
                />
              </label>
              <label className="settings-field">
                <span>最大输出长度</span>
                <input
                  min={1}
                  onChange={(event) => setModelDraft({ ...modelDraft, maxOutputTokens: event.target.value })}
                  type="number"
                  value={modelDraft.maxOutputTokens}
                />
              </label>
              <label className="settings-field">
                <span>Temperature</span>
                <input
                  onChange={(event) => setModelDraft({ ...modelDraft, temperature: event.target.value })}
                  step="0.1"
                  type="number"
                  value={modelDraft.temperature}
                />
              </label>
              <label className="settings-field">
                <span>Reasoning Effort</span>
                <SettingsSelect
                  onChange={(value) => setModelDraft({ ...modelDraft, reasoningEffort: value })}
                  options={reasoningEffortOptions}
                  value={modelDraft.reasoningEffort}
                />
              </label>
            </div>
            <div className="settings-toggle-row modal-toggle-row wrap">
              <label className="settings-check">
                <input
                  checked={modelDraft.enabled}
                  onChange={(event) => setModelDraft({ ...modelDraft, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>启用模型</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.text}
                  onChange={(event) => updateModelCapability("text", event.target.checked)}
                  type="checkbox"
                />
                <span>文本</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.tools}
                  onChange={(event) => updateModelCapability("tools", event.target.checked)}
                  type="checkbox"
                />
                <span>工具</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.reasoning}
                  onChange={(event) => updateModelCapability("reasoning", event.target.checked)}
                  type="checkbox"
                />
                <span>思考</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.vision}
                  onChange={(event) => updateModelCapability("vision", event.target.checked)}
                  type="checkbox"
                />
                <span>多模态</span>
              </label>
              <label className="settings-check">
                <input
                  checked={modelDraft.capabilities.audio}
                  onChange={(event) => updateModelCapability("audio", event.target.checked)}
                  type="checkbox"
                />
                <span>音频</span>
              </label>
            </div>
            {error ? <div className="settings-inline-error">{error}</div> : null}
            <div className="settings-modal-actions">
              <button className="settings-secondary-button" onClick={() => setModelDraft(null)} type="button">
                <span>取消</span>
              </button>
              <button className="settings-primary-button" disabled={busyId === modelDraft.id} onClick={() => void saveModelDraft()} type="button">
                <Check size={14} />
                <span>保存</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
