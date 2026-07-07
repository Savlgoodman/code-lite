from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.post("/inputs/{input_id}/response")
async def input_response(
    input_id: str,
    request: Request,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    body = await request.json()
    action = str(body.get("action") or "").lower()
    if action not in {"accept", "decline", "cancel"}:
        action = "cancel"
    content = body.get("content")
    pending = await services.inputs.resolve(
        input_id,
        action=action,  # type: ignore[arg-type]
        content=content if isinstance(content, dict) else None,
    )
    if pending is None:
        return JSONResponse({"ok": False})

    session_patch: dict[str, Any] = {
        "status": "running" if action in {"accept", "decline"} else "error",
    }
    session = services.conversation_recorder.update_session(
        pending.conversation_id,
        session_patch,
    )
    return JSONResponse({"ok": True, "session": session})
