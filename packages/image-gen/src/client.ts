import { buildGenerateBody } from "./request";
import type { ImageGenTransport } from "./transport";
import type {
  ImageAsset,
  ImageGenRecord,
  ImageGenRecordSummary,
  ImageGenRequest,
  ImageGenRun,
  ImageProvider,
  ImageProviderCreateInput,
  ImageProviderUpdateInput,
  PromptOptimizeRequest,
  PromptOptimizeResult
} from "./types";

/**
 * 生图客户端：调用方只关心参数（apiKey/url/modelId/prompt/参考图等），
 * 不关心 CORS/密钥/落盘。密钥由后端按 providerId 注入。
 */
export function createImageGenClient(transport: ImageGenTransport) {
  return {
    listProviders(): Promise<ImageProvider[]> {
      return transport
        .request<{ providers: ImageProvider[] }>("/api/image/providers", { method: "GET" })
        .then((result) => result.providers);
    },
    createProvider(input: ImageProviderCreateInput): Promise<ImageProvider> {
      return transport.request<ImageProvider>("/api/image/providers", { method: "POST", body: input });
    },
    updateProvider(providerId: string, patch: ImageProviderUpdateInput): Promise<ImageProvider> {
      return transport.request<ImageProvider>(`/api/image/providers/${providerId}`, {
        method: "PATCH",
        body: patch
      });
    },
    deleteProvider(providerId: string): Promise<void> {
      return transport
        .request<unknown>(`/api/image/providers/${providerId}`, { method: "DELETE" })
        .then(() => undefined);
    },

    listRecords(): Promise<ImageGenRecordSummary[]> {
      return transport
        .request<{ records: ImageGenRecordSummary[] }>("/api/image/records", { method: "GET" })
        .then((result) => result.records);
    },
    getRecord(recordId: string): Promise<ImageGenRecord> {
      return transport.request<ImageGenRecord>(`/api/image/records/${recordId}`, { method: "GET" });
    },
    createRecord(): Promise<ImageGenRecord> {
      return transport.request<ImageGenRecord>("/api/image/records", { method: "POST" });
    },
    deleteRecord(recordId: string): Promise<void> {
      return transport
        .request<unknown>(`/api/image/records/${recordId}`, { method: "DELETE" })
        .then(() => undefined);
    },

    uploadReference(recordId: string, file: File): Promise<ImageAsset> {
      const form = new FormData();
      form.append("file", file);
      return transport.upload<ImageAsset>(`/api/image/records/${recordId}/references`, form);
    },
    deleteReference(recordId: string, imageId: string): Promise<void> {
      return transport
        .request<unknown>(`/api/image/records/${recordId}/references/${imageId}`, { method: "DELETE" })
        .then(() => undefined);
    },

    generate(recordId: string, request: ImageGenRequest): Promise<ImageGenRun> {
      const body = buildGenerateBody(request);
      return transport.request<ImageGenRun>(`/api/image/records/${recordId}/generate`, {
        method: "POST",
        body
      });
    },

    optimizePrompt(request: PromptOptimizeRequest): Promise<PromptOptimizeResult> {
      return transport.request<PromptOptimizeResult>("/api/image/optimize-prompt", {
        method: "POST",
        body: request
      });
    }
  };
}

export type ImageGenClient = ReturnType<typeof createImageGenClient>;
