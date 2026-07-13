import type { PromptOptimizeSettings } from "../types";

import { ensureBackend } from "./agentClient";

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

export async function loadPromptOptimizeSettings(): Promise<PromptOptimizeSettings> {
  const result = await requestJson<{ promptOptimize: PromptOptimizeSettings }>("/api/settings/features");
  return result.promptOptimize;
}

export async function updatePromptOptimizeSettings(
  patch: Partial<PromptOptimizeSettings>
): Promise<PromptOptimizeSettings> {
  const result = await requestJson<{ promptOptimize: PromptOptimizeSettings }>("/api/settings/features", {
    body: JSON.stringify({ promptOptimize: patch }),
    method: "PATCH"
  });
  return result.promptOptimize;
}

/** code agent 提示词优化：把 workspace 根目录 AGENTS.md/CLAUDE.md 注入模板后调用文本模型。 */
export async function optimizeCodePrompt(options: {
  prompt: string;
  workspace?: string;
  modelId?: string;
}): Promise<string> {
  const result = await requestJson<{ prompt: string }>("/api/settings/optimize-code-prompt", {
    body: JSON.stringify({
      prompt: options.prompt,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {})
    }),
    method: "POST"
  });
  return result.prompt;
}
