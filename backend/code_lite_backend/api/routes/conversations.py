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


@router.post("/conversations")
async def create_conversation(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """创建新会话并绑定 agent。

    body: { "agentId": "codex", "title": "...", "preview": "..." }
    agentId 必填，后续该会话的所有 turn 都使用绑定的 agent。
    """
    agent_id = str(payload.get("agentId") or "").strip()
    if not agent_id:
        # fallback: 使用当前 activeAdapter
        agent_id = services.agent_runtime_config_store.resolve_adapter(None)

    title = str(payload.get("title") or "").strip() or None
    preview = str(payload.get("preview") or "").strip() or None

    session = services.conversation_store.create_session(title=title, preview=preview)

    # 绑定 agent 到 session
    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    session_with_agent = services.conversation_store.save_session(
        session["id"],
        {
            **session,
            "agent": agent_metadata,
        },
    )

    return JSONResponse({
        "session": session_with_agent,
        "messages": [],
    })


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    conversation = services.conversation_store.get_conversation(conversation_id)
    if conversation is None:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return JSONResponse(conversation)


@router.get("/conversations/{conversation_id}/events")
async def get_conversation_events(
    conversation_id: str,
    after: int = 0,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """获取会话事件列表，支持按 sequence 过滤（用于远程同步补偿）。

    ?after=42 返回 sequence > 42 的所有事件。
    """
    if services.event_store is None:
        return JSONResponse({"events": [], "error": "event store not available"})
    events = await services.event_store.load_events(conversation_id, after=after)
    return JSONResponse({"events": events})


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


@router.patch("/conversations/{conversation_id}/config")
async def update_conversation_config(
    conversation_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """保存会话配置和上下文使用量。

    body: {
      "config": { "modelFamily": "sonnet", ... },          # 可选
      "contextUsage": { "contextUsedTokens": 1234, ... }   # 可选
    }
    """
    config = payload.get("config")
    context_usage = payload.get("contextUsage")

    try:
        session = services.conversation_store._read_session(conversation_id)
    except ValueError:
        return JSONResponse({"error": "invalid conversation id"}, status_code=400)

    if session is None:
        return JSONResponse({"error": "conversation not found"}, status_code=404)

    updates = {**session}
    if isinstance(config, dict):
        updates["config"] = config
    if isinstance(context_usage, dict):
        updates["contextUsage"] = context_usage

    updated = services.conversation_store.save_session(conversation_id, updates)
    return JSONResponse({"session": updated})


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
