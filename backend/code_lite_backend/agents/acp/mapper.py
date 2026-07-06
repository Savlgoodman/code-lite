from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from code_lite_backend.agents.risk import describe_risk, risk_level
from code_lite_backend.core.structured_logging import sanitize_log_value


HISTORY_REPLAY_MIN_CHARS = 8


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_to_jsonable(item) for item in value]
    if hasattr(value, "__dict__"):
        return {
            str(key): _to_jsonable(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return str(value)


def _field(value: Any, snake_name: str, camel_name: str | None = None, default: Any = None) -> Any:
    if isinstance(value, dict):
        if snake_name in value:
            return value[snake_name]
        if camel_name and camel_name in value:
            return value[camel_name]
        return default
    found = getattr(value, snake_name, default)
    if found is not default or not camel_name:
        return found
    return getattr(value, camel_name, default)


def _text_from_content(content: Any) -> str:
    if content is None:
        return ""
    text = getattr(content, "text", None)
    if text is not None:
        return str(text)
    if isinstance(content, dict):
        return str(content.get("text") or "")
    return str(content)


def _content_text_from_blocks(value: Any) -> str:
    raw = _to_jsonable(value)
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        if isinstance(raw.get("text"), str):
            return raw["text"]
        content = raw.get("content")
        if content is not raw:
            nested = _content_text_from_blocks(content)
            if nested:
                return nested
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            text = _content_text_from_blocks(item)
            if text:
                parts.append(text)
        return "\n".join(parts)
    return ""


def _format_json(value: Any) -> str:
    try:
        return json.dumps(_to_jsonable(value), ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


@dataclass
class EventContext:
    """上下文信息，在映射事件时传递给 handler"""
    conversation_id: str
    turn_id: str
    runtime: str
    native_session_id: str | None = None
    metadata_extra: dict[str, Any] = field(default_factory=dict)


def _base_metadata(ctx: EventContext) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "runtime": ctx.runtime,
    }
    if ctx.native_session_id:
        metadata["nativeSessionId"] = ctx.native_session_id
    return metadata


def _base_event(event_type: str, ctx: EventContext) -> dict[str, Any]:
    return {
        "type": event_type,
        "conversationId": ctx.conversation_id,
        "turnId": ctx.turn_id,
        "metadata": _base_metadata(ctx),
    }


def _attach_raw_update(event: dict[str, Any], update: Any) -> dict[str, Any]:
    event.setdefault("metadata", {})
    event["metadata"]["rawUpdate"] = sanitize_log_value(_to_jsonable(update))
    return event


def _normalize_status(value: Any) -> str:
    status = str(value or "").strip()
    if status in {"pending", "in_progress", "completed"}:
        return status
    if status in {"complete", "done", "success", "succeeded"}:
        return "completed"
    if status in {"running", "active", "started", "in-progress"}:
        return "in_progress"
    return "pending"


def _clean_plan_text(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^\s*[-*]\s+\[[ xX]\]\s*", "", text)
    text = re.sub(r"^\s*(?:\d+|[一二三四五六七八九十]+)[.、]\s*", "", text)
    text = re.sub(r"^\s*#{1,6}\s*", "", text)
    text = text.replace("**", "").replace("__", "")
    return text.strip()


def _entry_from_raw(entry: Any, index: int) -> dict[str, Any] | None:
    raw = _to_jsonable(entry)
    if isinstance(raw, str):
        content = _clean_plan_text(raw)
        status = "pending"
        priority = "medium"
    elif isinstance(raw, dict):
        content = _clean_plan_text(
            str(raw.get("content") or raw.get("title") or raw.get("text") or raw.get("description") or "")
        )
        status = _normalize_status(raw.get("status"))
        priority = str(raw.get("priority") or "medium")
    else:
        return None
    if not content:
        return None
    if priority not in {"high", "medium", "low"}:
        priority = "medium"
    return {
        "id": str(raw.get("id") or f"plan-entry-{index}") if isinstance(raw, dict) else f"plan-entry-{index}",
        "content": content,
        "status": status,
        "priority": priority,
    }


def _normalize_plan_entries(entries: Any) -> list[dict[str, Any]]:
    raw_entries = _to_jsonable(entries)
    if not isinstance(raw_entries, list):
        return []
    result: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_entries):
        parsed = _entry_from_raw(entry, index)
        if parsed is not None:
            result.append(parsed)
    return result


def _entries_from_markdown(markdown: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    in_fence = False
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not stripped:
            continue

        status = "pending"
        text = ""
        checkbox = re.match(r"^[-*]\s+\[([ xX])\]\s+(.+)$", stripped)
        numbered = re.match(r"^(?:\d+|[一二三四五六七八九十]+)[.、]\s+(.+)$", stripped)
        step_heading = re.match(r"^#{2,6}\s+(?:步骤|Step|Task)\s*[\w一二三四五六七八九十]*[：:.\-\s]*(.+)$", stripped, re.I)

        if checkbox:
            status = "completed" if checkbox.group(1).lower() == "x" else "pending"
            text = checkbox.group(2)
        elif numbered:
            text = numbered.group(1)
        elif step_heading:
            text = step_heading.group(1)

        content = _clean_plan_text(text)
        if content:
            entries.append({
                "id": f"plan-entry-{len(entries)}",
                "content": content,
                "status": status,
                "priority": "medium",
            })

    return entries


def _plan_title_from_markdown(markdown: str) -> str | None:
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            title = _clean_plan_text(stripped)
            if title:
                return title
    return None


def _plan_snapshot(
    *,
    entries: list[dict[str, Any]] | None = None,
    markdown: str | None = None,
    source: str,
    title: str | None = None,
    plan_id: str | None = None,
    uri: str | None = None,
) -> dict[str, Any] | None:
    normalized_entries = list(entries or [])
    markdown_text = str(markdown or "").strip()
    if not normalized_entries and markdown_text:
        normalized_entries = _entries_from_markdown(markdown_text)
    if not normalized_entries and not markdown_text:
        return None
    plan: dict[str, Any] = {
        "entries": normalized_entries,
        "source": source,
    }
    if title or markdown_text:
        plan["title"] = title or _plan_title_from_markdown(markdown_text)
    if markdown_text:
        plan["markdown"] = markdown_text
    if plan_id:
        plan["id"] = plan_id
    if uri:
        plan["uri"] = uri
    return {key: value for key, value in plan.items() if value not in (None, "")}


def _extract_markdown_plan(value: Any) -> str:
    raw = _to_jsonable(value)
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        for key in ("markdown", "content", "text", "plan"):
            item = raw.get(key)
            if isinstance(item, str) and item.strip():
                return item
        raw_input = raw.get("rawInput") or raw.get("raw_input")
        if isinstance(raw_input, dict):
            item = raw_input.get("plan")
            if isinstance(item, str) and item.strip():
                return item
        return _content_text_from_blocks(raw.get("content"))
    return ""


def _plan_from_tool_payload(tool_call: Any, source: str) -> dict[str, Any] | None:
    raw = _to_jsonable(tool_call)
    if not isinstance(raw, dict):
        return None
    raw_input = raw.get("rawInput") or raw.get("raw_input")
    markdown = _extract_markdown_plan(raw_input) or _extract_markdown_plan(raw)
    if not markdown:
        return None
    plan_file = raw_input.get("planFilePath") if isinstance(raw_input, dict) else None
    return _plan_snapshot(
        markdown=markdown,
        source=source,
        title=str(raw.get("title") or "").strip() or None,
        uri=str(plan_file) if plan_file else None,
    )


def _plan_from_tool_result(result: Any) -> dict[str, Any] | None:
    if not isinstance(result, str):
        return None
    marker = "## Approved Plan"
    if marker not in result:
        return None
    markdown = result.split(marker, 1)[1].strip()
    markdown = re.sub(r"^\s*\(.*?\):\s*", "", markdown, count=1)
    if not markdown:
        return None
    return _plan_snapshot(markdown=markdown, source="acp.tool_result.approved_plan")


def _plan_from_codex_text(text: str) -> dict[str, Any] | None:
    normalized = text.lstrip()
    if not normalized.startswith("Plan:\n") and not normalized.startswith("Plan:\r\n"):
        return None
    markdown = re.sub(r"^Plan:\r?\n", "", normalized, count=1).strip()
    return _plan_snapshot(markdown=markdown, source="codex-acp.agent_message_chunk")


@dataclass
class TextDedupState:
    """文本 chunk 去重状态。

    部分 runtime 可能既发送 delta，又发送完整 snapshot，或者在复用 native
    session 时重放历史消息。状态需要同时记住跨 turn 的 native messageId，
    以及本 turn 开始前 code-lite 已经持久化过的文本基线。
    """
    accumulated: str = ""
    history_text: str = ""
    history_offset: int = 0
    seen_message_ids: set[str] = field(default_factory=set)
    current_turn_message_ids: set[str] = field(default_factory=set)

    def start_turn(self, history_text: str = "") -> None:
        """开始新的 turn，保留跨 turn 的 seen messageId。"""
        self.accumulated = ""
        self.history_text = history_text
        self.history_offset = 0
        self.current_turn_message_ids.clear()

    def reset(self) -> None:
        self.accumulated = ""
        self.history_text = ""
        self.history_offset = 0
        self.seen_message_ids.clear()
        self.current_turn_message_ids.clear()

    def dedup(self, chunk: str, *, message_id: str | None = None) -> str:
        """返回实际需要追加的增量文本。"""
        if not chunk:
            return ""

        if message_id:
            if message_id in self.seen_message_ids and message_id not in self.current_turn_message_ids:
                return ""
            self.seen_message_ids.add(message_id)
            self.current_turn_message_ids.add(message_id)

        chunk = self._strip_history_replay(chunk, allow_partial=message_id is not None)
        if not chunk:
            return ""

        if chunk == self.accumulated:
            return ""  # 完整 snapshot 重放，丢弃
        if self.accumulated and chunk.startswith(self.accumulated):
            delta = chunk[len(self.accumulated):]
            self.accumulated = chunk
            return delta
        # 正常增量或首次
        self.accumulated = chunk if not self.accumulated else self.accumulated + chunk
        return chunk

    def _strip_history_replay(self, chunk: str, *, allow_partial: bool) -> str:
        """去掉 runtime 在新 turn 开头重放的历史文本。"""
        if not self.history_text:
            return chunk

        if not allow_partial and len(self.history_text) < HISTORY_REPLAY_MIN_CHARS:
            return chunk

        if chunk.startswith(self.history_text):
            self.history_offset = len(self.history_text)
            return chunk[len(self.history_text):]

        if not allow_partial:
            return chunk

        remaining = self.history_text[self.history_offset:]
        if remaining and remaining.startswith(chunk):
            self.history_offset += len(chunk)
            return ""

        if remaining and chunk.startswith(remaining):
            self.history_offset = len(self.history_text)
            return chunk[len(remaining):]

        return chunk


def _map_agent_message_chunk(update: Any, ctx: EventContext) -> dict[str, Any]:
    text = _text_from_content(getattr(update, "content", None))
    plan = _plan_from_codex_text(text)
    if plan is not None:
        event = _base_event("agent.plan.updated", ctx)
        event["plan"] = plan
        message_id = getattr(update, "message_id", None)
        if message_id:
            event["metadata"]["nativeMessageId"] = str(message_id)
        return _attach_raw_update(event, update)

    event = _base_event("agent.text.delta", ctx)
    event["delta"] = text
    message_id = getattr(update, "message_id", None)
    if message_id:
        event["metadata"]["nativeMessageId"] = str(message_id)
    return event


def _map_agent_thought_chunk(update: Any, ctx: EventContext) -> dict[str, Any]:
    event = _base_event("agent.reasoning.delta", ctx)
    event["delta"] = _text_from_content(getattr(update, "content", None))
    message_id = getattr(update, "message_id", None)
    if message_id:
        event["metadata"]["nativeMessageId"] = str(message_id)
    return event


def _map_session_info_update(update: Any, ctx: EventContext) -> dict[str, Any] | None:
    title = str(getattr(update, "title", "") or "").strip()
    if not title:
        return None
    event = _base_event("agent.session.updated", ctx)
    event["title"] = title
    return event


def _map_plan_update(update: Any, ctx: EventContext) -> dict[str, Any]:
    entries = _normalize_plan_entries(getattr(update, "entries", None))
    markdown = _extract_markdown_plan(getattr(update, "plan", None)) or _extract_markdown_plan(update)
    plan = _plan_snapshot(
        entries=entries,
        markdown=markdown,
        source="acp.plan",
        plan_id=str(_field(update, "plan_id", "planId", "") or "") or None,
    )
    event = _base_event("agent.plan.updated", ctx)
    event["plan"] = plan or {"entries": [], "source": "acp.plan"}
    return _attach_raw_update(event, update)


def _map_current_mode_update(update: Any, ctx: EventContext) -> dict[str, Any]:
    event = _base_event("agent.mode.updated", ctx)
    event["modeId"] = str(_field(update, "current_mode_id", "currentModeId", "") or "")
    return _attach_raw_update(event, update)


def _map_available_commands_update(update: Any, ctx: EventContext) -> dict[str, Any]:
    raw_commands = _to_jsonable(_field(update, "available_commands", "availableCommands", []))
    commands: list[dict[str, Any]] = []
    if isinstance(raw_commands, list):
        for item in raw_commands:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            commands.append({
                "id": name,
                "label": name,
                "description": str(item.get("description") or ""),
                "command": f"/{name}",
            })
    event = _base_event("agent.command.available.updated", ctx)
    event["commands"] = commands
    return _attach_raw_update(event, update)


def _map_config_option_update(update: Any, ctx: EventContext) -> dict[str, Any]:
    event = _base_event("agent.config.updated", ctx)
    event["configOptions"] = _to_jsonable(_field(update, "config_options", "configOptions", []))
    return _attach_raw_update(event, update)


def _map_raw_update(update: Any, ctx: EventContext) -> dict[str, Any]:
    kind = str(getattr(update, "session_update", None) or _field(update, "session_update", "sessionUpdate", "unknown"))
    event = _base_event("agent.raw.update", ctx)
    event["updateKind"] = kind
    event["raw"] = sanitize_log_value(_to_jsonable(update))
    return event


def _map_tool_call(update: Any, ctx: EventContext) -> dict[str, Any]:
    tool_call_id = str(getattr(update, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
    name = str(getattr(update, "title", None) or getattr(update, "kind", None) or "tool")
    raw_input = _to_jsonable(getattr(update, "raw_input", None))
    kind = str(getattr(update, "kind", "") or name)
    event = _base_event("agent.tool.started", ctx)
    event.update({
        "toolCallId": tool_call_id,
        "name": name,
        "arguments": raw_input,
        "risk": risk_level(kind),
    })
    event["metadata"].update({
        "status": getattr(update, "status", None),
        "kind": getattr(update, "kind", None),
    })
    plan = _plan_from_tool_payload(update, "acp.tool_call.switch_mode")
    if plan is not None:
        event["plan"] = plan
    return event


def _map_tool_call_update(update: Any, ctx: EventContext) -> dict[str, Any] | None:
    status = str(getattr(update, "status", "") or "")
    tool_call_id = str(getattr(update, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
    name = str(getattr(update, "title", None) or "tool")
    raw_output = _to_jsonable(getattr(update, "raw_output", None))
    content = _to_jsonable(getattr(update, "content", None))

    if status == "completed":
        event = _base_event("agent.tool.completed", ctx)
        event.update({
            "toolCallId": tool_call_id,
            "name": name,
            "result": raw_output if raw_output is not None else content,
        })
        event["metadata"]["status"] = status
        result = raw_output if raw_output is not None else content
        plan = _plan_from_tool_result(result)
        if plan is not None:
            event["plan"] = plan
        return event

    if status == "failed":
        event = _base_event("agent.tool.failed", ctx)
        event.update({
            "toolCallId": tool_call_id,
            "name": name,
            "error": _format_json(raw_output) if raw_output else "Tool failed",
        })
        event["metadata"].update({
            "status": status,
            "content": content,
        })
        return event

    # 中间状态 → agent.tool.delta（长命令的中间进度）
    if status and status not in ("completed", "failed"):
        event = _base_event("agent.tool.delta", ctx)
        event.update({
            "toolCallId": tool_call_id,
            "name": name,
            "status": status,
        })
        if raw_output is not None:
            event["progress"] = raw_output
        elif content is not None:
            event["progress"] = content
        return event

    return None


@dataclass
class UsageSnapshot:
    """ACP usage 快照，合并 PromptResponse.usage 分项数据和 usage_update context window 数据。"""
    # 来自 PromptResponse.usage 的分项数据
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_read_tokens: int | None = None
    cached_write_tokens: int | None = None
    thought_tokens: int | None = None
    # 来自 UsageUpdate 的 context window 数据
    total_tokens: int | None = None
    context_used_tokens: int | None = None
    context_window_tokens: int | None = None
    source: str = "acp"

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cachedReadTokens": self.cached_read_tokens,
            "cachedWriteTokens": self.cached_write_tokens,
            "thoughtTokens": self.thought_tokens,
            "totalTokens": self.total_tokens,
            "contextUsedTokens": self.context_used_tokens,
            "contextWindowTokens": self.context_window_tokens,
            "source": self.source,
        }
        return {key: value for key, value in result.items() if value is not None}


def _extract_usage(update: Any) -> UsageSnapshot:
    """从 ACP usage_update 事件提取 context window 维度的 usage。"""
    return UsageSnapshot(
        total_tokens=getattr(update, "used", None),
        context_used_tokens=getattr(update, "used", None),
        context_window_tokens=getattr(update, "size", None),
        source="acp.usage_update",
    )


def extract_prompt_response_usage(usage: Any) -> UsageSnapshot:
    """从 PromptResponse.usage（Usage 对象）中提取完整分项 token 数据。"""
    return UsageSnapshot(
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        cached_read_tokens=getattr(usage, "cached_read_tokens", None),
        cached_write_tokens=getattr(usage, "cached_write_tokens", None),
        thought_tokens=getattr(usage, "thought_tokens", None),
        total_tokens=getattr(usage, "total_tokens", None),
        source="acp.prompt_response.usage",
    )


# 压缩检测关键词
COMPACT_SIGNALS = [
    "context compacted",
    "compacting",
    "context compressed",
]


def _detect_compaction(content: str, prev_usage: dict[str, Any] | None, curr_usage: dict[str, Any] | None) -> bool:
    """检测是否发生了上下文压缩。

    通过文本关键词匹配和 usage 骤降检测判断。
    """
    content_lower = content.lower()
    if any(signal in content_lower for signal in COMPACT_SIGNALS):
        return True
    if prev_usage and curr_usage:
        prev_used = prev_usage.get("contextUsedTokens") or prev_usage.get("totalTokens", 0)
        curr_used = curr_usage.get("contextUsedTokens") or curr_usage.get("totalTokens", 0)
        if isinstance(prev_used, (int, float)) and isinstance(curr_used, (int, float)):
            if prev_used > 0 and curr_used < prev_used * 0.5:
                return True
    return False


# 声明式映射表：ACP session_update kind → handler
ACP_EVENT_MAP: dict[str, Callable[[Any, EventContext], dict[str, Any] | None]] = {
    "agent_message_chunk": _map_agent_message_chunk,
    "agent_thought_chunk": _map_agent_thought_chunk,
    "available_commands_update": _map_available_commands_update,
    "config_option_update": _map_config_option_update,
    "current_mode_update": _map_current_mode_update,
    "plan": _map_plan_update,
    "session_info_update": _map_session_info_update,
    "tool_call": _map_tool_call,
    "tool_call_update": _map_tool_call_update,
}


class AcpEventMapper:
    """声明式 ACP → UnifiedAgentEvent 映射器。

    所有 ACP agent 共用，不需要为每个 runtime 写映射逻辑。
    内置文本去重，处理 runtime 可能的 snapshot 重放。
    """

    def __init__(self, runtime: str) -> None:
        self.runtime = runtime
        self._text_dedup: dict[str, TextDedupState] = {}  # channel -> state

    def _get_dedup(self, channel: str) -> TextDedupState:
        if channel not in self._text_dedup:
            self._text_dedup[channel] = TextDedupState()
        return self._text_dedup[channel]

    def map_update(self, update: Any, ctx: EventContext) -> dict[str, Any] | None:
        """将 ACP session/update 映射为 UnifiedAgentEvent。

        所有未知 update 会转为 agent.raw.update 推送与记录，避免未来协议项静默丢失。
        """
        kind = str(getattr(update, "session_update", "unknown"))
        handler = ACP_EVENT_MAP.get(kind)
        if handler:
            event = handler(update, ctx)
            if event is None:
                return None
            # 对文本事件应用去重
            if event.get("type") in ("agent.text.delta", "agent.reasoning.delta"):
                channel = kind
                dedup = self._get_dedup(channel)
                raw_delta = event.get("delta", "")
                metadata = event.get("metadata")
                message_id = None
                if isinstance(metadata, dict) and metadata.get("nativeMessageId"):
                    message_id = str(metadata["nativeMessageId"])
                deduped = dedup.dedup(raw_delta, message_id=message_id)
                if not deduped:
                    return None  # 重复 snapshot，丢弃
                event["delta"] = deduped
            return event
        return _map_raw_update(update, ctx)

    def start_turn(self, *, text_baseline: str = "", reasoning_baseline: str = "") -> None:
        """开始新 turn，设置已保存历史文本基线。"""
        self._get_dedup("agent_message_chunk").start_turn(text_baseline)
        self._get_dedup("agent_thought_chunk").start_turn(reasoning_baseline)

    def reset_dedup(self) -> None:
        """完全重置去重状态。"""
        for state in self._text_dedup.values():
            state.reset()
        self._text_dedup.clear()

    def map_permission_request(
        self,
        tool_call: Any,
        options: list[Any],
        ctx: EventContext,
        approval_id: str,
    ) -> dict[str, Any]:
        """将 ACP session/request_permission 映射为 approval.required"""
        tool_call_id = str(getattr(tool_call, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
        name = str(getattr(tool_call, "title", None) or getattr(tool_call, "kind", None) or "Permission request")
        kind = str(getattr(tool_call, "kind", None) or name)
        risk = risk_level(kind)
        description = describe_risk(kind)

        event: dict[str, Any] = {
            "type": "approval.required",
            "conversationId": ctx.conversation_id,
            "turnId": ctx.turn_id,
            "approvalId": approval_id,
            "toolCallId": tool_call_id,
            "name": name,
            "arguments": _to_jsonable(tool_call),
            "argumentsText": _format_json(tool_call),
            "risk": risk,
            **description,
            "metadata": {
                **_base_metadata(ctx),
                "options": [_to_jsonable(option) for option in options],
            },
        }
        plan = _plan_from_tool_payload(tool_call, "acp.permission.switch_mode")
        if plan is not None:
            event["plan"] = plan
        return event

    def map_raw_rpc_event(self, payload: dict[str, Any], ctx: EventContext) -> dict[str, Any]:
        """记录 ACP SDK 未建模或未适配的原始 JSON-RPC 项。"""
        event = _base_event("agent.raw.rpc", ctx)
        event["method"] = str(payload.get("method") or "")
        event["direction"] = str(payload.get("direction") or "unknown")
        event["rpcKind"] = str(payload.get("rpcKind") or "unknown")
        event["raw"] = sanitize_log_value(_to_jsonable(payload.get("message")))
        return event


# 工具函数，供其他模块使用
to_jsonable = _to_jsonable
text_from_content = _text_from_content
format_json = _format_json
extract_usage = _extract_usage
extract_prompt_response_usage = extract_prompt_response_usage
