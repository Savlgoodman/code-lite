/**
 * AiConversationStore — AI 对话与消息持久化
 *
 * 独立 AI 对话模块专用。为避免每条消息都重写全量历史：
 * - 索引键 `ai-conversations` 存会话元数据列表。
 * - 每个会话的消息单独存 `ai-conv-msgs-{id}`。
 *
 * 提供 useSyncExternalStore 所需的 subscribe/getSnapshot（快照为会话元数据列表）。
 */

import { Preferences } from "@capacitor/preferences";

const CONVERSATIONS_KEY = "ai-conversations";
const MESSAGES_KEY_PREFIX = "ai-conv-msgs-";

export interface AiImage {
  /** data URL：data:image/png;base64,xxxx */
  dataUrl: string;
  name: string;
  mimeType: string;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  updatedAt?: number;
  /** 用户消息可携带图片（多模态） */
  images?: AiImage[];
  error?: string;
}

export interface AiConversation {
  id: string;
  title: string;
  /** 指向 AiProviderStore 里某个已配置模型的 id */
  modelRefId: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

async function readJson<T>(key: string): Promise<T | null> {
  const pref = await Preferences.get({ key });
  const raw = pref.value ?? localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await Preferences.set({ key, value: json });
  localStorage.setItem(key, json);
}

async function removeKey(key: string): Promise<void> {
  await Preferences.remove({ key });
  localStorage.removeItem(key);
}

export class AiConversationStore {
  private conversations: AiConversation[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 同步快照：会话元数据列表（不含消息）。 */
  getSnapshot = (): AiConversation[] => this.conversations;

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** 首次进入时加载会话列表到内存快照。 */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.conversations = (await readJson<AiConversation[]>(CONVERSATIONS_KEY)) ?? [];
    this.loaded = true;
    this.emit();
  }

  private async persistConversations(): Promise<void> {
    await writeJson(CONVERSATIONS_KEY, this.conversations);
    this.emit();
  }

  getConversation(id: string): AiConversation | undefined {
    return this.conversations.find((c) => c.id === id);
  }

  async createConversation(modelRefId: string, title = "新对话"): Promise<AiConversation> {
    const now = Date.now();
    const conversation: AiConversation = {
      id: crypto.randomUUID(),
      title,
      modelRefId,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    this.conversations = [conversation, ...this.conversations];
    await this.persistConversations();
    return conversation;
  }

  async updateConversation(id: string, patch: Partial<Omit<AiConversation, "id">>): Promise<void> {
    let changed = false;
    this.conversations = this.conversations.map((c) => {
      if (c.id !== id) return c;
      changed = true;
      return { ...c, ...patch };
    });
    if (changed) await this.persistConversations();
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.updateConversation(id, { archived, updatedAt: Date.now() });
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    await removeKey(MESSAGES_KEY_PREFIX + id);
    await this.persistConversations();
  }

  // ── 消息 ──

  async loadMessages(conversationId: string): Promise<AiMessage[]> {
    return (await readJson<AiMessage[]>(MESSAGES_KEY_PREFIX + conversationId)) ?? [];
  }

  async saveMessages(conversationId: string, messages: AiMessage[]): Promise<void> {
    await writeJson(MESSAGES_KEY_PREFIX + conversationId, messages);
    // 触碰 updatedAt，让列表按最后互动时间排序
    await this.updateConversation(conversationId, { updatedAt: Date.now() });
  }
}

export const aiConversationStore = new AiConversationStore();
