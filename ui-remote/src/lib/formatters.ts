/** 消息时间格式化：今天显示 HH:MM，其他天显示 "周X HH:MM" */
export function formatMessageTime(value: number) {
  const date = new Date(value);
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

/** 完整日期时间（用于 title tooltip） */
export function formatFullDateTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
