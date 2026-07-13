import { ImageGenValidationError, type ImageGenRequest, type ImageQuality } from "./types";

export const MAX_IMAGES_PER_RUN = 4;
export const MAX_REFERENCE_IMAGES = 8;
const QUALITY_VALUES: ImageQuality[] = ["auto", "low", "medium", "high"];

/** GPT Image 2 推荐分辨率（size 下拉的候选）。 */
export const RECOMMENDED_SIZES: Array<{ label: string; value: string }> = [
  { label: "自动", value: "auto" },
  { label: "1:1 (1254x1254)", value: "1254x1254" },
  { label: "1:1 2K (2048x2048)", value: "2048x2048" },
  { label: "4:3 (1448x1086)", value: "1448x1086" },
  { label: "3:2 (1536x1024)", value: "1536x1024" },
  { label: "16:9 (1672x941)", value: "1672x941" },
  { label: "16:9 2K (2560x1440)", value: "2560x1440" },
  { label: "3:4 (1086x1448)", value: "1086x1448" },
  { label: "2:3 (1024x1536)", value: "1024x1536" },
  { label: "9:16 (941x1672)", value: "941x1672" }
];

/** 是否为合法 size：auto，或 WIDTHxHEIGHT 且两边均为正整数。 */
export function isValidSize(size: string): boolean {
  const trimmed = size.trim().toLowerCase();
  if (!trimmed || trimmed === "auto") {
    return true;
  }
  const match = trimmed.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return false;
  }
  return Number(match[1]) > 0 && Number(match[2]) > 0;
}

/**
 * 校验并归一化生成请求。校验失败抛 ImageGenValidationError，UI 直接展示 message。
 * 返回可直接作为后端 body 的对象（省略空值字段）。
 */
export function buildGenerateBody(request: ImageGenRequest): Record<string, unknown> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new ImageGenValidationError("请输入提示词");
  }
  if (!request.providerId) {
    throw new ImageGenValidationError("请选择图片生成供应商");
  }
  const model = request.model.trim();
  if (!model) {
    throw new ImageGenValidationError("请填写模型 ID");
  }

  const n = request.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_RUN) {
    throw new ImageGenValidationError(`生成数量需在 1 到 ${MAX_IMAGES_PER_RUN} 之间`);
  }

  const size = (request.size ?? "auto").trim() || "auto";
  if (!isValidSize(size)) {
    throw new ImageGenValidationError("分辨率格式不正确，应为 auto 或 宽x高");
  }

  const quality = request.quality ?? "auto";
  if (!QUALITY_VALUES.includes(quality)) {
    throw new ImageGenValidationError("画质取值不正确");
  }

  const referenceImageIds = (request.referenceImageIds ?? []).filter(Boolean);
  if (referenceImageIds.length > MAX_REFERENCE_IMAGES) {
    throw new ImageGenValidationError(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
  }

  const body: Record<string, unknown> = {
    providerId: request.providerId,
    model,
    prompt,
    n,
    size,
    quality
  };
  if (referenceImageIds.length > 0) {
    body.referenceImageIds = referenceImageIds;
  }
  return body;
}
