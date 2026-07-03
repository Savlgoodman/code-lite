from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.post("/approvals/{approval_id}/decision")
async def approval_decision(
    approval_id: str,
    request: Request,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    body = await request.json()
    decision = str(body.get("decision", "")).lower()
    allowed = decision in {"allow", "allowed", "yes", "true"}
    pending = await services.approvals.resolve(approval_id, allowed)
    if pending is None:
        return JSONResponse({"ok": False})

    session = services.conversation_recorder.update_session(
        pending.conversation_id,
        {
            "status": "running" if allowed else "error",
        },
    )
    return JSONResponse({"ok": True, "session": session})
