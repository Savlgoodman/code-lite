import { ensureBackend } from "./agentClient";
import type {
  AppAboutInfo,
  AgentRuntimeModelsResult,
  AgentRuntimeConfig,
  AgentRuntimeSettingsState,
  ConfiguredModel,
  ConfiguredModelProvider,
  DefaultModelStrategy,
  ModelCapabilities,
  ModelGeneration,
  ModelLimits,
  ModelProtocol,
  LogFilesResult,
  LogTailResult,
  ModelProviderModelsResult,
  ModelSettingsState,
  SavedModelProviderResult
} from "../types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message = typeof payload?.error === "string" ? payload.error : `Backend returned ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export async function loadAppAbout(): Promise<AppAboutInfo> {
  return requestJson<AppAboutInfo>("/api/settings/about");
}

export async function loadLogFiles(): Promise<LogFilesResult> {
  return requestJson<LogFilesResult>("/api/logs/files");
}

export async function loadLogTail(options: {
  category?: string;
  level?: string;
  runtime?: string;
  query?: string;
  limit?: number;
} = {}): Promise<LogTailResult> {
  const params = new URLSearchParams();
  if (options.category) params.set("category", options.category);
  if (options.level) params.set("level", options.level);
  if (options.runtime) params.set("runtime", options.runtime);
  if (options.query) params.set("query", options.query);
  if (options.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params}` : "";
  return requestJson<LogTailResult>(`/api/logs/tail${suffix}`);
}

export async function loadAgentRuntimeSettings(): Promise<AgentRuntimeSettingsState> {
  return requestJson<AgentRuntimeSettingsState>("/api/settings/agent-runtimes");
}

export async function updateAgentRuntime(
  runtimeId: string,
  patch: Partial<Omit<Pick<AgentRuntimeConfig, "codexPath" | "command" | "configMode" | "enabled" | "mode">, "command">> & {
    command?: string | string[];
  }
): Promise<AgentRuntimeConfig> {
  return requestJson<AgentRuntimeConfig>(`/api/settings/agent-runtimes/${runtimeId}`, {
    body: JSON.stringify(patch),
    method: "PATCH"
  });
}

export async function installAgentRuntime(runtimeId: string): Promise<AgentRuntimeConfig> {
  return requestJson<AgentRuntimeConfig>(`/api/settings/agent-runtimes/${runtimeId}/install`, {
    method: "POST"
  });
}

export async function updateActiveAgentRuntime(adapter: string): Promise<AgentRuntimeSettingsState> {
  return requestJson<AgentRuntimeSettingsState>("/api/settings/agent-runtimes/active", {
    body: JSON.stringify({ adapter }),
    method: "PATCH"
  });
}

export async function loadAgentRuntimeModels(runtimeId: string): Promise<AgentRuntimeModelsResult> {
  return requestJson<AgentRuntimeModelsResult>(`/api/settings/agent-runtimes/${runtimeId}/models`);
}

export async function fetchProviderModels(options: {
  apiKey: string;
  baseUrl: string;
}): Promise<ModelProviderModelsResult> {
  return requestJson<ModelProviderModelsResult>("/api/settings/model-providers/models", {
    body: JSON.stringify({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl
    }),
    method: "POST"
  });
}

export async function loadModelSettings(): Promise<ModelSettingsState> {
  return requestJson<ModelSettingsState>("/api/settings/model-providers");
}

export async function createModelProvider(options: {
  apiKey: string;
  baseUrl: string;
  name: string;
  protocol: ModelProtocol;
}): Promise<ConfiguredModelProvider> {
  return requestJson<ConfiguredModelProvider>("/api/settings/model-providers", {
    body: JSON.stringify(options),
    method: "POST"
  });
}

export async function updateModelProvider(
  providerId: string,
  patch: Partial<Pick<ConfiguredModelProvider, "baseUrl" | "enabled" | "name" | "protocol">> & { apiKey?: string }
): Promise<ConfiguredModelProvider> {
  return requestJson<ConfiguredModelProvider>(`/api/settings/model-providers/${providerId}`, {
    body: JSON.stringify(patch),
    method: "PATCH"
  });
}

export async function refreshModelProviderModels(providerId: string): Promise<ConfiguredModelProvider> {
  return requestJson<ConfiguredModelProvider>(`/api/settings/model-providers/${providerId}/models/refresh`, {
    method: "POST"
  });
}

export async function addProviderModels(
  providerId: string,
  models: Array<{
    capabilities?: Partial<ModelCapabilities>;
    generation?: Partial<ModelGeneration>;
    label?: string;
    limits?: Partial<ModelLimits>;
    model: string;
    protocol?: ModelProtocol;
  }>
): Promise<ModelSettingsState> {
  return requestJson<ModelSettingsState>(`/api/settings/model-providers/${providerId}/models`, {
    body: JSON.stringify({ models }),
    method: "POST"
  });
}

export async function updateConfiguredModel(
  modelId: string,
  patch: Partial<Pick<ConfiguredModel, "capabilities" | "enabled" | "generation" | "label" | "limits" | "protocol">>
): Promise<ConfiguredModel> {
  return requestJson<ConfiguredModel>(`/api/settings/models/${modelId}`, {
    body: JSON.stringify(patch),
    method: "PATCH"
  });
}

export async function deleteConfiguredModel(modelId: string): Promise<ModelSettingsState> {
  return requestJson<ModelSettingsState>(`/api/settings/models/${modelId}`, {
    method: "DELETE"
  });
}

export async function deleteModelProvider(providerId: string): Promise<ModelSettingsState> {
  return requestJson<ModelSettingsState>(`/api/settings/model-providers/${providerId}`, {
    method: "DELETE"
  });
}

export async function updateDefaultModel(options: {
  defaultModelId: string | null;
  defaultStrategy: DefaultModelStrategy;
}): Promise<ModelSettingsState> {
  return requestJson<ModelSettingsState>("/api/settings/models/default", {
    body: JSON.stringify(options),
    method: "PATCH"
  });
}

export async function saveDefaultModelProvider(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  supportsReasoning: boolean;
}): Promise<SavedModelProviderResult> {
  return requestJson<SavedModelProviderResult>("/api/settings/model-providers/default", {
    body: JSON.stringify({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      supportsReasoning: options.supportsReasoning
    }),
    method: "POST"
  });
}
