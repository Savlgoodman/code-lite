import { ensureBackend } from "./agentClient";
import type { ChatMessage, FileDiffArtifact, Session } from "../types";

interface ListConversationsResponse {
  sessions: Session[];
}

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

export async function listConversations(): Promise<Session[]> {
  const response = await requestJson<ListConversationsResponse>("/api/conversations");
  return response.sessions;
}

export async function loadConversation(sessionId: string): Promise<{
  messages: ChatMessage[];
  session: Session;
}> {
  const response = await requestJson<LoadConversationResponse>(`/api/conversations/${sessionId}`);
  return response;
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
