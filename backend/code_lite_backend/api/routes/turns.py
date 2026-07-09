from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.schemas.agent import (
    AgentRunRequest,
    ImageAttachmentSource,
    ImageInputBlock,
    TextInputBlock,
    UserInputBlock,
)
from code_lite_backend.services.model_config import ModelConfigError
from code_lite_backend.services.runtime import AppServices
from code_lite_backend.storage.attachments import (
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_BYTES_PER_TURN,
    MAX_IMAGES_PER_TURN,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@dataclass(frozen=True)
class TurnStartOutcome:
    """prepare_and_start_turn 的结果。

    - error 非 None：turn 未启动，调用方渲染该 agent.run.failed 错误文案。
    - busy 为 True：会话已有活动 turn，被互锁拒绝。
    - 否则：turn 已在后台启动，conversation_id/turn_id 为最终值。
    """

    conversation_id: str
    turn_id: str
    error: str | None = None
    busy: bool = False


# ACP runtime adapters 使用 runtime 原生模型（从 session/new 获取），
# 不查产品级 model_config。nanobot 是唯一的产品级模型 adapter。
_ACP_RUNTIME_IDS = {"codex", "claude_code", "opencode"}
_CLAUDE_DEFAULT_MODEL = "sonnet"
_FAST_MODE_ON_VALUES = {"1.5x", "fast", "high", "on", "true", "yes", "1"}
_FAST_MODE_OFF_VALUES = {"1x", "normal", "off", "false", "no", "0", "default"}


def _clean_label(value: str | None) -> str | None:
    label = str(value or "").strip()
    return label or None


def _normalize_claude_runtime_model(runtime_model: str | None) -> str:
    model = str(runtime_model or "").strip()
    if not model or model == "default":
        return _CLAUDE_DEFAULT_MODEL
    return model


def _normalize_codex_runtime_model(runtime_model: str | None) -> str | None:
    model = str(runtime_model or "").strip()
    if not model:
        return None
    if "[" not in model:
        return model
    family = model.split("[", 1)[0].strip()
    efforts = [item.strip() for item in re.findall(r"\[([^\]]+)\]", model) if item.strip()]
    if not family or not efforts:
        return model
    return f"{family}[{efforts[-1]}]"


def _normalize_fast_mode(value: object) -> str | None:
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, int | float) and not isinstance(value, bool):
        if value == 1.5:
            return "on"
        if value == 1:
            return "off"
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized in _FAST_MODE_ON_VALUES:
            return "on"
        if normalized in _FAST_MODE_OFF_VALUES:
            return "off"
    return None


def _fast_mode_from_config(selected_config: dict[str, object] | None) -> str | None:
    if not selected_config:
        return None
    for key in ("fast_mode", "fastMode", "speedMode", "speed_mode", "fast-mode", "fast"):
        if key in selected_config:
            return _normalize_fast_mode(selected_config.get(key))
    return None


def _capability_config_ids(services: AppServices, conversation_id: str) -> set[str]:
    binding = services.conversation_store.load_native_session(conversation_id)
    capabilities = binding.get("capabilities") if isinstance(binding, dict) else None
    config_options = capabilities.get("configOptions") if isinstance(capabilities, dict) else None
    ids: set[str] = set()
    if isinstance(config_options, list):
        for item in config_options:
            if isinstance(item, dict):
                config_id = str(item.get("id") or "").strip()
                if config_id:
                    ids.add(config_id)
    elif isinstance(config_options, dict):
        ids.update(str(key).strip() for key in config_options if str(key).strip())
    return ids


def _config_option_id(option: object) -> str:
    if isinstance(option, dict):
        return str(option.get("id") or "").strip()
    return ""


def _config_option_current_value(option: object) -> object:
    if isinstance(option, dict):
        return option.get("currentValue")
    return None


def _sync_fast_mode_from_config_update(model_metadata: dict[str, object], config_options: object) -> None:
    fast_mode = model_metadata.get("fastMode")
    if not isinstance(fast_mode, dict) or not isinstance(config_options, list):
        return
    runtime_config_id = str(fast_mode.get("runtimeConfigId") or "").strip()
    fast_ids = {item for item in (runtime_config_id, "fast_mode", "fast-mode", "fast") if item}
    option = next((item for item in config_options if _config_option_id(item) in fast_ids), None)
    requested = fast_mode.get("requested") is True or fast_mode.get("enabled") is True
    fast_mode["runtimeOptionPresent"] = option is not None
    fast_mode["effectiveSource"] = "runtime_config_update"
    if option is None:
        fast_mode["enabled"] = False
        fast_mode["applied"] = False
        fast_mode["effective"] = False
        fast_mode["billingMultiplier"] = 1
        if requested:
            fast_mode["effectiveReason"] = f"runtime option {runtime_config_id or 'fast'} is unavailable"
        return
    value = _normalize_fast_mode(_config_option_current_value(option))
    if value == "on":
        fast_mode["enabled"] = True
        fast_mode["configApplied"] = True
        fast_mode["applied"] = True
        fast_mode["effective"] = True
        fast_mode["runtimeValue"] = "on"
        fast_mode["speedMode"] = "fast"
        fast_mode["displayRate"] = "1.5x"
        fast_mode["billingMultiplier"] = 2
        fast_mode.pop("effectiveReason", None)
    elif value == "off":
        fast_mode["enabled"] = False
        fast_mode["configApplied"] = True
        fast_mode["applied"] = False
        fast_mode["effective"] = False
        fast_mode["runtimeValue"] = "off"
        fast_mode["speedMode"] = "normal"
        fast_mode["displayRate"] = "1x"
        fast_mode["billingMultiplier"] = 1
        if requested:
            fast_mode["effectiveReason"] = "runtime reported fast mode off"


def _supports_runtime_fast_mode(services: AppServices, conversation_id: str, runtime_config_id: str | None) -> bool:
    if not runtime_config_id:
        return False
    capability_ids = _capability_config_ids(services, conversation_id)
    return not capability_ids or runtime_config_id in capability_ids


def _fast_mode_metadata(fast_mode: str | None, *, runtime_config_id: str | None) -> dict[str, object] | None:
    if fast_mode not in {"on", "off"}:
        return None
    enabled = fast_mode == "on"
    return {
        "requested": enabled,
        "enabled": enabled,
        "configApplied": None,
        "applied": False,
        "effective": False,
        "effectiveSource": "pending_runtime_config",
        "speedMode": "fast" if enabled else "normal",
        "displayRate": "1.5x" if enabled else "1x",
        "runtimeConfigId": runtime_config_id,
        "runtimeValue": fast_mode,
        "billingMultiplier": 1,
    }


def _fast_mode_unavailable_metadata(
    fast_mode: str,
    *,
    runtime_config_id: str | None,
    reason: str,
) -> dict[str, object]:
    requested = fast_mode == "on"
    return {
        "requested": requested,
        "enabled": False,
        "configApplied": False,
        "applied": False,
        "effective": False,
        "effectiveSource": "runtime_capabilities",
        "effectiveReason": reason,
        "speedMode": "normal",
        "displayRate": "1x",
        "runtimeConfigId": runtime_config_id,
        "runtimeValue": fast_mode,
        "billingMultiplier": 1,
    }


def _runtime_fast_config_id(agent_id: str) -> str | None:
    if agent_id == "codex":
        return "fast-mode"
    if agent_id == "claude_code":
        return "fast"
    return None


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


def _int_or_none(value: object) -> int | None:
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float) and value.is_integer():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _attachment_message_metadata(metadata: dict[str, object]) -> dict[str, object]:
    keys = (
        "id",
        "kind",
        "name",
        "mimeType",
        "sizeBytes",
        "width",
        "height",
        "sha256",
        "wasCompressed",
        "createdAt",
    )
    return {key: metadata[key] for key in keys if key in metadata}


def _parse_content_blocks(
    *,
    body: dict[str, object],
    prompt: str,
    conversation_id: str,
    turn_id: str,
    services: AppServices,
) -> tuple[list[UserInputBlock], list[dict[str, object]], str | None]:
    raw_blocks = body.get("contentBlocks")
    blocks_payload = raw_blocks if isinstance(raw_blocks, list) else None
    input_blocks: list[UserInputBlock] = []
    attachments: list[dict[str, object]] = []
    has_text_block = False

    if blocks_payload is None:
        if prompt:
            input_blocks.append(TextInputBlock(type="text", text=prompt))
        return input_blocks, attachments, None

    for item in blocks_payload:
        if not isinstance(item, dict):
            return [], [], "contentBlocks 只能包含对象。"
        block_type = str(item.get("type") or "").strip().lower()
        if block_type == "text":
            text = str(item.get("text") or "").strip()
            if text:
                input_blocks.append(TextInputBlock(type="text", text=text))
                has_text_block = True
            continue
        if block_type != "image":
            return [], [], f"不支持的 content block 类型：{block_type or 'unknown'}"

        source = item.get("source")
        if not isinstance(source, dict) or source.get("kind") != "attachment":
            return [], [], "图片输入只支持 attachmentId 引用。"
        attachment_id = str(source.get("attachmentId") or "").strip()
        if not attachment_id:
            return [], [], "图片输入缺少 attachmentId。"
        stored = services.attachment_store.load_metadata(conversation_id, attachment_id)
        if stored is None:
            return [], [], f"图片附件不存在：{attachment_id}"
        if str(stored.get("conversationId") or "") != conversation_id or str(stored.get("turnId") or "") != turn_id:
            return [], [], f"图片附件不属于当前 turn：{attachment_id}"
        mime_type = str(stored.get("mimeType") or "").strip().lower()
        if mime_type not in ALLOWED_IMAGE_MIME_TYPES:
            return [], [], f"不支持的图片类型：{mime_type or 'unknown'}"

        attachments.append(_attachment_message_metadata(stored))
        input_blocks.append(
            ImageInputBlock(
                type="image",
                mime_type=mime_type,
                source=ImageAttachmentSource(kind="attachment", attachment_id=attachment_id),
                name=str(stored.get("name") or "") or None,
                size_bytes=_int_or_none(stored.get("sizeBytes")),
                width=_int_or_none(stored.get("width")),
                height=_int_or_none(stored.get("height")),
                sha256=str(stored.get("sha256") or "") or None,
                was_compressed=bool(stored.get("wasCompressed")) if "wasCompressed" in stored else None,
            )
        )

    if prompt and not has_text_block:
        input_blocks.insert(0, TextInputBlock(type="text", text=prompt))

    if len(attachments) > MAX_IMAGES_PER_TURN:
        return [], [], "单轮最多支持 20 张图片。"
    total_bytes = sum(int(item.get("sizeBytes") or 0) for item in attachments)
    if total_bytes > MAX_IMAGE_BYTES_PER_TURN:
        return [], [], "单轮图片总大小不能超过 200 MB。"
    return input_blocks, attachments, None


@router.post("/turns/{turn_id}/cancel")
async def cancel_turn(
    turn_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    await services.agent_adapter.cancel_turn(turn_id)
    await services.approvals.reject_all()
    await services.inputs.cancel_all()
    return JSONResponse({"ok": True})


async def prepare_and_start_turn(
    services: AppServices,
    body: dict[str, object],
) -> TurnStartOutcome:
    """解析请求、解析模型、构建并在后台启动一个会话 turn。

    唯一调用方是 WS turn.start RPC（0709 阶段二移除 HTTP NDJSON 后）。
    turn 在 ActiveTurnRegistry 的后台 task 中执行，事件经 SessionEventBus 广播。
    订阅由 WS 端自行管理，本函数只负责启动 turn。
    """
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
    requested_fast_mode = _fast_mode_from_config(selected_config)
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
    effective_fast_mode = requested_fast_mode

    if agent_id in _ACP_RUNTIME_IDS:
        # ACP runtime：使用 runtime 原生模型（不查产品级 model_config）
        runtime_model = requested_model_id
        if agent_id == "claude_code":
            runtime_model = _normalize_claude_runtime_model(runtime_model)
        elif agent_id == "codex":
            runtime_model = _normalize_codex_runtime_model(runtime_model)
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
            runtime_fast_config_id = _runtime_fast_config_id(agent_id)
            if requested_fast_mode and agent_id != "codex" and not _supports_runtime_fast_mode(
                services,
                conversation_id,
                runtime_fast_config_id,
            ):
                reason = f"runtime capabilities do not expose config id {runtime_fast_config_id}"
                logger.info(
                    "Ignoring fast_mode=%s for agent=%s model=%s because runtime capabilities do not expose config id %s",
                    requested_fast_mode,
                    agent_id,
                    runtime_model,
                    runtime_fast_config_id,
                    extra={
                        "category": "acp",
                        "runtime": agent_id,
                        "conversationId": conversation_id,
                        "turnId": turn_id,
                        "stage": "configure.fast_mode",
                        "fields": {
                            "fastMode": requested_fast_mode,
                            "configId": runtime_fast_config_id,
                            "supported": False,
                        },
                    },
                )
                model_metadata["fastMode"] = _fast_mode_unavailable_metadata(
                    requested_fast_mode,
                    runtime_config_id=runtime_fast_config_id,
                    reason=reason,
                )
                effective_fast_mode = None
            fast_mode_info = _fast_mode_metadata(
                effective_fast_mode,
                runtime_config_id=runtime_fast_config_id,
            )
            if fast_mode_info:
                model_metadata["fastMode"] = fast_mode_info
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
            return TurnStartOutcome(conversation_id=conversation_id, turn_id=turn_id, error=error_message)

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
        effective_fast_mode = None
    input_blocks, user_attachments, content_error = _parse_content_blocks(
        body=body,
        prompt=prompt,
        conversation_id=conversation_id,
        turn_id=turn_id,
        services=services,
    )
    if content_error is not None:
        services.attachment_store.delete_turn(conversation_id, turn_id)
        return TurnStartOutcome(conversation_id=conversation_id, turn_id=turn_id, error=content_error)
    if user_attachments and agent_id not in _ACP_RUNTIME_IDS:
        services.attachment_store.delete_turn(conversation_id, turn_id)
        return TurnStartOutcome(
            conversation_id=conversation_id,
            turn_id=turn_id,
            error="当前 Agent Runtime 暂不支持图片输入。",
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
        fast_mode=effective_fast_mode,
        input_blocks=input_blocks,
    )

    # 详细日志：记录完整请求参数，帮助排查模型选择问题
    prompt_preview = prompt[:80] + ("..." if len(prompt) > 80 else "")
    logger.info(
        "turn.start [%s] conversation=%s turn=%s agent=%s(%s) model=%s runtime_model=%s mode=%s effort=%s fast_mode=%s workspace=%s selectedConfig=%s prompt_len=%d prompt=%s",
        "ACP" if agent_id in _ACP_RUNTIME_IDS else "product",
        conversation_id, turn_id, agent_id, agent_metadata.get("label"),
        requested_model_id, runtime_model,
        requested_access_mode, requested_reasoning_effort, effective_fast_mode,
        workspace,
        selected_config,
        len(prompt), prompt_preview,
    )

    event_store = services.event_store
    event_bus = services.event_bus
    turn_registry = services.turn_registry
    runtime_id = agent_id  # runtime identifier for events

    def publish(event: dict[str, object]) -> None:
        # 会话事件总线（0709）：turn 的所有事件都经此 fan-out 给本地/远程订阅者。
        # 发布失败不影响 turn 执行与持久化。
        if event_bus is None:
            return
        try:
            event_bus.publish(conversation_id, event)
        except Exception:
            logger.exception("turn %s: bus publish failed", turn_id)

    async def run_turn_task() -> None:
        """会话拥有的后台 turn 执行体（0709 设计 5.1.1）。

        与发起它的连接无关：连接断开只影响 NDJSON/WS 中继，不取消本 task。
        adapter.stream_turn 在所有退出路径（正常/取消/错误）都会发出终止事件，
        因此本 task 总能干净收尾并持久化。
        """
        assistant_message_id = ""
        native_session_id: str | None = None
        completed = False

        has_user_input = bool(prompt or user_attachments)
        if not has_user_input:
            logger.warning("run_turn_task: empty prompt, nothing to do")
            return

        logger.info("run_turn_task: start_turn for conversation=%s", conversation_id)
        turn_record = services.conversation_recorder.start_turn(
            conversation_id=conversation_id,
            prompt=prompt,
            attachments=user_attachments,
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
        publish(started_event)

        try:
            async for event in services.agent_adapter.stream_turn(run_request):
                if event.get("type") == "agent.config.updated":
                    _sync_fast_mode_from_config_update(model_metadata, event.get("configOptions"))
                # 从 metadata 中提取 nativeSessionId
                metadata = event.get("metadata")
                if isinstance(metadata, dict) and metadata.get("nativeSessionId"):
                    native_session_id = str(metadata["nativeSessionId"])

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

                ui_event = services.conversation_recorder.project_agent_event_for_ui(
                    conversation_id=conversation_id,
                    event=event,
                )
                publish(ui_event)
                if event.get("type") in {"agent.run.completed", "agent.run.failed"}:
                    completed = True
                    logger.info("run_turn_task: turn %s finished with %s", turn_id, event.get("type"))
        except asyncio.CancelledError:
            # task 被显式取消（后端关停等）。cancel_turn 走 adapter 内部取消并
            # 由 stream_turn 发出终止事件，通常不会到这里。
            logger.info("run_turn_task: turn %s task cancelled", turn_id)
            cancel_event = {
                "type": "agent.run.failed",
                "conversationId": conversation_id,
                "turnId": turn_id,
                "error": "用户取消了当前任务。",
            }
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
            publish(cancel_event)
            completed = True
            raise
        except Exception:
            logger.exception("run_turn_task: unexpected error in turn %s", turn_id)
            raise
        finally:
            if not completed:
                logger.warning("run_turn_task: turn %s discarded (not completed)", turn_id)
                services.conversation_recorder.discard_turn(conversation_id)
            # 显式广播 turn.unlock（0710 第 5.3 节）：让只订阅了本会话频道、
            # 但不解析 terminal 事件的订阅者也能准确解锁输入框、显示"空闲"。
            # 与 turn.lock 对称，走同一会话频道。terminal 事件仍是最终状态真相源。
            publish({
                "type": "turn.unlock",
                "conversationId": conversation_id,
                "turnId": turn_id,
            })

    # 会话级串行互锁 + 启动后台 turn，全部同步完成（0709 第 6 节、5.1.1）。
    # 必须同步：不能推迟到惰性生成器里，否则返回响应到开始消费之间会出现
    # is_running=False 的窗口，导致互锁失效。
    if turn_registry is not None and turn_registry.is_running(conversation_id):
        return TurnStartOutcome(conversation_id=conversation_id, turn_id=turn_id, busy=True)

    try:
        if turn_registry is not None:
            turn_registry.start(conversation_id, run_turn_task)
        else:
            asyncio.ensure_future(run_turn_task())
    except Exception:
        raise

    # 广播 turn.lock：所有订阅者据此禁用输入框、显示"另一端正在运行"（0709 设计 6.1）。
    # turn.unlock 由 terminal 事件（agent.run.completed/failed）隐式表达，无需单独广播。
    if event_bus is not None:
        event_bus.publish(conversation_id, {
            "type": "turn.lock",
            "conversationId": conversation_id,
            "turnId": turn_id,
        })

    return TurnStartOutcome(
        conversation_id=conversation_id,
        turn_id=turn_id,
    )
