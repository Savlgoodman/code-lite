from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from code_lite_backend.storage.conversations import atomic_write_json, now_ms


ALLOWED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGE_BYTES = 25 * 1000 * 1000
TITLE_MAX_CHARS = 24


def _safe_id(value: str, field: str) -> str:
    if not value or any(char in value for char in ("\\", "/", ":", "*", "?", "\"", "<", ">", "|", "..")):
        raise ValueError(f"invalid {field}")
    return value


def _extension_for_mime(mime_type: str) -> str:
    return {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
    }.get(mime_type, "png")


def _title_from_prompt(prompt: str) -> str:
    text = " ".join(prompt.split())
    return text[:TITLE_MAX_CHARS] if text else "未命名生成"


class ImageRecordStore:
    """图片生成任务与生成图/参考图的落盘存储。

    data/image-gen/{recordId}/
      record.json
      references/{imageId}.{ext} + {imageId}.json
      images/{imageId}.{ext} + {imageId}.json
    """

    def __init__(self, image_gen_dir: Path) -> None:
        self._root = image_gen_dir
        self._root.mkdir(parents=True, exist_ok=True)

    # ── 任务 ──

    def list_records(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for directory in self._record_dirs():
            record = self._read_record(directory.name)
            if record is None:
                continue
            runs = record.get("runs") or []
            records.append({
                "id": record["id"],
                "title": record.get("title") or "未命名生成",
                "createdAt": record.get("createdAt"),
                "updatedAt": record.get("updatedAt"),
                "latestImageUrl": record.get("latestImageUrl"),
                "runCount": len(runs),
            })
        return sorted(records, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)

    def create_record(self) -> dict[str, Any]:
        record_id = f"imgrec_{uuid.uuid4().hex[:16]}"
        directory = self._record_dir(record_id)
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "images").mkdir(exist_ok=True)
        (directory / "references").mkdir(exist_ok=True)
        record = {
            "id": record_id,
            "title": "未命名生成",
            "createdAt": now_ms(),
            "updatedAt": now_ms(),
            "latestImageUrl": None,
            "runs": [],
            "referenceImages": [],
        }
        self._write_record(record_id, record)
        return self.get_record(record_id)

    def get_record(self, record_id: str) -> dict[str, Any]:
        record = self._read_record(record_id)
        if record is None:
            raise FileNotFoundError("图片生成任务不存在")
        return self._render_record(record)

    def delete_record(self, record_id: str) -> None:
        directory = self._record_dir(record_id)
        if not directory.exists():
            raise FileNotFoundError("图片生成任务不存在")
        shutil.rmtree(directory, ignore_errors=True)

    # ── 参考图 ──

    def save_reference(
        self,
        record_id: str,
        *,
        mime_type: str,
        data: bytes,
        width: int | None = None,
        height: int | None = None,
    ) -> dict[str, Any]:
        record = self._read_record(record_id)
        if record is None:
            raise FileNotFoundError("图片生成任务不存在")
        normalized_mime = mime_type.strip().lower()
        if normalized_mime not in ALLOWED_IMAGE_MIME_TYPES:
            raise ValueError(f"不支持的图片类型：{mime_type}")
        if not data:
            raise ValueError("参考图为空")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("参考图超过 25 MB")

        asset = self._write_asset(record_id, "references", normalized_mime, data, width=width, height=height)
        record.setdefault("referenceImages", []).append(asset)
        record["updatedAt"] = now_ms()
        self._write_record(record_id, record)
        return self._render_asset(record_id, "references", asset)

    def delete_reference(self, record_id: str, image_id: str) -> None:
        record = self._read_record(record_id)
        if record is None:
            raise FileNotFoundError("图片生成任务不存在")
        _safe_id(image_id, "image id")
        references = record.get("referenceImages") or []
        record["referenceImages"] = [item for item in references if item.get("id") != image_id]
        self._delete_asset_files(record_id, "references", image_id)
        record["updatedAt"] = now_ms()
        self._write_record(record_id, record)

    # ── 生成批次 ──

    def append_run(
        self,
        record_id: str,
        *,
        run_id: str,
        request: dict[str, Any],
        images: list[dict[str, Any]],
        error: str | None = None,
    ) -> dict[str, Any]:
        record = self._read_record(record_id)
        if record is None:
            raise FileNotFoundError("图片生成任务不存在")
        run = {
            "id": run_id,
            "createdAt": now_ms(),
            "request": request,
            "images": images,
            "error": error,
        }
        record.setdefault("runs", []).append(run)
        prompt = str(request.get("prompt") or "").strip()
        if prompt:
            record["title"] = _title_from_prompt(prompt)
        if images:
            last = images[-1]
            record["latestImageUrl"] = self._image_url(record_id, "images", str(last.get("id")))
        record["updatedAt"] = now_ms()
        self._write_record(record_id, record)
        return self._render_run(record_id, run)

    def write_generated_image(
        self,
        record_id: str,
        *,
        mime_type: str,
        data: bytes,
        revised_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> dict[str, Any]:
        normalized_mime = mime_type.strip().lower()
        if normalized_mime not in ALLOWED_IMAGE_MIME_TYPES:
            normalized_mime = "image/png"
        asset = self._write_asset(record_id, "images", normalized_mime, data, width=width, height=height)
        if revised_prompt:
            asset["revisedPrompt"] = revised_prompt
        return asset

    # ── 二进制访问 ──

    def image_file(self, record_id: str, kind: str, image_id: str) -> tuple[Path, str, str]:
        if kind not in {"images", "references"}:
            raise FileNotFoundError("图片不存在")
        _safe_id(image_id, "image id")
        meta_path = self._record_dir(record_id) / kind / f"{image_id}.json"
        if not meta_path.exists():
            raise FileNotFoundError("图片不存在")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        file_path = self._record_dir(record_id) / kind / str(meta.get("file"))
        if not file_path.exists():
            raise FileNotFoundError("图片不存在")
        return file_path, str(meta.get("mimeType") or "application/octet-stream"), str(meta.get("file"))

    # ── 内部 ──

    def _write_asset(
        self,
        record_id: str,
        kind: str,
        mime_type: str,
        data: bytes,
        *,
        width: int | None,
        height: int | None,
    ) -> dict[str, Any]:
        image_id = f"img_{uuid.uuid4().hex[:16]}"
        ext = _extension_for_mime(mime_type)
        directory = self._record_dir(record_id) / kind
        directory.mkdir(parents=True, exist_ok=True)
        file_name = f"{image_id}.{ext}"
        (directory / file_name).write_bytes(data)
        meta: dict[str, Any] = {
            "id": image_id,
            "file": file_name,
            "mimeType": mime_type,
            "sizeBytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "createdAt": now_ms(),
        }
        if width and width > 0:
            meta["width"] = width
        if height and height > 0:
            meta["height"] = height
        (directory / f"{image_id}.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return {
            "id": image_id,
            "mimeType": mime_type,
            "width": meta.get("width"),
            "height": meta.get("height"),
        }

    def _delete_asset_files(self, record_id: str, kind: str, image_id: str) -> None:
        directory = self._record_dir(record_id) / kind
        if not directory.exists():
            return
        for path in directory.glob(f"{image_id}.*"):
            path.unlink(missing_ok=True)

    def _render_record(self, record: dict[str, Any]) -> dict[str, Any]:
        record_id = record["id"]
        return {
            "id": record_id,
            "title": record.get("title") or "未命名生成",
            "createdAt": record.get("createdAt"),
            "updatedAt": record.get("updatedAt"),
            "latestImageUrl": record.get("latestImageUrl"),
            "runs": [self._render_run(record_id, run) for run in record.get("runs", [])],
            "referenceImages": [
                self._render_asset(record_id, "references", asset)
                for asset in record.get("referenceImages", [])
            ],
        }

    def _render_run(self, record_id: str, run: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": run.get("id"),
            "createdAt": run.get("createdAt"),
            "request": run.get("request") or {},
            "images": [self._render_asset(record_id, "images", asset) for asset in run.get("images", [])],
            "error": run.get("error"),
        }

    def _render_asset(self, record_id: str, kind: str, asset: dict[str, Any]) -> dict[str, Any]:
        image_id = str(asset.get("id"))
        rendered: dict[str, Any] = {
            "id": image_id,
            "url": self._image_url(record_id, kind, image_id),
        }
        if asset.get("width"):
            rendered["width"] = asset.get("width")
        if asset.get("height"):
            rendered["height"] = asset.get("height")
        if asset.get("mimeType"):
            rendered["mimeType"] = asset.get("mimeType")
        if asset.get("revisedPrompt"):
            rendered["revisedPrompt"] = asset.get("revisedPrompt")
        return rendered

    @staticmethod
    def _image_url(record_id: str, kind: str, image_id: str) -> str:
        return f"/api/image/records/{record_id}/{kind}/{image_id}"

    def _read_record(self, record_id: str) -> dict[str, Any] | None:
        path = self._record_dir(record_id) / "record.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _write_record(self, record_id: str, record: dict[str, Any]) -> None:
        atomic_write_json(self._record_dir(record_id) / "record.json", record)

    def _record_dir(self, record_id: str) -> Path:
        return self._root / _safe_id(record_id, "record id")

    def _record_dirs(self) -> list[Path]:
        if not self._root.exists():
            return []
        return [child for child in self._root.iterdir() if child.is_dir() and (child / "record.json").exists()]
