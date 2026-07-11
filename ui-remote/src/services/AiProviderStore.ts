/**
 * AiProviderStore — AI 模型供应商与模型配置持久化
 *
 * 独立 AI 对话模块专用，与 code-lite 无关。存储所有已配置的供应商及其加入系统的模型。
 * 沿用 DeviceStore 的双写策略（Capacitor Preferences + localStorage）。
 */

import { Preferences } from "@capacitor/preferences";

const PROVIDERS_KEY = "ai-providers";
const MODELS_KEY = "ai-models";

/** 目前仅支持 OpenAI 系两种协议。 */
export type AiProtocol = "responses" | "chat_completions";

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: AiProtocol;
}

export interface AiModel {
  id: string;
  providerId: string;
  /** 供应商侧的真实模型 id（请求体里用的） */
  modelId: string;
  /** UI 展示名，默认等于 modelId */
  label: string;
  contextTokens: number;
  maxOutputTokens: number;
  multimodal: boolean;
}

export const DEFAULT_CONTEXT_TOKENS = 131072;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

async function readJson<T>(key: string): Promise<T | null> {
  const pref = await Preferences.get({ key });
  const raw = pref.value ?? localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await Preferences.set({ key, value: json });
  localStorage.setItem(key, json);
}

export class AiProviderStore {
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ── 供应商 ──

  async loadProviders(): Promise<AiProvider[]> {
    return (await readJson<AiProvider[]>(PROVIDERS_KEY)) ?? [];
  }

  async saveProvider(provider: AiProvider): Promise<void> {
    const providers = await this.loadProviders();
    const idx = providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) providers[idx] = provider;
    else providers.push(provider);
    await writeJson(PROVIDERS_KEY, providers);
    this.emit();
  }

  async removeProvider(id: string): Promise<void> {
    const providers = (await this.loadProviders()).filter((p) => p.id !== id);
    await writeJson(PROVIDERS_KEY, providers);
    // 级联删除该供应商下的模型
    const models = (await this.loadModels()).filter((m) => m.providerId !== id);
    await writeJson(MODELS_KEY, models);
    this.emit();
  }

  // ── 模型 ──

  async loadModels(): Promise<AiModel[]> {
    return (await readJson<AiModel[]>(MODELS_KEY)) ?? [];
  }

  async saveModel(model: AiModel): Promise<void> {
    const models = await this.loadModels();
    const idx = models.findIndex((m) => m.id === model.id);
    if (idx >= 0) models[idx] = model;
    else models.push(model);
    await writeJson(MODELS_KEY, models);
    this.emit();
  }

  /** 批量加入模型（勾选添加时用），跳过已存在（同 provider + modelId）的。 */
  async addModels(providerId: string, modelIds: string[]): Promise<void> {
    const models = await this.loadModels();
    for (const modelId of modelIds) {
      const exists = models.some((m) => m.providerId === providerId && m.modelId === modelId);
      if (exists) continue;
      models.push({
        id: crypto.randomUUID(),
        providerId,
        modelId,
        label: modelId,
        contextTokens: DEFAULT_CONTEXT_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        multimodal: false,
      });
    }
    await writeJson(MODELS_KEY, models);
    this.emit();
  }

  async removeModel(id: string): Promise<void> {
    const models = (await this.loadModels()).filter((m) => m.id !== id);
    await writeJson(MODELS_KEY, models);
    this.emit();
  }

  /** 取某个已配置模型（含其供应商），供对话发送时组请求用。 */
  async resolveModel(modelRefId: string): Promise<{ model: AiModel; provider: AiProvider } | null> {
    const models = await this.loadModels();
    const model = models.find((m) => m.id === modelRefId);
    if (!model) return null;
    const providers = await this.loadProviders();
    const provider = providers.find((p) => p.id === model.providerId);
    if (!provider) return null;
    return { model, provider };
  }
}

export const aiProviderStore = new AiProviderStore();
