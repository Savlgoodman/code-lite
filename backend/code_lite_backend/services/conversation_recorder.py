from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from code_lite_backend.storage.conversations import (
    DEFAULT_PREVIEW,
    DEFAULT_TITLE,
    ConversationStore,
    create_conversation_id,
    now_ms,
)


def create_message_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def title_from_input(value: str) -> str:
    text = " ".join(value.strip().split())
    if not text:
        return DEFAULT_TITLE
    return f"{text[:24]}..." if len(text) > 24 else text


def format_json(value: Any) -> str:
    try:
        return json.dumps(value if value is not None else {}, ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


def _default_tool_call(tool_call_id: str, name: str) -> dict[str, Any]:
    timestamp = now_ms()
    return {
        "id": tool_call_id,
        "name": name,
        "argumentsText": "{}",
        "status": "running",
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


@dataclass(frozen=True)
class TurnRecord:
    session: dict[str, Any]
    user_message: dict[str, Any]
    assistant_message: dict[str, Any]
    messages: list[dict[str, Any]]


class ConversationRecorder:
    def __init__(self, store: ConversationStore) -> None:
        self._store = store
        self._active_messages: dict[str, list[dict[str, Any]]] = {}
        self._active_sessions: dict[str, dict[str, Any]] = {}

    def create_conversation_id(self) -> str:
        return create_conversation_id()

    def start_turn(
        self,
        *,
        conversation_id: str,
        prompt: str,
        agent_metadata: dict[str, Any] | None = None,
        model_metadata: dict[str, Any] | None = None,
    ) -> TurnRecord:
        timestamp = now_ms()
        agent_metadata = agent_metadata or {}
        model_metadata = model_metadata or {}
        persisted = self._store.get_conversation(conversation_id)
        previous_session = persisted.get("session") if persisted else {}
        session = {
            **previous_session,
            "agent": previous_session.get("agent") or agent_metadata or None,
            "id": conversation_id,
            "createdAt": previous_session.get("createdAt") or timestamp,
            "preview": prompt or DEFAULT_PREVIEW,
            "status": "running",
            "title": self._title_for_turn(conversation_id, prompt),
            "updatedAt": timestamp,
        }
        user_message = {
            "id": create_message_id("user"),
            "role": "user",
            "content": prompt,
            "createdAt": timestamp,
            "agent": session.get("agent"),
            "model": model_metadata or None,
            "toolCalls": [],
        }
        assistant_message = {
            "id": create_message_id("assistant"),
            "role": "assistant",
            "content": "",
            "createdAt": timestamp,
            "agent": session.get("agent"),
            "model": model_metadata or None,
            "streaming": True,
            "toolCalls": [],
        }
        messages = list(persisted.get("messages") or []) if persisted else []
        messages.extend([user_message, assistant_message])
        self._active_sessions[conversation_id] = session
        self._active_messages[conversation_id] = messages
        return TurnRecord(
            session=session,
            user_message=user_message,
            assistant_message=assistant_message,
            messages=messages,
        )

    def apply_agent_event(
        self,
        *,
        conversation_id: str,
        assistant_message_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any] | None:
        event_type = event.get("type")
        session_patch: dict[str, Any] | None = None

        messages = self._active_messages.get(conversation_id)
        if messages is None:
            messages = self._store.load_messages(conversation_id)
            self._active_messages[conversation_id] = messages
        assistant = self._find_message(messages, assistant_message_id)
        if assistant is None:
            return None

        if event_type == "agent.text.delta":
            assistant["content"] = f"{assistant.get('content') or ''}{event.get('delta') or ''}"
        elif event_type == "agent.reasoning.delta":
            assistant["reasoning"] = f"{assistant.get('reasoning') or ''}{event.get('delta') or ''}"
        elif event_type == "agent.context.updated":
            # 保存最新的 context usage 到 assistant message
            context_data = event.get("context")
            if isinstance(context_data, dict):
                assistant["usage"] = {
                    **(assistant.get("usage") or {}),
                    **context_data,
                }
        elif event_type == "agent.tool.started":
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "anchorOffset": len(str(assistant.get("content") or "")),
                    "argumentsText": format_json(event.get("arguments")),
                    "name": str(event.get("name") or ""),
                    "risk": event.get("risk"),
                    "status": "running",
                },
            )
        elif event_type == "agent.tool.completed":
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "name": str(event.get("name") or ""),
                    "resultText": format_json(event.get("result") if "result" in event else event.get("metadata")),
                    "status": "complete",
                },
            )
        elif event_type == "agent.tool.failed":
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "error": event.get("error") or "工具调用失败",
                    "name": str(event.get("name") or ""),
                    "status": "error",
                },
            )
        elif event_type == "approval.required":
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or event.get("approvalId") or create_message_id("tool"),
                {
                    "anchorOffset": len(str(assistant.get("content") or "")),
                    "argumentsText": format_json(event.get("argumentsText") or event.get("arguments")),
                    "name": str(event.get("name") or ""),
                    "risk": event.get("risk"),
                    "status": "approval",
                },
            )
            self._update_active_session(conversation_id, {"status": "approval"})
        elif event_type == "agent.run.completed":
            assistant["streaming"] = False
            if isinstance(event.get("usage"), dict):
                assistant["usage"] = event["usage"]
            session_patch = {"status": "idle"}
        elif event_type == "agent.run.failed":
            assistant["streaming"] = False
            assistant["error"] = event.get("error") or "Agent 运行失败"
            session_patch = {"status": "error"}

        if session_patch is not None:
            return self.finish_turn(conversation_id, session_patch)
        return None

    def update_session(self, conversation_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        session = self._update_active_session(conversation_id, patch)
        if conversation_id not in self._active_messages:
            return self._store.save_session(conversation_id, session)
        return session

    def finish_turn(self, conversation_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        session = self._update_active_session(conversation_id, patch)
        messages = self._active_messages.pop(conversation_id, None)
        self._active_sessions.pop(conversation_id, None)
        if messages is not None:
            self._store.save_session(conversation_id, session)
            self._store.save_messages(conversation_id, messages)
        return session

    def discard_turn(self, conversation_id: str) -> None:
        self._active_messages.pop(conversation_id, None)
        self._active_sessions.pop(conversation_id, None)

    def _update_active_session(self, conversation_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        session = self._active_sessions.get(conversation_id)
        if session is None:
            persisted = self._store.get_conversation(conversation_id)
            session = (persisted.get("session") if persisted else None) or {
                "id": conversation_id,
                "createdAt": now_ms(),
                "title": DEFAULT_TITLE,
                "preview": DEFAULT_PREVIEW,
                "status": "idle",
            }
        session = {
            **session,
            **patch,
            "id": conversation_id,
            "updatedAt": now_ms(),
        }
        self._active_sessions[conversation_id] = session
        return session

    def _title_for_turn(self, conversation_id: str, prompt: str) -> str:
        current = self._store.get_conversation(conversation_id)
        if current is None:
            return title_from_input(prompt)

        session = current.get("session") or {}
        messages = current.get("messages") or []
        if any(message.get("role") == "user" for message in messages):
            return str(session.get("title") or DEFAULT_TITLE)
        return title_from_input(prompt)

    @staticmethod
    def _find_message(messages: list[dict[str, Any]], message_id: str) -> dict[str, Any] | None:
        for message in messages:
            if message.get("id") == message_id:
                return message
        return None

    @staticmethod
    def _upsert_tool_call(message: dict[str, Any], tool_call_id: str, patch: dict[str, Any]) -> None:
        timestamp = now_ms()
        tool_calls = message.setdefault("toolCalls", [])
        for index, tool_call in enumerate(tool_calls):
            if tool_call.get("id") == tool_call_id:
                tool_calls[index] = {
                    **tool_call,
                    **patch,
                    "updatedAt": timestamp,
                }
                return

        name = str(patch.get("name") or "")
        tool_calls.append(
            {
                **_default_tool_call(tool_call_id, name),
                **patch,
                "updatedAt": timestamp,
            }
        )
