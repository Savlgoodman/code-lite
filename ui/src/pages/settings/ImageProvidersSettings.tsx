import { useEffect, useState } from "react";

import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import type { ImageProvider } from "@code-lite/image-gen";

import { getImageGenClient } from "../../services/imageGenStore";

interface ProviderDraft {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  id: string;
  name: string;
}

function providerNameFromUrl(value: string) {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

export function ImageProvidersSettings() {
  const client = getImageGenClient();
  const [providers, setProviders] = useState<ImageProvider[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("gpt-image-2");
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      setProviders(await client.listProviders());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      await client.createProvider({
        apiKey: trimmedApiKey,
        baseUrl: trimmedBaseUrl,
        defaultModel: defaultModel.trim() || "gpt-image-2",
        name: name.trim() || providerNameFromUrl(trimmedBaseUrl)
      });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setDefaultModel("gpt-image-2");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  function editProvider(provider: ImageProvider) {
    setDraft({
      apiKey: "",
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      enabled: provider.enabled,
      id: provider.id,
      name: provider.name
    });
    setError(null);
  }

  async function saveDraft() {
    if (!draft) {
      return;
    }
    const trimmedName = draft.name.trim();
    const trimmedBaseUrl = draft.baseUrl.trim();
    if (!trimmedName || !trimmedBaseUrl) {
      setError("请填写供应商名称和 URL");
      return;
    }
    setBusyId(draft.id);
    setError(null);
    try {
      await client.updateProvider(draft.id, {
        baseUrl: trimmedBaseUrl,
        defaultModel: draft.defaultModel.trim() || "gpt-image-2",
        enabled: draft.enabled,
        name: trimmedName,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      });
      setDraft(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProvider(provider: ImageProvider) {
    if (!window.confirm(`确定删除供应商“${provider.name}”吗？`)) {
      return;
    }
    setBusyId(provider.id);
    setError(null);
    try {
      await client.deleteProvider(provider.id);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading">
        <span className="eyebrow">配置</span>
        <h1>图片生成供应商</h1>
      </div>

      <div className="settings-card">
        <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
          添加供应商
        </h3>
        <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
          图片生成供应商仅需 URL 与 API Key，协议使用 OpenAI 图片兼容格式。
        </p>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>名称</span>
            <input
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 12ai"
              value={name}
            />
          </label>
          <label className="settings-field">
            <span>默认模型</span>
            <input
              autoComplete="off"
              onChange={(event) => setDefaultModel(event.target.value)}
              placeholder="gpt-image-2"
              value={defaultModel}
            />
          </label>
          <label className="settings-field settings-field-wide">
            <span>URL</span>
            <input
              autoComplete="off"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://cdn.12ai.org/v1"
              value={baseUrl}
            />
          </label>
          <label className="settings-field settings-field-wide">
            <span>API Key</span>
            <input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              type="password"
              value={apiKey}
            />
          </label>
        </div>
        <div className="settings-toggle-row">
          <button className="settings-primary-button" disabled={isLoading} onClick={() => void addProvider()} type="button">
            <Plus size={15} />
            <span>保存供应商</span>
          </button>
        </div>
        {error && !draft ? <div className="settings-inline-error">{error}</div> : null}
      </div>

      <div className="settings-list">
        {providers.length === 0 ? (
          <div className="settings-empty">暂无图片生成供应商</div>
        ) : (
          providers.map((provider) => (
            <article className="settings-provider-row" key={provider.id}>
              <div className="settings-provider-header">
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
                    <span className="enabled">{provider.defaultModel}</span>
                  </div>
                </div>
                <div className="settings-row-actions provider-actions">
                  <button className="settings-secondary-button" onClick={() => editProvider(provider)} type="button">
                    <Pencil size={14} />
                    <span>编辑</span>
                  </button>
                  <button
                    className="settings-danger-button"
                    disabled={busyId === provider.id}
                    onClick={() => void deleteProvider(provider)}
                    type="button"
                  >
                    <Trash2 size={14} />
                    <span>删除</span>
                  </button>
                </div>
              </div>
            </article>
          ))
        )}
      </div>

      {draft ? (
        <div className="settings-modal-backdrop" role="presentation">
          <div aria-modal="true" className="settings-modal" role="dialog">
            <div className="settings-modal-header">
              <div>
                <span className="eyebrow">供应商</span>
                <h2>编辑供应商</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setDraft(null)} title="关闭" type="button">
                <X size={16} />
              </button>
            </div>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>名称</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  value={draft.name}
                />
              </label>
              <label className="settings-field">
                <span>默认模型</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })}
                  value={draft.defaultModel}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>URL</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  value={draft.baseUrl}
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>API Key</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  placeholder="留空则保持原密钥"
                  type="password"
                  value={draft.apiKey}
                />
              </label>
            </div>
            <div className="settings-toggle-row modal-toggle-row">
              <label className="settings-check">
                <input
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span>启用供应商</span>
              </label>
            </div>
            {error ? <div className="settings-inline-error">{error}</div> : null}
            <div className="settings-modal-actions">
              <button className="settings-secondary-button" onClick={() => setDraft(null)} type="button">
                <span>取消</span>
              </button>
              <button className="settings-primary-button" disabled={busyId === draft.id} onClick={() => void saveDraft()} type="button">
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
