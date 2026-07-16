import { useState } from "react";
import { ArrowLeft, Plus, Trash2, Pencil } from "lucide-react";
import { Button, Input } from "../components/ui";
import {
  DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS,
  MAX_IMAGE_REQUEST_TIMEOUT_SECONDS,
  MIN_IMAGE_REQUEST_TIMEOUT_SECONDS,
  isValidImageRequestTimeoutSeconds,
} from "@code-lite/image-gen";
import { useNav } from "../hooks/useNav";
import { useImageProviders } from "../hooks/useImageProviders";
import {
  imageProviderStore,
  DEFAULT_IMAGE_MODEL,
  type ImageProviderRecord,
} from "../services/ImageProviderStore";

/** 复用的页面头部：返回键 + 标题。 */
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

/** 图片生成供应商列表页。 */
export function ImageProvidersListPage({ onBack }: { onBack: () => void }) {
  const { providers } = useImageProviders();
  const nav = useNav();

  return (
    <div className="settings-page">
      <PageHeader title="图片生成供应商" onBack={onBack} />
      <div className="settings-page-body">
        <div className="ai-provider-list">
          {providers.length === 0 && (
            <p className="ai-hint">还没有供应商。图片生成供应商仅需 URL 和 API Key，协议使用 OpenAI 图片兼容格式。</p>
          )}
          {providers.map((provider) => (
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
                    onClick={() => nav.push({ kind: "imageProviderForm", provider })}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="ai-icon-btn danger"
                    aria-label="删除"
                    onClick={() => void imageProviderStore.removeProvider(provider.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="ai-model-chips">
                <span className="ai-hint-inline">默认模型：{provider.defaultModel || DEFAULT_IMAGE_MODEL}</span>
                <span className="ai-hint-inline">请求超时：{provider.requestTimeoutSeconds} 秒</span>
              </div>
            </div>
          ))}
          <Button variant="primary" block onClick={() => nav.push({ kind: "imageProviderForm", provider: null })}>
            <Plus size={16} /> 添加供应商
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 图片生成供应商表单页（新增/编辑）。保存后返回列表。 */
export function ImageProviderFormPage({
  provider,
  onBack,
}: {
  provider: ImageProviderRecord | null;
  onBack: () => void;
}) {
  const nav = useNav();
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? DEFAULT_IMAGE_MODEL);
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = useState(
    String(provider?.requestTimeoutSeconds ?? DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS),
  );

  const parsedRequestTimeout = Number(requestTimeoutSeconds);
  const timeoutIsValid = isValidImageRequestTimeoutSeconds(parsedRequestTimeout);
  const canSave = Boolean(baseUrl.trim() && apiKey.trim() && timeoutIsValid);

  const handleSave = async () => {
    const record: ImageProviderRecord = {
      id: provider?.id ?? crypto.randomUUID(),
      name: name.trim() || baseUrl.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      defaultModel: defaultModel.trim() || DEFAULT_IMAGE_MODEL,
      requestTimeoutSeconds: parsedRequestTimeout,
    };
    await imageProviderStore.saveProvider(record);
    nav.pop();
  };

  return (
    <div className="settings-page">
      <PageHeader title={provider ? "编辑供应商" : "添加供应商"} onBack={onBack} />
      <div className="settings-page-body">
        <div className="ai-provider-form">
          <div className="field">
            <label>名称</label>
            <Input value={name} onValueChange={setName} placeholder="如 12ai" />
          </div>
          <div className="field">
            <label>Base URL</label>
            <Input
              value={baseUrl}
              onValueChange={setBaseUrl}
              placeholder="https://cdn.12ai.org/v1"
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
            <label>默认模型</label>
            <Input value={defaultModel} onValueChange={setDefaultModel} placeholder="gpt-image-2" spellCheck={false} autoCapitalize="none" />
          </div>
          <div className="field">
            <label>请求超时（秒）</label>
            <Input
              inputMode="numeric"
              value={requestTimeoutSeconds}
              onValueChange={(value) => setRequestTimeoutSeconds(value.replace(/\D/g, ""))}
              placeholder={String(DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS)}
            />
            {!timeoutIsValid && requestTimeoutSeconds ? (
              <span className="ai-hint-inline">
                请输入 {MIN_IMAGE_REQUEST_TIMEOUT_SECONDS} 到 {MAX_IMAGE_REQUEST_TIMEOUT_SECONDS} 秒
              </span>
            ) : null}
          </div>
          <Button variant="primary" block disabled={!canSave} onClick={handleSave}>保存</Button>
        </div>
      </div>
    </div>
  );
}
