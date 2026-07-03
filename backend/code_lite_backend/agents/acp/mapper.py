from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from code_lite_backend.agents.risk import describe_risk, risk_level


def _to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_to_jsonable(item) for item in value]
    return value


def _text_from_content(content: Any) -> str:
    if content is None:
        return ""
    text = getattr(content, "text", None)
    if text is not None:
        return str(text)
    if isinstance(content, dict):
        return str(content.get("text") or "")
    return str(content)


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


def _map_agent_message_chunk(update: Any, ctx: EventContext) -> dict[str, Any]:
    event = _base_event("agent.text.delta", ctx)
    event["delta"] = _text_from_content(getattr(update, "content", None))
    return event


def _map_agent_thought_chunk(update: Any, ctx: EventContext) -> dict[str, Any]:
    event = _base_event("agent.reasoning.delta", ctx)
    event["delta"] = _text_from_content(getattr(update, "content", None))
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

    return None


@dataclass
class UsageSnapshot:
    """从 ACP usage_update 提取的 usage 快照"""
    total_tokens: int | None = None
    context_used_tokens: int | None = None
    context_window_tokens: int | None = None
    source: str = "acp.usage_update"

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "totalTokens": self.total_tokens,
            "contextUsedTokens": self.context_used_tokens,
            "contextWindowTokens": self.context_window_tokens,
            "source": self.source,
        }
        return {key: value for key, value in result.items() if value is not None}


def _extract_usage(update: Any) -> UsageSnapshot:
    return UsageSnapshot(
        total_tokens=getattr(update, "used", None),
        context_used_tokens=getattr(update, "used", None),
        context_window_tokens=getattr(update, "size", None),
    )


# 声明式映射表：ACP session_update kind → handler
ACP_EVENT_MAP: dict[str, Callable[[Any, EventContext], dict[str, Any] | None]] = {
    "agent_message_chunk": _map_agent_message_chunk,
    "agent_thought_chunk": _map_agent_thought_chunk,
    "tool_call": _map_tool_call,
    "tool_call_update": _map_tool_call_update,
}


class AcpEventMapper:
    """声明式 ACP → UnifiedAgentEvent 映射器。

    所有 ACP agent 共用，不需要为每个 runtime 写映射逻辑。
    """

    def __init__(self, runtime: str) -> None:
        self.runtime = runtime

    def map_update(self, update: Any, ctx: EventContext) -> dict[str, Any] | None:
        """将 ACP session/update 映射为 UnifiedAgentEvent。

        返回 None 表示该事件不需要推送前端（如 usage_update）。
        """
        kind = str(getattr(update, "session_update", "unknown"))
        handler = ACP_EVENT_MAP.get(kind)
        if handler:
            return handler(update, ctx)
        return None

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
        return event


# 工具函数，供其他模块使用
to_jsonable = _to_jsonable
text_from_content = _text_from_content
format_json = _format_json
extract_usage = _extract_usage
