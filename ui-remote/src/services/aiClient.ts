/**
 * aiClient — 直连大模型 API 的客户端（独立 AI 对话模块）
 *
 * 与 code-lite 后端 / 中继无关。支持两种 OpenAI 系协议：
 * - chat_completions：POST {baseUrl}/chat/completions
 * - responses：POST {baseUrl}/responses
 *
 * 用浏览器原生 fetch + ReadableStream 做真流式（SSE），无新依赖。
 * - dev（浏览器）：请求经 /ai-proxy 同源转发，绕开 CORS，流式透传。
 * - 原生（Android/iOS）：直连目标 URL。注意此路径受 WebView CORS 约束，
 *   供应商需返回 CORS 头，否则会被预检拦截（此为 fetch + 真流式的固有取舍）。
 *
 * 多模态图片以 data URL 直接进请求体（无附件上传通道）。
 */

import type { AiProvider, AiModel } from "./AiProviderStore";
import type { AiImage, AiMessage } from "./AiConversationStore";
import { isNativeApp } from "../lib/environment";

/** 规范化 baseUrl：去掉结尾斜杠。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(provider: AiProvider): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.apiKey.trim()) {
    headers["Authorization"] = `Bearer ${provider.apiKey.trim()}`;
  }
  return headers;
}

/**
 * 把真实 URL 映射为请求地址：
 * - 原生 App：直接用原始 URL（原生 HTTP 不受 CORS 约束，未来接安卓原生模块）。
 * - 浏览器（dev）：映射到同源 /ai-proxy 转发，绕开 CORS 且保留流式。
 *
 * 注意：生产 PWA 环境不会走到这里——AI 入口已由 isAiAvailable() 整体禁用。
 */
function proxyUrl(url: string): string {
  if (isNativeApp()) return url;
  return `/ai-proxy/${url}`;
}

/** GET {baseUrl}/models，返回模型 id 列表（OpenAI 标准 data[].id）。 */
export async function fetchModels(provider: AiProvider): Promise<string[]> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/models`;
  const resp = await fetch(proxyUrl(url), { headers: authHeaders(provider) });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`获取模型失败 (${resp.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const payload = (await resp.json()) as { data?: Array<{ id?: string }> };
  const ids = (payload.data ?? [])
    .map((item) => String(item.id ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

export interface StreamChatCallbacks {
  onDelta: (delta: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export interface StreamChatParams {
  provider: AiProvider;
  model: AiModel;
  messages: AiMessage[];
  signal?: AbortSignal;
}

/** 组 chat_completions 的 messages（多模态用 content 数组）。 */
function buildChatMessages(messages: AiMessage[], multimodal: boolean): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "user" && multimodal && msg.images && msg.images.length > 0) {
      const parts: unknown[] = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      for (const image of msg.images) {
        parts.push({ type: "image_url", image_url: { url: image.dataUrl } });
      }
      return { role: msg.role, content: parts };
    }
    return { role: msg.role, content: msg.content };
  });
}

/** 组 responses 的 input（多模态用 input_image 块）。 */
function buildResponsesInput(messages: AiMessage[], multimodal: boolean): unknown[] {
  return messages.map((msg) => {
    const textType = msg.role === "assistant" ? "output_text" : "input_text";
    if (msg.role === "user" && multimodal && msg.images && msg.images.length > 0) {
      const parts: unknown[] = [];
      if (msg.content) parts.push({ type: "input_text", text: msg.content });
      for (const image of msg.images) {
        parts.push({ type: "input_image", image_url: image.dataUrl });
      }
      return { role: msg.role, content: parts };
    }
    return { role: msg.role, content: [{ type: textType, text: msg.content }] };
  });
}

/**
 * 读取 SSE 流，逐个 `data:` 事件回调 onEvent。遇到 `[DONE]` 结束。
 */
async function readSse(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (json: unknown) => void,
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("响应没有可读流。");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以换行分隔；逐行取 data:
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, sepIndex).trim();
        buffer = buffer.slice(sepIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        try {
          onEvent(JSON.parse(data));
        } catch {
          // 忽略无法解析的分片（部分供应商会插入非 JSON keep-alive）
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 从 chat_completions 的 SSE 事件里取文本增量。 */
function chatDelta(event: unknown): string {
  const choices = (event as { choices?: Array<{ delta?: { content?: string } }> }).choices;
  return choices?.[0]?.delta?.content ?? "";
}

/** 从 responses 的 SSE 事件里取文本增量。 */
function responsesDelta(event: unknown): string {
  const e = event as { type?: string; delta?: unknown };
  if (e.type === "response.output_text.delta" && typeof e.delta === "string") {
    return e.delta;
  }
  return "";
}

/**
 * 发起一次流式对话。messages 为完整历史（含最新用户消息），assistant 增量经
 * onDelta 回调。调用方负责把增量拼进 UI 与落盘。
 */
export async function streamChat(
  params: StreamChatParams,
  callbacks: StreamChatCallbacks,
): Promise<void> {
  const { provider, model, messages, signal } = params;
  const base = normalizeBaseUrl(provider.baseUrl);

  try {
    let url: string;
    let body: unknown;
    let extract: (event: unknown) => string;

    if (provider.protocol === "responses") {
      url = `${base}/responses`;
      body = {
        model: model.modelId,
        input: buildResponsesInput(messages, model.multimodal),
        max_output_tokens: model.maxOutputTokens,
        stream: true,
      };
      extract = responsesDelta;
    } else {
      url = `${base}/chat/completions`;
      body = {
        model: model.modelId,
        messages: buildChatMessages(messages, model.multimodal),
        max_tokens: model.maxOutputTokens,
        stream: true,
      };
      extract = chatDelta;
    }

    const response = await fetch(proxyUrl(url), {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`请求失败 (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    await readSse(response, signal, (event) => {
      const delta = extract(event);
      if (delta) callbacks.onDelta(delta);
    });
    callbacks.onDone();
  } catch (err) {
    if (signal?.aborted) {
      // 用户主动取消：视为正常收尾
      callbacks.onDone();
      return;
    }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 把 Blob 转 data URL（多模态图片直接进请求体用）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("图片读取失败。"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败。"));
    reader.readAsDataURL(blob);
  });
}

export type { AiImage };
