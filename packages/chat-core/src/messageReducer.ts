/**
 * 消息 / 工具调用 / plan 合并原语。
 *
 * 从 ui/src/pages/ChatPage.tsx 抽出的纯逻辑，供桌面与远端 reducer 共用。
 * 这些函数不依赖 React，不产生副作用（除读取 Date.now 时间戳外）。
 * 行为与原 ChatPage 内联实现逐字一致。
 */

import type { ChatMessage, PlanSnapshot, ToolCallItem } from "@code-lite/protocol";
import { hasVisiblePlan, latestMergedPlanFromMessages, mergePlanSnapshot } from "./planSnapshots";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function updateMessage(
  messages: Record<string, ChatMessage[]>,
  sessionId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): Record<string, ChatMessage[]> {
  return {
    ...messages,
    [sessionId]: (messages[sessionId] ?? []).map((message) =>
      message.id === messageId ? updater(message) : message
    )
  };
}

export function mergeRecords(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return Object.entries(incoming).reduce<Record<string, unknown>>((merged, [key, value]) => {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeRecords(current, value);
    } else {
      merged[key] = value;
    }
    return merged;
  }, { ...previous });
}

export function mergeFileDiffs(previous: unknown, incoming: unknown): unknown {
  if (!Array.isArray(previous) && !Array.isArray(incoming)) {
    return incoming ?? previous;
  }

  const merged: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  for (const source of [previous, incoming]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const item of source) {
      if (!isRecord(item) || typeof item.diffId !== "string") {
        continue;
      }
      const index = seen.get(item.diffId);
      if (index == null) {
        seen.set(item.diffId, merged.length);
        merged.push({ ...item });
      } else {
        merged[index] = { ...merged[index], ...item };
      }
    }
  }
  return merged;
}

export function mergeToolMetadata(
  previous: ToolCallItem["metadata"],
  incoming: ToolCallItem["metadata"],
): ToolCallItem["metadata"] {
  if (isRecord(previous) && isRecord(incoming)) {
    const merged = mergeRecords(previous, incoming);
    merged.fileDiffs = mergeFileDiffs(previous.fileDiffs, incoming.fileDiffs);
    return merged;
  }
  return incoming ?? previous;
}

export function mergeToolName(previous: string | undefined, incoming: string | undefined): string {
  if (previous && (!incoming || incoming === "tool")) {
    return previous;
  }
  return incoming ?? previous ?? "";
}

export function upsertToolCall(
  toolCalls: ToolCallItem[],
  item: Partial<ToolCallItem> & Pick<ToolCallItem, "id" | "name">,
): ToolCallItem[] {
  const now = Date.now();
  const index = toolCalls.findIndex((tool) => tool.id === item.id);
  if (index < 0) {
    return [
      ...toolCalls,
      {
        argumentsText: "{}",
        createdAt: now,
        status: "running",
        updatedAt: now,
        ...item
      } as ToolCallItem
    ];
  }

  return toolCalls.map((tool, currentIndex) =>
    currentIndex === index
      ? {
          ...tool,
          ...item,
          anchorOffset: item.anchorOffset ?? tool.anchorOffset,
          metadata: mergeToolMetadata(tool.metadata, item.metadata),
          name: mergeToolName(tool.name, item.name),
          updatedAt: now
        }
      : tool
  );
}

export interface RuntimeEventLike {
  type: string;
  [key: string]: unknown;
}

export function appendRuntimeEvent(
  events: ChatMessage["runtimeEvents"],
  event: RuntimeEventLike,
): NonNullable<ChatMessage["runtimeEvents"]> {
  const base: NonNullable<ChatMessage["runtimeEvents"]>[number] = {
    type: event.type,
    createdAt: Date.now(),
  };
  const rawEvent = event as Record<string, unknown>;
  for (const key of ["direction", "method", "modeId", "raw", "rpcKind", "updateKind"] as const) {
    if (rawEvent[key] != null) {
      (base as unknown as Record<string, unknown>)[key] = rawEvent[key];
    }
  }
  return [...(events ?? []), base].slice(-200);
}

export function mergeMessagePlan(
  message: ChatMessage,
  sessionMessages: ChatMessage[] | undefined,
  nextPlan: PlanSnapshot | undefined | null,
): PlanSnapshot | null | undefined {
  if (nextPlan?.source === "acp.plan") {
    return mergePlanSnapshot(null, nextPlan);
  }
  if (!hasVisiblePlan(nextPlan)) {
    return message.plan;
  }
  return mergePlanSnapshot(message.plan ?? latestMergedPlanFromMessages(sessionMessages, message.id), nextPlan);
}
