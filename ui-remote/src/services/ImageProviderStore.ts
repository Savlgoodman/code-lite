/**
 * ImageProviderStore — 图片生成供应商配置持久化（远程端本地）
 *
 * 与 AI 文本供应商（AiProviderStore）分开存储。图片供应商仅需 url + apiKey
 * （+ 可选名称 / 默认模型），协议固定 OpenAI 图片兼容格式。
 * 沿用 DeviceStore / AiProviderStore 的双写策略（Capacitor Preferences + localStorage）。
 */

import { Preferences } from "@capacitor/preferences";
import {
  normalizeImageRequestTimeoutSeconds,
} from "@code-lite/image-gen";

const PROVIDERS_KEY = "image-providers";

export interface ImageProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  requestTimeoutSeconds: number;
}

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

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

export class ImageProviderStore {
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  async loadProviders(): Promise<ImageProviderRecord[]> {
    const providers = (await readJson<ImageProviderRecord[]>(PROVIDERS_KEY)) ?? [];
    return providers.map((provider) => ({
      ...provider,
      requestTimeoutSeconds: normalizeImageRequestTimeoutSeconds(provider.requestTimeoutSeconds),
    }));
  }

  async saveProvider(provider: ImageProviderRecord): Promise<void> {
    const providers = await this.loadProviders();
    const normalized = {
      ...provider,
      requestTimeoutSeconds: normalizeImageRequestTimeoutSeconds(provider.requestTimeoutSeconds),
    };
    const idx = providers.findIndex((p) => p.id === normalized.id);
    if (idx >= 0) providers[idx] = normalized;
    else providers.push(normalized);
    await writeJson(PROVIDERS_KEY, providers);
    this.emit();
  }

  async removeProvider(id: string): Promise<void> {
    const providers = (await this.loadProviders()).filter((p) => p.id !== id);
    await writeJson(PROVIDERS_KEY, providers);
    this.emit();
  }

  async getProvider(id: string): Promise<ImageProviderRecord | null> {
    return (await this.loadProviders()).find((p) => p.id === id) ?? null;
  }
}

export const imageProviderStore = new ImageProviderStore();
