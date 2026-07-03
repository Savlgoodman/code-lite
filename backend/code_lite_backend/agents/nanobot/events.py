from __future__ import annotations

from typing import Any

from nanobot import (
    STREAM_EVENT_REASONING_COMPLETED,
    STREAM_EVENT_REASONING_DELTA,
    STREAM_EVENT_RUN_COMPLETED,
    STREAM_EVENT_RUN_FAILED,
    STREAM_EVENT_RUN_STARTED,
    STREAM_EVENT_TEXT_COMPLETED,
    STREAM_EVENT_TEXT_DELTA,
    STREAM_EVENT_TOOL_COMPLETED,
    STREAM_EVENT_TOOL_FAILED,
    STREAM_EVENT_TOOL_STARTED,
)

from code_lite_backend.agents.risk import risk_level
from code_lite_backend.core.json_utils import to_jsonable


def map_nanobot_event(event: Any, *, conversation_id: str, turn_id: str) -> dict[str, Any]:
    base = {
        "conversationId": conversation_id,
        "turnId": turn_id,
    }

    if event.type == STREAM_EVENT_RUN_STARTED:
        return {
            **base,
            "type": "agent.run.started",
            "metadata": to_jsonable(getattr(event, "metadata", {}) or {}),
        }
    if event.type == STREAM_EVENT_TEXT_DELTA:
        return {
            **base,
            "type": "agent.text.delta",
            "delta": getattr(event, "delta", "") or "",
        }
    if event.type == STREAM_EVENT_TEXT_COMPLETED:
        return {
            **base,
            "type": "agent.text.completed",
            "resuming": bool(getattr(event, "resuming", False)),
        }
    if event.type == STREAM_EVENT_REASONING_DELTA:
        return {
            **base,
            "type": "agent.reasoning.delta",
            "delta": getattr(event, "delta", "") or "",
        }
    if event.type == STREAM_EVENT_REASONING_COMPLETED:
        return {
            **base,
            "type": "agent.reasoning.completed",
            "content": getattr(event, "content", "") or "",
        }
    if event.type == STREAM_EVENT_TOOL_STARTED:
        name = getattr(event, "name", "") or ""
        return {
            **base,
            "type": "agent.tool.started",
            "toolCallId": getattr(event, "tool_call_id", "") or "",
            "name": name,
            "arguments": to_jsonable(getattr(event, "arguments", {}) or {}),
            "risk": risk_level(name),
        }
    if event.type == STREAM_EVENT_TOOL_COMPLETED:
        return {
            **base,
            "type": "agent.tool.completed",
            "toolCallId": getattr(event, "tool_call_id", "") or "",
            "name": getattr(event, "name", "") or "",
            "result": to_jsonable(getattr(event, "result", None)),
            "metadata": to_jsonable(getattr(event, "metadata", {}) or {}),
        }
    if event.type == STREAM_EVENT_TOOL_FAILED:
        return {
            **base,
            "type": "agent.tool.failed",
            "toolCallId": getattr(event, "tool_call_id", "") or "",
            "name": getattr(event, "name", "") or "",
            "error": getattr(event, "error", None) or "工具调用失败",
            "metadata": to_jsonable(getattr(event, "metadata", {}) or {}),
        }
    if event.type == STREAM_EVENT_RUN_COMPLETED:
        result = getattr(event, "result", None)
        return {
            **base,
            "type": "agent.run.completed",
            "result": to_jsonable(result),
            "usage": to_jsonable(getattr(result, "usage", None)),
        }
    if event.type == STREAM_EVENT_RUN_FAILED:
        return {
            **base,
            "type": "agent.run.failed",
            "error": getattr(event, "error", None) or "Agent 运行失败",
        }

    return {
        **base,
        "type": "agent.event",
        "rawType": getattr(event, "type", "unknown"),
        "payload": to_jsonable(event),
    }
