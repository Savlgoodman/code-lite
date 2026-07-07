from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO


ALLOWED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGES_PER_TURN = 20
MAX_IMAGE_BYTES_PER_IMAGE = 10 * 1000 * 1000
MAX_IMAGE_BYTES_PER_TURN = 200 * 1000 * 1000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str, field: str) -> str:
    if not value or any(char in value for char in ("\\", "/", ":", "*", "?", "\"", "<", ">", "|")):
        raise ValueError(f"invalid {field}")
    return value


def _normalize_filename(value: str | None, fallback: str) -> str:
    name = Path(value or "").name.strip()
    return name or fallback


@dataclass(frozen=True)
class StoredAttachment:
    metadata: dict[str, Any]
    image_path: Path


class AttachmentStore:
    """Stores user-sent image attachments after the user clicks send."""

    def __init__(self, attachments_dir: Path) -> None:
        self._root = attachments_dir
        self._root.mkdir(parents=True, exist_ok=True)

    def save_image(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        filename: str | None,
        mime_type: str,
        stream: BinaryIO,
        width: int | None = None,
        height: int | None = None,
        was_compressed: bool | None = None,
    ) -> dict[str, Any]:
        conversation_id = _safe_id(conversation_id, "conversation id")
        turn_id = _safe_id(turn_id, "turn id")
        normalized_mime = mime_type.strip().lower()
        if normalized_mime not in ALLOWED_IMAGE_MIME_TYPES:
            raise ValueError(f"unsupported image mime type: {mime_type}")

        attachment_id = f"att_{uuid.uuid4().hex}"
        directory = self._attachment_dir(conversation_id, attachment_id)
        directory.mkdir(parents=True, exist_ok=False)
        image_path = directory / "image"

        digest = hashlib.sha256()
        size = 0
        with image_path.open("wb") as target:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_IMAGE_BYTES_PER_IMAGE:
                    shutil.rmtree(directory, ignore_errors=True)
                    raise ValueError("image is larger than 10 MB")
                digest.update(chunk)
                target.write(chunk)

        if size <= 0:
            shutil.rmtree(directory, ignore_errors=True)
            raise ValueError("image is empty")

        metadata: dict[str, Any] = {
            "id": attachment_id,
            "kind": "image",
            "name": _normalize_filename(filename, f"{attachment_id}.image"),
            "mimeType": normalized_mime,
            "sizeBytes": size,
            "sha256": digest.hexdigest(),
            "createdAt": _now_iso(),
            "conversationId": conversation_id,
            "turnId": turn_id,
        }
        if width is not None and width > 0:
            metadata["width"] = width
        if height is not None and height > 0:
            metadata["height"] = height
        if was_compressed is not None:
            metadata["wasCompressed"] = bool(was_compressed)

        (directory / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return metadata

    def load_metadata(self, conversation_id: str, attachment_id: str) -> dict[str, Any] | None:
        path = self._metadata_path(conversation_id, attachment_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None

    def load_image(self, conversation_id: str, attachment_id: str) -> StoredAttachment | None:
        metadata = self.load_metadata(conversation_id, attachment_id)
        image_path = self._image_path(conversation_id, attachment_id)
        if metadata is None or not image_path.exists():
            return None
        return StoredAttachment(metadata=metadata, image_path=image_path)

    def delete_conversation(self, conversation_id: str) -> bool:
        directory = self._conversation_dir(conversation_id)
        if not directory.exists():
            return False
        shutil.rmtree(directory)
        return True

    def delete_turn(self, conversation_id: str, turn_id: str) -> int:
        directory = self._conversation_dir(conversation_id)
        if not directory.exists():
            return 0
        removed = 0
        for metadata_path in directory.glob("att_*/metadata.json"):
            try:
                data = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict) and data.get("turnId") == turn_id:
                shutil.rmtree(metadata_path.parent, ignore_errors=True)
                removed += 1
        return removed

    def _conversation_dir(self, conversation_id: str) -> Path:
        return self._root / "conversations" / _safe_id(conversation_id, "conversation id")

    def _attachment_dir(self, conversation_id: str, attachment_id: str) -> Path:
        return self._conversation_dir(conversation_id) / _safe_id(attachment_id, "attachment id")

    def _metadata_path(self, conversation_id: str, attachment_id: str) -> Path:
        return self._attachment_dir(conversation_id, attachment_id) / "metadata.json"

    def _image_path(self, conversation_id: str, attachment_id: str) -> Path:
        return self._attachment_dir(conversation_id, attachment_id) / "image"
