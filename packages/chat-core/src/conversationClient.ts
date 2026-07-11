/**
 * ConversationClient — 双端共享的会话状态层（框架无关）
 *
 * 桌面端（ui）与远端（ui-remote）复用同一套「加载 + 订阅 + 同步 + turn 生命周期」逻辑，
 * 只依赖 Transport + SyncManager，不依赖 React / Tauri / 浏览器。
 *
 * 职责：
 * - 会话列表（sessions）：拉 conversation.list + 订阅全局频道增量
 * - 单会话视图（views）：订阅会话频道 snapshot + 事件，用 reduceAgentEvent 规约
 * - 运行态（running）：由 SyncManager 的 session.running/stopped 驱动
 * - 配置（configs）：由 SyncManager 的 config.batch 驱动
 * - turn 生命周期：sendTurn / cancelTurn，terminal 事件内化
 * - delta 批处理：60ms flush，两端共享（此前仅桌面端有）
 *
 * 状态通过 subscribe/getSnapshot 暴露，配合 React useSyncExternalStore。
 *
 * 见 docs/design/0710-DUAL-END-UNIFICATION-REFACTOR.md 阶段 3。
 */

import type { AgentEvent, ChatMessage, Session } from "@code-lite/protocol";
import type { SyncManager, SessionConfig as SyncSessionConfig } from "@code-lite/sync";
import { reduceAgentEvent, sessionViewFromSnapshot, emptySessionView, type SessionViewState } from "./sessionReducer";
import { applyConversationListEvent, isConversationListEvent } from "./conversationList";

const GLOBAL_CHANNEL = "*";
const STREAM_FLUSH_MS = 60;

/** 传输适配：ConversationClient 只需这些方法（Transport 的子集）。 */
export interface ClientTransport {
  connect(): Promise<void>;
  request<T = unknown>(method: string, payload?: unknown): Promise<T>;
  subscribe(channel: string, options?: { afterSequence?: number }): Promise<{ channel: string; unsubscribe(): void }>;
  unsubscribe(channel: string): void;
  onEvent(handler: (event: AgentEvent, meta: { channel: string; seq?: number }) => void): () => void;
  onSnapshot(handler: (channel: string, payload: unknown) => void): () => void;
}

/** 客户端全局状态快照（不可变，供 useSyncExternalStore）。 */
export interface ClientState {
  sessions: Session[];
  views: Record<string, SessionViewState>;
}

/** fs.list 目录浏览返回（新建会话选工作区路径用）。 */
export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface DirectoryListing {
  /** 当前所在目录绝对路径 */
  path: string;
  /** 上级目录路径；已到根时为 null */
  parent: string | null;
  /** 子目录列表 */
  entries: DirectoryEntry[];
  /** 盘符列表（Windows），非 Windows 为空 */
  drives: DirectoryEntry[];
}

export interface SendTurnParams {
  conversationId: string;
  input: string;
  turnId?: string;
  accessMode?: string;
  modelId?: string;
  modelLabel?: string;
  reasoningEffort?: string;
  selectedConfig?: Record<string, string | number | boolean>;
  contentBlocks?: unknown[];
}

interface PendingDelta {
  text: string;
  reasoning: string;
}

export interface ConversationClientOptions {
  transport: ClientTransport;
  sync: SyncManager;
  /** 计时器注入（默认用全局 setTimeout；测试可注入假时钟）。 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  };
}

export class ConversationClient {
  private readonly transport: ClientTransport;
  private readonly sync: SyncManager;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;

  private sessions: Session[] = [];
  private views: Record<string, SessionViewState> = {};
  private snapshot: ClientState = { sessions: [], views: {} };

  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];

  // 每会话当前活动 assistant 消息 id（增量事件路由目标）。
  private readonly activeAssistantId: Record<string, string> = {};
  // 每会话当前活动 turnId（用于取消）。
  private readonly activeTurnId: Record<string, string> = {};
  // delta 批处理缓冲：conversationId -> { messageId -> {text, reasoning} }。
  private pendingDeltas: Record<string, Record<string, PendingDelta>> = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // turn 完成回调：turnId -> resolver（sendTurn 的 Promise 收尾）。
  private readonly turnResolvers = new Map<string, (event: AgentEvent) => void>();
  // 原始事件观察者：供 app 层处理 reducer 不覆盖的副作用（如桌面的 caps/config-from-events）。
  private readonly eventObservers = new Set<(event: AgentEvent, channel: string) => void>();

  constructor(options: ConversationClientOptions) {
    this.transport = options.transport;
    this.sync = options.sync;
    this.setTimeoutFn = options.scheduler?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.scheduler?.clearTimeout ?? ((h) => clearTimeout(h));
  }

  // ─── Store 接口（React useSyncExternalStore）────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClientState => this.snapshot;

  private rebuildSnapshot(): void {
    this.snapshot = { sessions: this.sessions, views: this.views };
  }

  private emit(): void {
    this.rebuildSnapshot();
    for (const l of this.listeners) l();
  }

  // ─── 状态读取辅助 ───────────────────────────────────────────

  getSession(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  getView(id: string): SessionViewState | undefined {
    return this.views[id];
  }

  isRunning(id: string): boolean {
    return this.sync.isRunning(id) || Boolean(this.views[id]?.running);
  }

  getActiveTurnId(id: string): string | undefined {
    return this.activeTurnId[id];
  }

  /** 暴露内部 SyncManager，供 app 层订阅配置同步等额外事件。 */
  getSync(): SyncManager {
    return this.sync;
  }

  /** 透传 RPC 请求，供 app 层调用非标准方法（如 session.initialize）。 */
  request<T = unknown>(method: string, payload?: unknown): Promise<T> {
    return this.transport.request<T>(method, payload);
  }

  /** 本地 patch 单个会话字段（触发 UI 重渲染）。供 app 层做 resolveApproval/archive 等即时 UI 反馈。 */
  patchSession(sessionId: string, patch: Partial<Session>): void {
    this.updateSessionInternal(sessionId, patch);
  }

  /** 用新会话对象替换列表中的一个（id 相同的会话）。 */
  replaceSession(updated: Session): void {
    const sessions = this.sessions;
    const existing = sessions.find((x) => x.id === updated.id);
    this.sessions = existing
      ? sessions.map((x) => (x.id === updated.id ? { ...x, ...updated } : x))
      : [updated, ...sessions];
    this.emit();
  }

  /**
   * 订阅原始会话级事件（reduce 之后触发），供 app 层处理 reducer 不覆盖的副作用：
   * 桌面端据此更新 per-session capabilities、config-from-events、context usage。
   * 返回取消函数。channel 为事件所属会话 id。
   */
  onRawEvent(observer: (event: AgentEvent, channel: string) => void): () => void {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  // ─── 启动 / 停止 ───────────────────────────────────────────

  /**
   * 启动客户端：连接、注册事件/快照/同步监听、订阅全局频道、拉会话列表。
   * 幂等前提由调用方保证（一个 client 实例只 start 一次）。
   */
  async start(): Promise<void> {
    await this.transport.connect();

    this.disposers.push(this.transport.onEvent(this.handleEvent));
    this.disposers.push(this.transport.onSnapshot(this.handleSnapshot));

    // 运行态与配置由 SyncManager 驱动。
    this.disposers.push(this.sync.onSessionRunning((p) => {
      this.updateSessionInternal(p.conversationId, { status: "running" });
      this.patchView(p.conversationId, (v) => ({ ...v, running: true }));
    }));
    this.disposers.push(this.sync.onSessionStopped((p) => {
      this.updateSessionInternal(p.conversationId, (s) => ({ status: s.status === "running" ? "idle" : s.status }));
      this.patchView(p.conversationId, (v) => ({ ...v, running: false }));
    }));

    await this.transport.subscribe(GLOBAL_CHANNEL);
    await this.loadList();
  }

  stop(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    if (this.flushTimer !== null) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** 拉会话列表（含后端 session.json 的 status，是运行态权威真相源）。 */
  async loadList(): Promise<void> {
    const result = await this.transport.request<{ sessions: Session[] }>("conversation.list", {});
    this.sessions = result.sessions ?? [];
    this.emit();
  }

  /** 打开会话：订阅其频道（后端回 snapshot 走 handleSnapshot，再推增量 event）。 */
  async openConversation(conversationId: string): Promise<void> {
    await this.transport.subscribe(conversationId);
  }

  closeConversation(conversationId: string): void {
    this.transport.unsubscribe(conversationId);
  }

  // ─── 事件分发 ───────────────────────────────────────────────

  private readonly handleEvent = (event: AgentEvent, meta: { channel: string; seq?: number }): void => {
    const type = (event as { type?: string }).type;

    // 同步事件（运行态/配置）优先喂 SyncManager；不进列表/视图 reducer。
    if (type === "sync") {
      this.sync.feedEvent(event);
      return;
    }

    // turn 生命周期：terminal 事件通知 sendTurn 的 resolver。
    const turnId = (event as { turnId?: string }).turnId;
    if (type === "conversation.turn.started" && turnId) {
      // 发起方在 draft 会话里发 turn：sendTurn 调用时还没有 conversationId，
      // 现在后端返回了真实 id，补登记 activeTurnId（供 cancelTurn 使用 + 清理）。
      const cid = (event as { conversationId?: string }).conversationId;
      if (cid && !this.activeTurnId[cid]) {
        this.activeTurnId[cid] = turnId;
      }
    }
    if (turnId && (type === "agent.run.completed" || type === "agent.run.failed")) {
      const resolver = this.turnResolvers.get(turnId);
      if (resolver) resolver(event);
      // 清理该会话的 activeTurnId（turnId -> conversationId 反查）。
      for (const [cid, tid] of Object.entries(this.activeTurnId)) {
        if (tid === turnId) {
          delete this.activeTurnId[cid];
          break;
        }
      }
    }

    // 会话列表级事件（全局频道）：更新 sessions 列表。
    if (isConversationListEvent(event)) {
      this.sessions = applyConversationListEvent(this.sessions, event);
      this.emit();
      return;
    }

    // 会话级事件：路由到对应会话视图，用 reduceAgentEvent 规约。
    const channel = (event as { conversationId?: string }).conversationId || meta.channel;
    if (!channel || channel === GLOBAL_CHANNEL) return;

    // 通知原始事件观察者（app 层副作用：桌面的 caps/config/context）。
    for (const obs of this.eventObservers) obs(event, channel);

    // 文本/推理增量走批处理缓冲（60ms flush）；其余事件即时 reduce。
    if (type === "agent.text.delta") {
      this.queueDelta(channel, (event as { delta: string }).delta, "text");
      return;
    }
    if (type === "agent.reasoning.delta") {
      this.queueDelta(channel, (event as { delta: string }).delta, "reasoning");
      return;
    }
    if (type === "agent.text.completed" || type === "agent.reasoning.completed") {
      this.flushDeltas();
      return;
    }

    // 记录活动 assistant 消息 id（供批处理 delta 定位）——须在 reduce 前设好。
    if (type === "conversation.turn.started") {
      const assistantId = (event as { assistantMessage?: { id?: string } }).assistantMessage?.id;
      if (assistantId) this.activeAssistantId[channel] = assistantId;
    }

    this.flushDeltas();
    this.reduceInto(channel, event);
  };

  private readonly handleSnapshot = (channel: string, payload: unknown): void => {
    if (channel === GLOBAL_CHANNEL) return;
    const snap = payload as { snapshot?: { session: Session | null; messages: ChatMessage[] } | null };
    if (!snap?.snapshot) return;
    const view = sessionViewFromSnapshot(snap.snapshot);
    this.views = { ...this.views, [channel]: view };
    if (view.activeAssistantMessageId) {
      this.activeAssistantId[channel] = view.activeAssistantMessageId;
    }
    // 快照带 session：合并进列表。
    if (view.session) {
      const s = view.session;
      const existing = this.sessions.find((x) => x.id === s.id);
      this.sessions = existing
        ? this.sessions.map((x) => (x.id === s.id ? { ...x, ...s } : x))
        : [s, ...this.sessions];
    }
    this.emit();
  };

  private reduceInto(channel: string, event: AgentEvent): void {
    const prev = this.views[channel] ?? emptySessionView(null);
    this.views = { ...this.views, [channel]: reduceAgentEvent(prev, event) };
    this.emit();
  }

  // ─── patch 辅助 ─────────────────────────────────────────────

  private updateSessionInternal(id: string, patch: Partial<Session> | ((s: Session) => Partial<Session>)): void {
    let changed = false;
    this.sessions = this.sessions.map((s) => {
      if (s.id !== id) return s;
      changed = true;
      const p = typeof patch === "function" ? patch(s) : patch;
      return { ...s, ...p };
    });
    if (changed) this.emit();
  }

  private patchView(id: string, updater: (v: SessionViewState) => SessionViewState): void {
    const existing = this.views[id];
    if (!existing) return;
    this.views = { ...this.views, [id]: updater(existing) };
    this.emit();
  }

  // ─── delta 批处理（60ms flush，两端共享）──────────────────────

  private queueDelta(conversationId: string, delta: string, kind: "text" | "reasoning"): void {
    const messageId = this.activeAssistantId[conversationId];
    if (!messageId) return;
    const perConv = this.pendingDeltas[conversationId] ?? (this.pendingDeltas[conversationId] = {});
    const buf = perConv[messageId] ?? (perConv[messageId] = { text: "", reasoning: "" });
    buf[kind] += delta;
    if (this.flushTimer === null) {
      this.flushTimer = this.setTimeoutFn(() => this.flushDeltas(), STREAM_FLUSH_MS);
    }
  }

  private flushDeltas(): void {
    if (this.flushTimer !== null) {
      this.clearTimeoutFn(this.flushTimer);
      this.flushTimer = null;
    }
    const pending = this.pendingDeltas;
    this.pendingDeltas = {};
    let mutated = false;
    for (const [conversationId, byMessage] of Object.entries(pending)) {
      const view = this.views[conversationId];
      if (!view) continue;
      const messages = view.messages.map((m) => {
        const buf = byMessage[m.id];
        if (!buf) return m;
        mutated = true;
        return {
          ...m,
          content: buf.text ? m.content + buf.text : m.content,
          reasoning: buf.reasoning ? (m.reasoning ?? "") + buf.reasoning : m.reasoning,
          updatedAt: Date.now(),
        };
      });
      this.views = { ...this.views, [conversationId]: { ...view, messages } };
    }
    if (mutated) this.emit();
  }

  // ─── turn 生命周期 ─────────────────────────────────────────

  /** 发起一个 turn。返回的 Promise 在 terminal 事件到达时 resolve。 */
  async sendTurn(params: SendTurnParams): Promise<void> {
    const turnId = params.turnId ?? `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload: Record<string, unknown> = { input: params.input, turnId };
    if (params.conversationId) payload.conversationId = params.conversationId;
    if (params.accessMode) payload.accessMode = params.accessMode;
    if (params.modelId) payload.modelId = params.modelId;
    if (params.modelLabel) payload.modelLabel = params.modelLabel;
    if (params.reasoningEffort) payload.reasoningEffort = params.reasoningEffort;
    if (params.selectedConfig) payload.selectedConfig = params.selectedConfig;
    if (params.contentBlocks) payload.contentBlocks = params.contentBlocks;

    if (params.conversationId) this.activeTurnId[params.conversationId] = turnId;

    const done = new Promise<void>((resolve) => {
      this.turnResolvers.set(turnId, () => {
        this.turnResolvers.delete(turnId);
        resolve();
      });
    });

    await this.transport.request("turn.start", payload);
    await done;
  }

  /** 终止会话当前 turn（双端均可，走 SyncManager.cancelSession）。 */
  async cancelTurn(conversationId: string): Promise<void> {
    await this.sync.cancelSession(conversationId, this.activeTurnId[conversationId]);
  }

  /** 更新会话配置（走 SyncManager，后端广播 config.batch 同步双端）。 */
  async updateConfig(conversationId: string, changes: Partial<SyncSessionConfig>): Promise<void> {
    await this.sync.syncConfig(conversationId, changes);
  }

  /** 新建会话（后端广播 conversation.created 到全局频道，列表自动插入）。 */
  async createConversation(options: { agentId?: string; workspace?: string; title?: string } = {}): Promise<Session> {
    const result = await this.transport.request<{ session: Session }>("conversation.create", options);
    return result.session;
  }

  /** 浏览宿主机目录（新建会话选工作区路径用）。path 为空返回 home + 盘符。 */
  async browseDirectory(path?: string): Promise<DirectoryListing> {
    return this.transport.request<DirectoryListing>("fs.list", { path: path ?? "" });
  }

  /** 在宿主机 path 目录下新建名为 name 的文件夹，返回新目录信息。 */
  async createDirectory(path: string, name: string): Promise<DirectoryEntry> {
    return this.transport.request<DirectoryEntry>("fs.mkdir", { path, name });
  }

  async archiveConversation(conversationId: string, archived: boolean): Promise<void> {
    await this.transport.request("conversation.archive", { conversationId, archived });
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.transport.request("conversation.delete", { conversationId });
  }

  async resolveApproval(approvalId: string, decision: "allow" | "deny"): Promise<void> {
    await this.transport.request("approval.decision", { approvalId, decision });
  }

  async resolveInput(inputRequestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>): Promise<void> {
    await this.transport.request("input.response", { inputRequestId, action, content });
  }

  /**
   * 上传单张图片附件（base64 走 WS 通道）。
   * 桌面端用 HTTP multipart；远端无 HTTP 通道，改用此 RPC。返回附件元数据。
   */
  async uploadAttachment(params: {
    conversationId: string;
    turnId: string;
    fileName: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: string;
    width?: number;
    height?: number;
    wasCompressed?: boolean;
  }): Promise<AttachmentMetadata> {
    const result = await this.transport.request<{ attachment: AttachmentMetadata }>("attachment.upload", params);
    return result.attachment;
  }

  /** 拉取图片附件内容（base64 走 WS 通道），供远端在无 HTTP 时渲染历史图片。 */
  async getAttachment(conversationId: string, attachmentId: string): Promise<AttachmentData> {
    return this.transport.request<AttachmentData>("attachment.get", { conversationId, attachmentId });
  }
}

/** attachment.upload 返回的元数据（后端 AttachmentStore.save_image 产出）。 */
export interface AttachmentMetadata {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  sha256: string;
  wasCompressed?: boolean;
  createdAt?: string;
}

/** attachment.get 返回的图片内容（base64）。 */
export interface AttachmentData {
  data: string;
  mimeType: string;
  name: string;
}
