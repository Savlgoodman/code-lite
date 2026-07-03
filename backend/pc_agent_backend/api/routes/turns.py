from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

from pc_agent_backend.api.dependencies import get_services
from pc_agent_backend.core.json_utils import encode_ndjson_event
from pc_agent_backend.schemas.agent import AgentRunRequest
from pc_agent_backend.services.model_config import ModelConfigError
from pc_agent_backend.services.runtime import AppServices


router = APIRouter()


@router.post("/turns/{turn_id}/cancel")
async def cancel_turn(
    turn_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    await services.agent_adapter.cancel_turn(turn_id)
    await services.approvals.reject_all()
    return JSONResponse({"ok": True})


@router.post("/turns/stream")
async def stream_turn(
    request: Request,
    services: AppServices = Depends(get_services),
) -> StreamingResponse:
    body = await request.json()
    conversation_id = str(body.get("conversationId") or "").strip()
    if not conversation_id:
        conversation_id = services.conversation_recorder.create_conversation_id()
    turn_id = str(body.get("turnId") or f"turn-{uuid.uuid4().hex}")
    prompt = str(body.get("input") or "").strip()
    requested_model_id = str(body.get("modelId") or "").strip() or None
    requested_access_mode = str(body.get("accessMode") or "").strip() or None
    requested_reasoning_effort = str(body.get("reasoningEffort") or "").strip() or None
    persisted = None if not conversation_id else services.conversation_store.get_conversation(conversation_id)
    persisted_agent = None
    if persisted and isinstance(persisted.get("session"), dict):
        raw_agent = persisted["session"].get("agent")
        if isinstance(raw_agent, dict):
            persisted_agent = str(raw_agent.get("id") or "").strip() or None
    agent_id = services.agent_runtime_config_store.resolve_adapter(persisted_agent)
    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    try:
        if requested_model_id:
            resolved_model = services.model_config_store.resolve_model(requested_model_id)
            if resolved_model is None:
                raise ModelConfigError("所选模型不存在或已被禁用")
        else:
            resolved_model = services.model_config_store.effective_default_model()
    except ModelConfigError as error:
        async def error_stream():
            yield encode_ndjson_event(
                {
                    "type": "agent.run.failed",
                    "conversationId": conversation_id,
                    "turnId": turn_id,
                    "error": str(error),
                }
            )

        return StreamingResponse(error_stream(), media_type="application/x-ndjson; charset=utf-8")

    model_metadata = (
        {
            "modelId": resolved_model.model_id,
            "modelPresetId": resolved_model.model_preset_id,
            "providerId": resolved_model.provider_id,
            "providerName": resolved_model.provider_name,
            "model": resolved_model.model,
            "label": resolved_model.label,
            "protocol": resolved_model.protocol,
            "contextWindowTokens": resolved_model.context_window_tokens,
            "maxOutputTokens": resolved_model.max_output_tokens,
            "reasoningEffort": resolved_model.reasoning_effort,
        }
        if resolved_model is not None
        else {}
    )
    run_request = AgentRunRequest(
        conversation_id=conversation_id,
        turn_id=turn_id,
        prompt=prompt,
        workspace=services.workspace,
        model_id=resolved_model.model_id if resolved_model else None,
        model_preset_id=resolved_model.model_preset_id if resolved_model else None,
        agent_id=agent_id,
        agent_label=str(agent_metadata.get("label") or agent_id),
        access_mode=requested_access_mode,
        model_metadata=model_metadata,
        reasoning_effort=requested_reasoning_effort,
    )

    async def event_stream():
        assistant_message_id = ""
        if prompt:
            turn_record = services.conversation_recorder.start_turn(
                conversation_id=conversation_id,
                prompt=prompt,
                agent_metadata=agent_metadata,
                model_metadata=model_metadata,
            )
            if resolved_model:
                services.model_config_store.mark_last_used(resolved_model.model_id)
            assistant_message_id = str(turn_record.assistant_message["id"])
            yield encode_ndjson_event(
                {
                    "type": "conversation.turn.started",
                    "conversationId": conversation_id,
                    "turnId": turn_id,
                    "session": turn_record.session,
                    "userMessage": turn_record.user_message,
                    "assistantMessage": turn_record.assistant_message,
                }
            )

        completed = False
        try:
            async for event in services.agent_adapter.stream_turn(run_request):
                if assistant_message_id:
                    session = services.conversation_recorder.apply_agent_event(
                        conversation_id=conversation_id,
                        assistant_message_id=assistant_message_id,
                        event=event,
                    )
                    if session is not None:
                        event = {
                            **event,
                            "session": session,
                        }
                yield encode_ndjson_event(event)
                if event.get("type") in {"agent.run.completed", "agent.run.failed"}:
                    completed = True
        except asyncio.CancelledError:
            if assistant_message_id:
                services.conversation_recorder.apply_agent_event(
                    conversation_id=conversation_id,
                    assistant_message_id=assistant_message_id,
                    event={
                        "type": "agent.run.failed",
                        "conversationId": conversation_id,
                        "turnId": turn_id,
                        "error": "用户取消了当前任务。",
                    },
                )
                completed = True
            raise
        finally:
            if assistant_message_id and not completed:
                services.conversation_recorder.discard_turn(conversation_id)

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson; charset=utf-8",
    )
