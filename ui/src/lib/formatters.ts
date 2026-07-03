import type { ToolCallItem } from "../types";

export function formatTimeLabel(value: number) {
  const diff = Date.now() - value;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) {
    return "刚刚";
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)} 分`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)} 小时`;
  }
  return `${Math.floor(diff / day)} 天`;
}

export function formatConversationBoundaryTime(value: number) {
  const date = new Date(value);
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return time;
  }

  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
  return `${weekday} ${time}`;
}

export function titleFromInput(input: string) {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) {
    return "新的维修会话";
  }
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function summarizeArguments(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 3);
      const summary = entries.map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join(", ");
      return summary.length > 120 ? `${summary.slice(0, 120)}...` : summary || "{}";
    }
  } catch {
    // Fall back to plain text summary below.
  }

  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact || "{}";
}

export function formatRisk(risk?: ToolCallItem["risk"]) {
  if (risk === "high") {
    return "高风险";
  }
  if (risk === "medium") {
    return "中风险";
  }
  if (risk === "blocked") {
    return "已阻止";
  }
  return "低风险";
}
