// 图片生成共享协议类型。桌面端与远程端共用，与后端 JSON 一一对齐。
// 本包不直接发外部请求：外部供应商调用在后端完成，前端只组装参数、经 backend 代理。

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageResponseFormat = "url" | "b64_json";

export const DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS = 300;
export const MIN_IMAGE_REQUEST_TIMEOUT_SECONDS = 10;
export const MAX_IMAGE_REQUEST_TIMEOUT_SECONDS = 3600;

export function isValidImageRequestTimeoutSeconds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_IMAGE_REQUEST_TIMEOUT_SECONDS
    && value <= MAX_IMAGE_REQUEST_TIMEOUT_SECONDS;
}

export function normalizeImageRequestTimeoutSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS;
  }
  return Math.min(
    MAX_IMAGE_REQUEST_TIMEOUT_SECONDS,
    Math.max(MIN_IMAGE_REQUEST_TIMEOUT_SECONDS, Math.round(parsed)),
  );
}

/** 图片生成供应商（前端可见视图，密钥遮蔽）。 */
export interface ImageProvider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyPreview: string;
  defaultModel: string;
  requestTimeoutSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** 新建供应商入参。 */
export interface ImageProviderCreateInput {
  name?: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  requestTimeoutSeconds?: number;
}

/** 更新供应商入参；apiKey 为空表示不修改已有密钥。 */
export interface ImageProviderUpdateInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  enabled?: boolean;
  requestTimeoutSeconds?: number;
}

/** 一次生成的请求参数（前端组装，不含真实密钥；providerId 指向后端已存密钥）。 */
export interface ImageGenRequest {
  providerId: string;
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: ImageQuality;
  referenceImageIds?: string[];
}

/** 单张图片（生成图或参考图）。 */
export interface ImageAsset {
  id: string;
  url: string;
  width?: number;
  height?: number;
  mimeType?: string;
  revisedPrompt?: string;
}

/** 一次生成批次（任务内的一次生成动作，产出 1..n 张图片）。 */
export interface ImageGenRun {
  id: string;
  createdAt: number;
  request: ImageGenRequest;
  images: ImageAsset[];
  error?: string;
}

/** 生图任务（一个列表卡片 = 一个任务）。 */
export interface ImageGenRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  latestImageUrl: string | null;
  runs: ImageGenRun[];
  referenceImages: ImageAsset[];
}

/** 列表页用的任务摘要（不含全部 runs）。 */
export interface ImageGenRecordSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  latestImageUrl: string | null;
  runCount: number;
}

/** 提示词优化请求，复用产品级文本模型。 */
export interface PromptOptimizeRequest {
  modelId: string;
  prompt: string;
  style?: string;
}

export interface PromptOptimizeResult {
  prompt: string;
}

export class ImageGenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenValidationError";
  }
}

// ── 直连客户端（远程端：不走后端，直连供应商）──

/** 供应商连接信息（真实 baseUrl/apiKey，由调用方从本地存储解析后传入）。 */
export interface ImageProviderConnection {
  baseUrl: string;
  apiKey: string;
}

/** 文本模型连接信息（提示词优化复用已配置文本模型）。 */
export interface TextModelConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 参考图（base64）：直连时随 JSON 请求体发送，避开 multipart。 */
export interface ReferenceImageInput {
  /** 纯 base64（不含 data: 前缀）。 */
  base64: string;
  mimeType: string;
}

/** 直连生成的入参（裸参数，不含 providerId；连接信息单独传）。 */
export interface DirectGenerateInput {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: ImageQuality;
  references?: ReferenceImageInput[];
}

/** 直连返回的单张裸图片结果（url 或 base64 二选一）。 */
export interface DirectImageResult {
  /** 供应商返回的图片直链（response_format=url）。 */
  url?: string;
  /** 供应商返回的 base64（response_format=b64_json），不含 data: 前缀。 */
  base64?: string;
  mimeType?: string;
  revisedPrompt?: string;
}

/**
 * 由调用方注入的 JSON HTTP 实现（按环境分流：dev 走 /ai-proxy fetch，原生走 CapacitorHttp）。
 * 返回解析后的 JSON 对象；非 2xx 应抛错。
 */
export interface ImageJsonHttp {
  postJson(url: string, apiKey: string, body: unknown): Promise<unknown>;
}
