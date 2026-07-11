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
import type { TransportStatus } from "@code-lite/transport";
import { RelayTransport } from "../services/RelayTransport";
import { Preferences } from "@capacitor/preferences";

const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";
const LS_DEVICE_NAME = "code-lite-device-name";

export interface ConnectionConfig {
  relayUrl: string;
  pairKey: string;
  deviceName?: string;
}

export class ConnectionManager {
  private client: ConversationClient | null = null;
  private sync: SyncManager | null = null;
  private transport: RelayTransport | null = null;
  private config: ConnectionConfig | null = null;
  private onHostStatusChange: ((online: boolean) => void) | null = null;
  private onStatusChange: ((status: TransportStatus) => void) | null = null;
  // 宿主是否在线（host.online/offline 驱动）。socket 断开期间视为不可达。
  private hostOnline = false;

  async loadStoredConfig(): Promise<ConnectionConfig | null> {
    // 优先从 Capacitor Preferences 读取 (Android 持久化)
    const urlResult = await Preferences.get({ key: LS_RELAY_URL });
    const keyResult = await Preferences.get({ key: LS_PAIR_KEY });
    const nameResult = await Preferences.get({ key: LS_DEVICE_NAME });

    if (urlResult.value && keyResult.value) {
      return {
        relayUrl: urlResult.value,
        pairKey: keyResult.value,
        deviceName: nameResult.value || undefined,
      };
    }

    // 降级到 localStorage (Web 调试用)
    const lsUrl = localStorage.getItem(LS_RELAY_URL);
    const lsKey = localStorage.getItem(LS_PAIR_KEY);
    if (lsUrl && lsKey) {
      return {
        relayUrl: lsUrl,
        pairKey: lsKey,
        deviceName: localStorage.getItem(LS_DEVICE_NAME) || undefined,
      };
    }

    return null;
  }

  async saveConfig(config: ConnectionConfig): Promise<void> {
    this.config = config;
    // 双写: Capacitor Preferences + localStorage
    await Preferences.set({ key: LS_RELAY_URL, value: config.relayUrl });
    await Preferences.set({ key: LS_PAIR_KEY, value: config.pairKey });
    await Preferences.set({ key: LS_DEVICE_NAME, value: config.deviceName ?? "" });
    localStorage.setItem(LS_RELAY_URL, config.relayUrl);
    localStorage.setItem(LS_PAIR_KEY, config.pairKey);
    if (config.deviceName) {
      localStorage.setItem(LS_DEVICE_NAME, config.deviceName);
    }
  }

  async clearConfig(): Promise<void> {
    this.config = null;
    await Preferences.remove({ key: LS_RELAY_URL });
    await Preferences.remove({ key: LS_PAIR_KEY });
    await Preferences.remove({ key: LS_DEVICE_NAME });
    localStorage.removeItem(LS_RELAY_URL);
    localStorage.removeItem(LS_PAIR_KEY);
    localStorage.removeItem(LS_DEVICE_NAME);
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
    const transport = new RelayTransport({
      relayUrl: config.relayUrl,
      roomId,
      onHostStatusChange: (online) => {
        console.log("[ConnectionManager] Host status:", online);
        this.hostOnline = online;
        // 宿主重连上线：本端 socket 未断，但宿主刚重建了本 peer 的 pump，
        // 需重放订阅让宿主重新推事件，否则会话页收不到后续更新（假卡死）。
        if (online) {
          this.transport?.resubscribeAll();
          this.client?.loadList().catch(() => { /* 列表刷新失败不阻断 */ });
        }
        this.emitConnected();
      },
    });
    this.transport = transport;

    // 传输层状态：socket 断开/重连/关闭都要反映到 UI 在线态。
    transport.onStatus((status) => {
      console.log("[ConnectionManager] Transport status:", status);
      this.onStatusChange?.(status);
      this.emitConnected();
    });

    // 本端 socket 断线自动重连成功：重放订阅已在基类完成，这里刷新列表补齐状态。
    transport.onReconnected(() => {
      console.log("[ConnectionManager] Reconnected, refreshing list");
      this.client?.loadList().catch(() => { /* 列表刷新失败不阻断 */ });
    });

    // 创建 sync manager (role: "remote")
    this.sync = new SyncManager({
      transport,
      role: "remote",
    });

    // 创建 client
    this.client = new ConversationClient({
      transport,
      sync: this.sync,
    });

    this.config = config;

    // 启动 client
    await this.client.start();

    return this.client;
  }

  /** 综合传输层状态与宿主在线态，向 UI 广播"是否真正可用"。 */
  private emitConnected(): void {
    const status = this.transport?.status ?? "closed";
    const usable = status === "connected" && this.hostOnline;
    this.onHostStatusChange?.(usable);
  }

  /** 当前传输层连接状态（供 UI 显示"重连中/离线"）。 */
  getStatus(): TransportStatus {
    return this.transport?.status ?? "closed";
  }

  /** 手动重连：有限次自动重连耗尽后，用户点击"重新连接"时调用。 */
  async reconnect(): Promise<void> {
    const t = this.transport;
    if (!t) return;
    await t.connect();
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
    this.hostOnline = false;
  }

  isConnected(): boolean {
    const status = this.transport?.status ?? "closed";
    return status === "connected" && this.hostOnline;
  }

  setHostStatusCallback(cb: (online: boolean) => void): void {
    this.onHostStatusChange = cb;
  }

  /** 设置传输层状态回调：供 UI 区分"重连中/离线"态。 */
  setStatusCallback(cb: (status: TransportStatus) => void): void {
    this.onStatusChange = cb;
  }
}

export async function computeRoomId(pairKey: string): Promise<string> {
  // 简易 SHA256 实现 (实际应使用 crypto.subtle.digest)
  const encoder = new TextEncoder();
  const data = encoder.encode(pairKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 导出单例
export const connectionManager = new ConnectionManager();
