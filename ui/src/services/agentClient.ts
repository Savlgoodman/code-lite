import { invoke } from "@tauri-apps/api/core";

import type { AgentEvent, MessageAttachment, Session, SessionCapabilities, UserContentBlock } from "../types";
import { LocalTransport } from "./localTransport";

// 共享 WS 传输：本地桌面前端的事件源与命令通道（0709 阶段二）。
let sharedTransport: LocalTransport | null = null;

export function getLocalTransport(): LocalTransport {
  if (!sharedTransport) {
    sharedTransport = new LocalTransport();
  }
  return sharedTransport;
}

interface BackendStatus {
  base_url?: string;
  baseUrl?: string;
  reused: boolean;
}

export interface StartTurnOptions {
  accessMode?: string | null;
  conversationId?: string;
  input: string;
  contentBlocks?: UserContentBlock[];
  modelId?: string | null;
  modelLabel?: string | null;
  reasoningEffort?: string | null;
  selectedConfig?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  turnId: string;
  onEvent: (event: AgentEvent) => void;
}

export interface UploadTurnAttachmentInput {
  blob: Blob;
  fileName: string;
  height?: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  wasCompressed?: boolean;
  width?: number;
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

export async function attachmentImageUrl(
  conversationId: string,
  attachmentId: string,
): Promise<string> {
  const baseUrl = await ensureBackend();
  return `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/image`;
}

export async function uploadTurnAttachments(options: {
  conversationId: string;
  turnId: string;
  images: UploadTurnAttachmentInput[];
}): Promise<MessageAttachment[]> {
  if (options.images.length === 0) {
    return [];
  }
  const baseUrl = await ensureBackend();
  const form = new FormData();
  for (const image of options.images) {
    form.append("files", image.blob, image.fileName);
    form.append("widths", String(image.width ?? ""));
    form.append("heights", String(image.height ?? ""));
    form.append("wasCompressed", image.wasCompressed ? "true" : "false");
  }
  const response = await fetch(
    `${baseUrl}/api/conversations/${encodeURIComponent(options.conversationId)}/turns/${encodeURIComponent(options.turnId)}/attachments`,
    {
      body: form,
      method: "POST",
    },
  );

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: string };
      detail = payload.error ?? "";
    } catch {
      detail = "";
    }
    throw new Error(detail || `Backend returned ${response.status}`);
  }

  const payload = await response.json() as { attachments: MessageAttachment[] };
  return payload.attachments;
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

/**
 * 通过 WS 发起一个 turn 并把本 turn 的事件驱动给 onEvent。
 *
 * 契约与旧 NDJSON 版本一致：为本 turn 的每个事件调用 onEvent，turn 到达
 * 终止事件（run.completed/failed）时 resolve；signal.abort 时提前结束。
 * 事件按 turnId 过滤——turnId 由前端生成且稳定，draft 会话也可靠。
 * 后端在启动 turn 前已自动订阅该会话频道，故不会漏早期事件（0709 阶段二）。
 */
export async function streamAgentTurn(options: StartTurnOptions): Promise<void> {
  const transport = getLocalTransport();
  await transport.connect();

  const turnId = options.turnId;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribeEvents: (() => void) | null = null;
    let abortTimer: number | null = null;

    const cleanup = () => {
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      if (abortTimer !== null) {
        window.clearTimeout(abortTimer);
        abortTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    function onAbort() {
      // 中止：不立即退订。实际取消由 cancelTurn 走 turn.cancel，后端会发出
      // agent.run.failed 终止事件，仍需它到达才能清掉 streaming 状态（否则一直"正在思考"）。
      // 兜底：若 3s 内没等到终止事件（异常场景），本地合成一条 run.failed 收尾。
      if (settled || abortTimer !== null) {
        return;
      }
      abortTimer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        options.onEvent({
          type: "agent.run.failed",
          conversationId: options.conversationId ?? "",
          turnId,
          error: "用户取消了当前任务。"
        } as AgentEvent);
        finish();
      }, 3000);
    }

    unsubscribeEvents = transport.onEvent((event) => {
      if ((event as { turnId?: string }).turnId !== turnId) {
        return;
      }
      options.onEvent(event);
      if (event.type === "agent.run.completed" || event.type === "agent.run.failed") {
        finish();
      }
    });

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort);
      }
    }

    transport
      .request("turn.start", {
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.accessMode ? { accessMode: options.accessMode } : {}),
        input: options.input,
        ...(options.contentBlocks ? { contentBlocks: options.contentBlocks } : {}),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.selectedConfig ? { selectedConfig: options.selectedConfig } : {}),
        turnId
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
  });
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

export async function sendInputResponse(
  inputRequestId: string,
  action: "accept" | "decline" | "cancel",
  content?: Record<string, unknown>,
): Promise<{ session?: Session }> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/inputs/${inputRequestId}/response`, {
    body: JSON.stringify({ action, ...(content ? { content } : {}) }),
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
