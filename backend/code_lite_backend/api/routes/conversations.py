from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


def _resolve_general_workspace(services: AppServices) -> Path:
    """普通会话的默认工作区：~/.code-lite/workspace。"""
    return (services.runtime_config.data_dir / "workspace").resolve()


def _normalize_workspace(
    raw_workspace: str | None, services: AppServices
) -> tuple[str, str]:
    """解析请求中的工作区路径。

    返回 (workspace_path, workspace_kind)。
    - 用户提供路径 → ("<abs path>", "project")
    - 未提供 → ("<~/.code-lite/workspace>", "general")
    """
    candidate = (raw_workspace or "").strip()
    if candidate:
        resolved = Path(candidate).expanduser()
        try:
            resolved = resolved.resolve()
        except OSError:
            resolved = resolved.absolute()
        return str(resolved), "project"

    general = _resolve_general_workspace(services)
    general.mkdir(parents=True, exist_ok=True)
    return str(general), "general"


@router.get("/conversations")
async def list_conversations(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    return {"sessions": services.conversation_store.list_sessions()}


def create_conversation_record(services: AppServices, payload: dict[str, Any]) -> dict[str, Any]:
    """创建新会话并绑定 agent，返回 {session, messages}。

    供 HTTP POST /conversations 与 WS conversation.create 复用。
    """
    agent_id = str(payload.get("agentId") or "").strip()
    if not agent_id:
        # fallback: 使用当前 activeAdapter
        agent_id = services.agent_runtime_config_store.resolve_adapter(None)

    title = str(payload.get("title") or "").strip() or None
    preview = str(payload.get("preview") or "").strip() or None
    workspace, workspace_kind = _normalize_workspace(payload.get("workspace"), services)

    session = services.conversation_store.create_session(
        title=title,
        preview=preview,
        workspace=workspace,
        workspace_kind=workspace_kind,
    )

    # 绑定 agent 到 session
    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    session_with_agent = services.conversation_store.save_session(
        session["id"],
        {
            **session,
            "agent": agent_metadata,
        },
    )

    return {
        "session": session_with_agent,
        "messages": [],
    }


@router.post("/conversations")
async def create_conversation(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """创建新会话并绑定 agent。

    body: { "agentId": "codex", "title": "...", "preview": "..." }
    agentId 必填，后续该会话的所有 turn 都使用绑定的 agent。
    """
    result = create_conversation_record(services, payload)
    # 广播会话创建事件到全局频道（0709 阶段二）：供其他前端订阅者实时更新列表。
    if services.event_bus is not None:
        services.event_bus.publish(
            "*",
            {"type": "conversation.created", "session": result["session"]},
        )
    return JSONResponse(result)


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


@router.get("/conversations/{conversation_id}/diffs/{diff_id}")
async def get_conversation_diff(
    conversation_id: str,
    diff_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        diff = services.diff_artifact_store.load_diff(conversation_id, diff_id)
    except ValueError:
        return JSONResponse({"error": "invalid diff id"}, status_code=400)

    if diff is None:
        return JSONResponse({"error": "diff not found"}, status_code=404)
    return JSONResponse({"diff": diff})


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
    if bool(payload.get("archived")) and services.runtime_manager is not None:
        await services.runtime_manager.close_session_for_conversation(
            conversation_id,
            delete_binding=False,
            close_empty_connection=True,
        )
    # 广播会话归档事件到全局频道（0709 阶段二）
    if services.event_bus is not None and bool(payload.get("archived")):
        services.event_bus.publish(
            "*",
            {"type": "conversation.archived", "session": session},
        )
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
    # 广播配置变更事件到会话频道（0709 设计 5.3）：其他订阅者选择器实时跟随
    if services.event_bus is not None and isinstance(config, dict):
        services.event_bus.publish(
            conversation_id,
            {
                "type": "conversation.config.updated",
                "conversationId": conversation_id,
                "config": config,
            },
        )
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
    if services.runtime_manager is not None:
        await services.runtime_manager.close_session_for_conversation(
            conversation_id,
            delete_binding=True,
            close_empty_connection=True,
        )
    services.attachment_store.delete_conversation(conversation_id)
    # 广播会话删除事件到全局频道（0709 阶段二）
    if services.event_bus is not None:
        services.event_bus.publish(
            "*",
            {"type": "conversation.deleted", "session": {"id": conversation_id}},
        )
    return JSONResponse({"deleted": True})
