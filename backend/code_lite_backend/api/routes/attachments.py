from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.storage.attachments import (
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGES_PER_TURN,
    MAX_IMAGE_BYTES_PER_TURN,
)
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


def _as_int(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _as_bool(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    return value.lower() in {"1", "true", "yes", "on"}


@router.post("/conversations/{conversation_id}/turns/{turn_id}/attachments")
async def upload_turn_attachments(
    conversation_id: str,
    turn_id: str,
    files: list[UploadFile] = File(...),
    widths: list[str] = Form(default_factory=list),
    heights: list[str] = Form(default_factory=list),
    wasCompressed: list[str] = Form(default_factory=list),
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    if len(files) > MAX_IMAGES_PER_TURN:
        return JSONResponse({"error": "单轮最多支持 20 张图片。"}, status_code=400)

    conversation = services.conversation_store.get_conversation(conversation_id)
    if conversation is None:
        return JSONResponse({"error": "conversation not found"}, status_code=404)

    saved: list[dict[str, Any]] = []
    total_bytes = 0
    try:
        for index, upload in enumerate(files):
            mime_type = (upload.content_type or "").strip().lower()
            if mime_type not in ALLOWED_IMAGE_MIME_TYPES:
                return JSONResponse({"error": f"不支持的图片类型：{mime_type or 'unknown'}"}, status_code=400)
            metadata = services.attachment_store.save_image(
                conversation_id=conversation_id,
                turn_id=turn_id,
                filename=upload.filename,
                mime_type=mime_type,
                stream=upload.file,
                width=_as_int(widths[index] if index < len(widths) else None),
                height=_as_int(heights[index] if index < len(heights) else None),
                was_compressed=_as_bool(wasCompressed[index] if index < len(wasCompressed) else None),
            )
            total_bytes += int(metadata.get("sizeBytes") or 0)
            if total_bytes > MAX_IMAGE_BYTES_PER_TURN:
                services.attachment_store.delete_turn(conversation_id, turn_id)
                return JSONResponse({"error": "单轮图片总大小不能超过 200 MB。"}, status_code=400)
            saved.append(metadata)
    except ValueError as exc:
        services.attachment_store.delete_turn(conversation_id, turn_id)
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        for upload in files:
            await upload.close()

    return JSONResponse({"attachments": saved})


@router.get("/conversations/{conversation_id}/attachments/{attachment_id}/image")
async def get_attachment_image(
    conversation_id: str,
    attachment_id: str,
    services: AppServices = Depends(get_services),
) -> Response:
    stored = services.attachment_store.load_image(conversation_id, attachment_id)
    if stored is None:
        return JSONResponse({"error": "attachment not found"}, status_code=404)
    return FileResponse(
        stored.image_path,
        media_type=str(stored.metadata.get("mimeType") or "application/octet-stream"),
        filename=str(stored.metadata.get("name") or "image"),
    )
