import { ensureBackend, getLocalTransport } from "./agentClient";
import type { ChatMessage, FileDiffArtifact, Session } from "../types";

interface LoadConversationResponse {
  session: Session;
  messages: ChatMessage[];
}

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
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/** 列出会话（0709 阶段二：走 WS RPC，观察者也能收到后端活动态）。 */
export async function listConversations(): Promise<Session[]> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ sessions: Session[] }>("conversation.list", {});
  return result.sessions;
}

/** 读取单个会话（0709 阶段二：走 WS RPC，优先返回活动态快照）。 */
export async function loadConversation(sessionId: string): Promise<{
  messages: ChatMessage[];
  session: Session;
}> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<LoadConversationResponse>("conversation.get", {
    conversationId: sessionId,
  });
  return { session: result.session, messages: result.messages };
}

export async function deleteConversation(sessionId: string): Promise<void> {
  await requestJson<{ deleted: boolean }>(`/api/conversations/${sessionId}`, {
    method: "DELETE"
  });
}

export async function updateConversationArchiveState(
  sessionId: string,
  archived: boolean,
): Promise<Session> {
  const response = await requestJson<{ session: Session }>(`/api/conversations/${sessionId}/archive`, {
    body: JSON.stringify({ archived }),
    method: "PATCH"
  });
  return response.session;
}

export async function saveConversationConfig(
  sessionId: string,
  config: Record<string, unknown>,
): Promise<Session> {
  const response = await requestJson<{ session: Session }>(`/api/conversations/${sessionId}/config`, {
    body: JSON.stringify({ config }),
    method: "PATCH"
  });
  return response.session;
}

export async function loadConversationDiff(sessionId: string, diffId: string): Promise<FileDiffArtifact> {
  const response = await requestJson<{ diff: FileDiffArtifact }>(
    `/api/conversations/${encodeURIComponent(sessionId)}/diffs/${encodeURIComponent(diffId)}`,
  );
  return response.diff;
}
