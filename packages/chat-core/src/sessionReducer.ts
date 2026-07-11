/**
 * 单会话视图 reducer（0710 第 5.1、7 节）。
 *
 * 把一个会话频道上的 AgentEvent 流规约为该会话的视图状态，供远端（ui-remote）
 * 与桌面复用同一套语义。桌面当前仍用 ChatPage 内联 handler，本 reducer 的行为
 * 与其逐类对齐，后续桌面可迁移到此处收敛为唯一实现。
 *
 * 纯函数：输入旧状态与事件，返回新状态，不产生副作用（除 Date.now 时间戳）。
 */

import type {
  AgentEvent,
  ApprovalRequest,
  ChatMessage,
  InputRequest,
  Session,
  UsageStats,
} from "@code-lite/protocol";
import {
  appendRuntimeEvent,
  mergeMessagePlan,
  upsertToolCall,
} from "./messageReducer";

export interface SessionViewState {
  session: Session | null;
  messages: ChatMessage[];
  /** 当前累积 assistant 消息 id（增量事件路由到它）。 */
  activeAssistantMessageId: string | null;
  running: boolean;
  contextUsage: UsageStats | null;
  pendingApproval: ApprovalRequest | null;
  pendingInput: InputRequest | null;
}

export function emptySessionView(session: Session | null = null): SessionViewState {
  return {
    session,
    messages: [],
    activeAssistantMessageId: null,
    running: session?.status === "running",
    contextUsage: null,
    pendingApproval: null,
    pendingInput: null,
  };
}

/** 把后端回传的 approval.required 展示 payload 还原为 ApprovalRequest。 */
function approvalFromPayload(payload: Record<string, unknown>): ApprovalRequest | null {
  const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : null;
  if (!approvalId) return null;
  return {
    approvalId,
    argumentsText: formatJson(
      payload.argumentsText ? payload.argumentsText : payload.arguments,
    ),
    impact: typeof payload.impact === "string" ? payload.impact : "",
    name: typeof payload.name === "string" ? payload.name : "",
    plan: (payload.plan as ApprovalRequest["plan"]) ?? undefined,
    purpose: typeof payload.purpose === "string" ? payload.purpose : "",
    risk: (payload.risk as ApprovalRequest["risk"]) ?? "low",
    risks: Array.isArray(payload.risks) ? (payload.risks as string[]) : [],
    rollback: typeof payload.rollback === "string" ? payload.rollback : "",
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
  };
}

/** 把后端回传的 agent.input.required 展示 payload 还原为 InputRequest。 */
function inputFromPayload(payload: Record<string, unknown>): InputRequest | null {
  const inputRequestId =
    typeof payload.inputRequestId === "string" ? payload.inputRequestId : null;
  if (!inputRequestId) return null;
  return {
    inputRequestId,
    message: typeof payload.message === "string" ? payload.message : "",
    mode: typeof payload.mode === "string" ? payload.mode : "form",
    schema: (payload.schema as InputRequest["schema"]) ?? undefined,
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
  };
}

/**
 * 用快照 {session, messages} 初始化视图（附着即快照，0710 第 5.2 节）。
 * pendingApprovals / pendingInputs 由 subscribe 结果回传，用于重新附着时恢复
 * 待审批 / 待输入卡片，修复挂起审批切走再回来的假死（0711 设计第 8.3 节）。
 */
export function sessionViewFromSnapshot(snapshot: {
  session: Session | null;
  messages: ChatMessage[];
  pendingApprovals?: Array<Record<string, unknown>>;
  pendingInputs?: Array<Record<string, unknown>>;
}): SessionViewState {
  const messages = snapshot.messages ?? [];
  let activeAssistantMessageId: string | null = null;
  let contextUsage: UsageStats | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (msg.streaming && !activeAssistantMessageId) {
        activeAssistantMessageId = msg.id;
      }
      // 从最后一条带有效 usage 的 assistant 消息恢复 contextUsage（0710 回归修复）。
      if (!contextUsage && msg.usage && typeof msg.usage === "object") {
        const u = msg.usage as UsageStats;
        if (u.contextUsedTokens !== undefined || u.contextWindowTokens !== undefined) {
          contextUsage = u;
        }
      }
      // 两个都找到了即可退出。
      if (activeAssistantMessageId && contextUsage) break;
    }
  }
  let pendingApproval: ApprovalRequest | null = null;
  for (const payload of snapshot.pendingApprovals ?? []) {
    const restored = approvalFromPayload(payload);
    if (restored) {
      pendingApproval = restored;
      break;
    }
  }
  let pendingInput: InputRequest | null = null;
  for (const payload of snapshot.pendingInputs ?? []) {
    const restored = inputFromPayload(payload);
    if (restored) {
      pendingInput = restored;
      break;
    }
  }
  return {
    session: snapshot.session,
    messages,
    activeAssistantMessageId,
    running: snapshot.session?.status === "running",
    contextUsage,
    pendingApproval,
    pendingInput,
  };
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function mapMessage(
  state: SessionViewState,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return state.messages.map((m) => (m.id === messageId ? updater(m) : m));
}

/**
 * 把一个会话级事件应用到视图状态，返回新状态（不可变）。
 *
 * 运行态（running）的跨端同步由 @code-lite/sync 的 SyncManager 统一驱动
 * （session.running / session.stopped 事件）；本 reducer 只负责会话内视图状态：
 * conversation.turn.started 置 running=true，terminal 事件置 running=false。
 */
export function reduceAgentEvent(state: SessionViewState, event: AgentEvent): SessionViewState {
  if (event.type === "conversation.turn.started") {
    const existing = state.messages;
    const hasUser = existing.some((m) => m.id === event.userMessage.id);
    const hasAssistant = existing.some((m) => m.id === event.assistantMessage.id);
    const toAdd: ChatMessage[] = [];
    if (!hasUser) toAdd.push(event.userMessage);
    if (!hasAssistant) toAdd.push(event.assistantMessage);
    return {
      ...state,
      session: event.session ?? state.session,
      running: true,
      activeAssistantMessageId: event.assistantMessage.id,
      messages: toAdd.length ? [...existing, ...toAdd] : existing,
    };
  }

  const assistantId = state.activeAssistantMessageId;

  // 审批被处理：立即清除待审批卡片（不依赖 run.completed），修复卡死。
  // 即使丢了 assistantId（重新附着场景）也要清，故放在 assistantId 守卫之前。
  if (event.type === "approval.resolved") {
    if (state.pendingApproval?.approvalId !== event.approvalId) {
      return state;
    }
    const next: SessionViewState = {
      ...state,
      pendingApproval: null,
      session:
        state.session && state.session.status === "approval"
          ? { ...state.session, status: event.decision === "allow" ? "running" : "idle" }
          : state.session,
    };
    return next;
  }

  // 终端事件即使丢了 assistantId 也要解除 running，避免永久卡"运行中"。
  if (!assistantId) {
    if (event.type === "agent.run.completed") {
      return { ...state, running: false };
    }
    if (event.type === "agent.run.failed") {
      return { ...state, running: false };
    }
    return state;
  }

  switch (event.type) {
    case "agent.text.delta":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          content: m.content + event.delta,
          updatedAt: Date.now(),
        })),
      };

    case "agent.reasoning.delta":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          reasoning: (m.reasoning ?? "") + event.delta,
          updatedAt: Date.now(),
        })),
      };

    case "agent.plan.updated":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          plan: mergeMessagePlan(m, state.messages, event.plan),
          runtimeEvents: appendRuntimeEvent(m.runtimeEvents, event),
          updatedAt: Date.now(),
        })),
      };

    case "agent.tool.started":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          plan: mergeMessagePlan(m, state.messages, event.plan),
          toolCalls: upsertToolCall(m.toolCalls, {
            anchorOffset: m.content.length,
            argumentsText: formatJson(event.arguments),
            id: event.toolCallId,
            metadata: event.metadata ?? null,
            name: event.name,
            risk: event.risk,
            status: "running",
          }),
        })),
      };

    case "agent.tool.delta":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          toolCalls: upsertToolCall(m.toolCalls, {
            id: event.toolCallId,
            metadata: event.metadata ?? null,
            name: event.name,
            status: "running",
            resultText: event.progress != null ? formatJson(event.progress) : undefined,
          }),
        })),
      };

    case "agent.tool.completed":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          plan: mergeMessagePlan(m, state.messages, event.plan),
          toolCalls: upsertToolCall(m.toolCalls, {
            id: event.toolCallId,
            metadata: event.metadata ?? null,
            name: event.name,
            resultText: formatJson(event.result ?? event.metadata),
            status: "complete",
          }),
        })),
      };

    case "agent.tool.failed":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          toolCalls: upsertToolCall(m.toolCalls, {
            error: event.error ?? "工具调用失败",
            id: event.toolCallId,
            metadata: event.metadata ?? null,
            name: event.name,
            status: "error",
          }),
        })),
      };

    case "approval.required":
      return {
        ...state,
        pendingApproval: {
          approvalId: event.approvalId,
          argumentsText: formatJson(event.argumentsText ? event.argumentsText : event.arguments),
          impact: event.impact,
          name: event.name,
          plan: event.plan,
          purpose: event.purpose,
          risk: event.risk,
          risks: event.risks,
          rollback: event.rollback,
          toolCallId: event.toolCallId,
        },
        session: state.session ? { ...state.session, status: "approval" } : state.session,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          plan: mergeMessagePlan(m, state.messages, event.plan),
          toolCalls: upsertToolCall(m.toolCalls, {
            anchorOffset: m.content.length,
            argumentsText: formatJson(event.argumentsText ? event.argumentsText : event.arguments),
            id: event.toolCallId || event.approvalId,
            name: event.name,
            risk: event.risk,
            status: "approval",
          }),
        })),
      };

    case "agent.input.required":
      return {
        ...state,
        pendingInput: {
          inputRequestId: event.inputRequestId,
          message: event.message,
          mode: event.mode,
          schema: event.schema,
          toolCallId: event.toolCallId,
        },
        session: state.session ? { ...state.session, status: "approval" } : state.session,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          runtimeEvents: appendRuntimeEvent(m.runtimeEvents, event),
        })),
      };

    case "agent.input.completed":
      return {
        ...state,
        pendingInput:
          state.pendingInput?.inputRequestId === event.inputRequestId ? null : state.pendingInput,
      };

    case "agent.context.updated":
      return { ...state, contextUsage: event.context };

    case "agent.session.updated": {
      const title = event.title?.trim();
      if (!event.session && !title) return state;
      return {
        ...state,
        session:
          event.session ??
          (state.session ? { ...state.session, title: title ?? state.session.title } : state.session),
      };
    }

    case "agent.run.completed": {
      const completedAt = Date.now();
      return {
        ...state,
        running: false,
        pendingApproval: null,
        pendingInput: null,
        contextUsage:
          typeof event.usage === "object" && event.usage
            ? ({ ...(state.contextUsage ?? {}), ...(event.usage as UsageStats) })
            : state.contextUsage,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          model:
            typeof event.model === "object" && event.model
              ? (event.model as ChatMessage["model"])
              : m.model,
          streaming: false,
          updatedAt: completedAt,
          usage:
            typeof event.usage === "object" && event.usage
              ? (event.usage as ChatMessage["usage"])
              : m.usage,
        })),
        session: event.session ?? (state.session ? { ...state.session, status: "idle" } : state.session),
      };
    }

    case "agent.run.failed": {
      const failedAt = Date.now();
      return {
        ...state,
        running: false,
        pendingApproval: null,
        pendingInput: null,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          error: event.error ?? "Agent 运行失败",
          streaming: false,
          updatedAt: failedAt,
        })),
        session: event.session ?? (state.session ? { ...state.session, status: "error" } : state.session),
      };
    }

    case "agent.command.available.updated":
    case "agent.config.updated":
    case "agent.mode.updated":
    case "agent.raw.rpc":
    case "agent.raw.update":
      return {
        ...state,
        messages: mapMessage(state, assistantId, (m) => ({
          ...m,
          runtimeEvents: appendRuntimeEvent(m.runtimeEvents, event),
        })),
      };

    default:
      return state;
  }
}
