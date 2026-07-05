import { invoke } from "@tauri-apps/api/core";

import type { AgentEvent, Session, SessionCapabilities } from "../types";

interface BackendStatus {
  base_url?: string;
  baseUrl?: string;
  reused: boolean;
}

export interface StartTurnOptions {
  accessMode?: string | null;
  conversationId?: string;
  input: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  selectedConfig?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  turnId: string;
  onEvent: (event: AgentEvent) => void;
}

const FALLBACK_BACKEND_URL = "http://127.0.0.1:18765";

function hasTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function backendUrlFromStatus(status: BackendStatus): string {
  return status.base_url ?? status.baseUrl ?? FALLBACK_BACKEND_URL;
}

export async function ensureBackend(): Promise<string> {
  if (!hasTauri()) {
    return FALLBACK_BACKEND_URL;
  }

  const status = await invoke<BackendStatus>("ensure_backend");
  return backendUrlFromStatus(status);
}

/** 进入对话时调用，初始化 ACP session 并返回 SessionCapabilities。 */
export async function initializeSession(conversationId: string): Promise<SessionCapabilities> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(conversationId)}/initialize`, {
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<SessionCapabilities>;
}

export async function createConversation(options: {
  agentId: string;
  title?: string;
  preview?: string;
  workspace?: string;
}): Promise<{ session: Session; messages: unknown[] }> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/conversations`, {
    body: JSON.stringify(options),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<{ session: Session; messages: unknown[] }>;
}

export interface ConversationEventsResult {
  events: Array<Record<string, unknown>>;
}

export async function getConversationEvents(
  conversationId: string,
  afterSequence = 0,
): Promise<ConversationEventsResult> {
  const baseUrl = await ensureBackend();
  const params = afterSequence > 0 ? `?after=${afterSequence}` : "";
  const response = await fetch(
    `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/events${params}`,
    { headers: { "Content-Type": "application/json" } },
  );

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<ConversationEventsResult>;
}

export async function streamAgentTurn(options: StartTurnOptions): Promise<void> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/turns/stream`, {
    body: JSON.stringify({
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.accessMode ? { accessMode: options.accessMode } : {}),
      input: options.input,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.selectedConfig ? { selectedConfig: options.selectedConfig } : {}),
      turnId: options.turnId
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST",
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Backend did not return a readable stream.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line) {
        continue;
      }

      options.onEvent(JSON.parse(line) as AgentEvent);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    options.onEvent(JSON.parse(tail) as AgentEvent);
  }
}

export async function sendApprovalDecision(
  approvalId: string,
  decision: "allow" | "deny",
): Promise<{ session?: Session }> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/approvals/${approvalId}/decision`, {
    body: JSON.stringify({ decision }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<{ session?: Session }>;
}

export async function cancelTurn(turnId: string): Promise<void> {
  const baseUrl = await ensureBackend();
  await fetch(`${baseUrl}/api/turns/${turnId}/cancel`, {
    method: "POST"
  });
}
