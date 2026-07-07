from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from code_lite_backend.storage.conversations import (
    DEFAULT_PREVIEW,
    DEFAULT_TITLE,
    ConversationStore,
    create_conversation_id,
    now_ms,
)
from code_lite_backend.storage.diff_artifacts import DiffArtifactStore


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


def _event_record(event: dict[str, Any]) -> dict[str, Any]:
    timestamp = now_ms()
    keys = (
        "type",
        "updateKind",
        "method",
        "direction",
        "rpcKind",
        "modeId",
        "commands",
        "configOptions",
        "raw",
        "metadata",
    )
    record = {key: event[key] for key in keys if key in event}
    record["createdAt"] = timestamp
    return record


def _event_metadata(event: dict[str, Any]) -> dict[str, Any] | None:
    metadata = event.get("metadata")
    return metadata if isinstance(metadata, dict) else None


def _deep_merge_records(previous: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(previous)
    for key, value in incoming.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _deep_merge_records(current, value)
        else:
            merged[key] = value
    return merged


def _merge_file_diff_summaries(previous: Any, incoming: Any) -> list[dict[str, Any]] | None:
    if not isinstance(previous, list) and not isinstance(incoming, list):
        return None

    merged: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for source in (previous, incoming):
        if not isinstance(source, list):
            continue
        for item in source:
            if not isinstance(item, dict):
                continue
            diff_id = str(item.get("diffId") or "").strip()
            if not diff_id:
                continue
            if diff_id in seen:
                merged[seen[diff_id]] = {
                    **merged[seen[diff_id]],
                    **item,
                }
                continue
            seen[diff_id] = len(merged)
            merged.append(dict(item))
    return merged


def _merge_tool_metadata(previous: Any, incoming: Any) -> Any:
    if isinstance(previous, dict) and isinstance(incoming, dict):
        merged = _deep_merge_records(previous, incoming)
        file_diffs = _merge_file_diff_summaries(previous.get("fileDiffs"), incoming.get("fileDiffs"))
        if file_diffs is not None:
            merged["fileDiffs"] = file_diffs
        return merged
    if incoming is None:
        return previous
    return incoming


def _merge_tool_name(previous: Any, incoming: Any) -> str:
    previous_name = str(previous or "")
    incoming_name = str(incoming or "")
    if previous_name and incoming_name in {"", "tool"}:
        return previous_name
    return incoming_name or previous_name


def _has_visible_plan(plan: Any) -> bool:
    if not isinstance(plan, dict):
        return False
    entries = plan.get("entries")
    markdown = plan.get("markdown")
    return (isinstance(entries, list) and len(entries) > 0) or _has_markdown_plan_entries(markdown)


def _has_markdown_plan_entries(markdown: Any) -> bool:
    if not isinstance(markdown, str) or not markdown.strip():
        return False
    for line in markdown.splitlines():
        stripped = line.strip()
        if re.match(r"^[-*]\s+\[[ xX]\]\s+.+$", stripped):
            return True
        if re.match(r"^(?:\d+|[一二三四五六七八九十]+)[.、]\s+.+$", stripped):
            return True
        if re.match(r"^#{2,6}\s+(?:步骤|Step|Task)\s*[\w一二三四五六七八九十]*[：:.\-\s]*.+$", stripped, re.I):
            return True
    return False


def _merge_plan_snapshot(current: Any, next_plan: Any) -> dict[str, Any] | None:
    if not isinstance(next_plan, dict):
        return current if isinstance(current, dict) else None
    if next_plan.get("source") == "acp.plan":
        return next_plan if _has_visible_plan(next_plan) else None
    if not _has_visible_plan(next_plan):
        return current if isinstance(current, dict) else None
    if not isinstance(current, dict) or not _has_visible_plan(current):
        return next_plan
    return next_plan


def _split_lines(value: str | None) -> list[str]:
    if not value:
        return []
    return value.splitlines()


def _diff_stats(old_text: str | None, new_text: str | None) -> dict[str, int]:
    old_lines = _split_lines(old_text)
    new_lines = _split_lines(new_text)
    if old_text is None:
        return {"added": len(new_lines), "removed": 0}
    if new_text is None:
        return {"added": 0, "removed": len(old_lines)}

    added = 0
    removed = 0
    matcher = SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    for tag, first_start, first_end, second_start, second_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        removed += first_end - first_start
        added += second_end - second_start
    return {"added": added, "removed": removed}


def _content_change_kind(content: dict[str, Any], old_text: str | None, new_text: str | None) -> str:
    meta = content.get("_meta")
    native_kind = str(meta.get("kind") or "").strip().lower() if isinstance(meta, dict) else ""
    if old_text is None and new_text is not None:
        return "create"
    if old_text is not None and new_text is None:
        return "delete" if native_kind == "delete" else "clear"
    if old_text is not None and new_text == "":
        return "delete" if native_kind == "delete" else "clear"
    return "modify"


def _safe_diff_id(tool_call_id: str, content_index: int) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", tool_call_id.strip()) or "tool"
    return f"{base}-{content_index}"


def _raw_update_summary(raw_update: dict[str, Any]) -> dict[str, Any]:
    summary = {key: value for key, value in raw_update.items() if key != "content"}
    content = raw_update.get("content")
    if isinstance(content, list):
        content_types = [
            str(item.get("type") or "unknown")
            for item in content
            if isinstance(item, dict)
        ]
        summary["contentCount"] = len(content)
        summary["contentTypes"] = content_types
        summary["hasFileDiffs"] = any(item.get("type") == "diff" for item in content if isinstance(item, dict))
    return summary


@dataclass(frozen=True)
class TurnRecord:
    session: dict[str, Any]
    user_message: dict[str, Any]
    assistant_message: dict[str, Any]
    messages: list[dict[str, Any]]


class ConversationRecorder:
    def __init__(self, store: ConversationStore, diff_store: DiffArtifactStore | None = None) -> None:
        self._store = store
        self._diff_store = diff_store or DiffArtifactStore(store.record_dir)
        self._active_messages: dict[str, list[dict[str, Any]]] = {}
        self._active_sessions: dict[str, dict[str, Any]] = {}

    def create_conversation_id(self) -> str:
        return create_conversation_id()

    def start_turn(
        self,
        *,
        conversation_id: str,
        prompt: str,
        attachments: list[dict[str, Any]] | None = None,
        agent_metadata: dict[str, Any] | None = None,
        model_metadata: dict[str, Any] | None = None,
    ) -> TurnRecord:
        timestamp = now_ms()
        attachments = attachments or []
        agent_metadata = agent_metadata or {}
        model_metadata = model_metadata or {}
        persisted = self._store.get_conversation(conversation_id)
        previous_session = persisted.get("session") if persisted else {}
        session = {
            **previous_session,
            "agent": previous_session.get("agent") or agent_metadata or None,
            "id": conversation_id,
            "createdAt": previous_session.get("createdAt") or timestamp,
            "preview": prompt or (f"{len(attachments)} 张图片" if attachments else DEFAULT_PREVIEW),
            "status": "running",
            "title": self._title_for_turn(conversation_id, prompt),
            "updatedAt": timestamp,
        }
        user_message = {
            "id": create_message_id("user"),
            "role": "user",
            "content": prompt,
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "agent": session.get("agent"),
            "model": model_metadata or None,
            "attachments": attachments,
            "toolCalls": [],
        }
        assistant_message = {
            "id": create_message_id("assistant"),
            "role": "assistant",
            "content": "",
            "createdAt": timestamp,
            "updatedAt": timestamp,
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
        elif event_type == "agent.plan.updated":
            plan = event.get("plan")
            if isinstance(plan, dict):
                assistant["plan"] = self._merge_message_plan(assistant, plan)
                assistant["updatedAt"] = now_ms()
            self._append_runtime_event(assistant, event)
        elif event_type in {
            "agent.command.available.updated",
            "agent.config.updated",
            "agent.input.completed",
            "agent.input.required",
            "agent.mode.updated",
            "agent.raw.rpc",
            "agent.raw.update",
        }:
            self._append_runtime_event(assistant, event)
            if event_type == "agent.input.required":
                self._update_active_session(conversation_id, {"status": "approval"})
        elif event_type == "agent.session.updated":
            title = str(event.get("title") or "").strip()
            if title:
                return self._update_active_session(conversation_id, {"title": title})
        elif event_type == "agent.tool.started":
            plan = event.get("plan")
            if isinstance(plan, dict):
                assistant["plan"] = self._merge_message_plan(assistant, plan)
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "anchorOffset": len(str(assistant.get("content") or "")),
                    "argumentsText": format_json(event.get("arguments")),
                    "name": str(event.get("name") or ""),
                    "risk": event.get("risk"),
                    "status": "running",
                    "metadata": self._project_tool_metadata(
                        conversation_id=conversation_id,
                        event=event,
                    ),
                },
            )
        elif event_type == "agent.tool.delta":
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "name": str(event.get("name") or ""),
                    "status": "running",
                    "resultText": format_json(event.get("progress")) if event.get("progress") is not None else None,
                    "metadata": self._project_tool_metadata(
                        conversation_id=conversation_id,
                        event=event,
                    ),
                },
            )
        elif event_type == "agent.tool.completed":
            plan = event.get("plan")
            if isinstance(plan, dict):
                assistant["plan"] = self._merge_message_plan(assistant, plan)
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or create_message_id("tool"),
                {
                    "name": str(event.get("name") or ""),
                    "resultText": format_json(event.get("result") if "result" in event else event.get("metadata")),
                    "status": "complete",
                    "metadata": self._project_tool_metadata(
                        conversation_id=conversation_id,
                        event=event,
                    ),
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
                    "metadata": self._project_tool_metadata(
                        conversation_id=conversation_id,
                        event=event,
                    ),
                },
            )
        elif event_type == "approval.required":
            plan = event.get("plan")
            if isinstance(plan, dict):
                assistant["plan"] = self._merge_message_plan(assistant, plan)
            self._upsert_tool_call(
                assistant,
                event.get("toolCallId") or event.get("approvalId") or create_message_id("tool"),
                {
                    "anchorOffset": len(str(assistant.get("content") or "")),
                    "argumentsText": format_json(event.get("argumentsText") or event.get("arguments")),
                    "name": str(event.get("name") or ""),
                    "risk": event.get("risk"),
                    "status": "approval",
                    "metadata": self._project_tool_metadata(
                        conversation_id=conversation_id,
                        event=event,
                    ),
                },
            )
            self._update_active_session(conversation_id, {"status": "approval"})
        elif event_type == "agent.run.completed":
            assistant["streaming"] = False
            assistant["updatedAt"] = now_ms()
            if isinstance(event.get("usage"), dict):
                assistant["usage"] = event["usage"]
            session_patch = {"status": "idle"}
        elif event_type == "agent.run.failed":
            assistant["streaming"] = False
            assistant["updatedAt"] = now_ms()
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
    def _merge_message_plan(
        assistant: dict[str, Any],
        next_plan: dict[str, Any],
    ) -> dict[str, Any] | None:
        if isinstance(next_plan, dict) and next_plan.get("source") == "acp.plan":
            return _merge_plan_snapshot(None, next_plan)
        if not _has_visible_plan(next_plan):
            return assistant.get("plan") if isinstance(assistant.get("plan"), dict) else None
        return _merge_plan_snapshot(assistant.get("plan"), next_plan)

    def _project_tool_metadata(
        self,
        *,
        conversation_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any] | None:
        metadata = _event_metadata(event)
        if metadata is None:
            return None

        projected = dict(metadata)
        raw_update = projected.get("rawUpdate")
        if not isinstance(raw_update, dict):
            return projected

        tool_call_id = str(
            event.get("toolCallId")
            or raw_update.get("toolCallId")
            or raw_update.get("id")
            or create_message_id("tool")
        )
        file_diffs = self._save_file_diffs(
            conversation_id=conversation_id,
            turn_id=str(event.get("turnId") or ""),
            tool_call_id=tool_call_id,
            raw_update=raw_update,
        )

        if file_diffs:
            projected["fileDiffs"] = file_diffs
        projected["rawUpdateSummary"] = _raw_update_summary(raw_update)
        projected.pop("rawUpdate", None)
        return projected

    def _save_file_diffs(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        tool_call_id: str,
        raw_update: dict[str, Any],
    ) -> list[dict[str, Any]]:
        content = raw_update.get("content")
        if not isinstance(content, list):
            return []

        summaries: list[dict[str, Any]] = []
        for index, item in enumerate(content):
            if not isinstance(item, dict) or item.get("type") != "diff":
                continue
            path = str(item.get("path") or "").strip()
            new_text = item.get("newText")
            old_text = item.get("oldText")
            if not path or not isinstance(new_text, str):
                continue
            if old_text is not None and not isinstance(old_text, str):
                continue

            diff_id = _safe_diff_id(tool_call_id, index)
            stats = _diff_stats(old_text, new_text)
            meta = item.get("_meta")
            native_kind = str(meta.get("kind") or "").strip() if isinstance(meta, dict) else None
            artifact = self._diff_store.save_diff(
                conversation_id,
                {
                    "diffId": diff_id,
                    "turnId": turn_id,
                    "toolCallId": tool_call_id,
                    "contentIndex": index,
                    "path": path,
                    "changeType": _content_change_kind(item, old_text, new_text),
                    "nativeChangeKind": native_kind,
                    "added": stats["added"],
                    "removed": stats["removed"],
                    "oldText": old_text,
                    "newText": new_text,
                    "createdAt": now_ms(),
                },
            )
            summaries.append(
                {
                    "diffId": diff_id,
                    "toolCallId": tool_call_id,
                    "path": path,
                    "changeType": artifact.get("changeType"),
                    "nativeChangeKind": artifact.get("nativeChangeKind"),
                    "added": artifact.get("added") or 0,
                    "removed": artifact.get("removed") or 0,
                    "artifactPath": DiffArtifactStore.artifact_relative_path(diff_id),
                }
            )
        return summaries

    @staticmethod
    def _upsert_tool_call(message: dict[str, Any], tool_call_id: str, patch: dict[str, Any]) -> None:
        timestamp = now_ms()
        tool_calls = message.setdefault("toolCalls", [])
        for index, tool_call in enumerate(tool_calls):
            if tool_call.get("id") == tool_call_id:
                merged_patch = {
                    **patch,
                    "metadata": _merge_tool_metadata(tool_call.get("metadata"), patch.get("metadata")),
                    "name": _merge_tool_name(tool_call.get("name"), patch.get("name")),
                }
                tool_calls[index] = {
                    **tool_call,
                    **merged_patch,
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

    @staticmethod
    def _append_runtime_event(message: dict[str, Any], event: dict[str, Any]) -> None:
        timestamp = now_ms()
        events = message.setdefault("runtimeEvents", [])
        if isinstance(events, list):
            events.append(_event_record(event))
            del events[:-200]
        message["updatedAt"] = timestamp
