/**
 * ConfigSyncer：配置同步器
 *
 * 负责会话级配置（模型、思考强度、访问模式等）的双向同步。
 * 当任一端修改配置后，通过 Transport 发送 RPC 到后端，
 * 后端成功更新后广播事件到订阅频道，双端同步刷新。
 *
 * 设计要点：
 * - 乐观更新：调用方本地先更新 UI，不等后端确认
 * - 冲突解决：最后写入胜出（last-write-wins），因操作间隔远大于网络延迟
 * - 批量更新：支持一次更新多个配置项，减少网络往返
 */

import type { SyncTransportAdapter } from "./manager";
import type { SyncRole, SessionConfig, ConfigChangePayload, ConfigBatchPayload } from "./types";

export type ConfigUpdateHandler = (conversationId: string, config: SessionConfig) => void;

export class ConfigSyncer {
  private readonly transport: SyncTransportAdapter;
  private readonly role: SyncRole;
  private readonly configs = new Map<string, SessionConfig>();
  private readonly handlers = new Set<ConfigUpdateHandler>();

  constructor(transport: SyncTransportAdapter, role: SyncRole) {
    this.transport = transport;
    this.role = role;
  }

  /** 当前同步角色（host/remote），供调用方标注操作来源。 */
  get syncRole(): SyncRole {
    return this.role;
  }

  /** 获取某会话的当前配置 */
  get(conversationId: string): SessionConfig | undefined {
    return this.configs.get(conversationId);
  }

  /** 设置本地配置缓存（来自 snapshot 或远端同步事件） */
  setLocal(conversationId: string, config: SessionConfig): void {
    this.configs.set(conversationId, { ...this.configs.get(conversationId), ...config });
    this.notify(conversationId);
  }

  /**
   * 发起配置变更（发送到后端并乐观更新本地）。
   * 后端成功后会广播事件到频道，另一端接收后更新。
   */
  async update(conversationId: string, changes: Partial<SessionConfig>): Promise<void> {
    // 乐观更新
    const existing = this.configs.get(conversationId) ?? {};
    Object.assign(existing, changes);
    this.configs.set(conversationId, existing);
    this.notify(conversationId);

    // 发送 RPC（后端 _handle_conversation_config_update 期望 config 字段）
    await this.transport.request("conversation.config.update", {
      conversationId,
      config: changes,
    });
  }

  /**
   * 处理来自后端广播的配置变更事件。
   * 由 SyncManager 在收到同步事件后调用。
   */
  handleRemoteChange(payload: ConfigChangePayload): void {
    const p = payload as ConfigBatchPayload;
    const conversationId = p.conversationId;
    if (!conversationId) return;

    const existing = this.configs.get(conversationId) ?? {};

    if (p.changes) {
      // config.batch 类型
      Object.assign(existing, p.changes);
    } else {
      // 单项配置类型（model/effort/access_mode）
      const record = payload as unknown as Record<string, unknown>;
      if (record.model != null) existing.model = record.model as string;
      if (record.effort != null) existing.effort = record.effort as SessionConfig["effort"];
      if (record.accessMode != null) existing.accessMode = record.accessMode as SessionConfig["accessMode"];
    }

    this.configs.set(conversationId, existing);
    this.notify(conversationId);
  }

  /** 订阅配置变化（返回取消函数） */
  onChange(handler: ConfigUpdateHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** 清除缓存（断线重连时调用） */
  clear(): void {
    this.configs.clear();
  }

  private notify(conversationId: string): void {
    const config = this.configs.get(conversationId);
    if (config) {
      for (const h of this.handlers) h(conversationId, config);
    }
  }
}
