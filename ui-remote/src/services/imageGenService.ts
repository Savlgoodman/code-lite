/**
 * imageGenService — 远程端生图流程编排
 *
 * 把「直连供应商生成 → 图片落 IndexedDB → 追加批次记录」串起来，页面只管 UI。
 * 直连客户端来自共享包 @code-lite/image-gen（注入 imageJsonHttp 按环境分流）。
 * 图片二进制存 imageBlobStore（IndexedDB），记录元数据存 imageGenStore。
 */

import {
  createDirectImageGenClient,
  type DirectGenerateInput,
  type ReferenceImageInput,
} from "@code-lite/image-gen";
import { aiProviderStore } from "./AiProviderStore";
import { base64ToBlob, blobToBase64, imageBlobStore } from "./imageBlobStore";
import { imageGenStore, type ImageRef, type ImageRun, type ImageRunParams } from "./ImageGenStore";
import { imageProviderStore } from "./ImageProviderStore";
import { downloadImage, imageJsonHttp } from "./imageHttp";

const client = createDirectImageGenClient(imageJsonHttp);

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 执行一次生成：请求供应商 → 每张图落 IndexedDB → 组装并追加批次。
 * 返回追加后的批次；供应商/网络出错时抛出可读错误（调用方展示）。
 */
export async function runGeneration(recordId: string, params: ImageRunParams): Promise<ImageRun> {
  const provider = await imageProviderStore.getProvider(params.providerId);
  if (!provider) {
    throw new Error("请选择图片生成供应商");
  }

  // 参考图：从 IndexedDB 取 Blob 转 base64，随 JSON 请求发送。
  const references: ReferenceImageInput[] = [];
  for (const refId of params.referenceImageIds) {
    const blob = await imageBlobStore.getImage(refId);
    if (blob) {
      references.push(await blobToBase64(blob));
    }
  }

  const input: DirectGenerateInput = {
    model: params.model,
    prompt: params.prompt,
    n: params.n,
    size: params.size,
    quality: params.quality,
    references,
  };

  const results = await client.generate(
    { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
    input,
  );

  // 每张结果落 IndexedDB（url 下载 / base64 解码，统一存 Blob）。
  const imageIds: string[] = [];
  const images: ImageRef[] = [];
  for (const result of results) {
    let blob: Blob;
    let mimeType: string;
    if (result.base64) {
      mimeType = result.mimeType ?? "image/png";
      blob = base64ToBlob(result.base64, mimeType);
    } else if (result.url) {
      blob = await downloadImage(result.url, provider.apiKey);
      mimeType = blob.type || "image/png";
    } else {
      continue;
    }
    const imageId = crypto.randomUUID();
    await imageBlobStore.putImage(imageId, blob);
    imageIds.push(imageId);
    images.push({ id: imageId, mimeType, revisedPrompt: result.revisedPrompt });
  }

  if (imageIds.length === 0) {
    throw new Error("图片生成结果为空");
  }

  const run: ImageRun = {
    id: makeRunId(),
    createdAt: Date.now(),
    params,
    imageIds,
    images,
  };
  await imageGenStore.appendRun(recordId, run);
  return run;
}

/** 上传一张参考图：存 IndexedDB + 登记到任务参考图池，返回其引用。 */
export async function addReferenceImage(recordId: string, file: Blob): Promise<ImageRef> {
  const imageId = crypto.randomUUID();
  await imageBlobStore.putImage(imageId, file);
  const ref: ImageRef = { id: imageId, mimeType: file.type || "image/png" };
  await imageGenStore.addReference(recordId, ref);
  return ref;
}

/** 提示词优化：复用已配置的 AI 文本模型（modelRefId 指向 AiProviderStore）。 */
export async function optimizePrompt(modelRefId: string, prompt: string): Promise<string> {
  const resolved = await aiProviderStore.resolveModel(modelRefId);
  if (!resolved) {
    throw new Error("请选择用于优化的文本模型");
  }
  const result = await client.optimizePrompt(
    {
      baseUrl: resolved.provider.baseUrl,
      apiKey: resolved.provider.apiKey,
      model: resolved.model.modelId,
    },
    prompt,
  );
  return result.prompt;
}
