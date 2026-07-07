from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from code_lite_backend.storage.conversations import atomic_write_json, read_json


DIFF_ARTIFACT_SCHEMA_VERSION = 1
_CONVERSATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
_DIFF_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


class DiffArtifactStore:
    def __init__(self, record_dir: Path) -> None:
        self._record_dir = record_dir

    def save_diff(self, conversation_id: str, diff: dict[str, Any]) -> dict[str, Any]:
        diff_id = str(diff.get("diffId") or "").strip()
        self._validate_conversation_id(conversation_id)
        self._validate_diff_id(diff_id)

        artifact_path = self._diff_path(conversation_id, diff_id)
        payload = {
            "schemaVersion": DIFF_ARTIFACT_SCHEMA_VERSION,
            **diff,
            "conversationId": conversation_id,
            "diffId": diff_id,
        }
        atomic_write_json(artifact_path, payload)
        return payload

    def load_diff(self, conversation_id: str, diff_id: str) -> dict[str, Any] | None:
        self._validate_conversation_id(conversation_id)
        self._validate_diff_id(diff_id)

        artifact_path = self._diff_path(conversation_id, diff_id)
        if not artifact_path.exists():
            return None
        payload = read_json(artifact_path, {})
        if payload.get("conversationId") != conversation_id or payload.get("diffId") != diff_id:
            return None
        return payload

    @staticmethod
    def artifact_relative_path(diff_id: str) -> str:
        DiffArtifactStore._validate_diff_id(diff_id)
        return f"diffs/{diff_id}.json"

    @staticmethod
    def _validate_conversation_id(conversation_id: str) -> None:
        if not _CONVERSATION_ID_PATTERN.match(conversation_id):
            raise ValueError("invalid conversation id")

    @staticmethod
    def _validate_diff_id(diff_id: str) -> None:
        if not _DIFF_ID_PATTERN.match(diff_id):
            raise ValueError("invalid diff id")

    def _diff_path(self, conversation_id: str, diff_id: str) -> Path:
        return self._record_dir / conversation_id / "diffs" / f"{diff_id}.json"
