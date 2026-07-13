import {
  createImageGenClient,
  type ImageGenClient,
  type ImageGenTransport
} from "@code-lite/image-gen";

import { ensureBackend } from "./agentClient";

async function parseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined);
  if (payload && typeof (payload as { error?: unknown }).error === "string") {
    return (payload as { error: string }).error;
  }
  return `Backend returned ${response.status}`;
}

const transport: ImageGenTransport = {
  async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const baseUrl = await ensureBackend();
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    return response.json() as Promise<T>;
  },
  async upload<T>(path: string, form: FormData): Promise<T> {
    const baseUrl = await ensureBackend();
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    return response.json() as Promise<T>;
  }
};

let client: ImageGenClient | null = null;

export function getImageGenClient(): ImageGenClient {
  if (!client) {
    client = createImageGenClient(transport);
  }
  return client;
}

/** 把后端相对图片路径拼成可直接用于 <img src> 的绝对地址。 */
export async function resolveImageUrl(url: string | null | undefined): Promise<string> {
  if (!url) {
    return "";
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const baseUrl = await ensureBackend();
  return `${baseUrl}${url}`;
}
