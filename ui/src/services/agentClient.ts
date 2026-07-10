import { invoke } from "@tauri-apps/api/core";

import type { AgentEvent, MessageAttachment, Session, SessionCapabilities, UserContentBlock } from "../types";
import { LocalTransport } from "./localTransport";
import { SyncManager } from "@code-lite/sync";
import { ConversationClient } from "@code-lite/chat-core";

// 共享 WS 传输：本地桌面前端的事件源与命令通道（0709 阶段二）。
let sharedTransport: LocalTransport | null = null;

export function getLocalTransport(): LocalTransport {
  if (!sharedTransport) {
    // 注入 Tauri 后端发现作为 urlProvider（避免 packages 依赖 Tauri）。
    sharedTransport = new LocalTransport(ensureBackend);
  }
  return sharedTransport;
}

// 共享 SyncManager（role=host）：统一处理运行态与配置的双端同步。
let sharedSyncManager: SyncManager | null = null;

export function getSyncManager(): SyncManager {
  if (!sharedSyncManager) {
    sharedSyncManager = new SyncManager({ transport: getLocalTransport(), role: "host" });
  }
  return sharedSyncManager;
}

// 共享 ConversationClient（role=host）：会话列表 + 视图态的统一状态层。
let sharedConversationClient: ConversationClient | null = null;

export function getConversationClient(): ConversationClient {
  if (!sharedConversationClient) {
    sharedConversationClient = new ConversationClient({
      transport: getLocalTransport(),
      sync: getSyncManager(),
    });
  }
  return sharedConversationClient;
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
  /**
   * 事件回调：由调用方注册。事件不再由本函数订阅 transport，而是由 ChatPage
   * 的全局 WS 事件监听分发（0709 阶段二），保证第二个前端也能实时看到 turn。
   * 本函数只负责发 turn.start RPC 并把 terminal 事件到达时机映射到 Promise 收尾。
   */
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

/** 进入对话时调用，初始化 ACP session 并返回 SessionCapabilities（0710 收敛：走 WS RPC）。 */
export async function initializeSession(conversationId: string): Promise<SessionCapabilities> {
  const transport = getLocalTransport();
  await transport.connect();
  return transport.request<SessionCapabilities>("session.initialize", { conversationId });
}

export async function createConversation(options: {
  agentId: string;
  title?: string;
  preview?: string;
  workspace?: string;
}): Promise<{ session: Session; messages: unknown[] }> {
  // 0709 阶段二：走 WS RPC，后端自动广播 conversation.created 到全局频道
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ session: Session; messages: unknown[] }>(
    "conversation.create",
    options,
  );
  return result;
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
 * 通过 WS 发起一个 turn。事件不再由本函数订阅 transport，而是由 ChatPage
 * 的全局 WS 事件监听分发（0709 阶段二）：
 * - 本函数只负责发 turn.start RPC；
 * - terminal 事件（run.completed/run.failed）由外部调用 notifyTurnEvent 通知，
 *   本函数据此 resolve；
 * - abort 后由 stopCurrentTurn 乐观清理 UI，不再在本函数内合成 fallback 事件
 *   （但保留 10s 兜底：若外部未收到 terminal 事件，合成一条保证 resolve）。
 */
export async function streamAgentTurn(options: StartTurnOptions): Promise<void> {
  const transport = getLocalTransport();
  await transport.connect();

  const turnId = options.turnId;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let abortTimer: number | null = null;
    // turn.start 的 result 回带真实 conversationId（draft→real）。兜底合成终止事件时
    // 必须用它路由，否则 draft 场景会带空 conversationId 落到错误会话，清不掉"正在思考"。
    let resolvedConversationId = options.conversationId ?? "";

    const cleanup = () => {
      if (abortTimer !== null) {
        window.clearTimeout(abortTimer);
        abortTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      turnResolvers.delete(turnId);
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
      // 中止：UI 由 stopCurrentTurn 即时清理。这里只启动兜底定时器，
      // 以防极端情况下后端未发 run.failed 导致 Promise 永不 resolve。
      if (settled || abortTimer !== null) {
        return;
      }
      abortTimer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        options.onEvent({
          type: "agent.run.failed",
          conversationId: resolvedConversationId,
          turnId,
          error: "用户取消了当前任务。"
        } as AgentEvent);
        finish();
      }, 10000);
    }

    // 全局事件监听 → 本 turn 的事件转给 onEvent，terminal 事件 resolve。
    turnResolvers.set(turnId, (event) => {
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
      .then((result) => {
        const realId = (result as { conversationId?: string } | undefined)?.conversationId;
        if (realId) {
          resolvedConversationId = realId;
        }
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/**
 * 全局事件路由入口。ChatPage 在注册 WS 全局监听后，把每条事件喂进来；
 * 本模块按 turnId 分发给对应的 streamAgentTurn 调用方。
 */
export function notifyTurnEvent(event: AgentEvent): void {
  const turnId = (event as { turnId?: string }).turnId;
  if (!turnId) {
    return;
  }
  const resolver = turnResolvers.get(turnId);
  if (resolver) {
    resolver(event);
  }
}

const turnResolvers = new Map<string, (event: AgentEvent) => void>();

export async function sendApprovalDecision(
  approvalId: string,
  decision: "allow" | "deny",
): Promise<{ session?: Session }> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ ok: boolean }>("approval.decision", { approvalId, decision });
  // 后端 approval.decision 返回 { ok: boolean }，审批状态通过事件总线回流
  return { session: undefined };
}

export async function sendInputResponse(
  inputRequestId: string,
  action: "accept" | "decline" | "cancel",
  content?: Record<string, unknown>,
): Promise<{ session?: Session }> {
  const transport = getLocalTransport();
  await transport.connect();
  await transport.request("input.response", {
    inputRequestId,
    action,
    ...(content ? { content } : {}),
  });
  // 后端 input.response 后，会话状态通过事件总线回流
  return { session: undefined };
}

export async function cancelTurn(turnId: string): Promise<void> {
  // 走 WS RPC turn.cancel（0709 阶段二，7.5）：后端据此发 ACP session/cancel
  // 真正终止 agent 子进程，并广播 agent.run.failed 终止事件给所有订阅者。
  const transport = getLocalTransport();
  await transport.connect();
  await transport.request("turn.cancel", { turnId });
}
