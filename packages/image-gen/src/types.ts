// 图片生成共享协议类型。桌面端与远程端共用，与后端 JSON 一一对齐。
// 本包不直接发外部请求：外部供应商调用在后端完成，前端只组装参数、经 backend 代理。

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageResponseFormat = "url" | "b64_json";

/** 图片生成供应商（前端可见视图，密钥遮蔽）。 */
export interface ImageProvider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyPreview: string;
  defaultModel: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建供应商入参。 */
export interface ImageProviderCreateInput {
  name?: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

/** 更新供应商入参；apiKey 为空表示不修改已有密钥。 */
export interface ImageProviderUpdateInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  enabled?: boolean;
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
