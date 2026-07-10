import { getLocalTransport } from "./agentClient";
import type { ChatMessage, FileDiffArtifact, Session } from "../types";

interface LoadConversationResponse {
  session: Session;
  messages: ChatMessage[];
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

/** 删除会话（0710 收敛：走 WS RPC，后端广播 conversation.deleted 到全局频道）。 */
export async function deleteConversation(sessionId: string): Promise<void> {
  const transport = getLocalTransport();
  await transport.connect();
  await transport.request<{ ok: boolean }>("conversation.delete", { conversationId: sessionId });
}

/** 归档/取消归档会话（0710 收敛：走 WS RPC，后端广播到全局频道）。 */
export async function updateConversationArchiveState(
  sessionId: string,
  archived: boolean,
): Promise<Session> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ session: Session }>("conversation.archive", {
    conversationId: sessionId,
    archived,
  });
  return result.session;
}

/** 保存会话配置（0710 收敛：走 WS RPC，后端广播 config.batch sync 事件到双端）。 */
export async function saveConversationConfig(
  sessionId: string,
  config: Record<string, unknown>,
): Promise<Session> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ session: Session }>("conversation.config.update", {
    conversationId: sessionId,
    config,
  });
  return result.session;
}

/** 拉取 diff 全文（0710 收敛：走 WS RPC，按需懒加载）。 */
export async function loadConversationDiff(sessionId: string, diffId: string): Promise<FileDiffArtifact> {
  const transport = getLocalTransport();
  await transport.connect();
  const result = await transport.request<{ diff: FileDiffArtifact }>("diff.get", {
    conversationId: sessionId,
    diffId,
  });
  return result.diff;
}
