import { isValidSize, MAX_IMAGES_PER_RUN, MAX_REFERENCE_IMAGES } from "./request";
import {
  ImageGenValidationError,
  type DirectGenerateInput,
  type DirectImageResult,
  type ImageJsonHttp,
  type ImageProviderConnection,
  type PromptOptimizeResult,
  type TextModelConnection
} from "./types";

/** 规范化 baseUrl：去掉结尾斜杠。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 从供应商响应的一条 data 项解析裸图片结果。 */
function parseImageItem(item: unknown): DirectImageResult | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  const b64 = record.b64_json;
  const url = record.url;
  const revised = record.revised_prompt;
  const result: DirectImageResult = {};
  if (typeof b64 === "string" && b64) {
    result.base64 = b64;
    result.mimeType = "image/png";
  } else if (typeof url === "string" && url) {
    result.url = url;
  } else {
    return null;
  }
  if (typeof revised === "string" && revised) {
    result.revisedPrompt = revised;
  }
  return result;
}

function parseImageList(payload: unknown): DirectImageResult[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error("供应商未返回图片数据");
  }
  const images = data.map(parseImageItem).filter((item): item is DirectImageResult => item !== null);
  if (images.length === 0) {
    throw new Error("图片生成结果为空");
  }
  return images;
}

/**
 * 直连生图客户端（远程端用）：不走 code-lite 后端，直连供应商。
 * 传输由调用方按环境注入（dev 走 /ai-proxy fetch，原生走 CapacitorHttp）。
 * 参考图走 base64 JSON，避开 multipart。
 */
export function createDirectImageGenClient(http: ImageJsonHttp) {
  function validate(input: DirectGenerateInput): void {
    if (!input.prompt.trim()) {
      throw new ImageGenValidationError("请输入提示词");
    }
    if (!input.model.trim()) {
      throw new ImageGenValidationError("请填写模型 ID");
    }
    const n = input.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_RUN) {
      throw new ImageGenValidationError(`生成数量需在 1 到 ${MAX_IMAGES_PER_RUN} 之间`);
    }
    const size = (input.size ?? "auto").trim() || "auto";
    if (!isValidSize(size)) {
      throw new ImageGenValidationError("分辨率格式不正确，应为 auto 或 宽x高");
    }
    if ((input.references ?? []).length > MAX_REFERENCE_IMAGES) {
      throw new ImageGenValidationError(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
    }
  }

  return {
    /** 发起一次生成，返回裸图片结果（url 或 base64），落盘/存储交给调用方。 */
    async generate(conn: ImageProviderConnection, input: DirectGenerateInput): Promise<DirectImageResult[]> {
      validate(input);
      const base = normalizeBaseUrl(conn.baseUrl);
      const references = input.references ?? [];
      const body: Record<string, unknown> = {
        model: input.model.trim(),
        prompt: input.prompt.trim(),
        n: input.n ?? 1,
        size: (input.size ?? "auto").trim() || "auto",
        quality: input.quality ?? "auto",
        response_format: "url"
      };

      let url: string;
      if (references.length > 0) {
        // 有参考图：走 edits 的 JSON 变体，image 传 base64（data URL），避开 multipart。
        url = `${base}/images/edits`;
        const dataUrls = references.map((ref) => `data:${ref.mimeType};base64,${ref.base64}`);
        body.image = dataUrls.length === 1 ? dataUrls[0] : dataUrls;
      } else {
        url = `${base}/images/generations`;
      }

      const payload = await http.postJson(url, conn.apiKey, body);
      return parseImageList(payload);
    },

    /** 提示词优化：复用已配置文本模型的 chat/completions。 */
    async optimizePrompt(
      conn: TextModelConnection,
      prompt: string,
      style?: string
    ): Promise<PromptOptimizeResult> {
      const trimmed = prompt.trim();
      if (!trimmed) {
        throw new ImageGenValidationError("请输入待优化的提示词");
      }
      const base = normalizeBaseUrl(conn.baseUrl);
      const system =
        "你是图像生成提示词优化助手。请把用户给出的图片描述扩写成更精细、结构清晰、" +
        "利于文生图模型理解的提示词，补充画面主体、风格、光照、构图、细节等要素，" +
        "保持与用户输入相同的语言，只返回优化后的提示词本身，不要解释、不要加引号。";
      const userContent = style ? `${trimmed}\n\n偏好风格：${style}` : trimmed;
      const payload = await http.postJson(`${base}/chat/completions`, conn.apiKey, {
        model: conn.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ],
        temperature: 0.7
      });
      const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return { prompt: content.trim() };
      }
      throw new Error("提示词优化结果为空");
    }
  };
}

export type DirectImageGenClient = ReturnType<typeof createDirectImageGenClient>;
