from __future__ import annotations

import json
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
DEFAULT_TITLE = "新的维修会话"
DEFAULT_PREVIEW = "描述电脑问题，Agent 会先生成只读检查计划"


def now_ms() -> int:
    return int(datetime.now().timestamp() * 1000)


def create_conversation_id() -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{timestamp}-{uuid.uuid4().hex[:16]}"


def atomic_write_json(path: Path, value: dict[str, Any], *, retries: int = 8) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for attempt in range(retries):
        try:
            temp_path.replace(path)
            return
        except PermissionError:
            if attempt >= retries - 1:
                raise
            time.sleep(0.03 * (attempt + 1))
    temp_path.replace(path)


def read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


class ConversationStore:
    def __init__(self, record_dir: Path) -> None:
        self.record_dir = record_dir
        self.record_dir.mkdir(parents=True, exist_ok=True)

    def list_sessions(self) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        for directory in self._conversation_dirs():
            session = self._read_session(directory.name)
            if session is not None:
                sessions.append(session)
        return sorted(sessions, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)

    def create_session(self, *, title: str | None = None, preview: str | None = None) -> dict[str, Any]:
        conversation_id = create_conversation_id()
        timestamp = now_ms()
        session = {
            "id": conversation_id,
            "title": title or DEFAULT_TITLE,
            "preview": preview or DEFAULT_PREVIEW,
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "status": "idle",
            "schemaVersion": SCHEMA_VERSION,
        }
        directory = self._conversation_dir(conversation_id)
        directory.mkdir(parents=True, exist_ok=False)
        atomic_write_json(self._session_path(conversation_id), session)
        atomic_write_json(self._messages_path(conversation_id), {"schemaVersion": SCHEMA_VERSION, "messages": []})
        return session

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        session = self._read_session(conversation_id)
        if session is None:
            return None
        return {
            "session": session,
            "messages": self.load_messages(conversation_id),
        }

    def delete_conversation(self, conversation_id: str) -> bool:
        directory = self._conversation_dir(conversation_id)
        if not directory.exists():
            return False
        shutil.rmtree(directory)
        return True

    def update_archive_state(self, conversation_id: str, *, archived: bool) -> dict[str, Any] | None:
        session = self._read_session(conversation_id)
        if session is None:
            return None
        return self.save_session(conversation_id, {
            **session,
            "archived": archived,
            "updatedAt": session.get("updatedAt"),
        })

    def save_session(self, conversation_id: str, session: dict[str, Any]) -> dict[str, Any]:
        directory = self._conversation_dir(conversation_id)
        if not directory.exists():
            directory.mkdir(parents=True, exist_ok=True)

        current = self._read_session(conversation_id) or {}
        created_at = current.get("createdAt") or session.get("createdAt") or now_ms()
        next_session = {
            **current,
            **session,
            "id": conversation_id,
            "createdAt": created_at,
            "updatedAt": session.get("updatedAt") or now_ms(),
            "schemaVersion": SCHEMA_VERSION,
        }
        atomic_write_json(self._session_path(conversation_id), next_session)
        return next_session

    def load_messages(self, conversation_id: str) -> list[dict[str, Any]]:
        payload = read_json(self._messages_path(conversation_id), {"schemaVersion": SCHEMA_VERSION, "messages": []})
        messages = payload.get("messages")
        return messages if isinstance(messages, list) else []

    def save_messages(self, conversation_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self._conversation_dir(conversation_id).exists():
            self.save_session(
                conversation_id,
                {
                    "title": DEFAULT_TITLE,
                    "preview": DEFAULT_PREVIEW,
                    "status": "idle",
                },
            )
        atomic_write_json(
            self._messages_path(conversation_id),
            {
                "schemaVersion": SCHEMA_VERSION,
                "messages": messages,
            },
        )
        return messages

    def append_message(self, conversation_id: str, message: dict[str, Any]) -> list[dict[str, Any]]:
        messages = self.load_messages(conversation_id)
        messages.append(message)
        return self.save_messages(conversation_id, messages)

    def _conversation_dirs(self) -> list[Path]:
        return [path for path in self.record_dir.iterdir() if path.is_dir()]

    def _conversation_dir(self, conversation_id: str) -> Path:
        if not conversation_id or any(char in conversation_id for char in ("\\", "/", ":", "*", "?", "\"", "<", ">", "|")):
            raise ValueError("invalid conversation id")
        return self.record_dir / conversation_id

    def _session_path(self, conversation_id: str) -> Path:
        return self._conversation_dir(conversation_id) / "session.json"

    def _messages_path(self, conversation_id: str) -> Path:
        return self._conversation_dir(conversation_id) / "messages.json"

    def _read_session(self, conversation_id: str) -> dict[str, Any] | None:
        path = self._session_path(conversation_id)
        if not path.exists():
            return None
        session = read_json(path, {})
        session.setdefault("id", conversation_id)
        session.setdefault("schemaVersion", SCHEMA_VERSION)
        return session
