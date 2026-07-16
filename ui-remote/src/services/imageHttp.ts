/**
 * imageHttp — 图片生成 API 的 HTTP seam（按运行环境分流）
 *
 * 与 aiClient/httpTransport 同理，直连供应商会撞 CORS，三种环境各走一条路：
 * - dev（浏览器）：经同源 /ai-proxy 中间件转发 fetch（JSON 与图片下载都走它）。
 * - 原生（Android/iOS）：@capacitor/core 内置 CapacitorHttp 原生 HTTP，绕开 WebView CORS，
 *   JSON 请求/响应，并能拿到 HTTP status（流式插件拿不到）。
 * - PWA / 生产静态部署：入口已由 isAiAvailable() 禁用，不会走到这里。
 *
 * 生图接口返回一次性 JSON（非 SSE 流），故用 CapacitorHttp 而非流式插件。
 * 详见 docs/design/0713-IMAGE-GENERATION.md 第 10 节。
 */

import { CapacitorHttp } from "@capacitor/core";
import {
  DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS,
  normalizeImageRequestTimeoutSeconds,
  type ImageJsonHttp,
} from "@code-lite/image-gen";
import { isNativeApp } from "../lib/environment";

const IMAGE_CONNECT_TIMEOUT_MS = 30_000;

/** dev/web 分支：把真实 URL 映射到同源 /ai-proxy 转发地址。 */
function proxyUrl(url: string): string {
  return `/ai-proxy/${url}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  return headers;
}

/** 发一次 JSON POST，返回解析后的 JSON 对象；非 2xx 抛错。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function timeoutMilliseconds(requestTimeoutSeconds: number): number {
  return normalizeImageRequestTimeoutSeconds(requestTimeoutSeconds) * 1000;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

function isTimeoutError(error: unknown): boolean {
  return /timeout|timed out|time out/i.test(errorMessage(error));
}

async function withFetchTimeout<T>(
  requestTimeoutSeconds: number,
  signal: AbortSignal | undefined,
  label: string,
  request: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const timeoutSeconds = normalizeImageRequestTimeoutSeconds(requestTimeoutSeconds);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);

  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label}超时（${timeoutSeconds} 秒）`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
  requestTimeoutSeconds = DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS,
): Promise<unknown> {
  throwIfAborted(signal);
  const normalizedTimeout = normalizeImageRequestTimeoutSeconds(requestTimeoutSeconds);
  const requestTimeoutMs = timeoutMilliseconds(normalizedTimeout);
  if (isNativeApp()) {
    let resp: Awaited<ReturnType<typeof CapacitorHttp.request>>;
    try {
      resp = await CapacitorHttp.request({
        url,
        method: "POST",
        headers: authHeaders(apiKey),
        data: body,
        connectTimeout: Math.min(IMAGE_CONNECT_TIMEOUT_MS, requestTimeoutMs),
        readTimeout: requestTimeoutMs,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(`图片请求超时（${normalizedTimeout} 秒）`);
      }
      throw error;
    }
    throwIfAborted(signal);
    if (resp.status < 200 || resp.status >= 300) {
      const detail = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      throw new Error(mapStatusError(resp.status, detail));
    }
    // CapacitorHttp 会按 Content-Type 自动解析 JSON；字符串则手动 parse。
    return typeof resp.data === "string" ? safeParse(resp.data) : resp.data;
  }
  return withFetchTimeout(normalizedTimeout, signal, "图片请求", async (requestSignal) => {
    const resp = await fetch(proxyUrl(url), {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(mapStatusError(resp.status, detail));
    }
    return resp.json();
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`供应商返回内容无法解析${text ? `：${text.slice(0, 200)}` : ""}`);
  }
}

function mapStatusError(status: number, detail: string): string {
  const snippet = detail ? `：${detail.slice(0, 200)}` : "";
  if (status === 401) return "API Key 无效";
  if (status === 402) return "供应商余额不足";
  if (status === 403) return "内容安全策略拦截，请调整提示词后重试";
  if (status === 429) return "请求过于频繁，请稍后重试";
  return `请求失败 (${status})${snippet}`;
}

/** 把 data URL 直接解码成 Blob（不走网络/代理）。 */
function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("图片 data URL 格式不正确");
  const mime = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const raw = match[3];
  if (isBase64) {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(raw)], { type: mime });
}

/**
 * 下载图片直链为 Blob（供应商返回 response_format=url 时用）。
 * data URL 直接解码；http(s) 直链 dev 经 /ai-proxy，原生用 CapacitorHttp responseType=blob。
 */
export async function downloadImage(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
  requestTimeoutSeconds = DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS,
): Promise<Blob> {
  throwIfAborted(signal);
  // 有的供应商在 url 字段里塞的是 data URL，直接解码，不能套代理前缀。
  if (url.startsWith("data:")) {
    const blob = dataUrlToBlob(url);
    throwIfAborted(signal);
    return blob;
  }
  const normalizedTimeout = normalizeImageRequestTimeoutSeconds(requestTimeoutSeconds);
  const requestTimeoutMs = timeoutMilliseconds(normalizedTimeout);
  if (isNativeApp()) {
    let resp: Awaited<ReturnType<typeof CapacitorHttp.request>>;
    try {
      resp = await CapacitorHttp.request({
        url,
        method: "GET",
        headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : undefined,
        responseType: "blob",
        connectTimeout: Math.min(IMAGE_CONNECT_TIMEOUT_MS, requestTimeoutMs),
        readTimeout: requestTimeoutMs,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(`图片下载超时（${normalizedTimeout} 秒）`);
      }
      throw error;
    }
    throwIfAborted(signal);
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`图片下载失败 (${resp.status})`);
    }
    // 原生 blob 响应体是 base64 字符串。
    const base64 = typeof resp.data === "string" ? resp.data : "";
    const mime = String(resp.headers?.["Content-Type"] ?? resp.headers?.["content-type"] ?? "image/png").split(";")[0];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/png" });
  }
  return withFetchTimeout(normalizedTimeout, signal, "图片下载", async (requestSignal) => {
    const resp = await fetch(proxyUrl(url), {
      method: "GET",
      headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : undefined,
      signal: requestSignal,
    });
    if (!resp.ok) throw new Error(`图片下载失败 (${resp.status})`);
    return resp.blob();
  });
}

/** 提供给共享包直连客户端的 JSON HTTP 实现。 */
export function createImageJsonHttp(
  signal?: AbortSignal,
  requestTimeoutSeconds = DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS,
): ImageJsonHttp {
  return {
    postJson: (url, apiKey, body) => postJson(
      url,
      apiKey,
      body,
      signal,
      requestTimeoutSeconds,
    ),
  };
}

export const imageJsonHttp: ImageJsonHttp = createImageJsonHttp();
