/**
 * StateTracker：运行态追踪器
 *
 * 专注于追踪哪些会话正在运行、由谁发起、当前进度如何。
 * 提供响应式 API，方便前端 UI 绑定。
 *
 * 可独立使用，也可作为 SyncManager 的子模块。
 */

import type { SyncRole, RunningState } from "./types";

export type StateChangeHandler = (states: ReadonlyMap<string, RunningState>) => void;

export class StateTracker {
  private readonly states = new Map<string, RunningState>();
  private readonly handlers = new Set<StateChangeHandler>();

  /** 获取所有运行中的会话 */
  getRunning(): ReadonlyMap<string, RunningState> {
    return this.states;
  }

  /** 检查某会话是否正在运行 */
  isRunning(conversationId: string): boolean {
    const s = this.states.get(conversationId);
    return s != null && s.status === "running";
  }

  /** 获取某会话当前由谁发起 */
  getStarter(conversationId: string): SyncRole | undefined {
    return this.states.get(conversationId)?.startedBy;
  }

  /** 标记会话开始运行 */
  markRunning(conversationId: string, turnId: string, startedBy: SyncRole): void {
    this.states.set(conversationId, {
      conversationId,
      turnId,
      startedBy,
      startedAt: Date.now(),
      status: "running",
    });
    this.notify();
  }

  /** 标记会话停止运行 */
  markStopped(
    conversationId: string,
    reason: "cancelled" | "completed" | "error",
  ): void {
    const existing = this.states.get(conversationId);
    if (existing) {
      existing.status = reason === "cancelled" ? "cancelled" : reason === "completed" ? "completed" : "error";
    }
    // 停止后移除，让 isRunning 返回 false
    this.states.delete(conversationId);
    this.notify();
  }

  /** 清除所有运行态（断线重连时调用） */
  clear(): void {
    this.states.clear();
    this.notify();
  }

  /** 订阅状态变化（返回取消函数） */
  onChange(handler: StateChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private notify(): void {
    for (const h of this.handlers) h(this.states);
  }
}
