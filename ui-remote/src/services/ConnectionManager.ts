/**
 * ConnectionManager — 管理远端连接生命周期
 *
 * 职责:
 * - 存储/读取 Relay URL 和 Pair Key (localStorage + Capacitor Preferences)
 * - 创建/销毁 ConversationClient 实例
 * - 设备切换时重新连接
 */

import { ConversationClient } from "@code-lite/chat-core";
import { SyncManager } from "@code-lite/sync";
import { RelayTransport } from "../services/RelayTransport";
import { Preferences } from "@capacitor/preferences";

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";

export interface ConnectionConfig {
  relayUrl: string;
  pairKey: string;
}

export class ConnectionManager {
  private client: ConversationClient | null = null;
  private sync: SyncManager | null = null;
  private transport: RelayTransport | null = null;
  private config: ConnectionConfig | null = null;

  async loadStoredConfig(): Promise<ConnectionConfig | null> {
    // 优先从 Capacitor Preferences 读取 (Android 持久化)
    const urlResult = await Preferences.get({ key: LS_RELAY_URL });
    const keyResult = await Preferences.get({ key: LS_PAIR_KEY });

    if (urlResult.value && keyResult.value) {
      return { relayUrl: urlResult.value, pairKey: keyResult.value };
    }

    // 降级到 localStorage (Web 调试用)
    const lsUrl = localStorage.getItem(LS_RELAY_URL);
    const lsKey = localStorage.getItem(LS_PAIR_KEY);
    if (lsUrl && lsKey) {
      return { relayUrl: lsUrl, pairKey: lsKey };
    }

    return null;
  }

  async saveConfig(config: ConnectionConfig): Promise<void> {
    this.config = config;
    // 双写: Capacitor Preferences + localStorage
    await Preferences.set({ key: LS_RELAY_URL, value: config.relayUrl });
    await Preferences.set({ key: LS_PAIR_KEY, value: config.pairKey });
    localStorage.setItem(LS_RELAY_URL, config.relayUrl);
    localStorage.setItem(LS_PAIR_KEY, config.pairKey);
  }

  async clearConfig(): Promise<void> {
    this.config = null;
    await Preferences.remove({ key: LS_RELAY_URL });
    await Preferences.remove({ key: LS_PAIR_KEY });
    localStorage.removeItem(LS_RELAY_URL);
    localStorage.removeItem(LS_PAIR_KEY);
  }

  getConfig(): ConnectionConfig | null {
    return this.config;
  }

  getClient(): ConversationClient | null {
    return this.client;
  }

  async connect(config: ConnectionConfig): Promise<ConversationClient> {
    // 如果已有连接且配置相同，直接返回
    if (this.client && this.config?.relayUrl === config.relayUrl && this.config?.pairKey === config.pairKey) {
      return this.client;
    }

    // 断开旧连接
    if (this.client) {
      this.disconnect();
    }

    // 计算 roomId (SHA256 of pairKey)
    const roomId = await computeRoomId(config.pairKey);

    // 创建 transport
    this.transport = new RelayTransport({
      relayUrl: config.relayUrl,
      roomId,
      onHostStatusChange: (online) => {
        console.log("[ConnectionManager] Host status:", online);
        // TODO: 通知 UI 层更新连接状态
      },
    });

    // 创建 sync manager (role: "remote")
    this.sync = new SyncManager({
      transport: this.transport,
      role: "remote",
    });

    // 创建 client
    this.client = new ConversationClient({
      transport: this.transport,
      sync: this.sync,
    });

    this.config = config;

    // 启动 client
    await this.client.start();

    return this.client;
  }

  disconnect(): void {
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    if (this.sync) {
      this.sync.stop();
      this.sync = null;
    }
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.config = null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }
}

async function computeRoomId(pairKey: string): Promise<string> {
  // 简易 SHA256 实现 (实际应使用 crypto.subtle.digest)
  const encoder = new TextEncoder();
  const data = encoder.encode(pairKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 导出单例
export const connectionManager = new ConnectionManager();
