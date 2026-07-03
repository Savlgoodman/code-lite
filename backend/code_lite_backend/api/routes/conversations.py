from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.get("/conversations")
async def list_conversations(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    return {"sessions": services.conversation_store.list_sessions()}


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    conversation = services.conversation_store.get_conversation(conversation_id)
    if conversation is None:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return JSONResponse(conversation)


@router.patch("/conversations/{conversation_id}/archive")
async def update_conversation_archive_state(
    conversation_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        session = services.conversation_store.update_archive_state(
            conversation_id,
            archived=bool(payload.get("archived")),
        )
    except ValueError:
        return JSONResponse({"error": "invalid conversation id"}, status_code=400)

    if session is None:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return JSONResponse({"session": session})


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        deleted = services.conversation_store.delete_conversation(conversation_id)
    except ValueError:
        return JSONResponse({"error": "invalid conversation id"}, status_code=400)

    if not deleted:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return JSONResponse({"deleted": True})
