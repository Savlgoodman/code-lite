/**
 * httpTransport — AI API 的 HTTP 传输 seam（按运行环境选择实现）。
 *
 * AI 直连大模型会撞上浏览器/WebView 的 CORS。三种环境各走一条路：
 * - dev（浏览器）：经同源 /ai-proxy 中间件转发（vite.config.ts），fetch + 真流式。
 * - 原生（Android/iOS）：capacitor-stream-http-v2 用原生 HTTP 发起，绕开 WebView CORS，
 *   并把 chunk/end/error 事件桥接成标准 ReadableStream，保留逐字流式（不整段缓冲）。
 * - PWA / 生产静态部署：AI 入口已由 isAiAvailable() 整体禁用，不会走到这里。
 *
 * 上层（aiClient）只认这里暴露的 openStream / requestText，不关心底层是 fetch 还是原生插件。
 * 详见 docs/design/0712-REMOTE-NAV-AND-STREAMING.md 与 AGENTS.md「AI 功能的环境可用性」。
 */

import { StreamHttp } from "capacitor-stream-http-v2";
import { isNativeApp } from "../lib/environment";

export interface HttpStreamInit {
  method: string;
  headers?: Record<string, string>;
  /** 请求体（已序列化为字符串）。 */
  body?: string;
  signal?: AbortSignal;
}

/** dev/web 分支：把真实 URL 映射到同源 /ai-proxy 转发地址。 */
function proxyUrl(url: string): string {
  return `/ai-proxy/${url}`;
}

/**
 * 原生分支：用流式插件发起请求，把事件桥接为 ReadableStream<Uint8Array>。
 *
 * 局限：插件事件只有 chunk/end/error，拿不到 HTTP status / 响应头，因此无法像 fetch
 * 那样在开流前判定 resp.ok；非 2xx 通常经 error 事件到达，这里让流 error 出来，由调用方
 * 的 try/catch 统一转成 onError。
 */
function nativeStream(url: string, init: HttpStreamInit): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let streamId: string | null = null;
  const removers: Array<() => void> = [];
  let onAbort: (() => void) | null = null;

  const cleanup = () => {
    for (const remove of removers) remove();
    removers.length = 0;
    if (onAbort && init.signal) init.signal.removeEventListener("abort", onAbort);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const chunkL = await StreamHttp.addListener("chunk", (data) => {
          if (streamId && data.id !== streamId) return;
          if (typeof data.chunk === "string" && data.chunk.length > 0) {
            controller.enqueue(encoder.encode(data.chunk));
          }
        });
        removers.push(() => chunkL.remove());

        const endL = await StreamHttp.addListener("end", (data) => {
          if (streamId && data.id !== streamId) return;
          cleanup();
          controller.close();
        });
        removers.push(() => endL.remove());

        const errL = await StreamHttp.addListener("error", (data) => {
          if (streamId && data.id !== streamId) return;
          cleanup();
          controller.error(new Error(data.error || "原生 HTTP 流出错"));
        });
        removers.push(() => errL.remove());

        const { id } = await StreamHttp.startStream({
          url,
          method: init.method,
          headers: init.headers,
          body: init.body,
        });
        streamId = id;

        // 开流后若已收到取消信号，立即取消原生流。
        if (init.signal) {
          onAbort = () => {
            if (streamId) void StreamHttp.cancelStream({ id: streamId });
            cleanup();
            controller.error(new DOMException("Aborted", "AbortError"));
          };
          if (init.signal.aborted) onAbort();
          else init.signal.addEventListener("abort", onAbort);
        }
      } catch (err) {
        cleanup();
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
    cancel() {
      if (streamId) void StreamHttp.cancelStream({ id: streamId });
      cleanup();
    },
  });
}

/**
 * 打开一个响应流。返回标准 ReadableStream<Uint8Array>，供 SSE 逐块读取。
 * dev/web 分支在开流前校验 HTTP 状态，非 2xx 抛出带状态码与响应片段的错误。
 */
export async function openStream(url: string, init: HttpStreamInit): Promise<ReadableStream<Uint8Array>> {
  if (isNativeApp()) {
    return nativeStream(url, init);
  }
  const resp = await fetch(proxyUrl(url), {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`请求失败 (${resp.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  if (!resp.body) throw new Error("响应没有可读流。");
  return resp.body;
}

/** 读尽一个流并解码为字符串（用于非流式 GET，如 /models）。 */
export async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}
