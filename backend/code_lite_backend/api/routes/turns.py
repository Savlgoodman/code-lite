from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.core.json_utils import encode_ndjson_event
from code_lite_backend.schemas.agent import AgentRunRequest
from code_lite_backend.services.model_config import ModelConfigError
from code_lite_backend.services.runtime import AppServices

logger = logging.getLogger(__name__)

router = APIRouter()

# ACP runtime adapters 使用 runtime 原生模型（从 session/new 获取），
# 不查产品级 model_config。nanobot 是唯一的产品级模型 adapter。
_ACP_RUNTIME_IDS = {"codex", "claude_code", "opencode"}
_CLAUDE_DEFAULT_MODEL = "sonnet"


def _clean_label(value: str | None) -> str | None:
    label = str(value or "").strip()
    return label or None


def _normalize_claude_runtime_model(runtime_model: str | None) -> str:
    model = str(runtime_model or "").strip()
    if not model or model == "default":
        return _CLAUDE_DEFAULT_MODEL
    return model


def _claude_model_label(
    services: AppServices,
    conversation_id: str,
    runtime_model: str | None,
    fallback_label: str | None = None,
) -> str | None:
    if not runtime_model or runtime_model == "default":
        return None
    fallback = _clean_label(fallback_label)
    binding = services.conversation_store.load_native_session(conversation_id)
    capabilities = binding.get("capabilities") if isinstance(binding, dict) else None
    config_options = capabilities.get("configOptions") if isinstance(capabilities, dict) else None
    if not isinstance(config_options, list):
        return fallback
    for item in config_options:
        if not isinstance(item, dict) or item.get("id") != "model":
            continue
        options = item.get("options")
        if not isinstance(options, list):
            return fallback
        for option in options:
            if not isinstance(option, dict):
                continue
            if str(option.get("value") or "") == runtime_model:
                name = str(option.get("name") or "").strip()
                return name or fallback
    return fallback


@router.post("/turns/{turn_id}/cancel")
async def cancel_turn(
    turn_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    await services.agent_adapter.cancel_turn(turn_id)
    await services.approvals.reject_all()
    await services.inputs.cancel_all()
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
    requested_model_label = str(body.get("modelLabel") or "").strip() or None
    requested_access_mode = str(body.get("accessMode") or "").strip() or None
    requested_reasoning_effort = str(body.get("reasoningEffort") or "").strip() or None
    selected_config = body.get("selectedConfig") if isinstance(body.get("selectedConfig"), dict) else None
    # selectedConfig 中的 reasoning_effort 覆盖旧字段（兼容过渡期）
    if selected_config and "reasoning_effort" in selected_config:
        requested_reasoning_effort = str(selected_config["reasoning_effort"] or "").strip() or None
    persisted = None if not conversation_id else services.conversation_store.get_conversation(conversation_id)
    persisted_agent = None
    session_workspace: str | None = None
    if persisted and isinstance(persisted.get("session"), dict):
        raw_agent = persisted["session"].get("agent")
        if isinstance(raw_agent, dict):
            persisted_agent = str(raw_agent.get("id") or "").strip() or None
        raw_workspace = persisted["session"].get("workspace")
        if isinstance(raw_workspace, str) and raw_workspace.strip():
            session_workspace = raw_workspace.strip()

    # 会话绑定的工作区（固定），未记录则回退到全局默认工作区
    workspace = Path(session_workspace) if session_workspace else services.workspace
    agent_id = services.agent_runtime_config_store.resolve_adapter(persisted_agent)
    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    resolved_model = None
    runtime_model = None
    model_metadata: dict[str, object] = {}

    if agent_id in _ACP_RUNTIME_IDS:
        # ACP runtime：使用 runtime 原生模型（不查产品级 model_config）
        runtime_model = requested_model_id
        if agent_id == "claude_code":
            runtime_model = _normalize_claude_runtime_model(runtime_model)
        if runtime_model:
            label = (
                _claude_model_label(
                    services,
                    conversation_id,
                    runtime_model,
                    requested_model_label,
                )
                if agent_id == "claude_code"
                else None
            ) or runtime_model
            model_metadata = {
                "model": label,
                "label": label,
                "runtimeModel": runtime_model,
                "source": f"{agent_id}-acp",
                "reasoningEffort": requested_reasoning_effort or "none",
            }
    else:
        try:
            if requested_model_id:
                resolved_model = services.model_config_store.resolve_model(requested_model_id)
                if resolved_model is None:
                    raise ModelConfigError("所选模型不存在或已被禁用")
            else:
                resolved_model = services.model_config_store.effective_default_model()
        except ModelConfigError as error:
            error_message = str(error)
            logger.warning("Model config error for agent=%s: %s", agent_id, error_message)

            async def error_stream():
                yield encode_ndjson_event(
                    {
                        "type": "agent.run.failed",
                        "conversationId": conversation_id,
                        "turnId": turn_id,
                        "error": error_message,
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
        workspace=workspace,
        model_id=resolved_model.model_id if resolved_model else None,
        model_preset_id=resolved_model.model_preset_id if resolved_model else None,
        runtime_model=runtime_model,
        agent_id=agent_id,
        agent_label=str(agent_metadata.get("label") or agent_id),
        access_mode=requested_access_mode,
        model_metadata=model_metadata,
        reasoning_effort=requested_reasoning_effort,
    )

    # 详细日志：记录完整请求参数，帮助排查模型选择问题
    prompt_preview = prompt[:80] + ("..." if len(prompt) > 80 else "")
    logger.info(
        "POST /turns/stream [%s] conversation=%s turn=%s agent=%s(%s) model=%s runtime_model=%s mode=%s effort=%s workspace=%s selectedConfig=%s prompt_len=%d prompt=%s",
        "ACP" if agent_id in _ACP_RUNTIME_IDS else "product",
        conversation_id, turn_id, agent_id, agent_metadata.get("label"),
        requested_model_id, runtime_model,
        requested_access_mode, requested_reasoning_effort,
        workspace,
        selected_config,
        len(prompt), prompt_preview,
    )

    async def event_stream():
        assistant_message_id = ""
        event_store = services.event_store
        runtime_id = agent_id  # runtime identifier for events
        native_session_id: str | None = None

        if not prompt:
            logger.warning("event_stream: empty prompt, nothing to do")

        if prompt:
            logger.info("event_stream: start_turn for conversation=%s", conversation_id)
            turn_record = services.conversation_recorder.start_turn(
                conversation_id=conversation_id,
                prompt=prompt,
                agent_metadata=agent_metadata,
                model_metadata=model_metadata,
            )
            if resolved_model:
                services.model_config_store.mark_last_used(resolved_model.model_id)
            assistant_message_id = str(turn_record.assistant_message["id"])
            started_event = {
                "type": "conversation.turn.started",
                "conversationId": conversation_id,
                "turnId": turn_id,
                "session": turn_record.session,
                "userMessage": turn_record.user_message,
                "assistantMessage": turn_record.assistant_message,
            }
            if event_store:
                await event_store.append_event(
                    conversation_id, started_event, runtime=runtime_id,
                )
            logger.info("event_stream: yielding conversation.turn.started")
            yield encode_ndjson_event(started_event)

        completed = False
        try:
            async for event in services.agent_adapter.stream_turn(run_request):
                # 从 metadata 中提取 nativeSessionId
                metadata = event.get("metadata")
                if isinstance(metadata, dict) and metadata.get("nativeSessionId"):
                    native_session_id = str(metadata["nativeSessionId"])

                if assistant_message_id:
                    session = services.conversation_recorder.apply_agent_event(
                        conversation_id=conversation_id,
                        assistant_message_id=assistant_message_id,
                        event=event,
                    )
                    if event.get("type") == "agent.run.completed" and isinstance(event.get("usage"), dict):
                        services.billing_usage_recorder.enqueue_turn_usage(
                            conversation_id=conversation_id,
                            turn_id=turn_id,
                            assistant_message_id=assistant_message_id,
                            workspace=workspace,
                            agent_id=agent_id,
                            agent_label=str(agent_metadata.get("label") or agent_id),
                            model_metadata=model_metadata,
                            usage=event.get("usage"),
                        )
                    if session is not None:
                        event = {
                            **event,
                            "session": session,
                        }

                # 持久化到 events.ndjson（跳过高频 text.delta 以减少 IO）
                if event_store:
                    event_type = event.get("type", "")
                    skip_persist = event_type in (
                        "agent.text.delta",
                        "agent.reasoning.delta",
                    )
                    if not skip_persist:
                        await event_store.append_event(
                            conversation_id, event,
                            runtime=runtime_id,
                            native_session_id=native_session_id,
                        )

                yield encode_ndjson_event(event)
                if event.get("type") in {"agent.run.completed", "agent.run.failed"}:
                    completed = True
                    logger.info("event_stream: turn %s finished with %s", turn_id, event.get("type"))
        except asyncio.CancelledError:
            logger.info("event_stream: turn %s cancelled by client", turn_id)
            cancel_event = {
                "type": "agent.run.failed",
                "conversationId": conversation_id,
                "turnId": turn_id,
                "error": "用户取消了当前任务。",
            }
            if assistant_message_id:
                services.conversation_recorder.apply_agent_event(
                    conversation_id=conversation_id,
                    assistant_message_id=assistant_message_id,
                    event=cancel_event,
                )
                if event_store:
                    await event_store.append_event(
                        conversation_id, cancel_event,
                        runtime=runtime_id,
                        native_session_id=native_session_id,
                    )
                completed = True
            raise
        except Exception:
            logger.exception("event_stream: unexpected error in turn %s", turn_id)
            raise
        finally:
            if assistant_message_id and not completed:
                logger.warning("event_stream: turn %s discarded (not completed)", turn_id)
                services.conversation_recorder.discard_turn(conversation_id)

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson; charset=utf-8",
    )
