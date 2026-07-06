from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

import acp
from acp import schema as acp_schema

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.runtimes import get_descriptor, get_runtime_profile
from code_lite_backend.api.dependencies import get_services
from code_lite_backend.core.structured_logging import DiagnosticError, log_diagnostic
from code_lite_backend.schemas.session import (
    SessionCapabilities,
    build_nanobot_session_capabilities,
    build_session_capabilities,
)
from code_lite_backend.services.runtime import AppServices

logger = logging.getLogger(__name__)

router = APIRouter()


def _log_session_diagnostic(
    *,
    services: AppServices,
    code: str,
    message: str,
    agent_id: str,
    conversation_id: str,
    error: Exception,
    stage: str,
    command: list[str] | None = None,
) -> dict[str, Any]:
    connection = services.runtime_manager.get_connection_for_conversation(conversation_id) if services.runtime_manager else None
    stderr_tail = list(connection.stderr_ring_buffer) if connection is not None else []
    native_session_id = None
    if connection is not None:
        binding = connection.sessions.get(conversation_id)
        native_session_id = binding.native_session_id if binding is not None else None
    diagnostic = DiagnosticError(
        code=code,
        message=message,
        category="acp",
        stage=stage,
        runtime=agent_id,
        conversation_id=conversation_id,
        native_session_id=native_session_id,
        retryable=True,
        user_action="请查看设置页日志中的 ACP 与 runtime stderr 详情。",
        details={
            "errorType": type(error).__name__,
            "command": command,
            "stderrTail": stderr_tail,
        },
    )
    log_diagnostic(services.runtime_config.logs_dir, diagnostic)
    return diagnostic.to_dict()


@router.post("/sessions/{conversation_id}/initialize")
async def initialize_session(
    conversation_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """进入对话时调用，初始化 ACP session 并返回 SessionCapabilities。

    前端根据 SessionCapabilities 动态渲染权限模式、模型选择、思考强度等控件。

    使用 AcpRuntimeManager 复用连接和 session，不再每轮临时 spawn。
    """
    logger.info("POST /sessions/%s/initialize — entry", conversation_id)

    # 优先从会话绑定的 agent 解析，其次 fallback 到全局 activeAdapter
    persisted_agent = None
    if conversation_id and not conversation_id.startswith("__"):
        persisted = services.conversation_store.get_conversation(conversation_id)
        if persisted and isinstance(persisted.get("session"), dict):
            raw_agent = persisted["session"].get("agent")
            if isinstance(raw_agent, dict):
                persisted_agent = str(raw_agent.get("id") or "").strip() or None
        logger.info("  persisted_agent from session: %s", persisted_agent)
    else:
        logger.info("  conversation_id starts with __, skipping persisted agent lookup")

    agent_id = services.agent_runtime_config_store.resolve_adapter(persisted_agent)
    logger.info("  resolved agent_id: %s", agent_id)

    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    agent_label = str(agent_metadata.get("label") or agent_id)
    logger.info("  agent_label: %s, metadata: %s", agent_label, agent_metadata)

    if agent_id == "nanobot":
        caps = build_nanobot_session_capabilities(
            model_config_store=services.model_config_store,
        )
        return JSONResponse(caps.to_dict())

    descriptor = get_descriptor(agent_id)
    if descriptor is None:
        logger.error("  No descriptor for agent_id=%s", agent_id)
        return JSONResponse({
            "error": f"不支持的 agent: {agent_id}",
        }, status_code=400)

    logger.info("  descriptor: id=%s label=%s status=%s default_mode=%s",
                descriptor.id, descriptor.label, descriptor.status, descriptor.default_mode)

    try:
        caps = await _initialize_acp_session(
            agent_id=agent_id,
            agent_label=agent_label,
            descriptor=descriptor,
            services=services,
            conversation_id=conversation_id,
        )
        logger.info("  SUCCESS — modes=%d models=%d configOptions=%d",
                    len(caps.modes), len(caps.models), len(caps.config_options))
        logger.info("  modes: %s", [m.id for m in caps.modes])
        logger.info("  models: %s", [m.id for m in caps.models])
        logger.info("  configOptions: %s", [o.id for o in caps.config_options])
        return JSONResponse(caps.to_dict())
    except FileNotFoundError as exc:
        diagnostic = _log_session_diagnostic(
            services=services,
            code="acp.session_command_not_found",
            message=f"{agent_label} session 初始化失败：{exc}",
            agent_id=agent_id,
            conversation_id=conversation_id,
            error=exc,
            stage="session.initialize.spawn",
        )
        logger.error("  FAIL — command not found: %s", exc)
        return JSONResponse({
            "error": f"初始化 session 失败：{agent_label} 的可执行文件未找到 ({exc})。请在设置页安装 ACP 包。",
            "diagnostic": diagnostic,
        }, status_code=502)
    except Exception as exc:
        diagnostic = _log_session_diagnostic(
            services=services,
            code="acp.session_initialize_failed",
            message=f"{agent_label} session 初始化失败：{type(exc).__name__}: {exc}",
            agent_id=agent_id,
            conversation_id=conversation_id,
            error=exc,
            stage="session.initialize",
        )
        logger.exception("  FAIL — unexpected error: %s: %s", type(exc).__name__, exc)
        return JSONResponse({
            "error": f"初始化 session 失败: {type(exc).__name__}: {exc}",
            "diagnostic": diagnostic,
        }, status_code=502)


async def _initialize_acp_session(
    *,
    agent_id: str,
    agent_label: str,
    descriptor: Any,
    services: AppServices,
    conversation_id: str,
) -> SessionCapabilities:
    """通过 RuntimeManager 复用连接和 session 来构建 SessionCapabilities。"""
    profile = get_runtime_profile(agent_id)
    if profile is None:
        raise RuntimeError(f"Unsupported ACP runtime profile: {agent_id}")

    command = profile.resolve_command(services.agent_runtime_config_store)
    env = profile.build_env(services.agent_runtime_config_store, services.runtime_config)
    default_mode = profile.default_mode(services.agent_runtime_config_store)

    logger.info("  command: %s", command)
    logger.info("  default_mode: %s", default_mode)

    runtime_manager = services.runtime_manager
    if runtime_manager is None:
        logger.info("  No runtime_manager, using legacy path")
        return await _initialize_acp_session_legacy(
            agent_id=agent_id,
            agent_label=agent_label,
            descriptor=descriptor,
            services=services,
            command=command,
            env=env,
            default_mode=default_mode,
        )

    # 使用 RuntimeManager 复用连接
    logger.info("  Calling ensure_connection (conversation=%s)...", conversation_id)
    connection = await runtime_manager.ensure_connection(
        descriptor=descriptor,
        command=command,
        env=env,
        workspace=services.workspace,
        conversation_id=conversation_id,
        approvals=services.approvals,
    )
    logger.info("  Connection ready, process.returncode=%s", connection.process.returncode)

    # 使用 RuntimeManager 复用或创建 session
    logger.info("  Calling ensure_session (conversation=%s)...", conversation_id)
    binding = await runtime_manager.ensure_session(
        connection=connection,
        conversation_id=conversation_id,
        workspace=services.workspace,
    )
    logger.info("  Session bound: native_id=%s", binding.native_session_id[:16] if binding.native_session_id else "?")

    # 使用 binding 中保存的 session/new 原始数据构建 SessionCapabilities
    caps_data = binding.capabilities
    logger.info("  capabilities from binding: %s",
                "present" if caps_data else "MISSING — will produce empty modes/models")

    result = build_session_capabilities(
        agent_id=agent_id,
        agent_label=agent_label,
        adapter_kind="acp",
        status=descriptor.status,
        session_result=_SessionDataWrapper(caps_data),
        default_mode=default_mode,
        runtime=descriptor.id,
    )
    return result


class _SessionDataWrapper:
    """包装序列化的 session result dict，使其兼容 to_jsonable() 的期望。"""

    def __init__(self, data: dict[str, Any] | None) -> None:
        self._data = data or {}

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        return self._data

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return self._data.get(name)


async def _initialize_acp_session_legacy(
    *,
    agent_id: str,
    agent_label: str,
    descriptor: Any,
    services: AppServices,
    command: list[str],
    env: dict[str, str],
    default_mode: str,
) -> SessionCapabilities:
    """Legacy fallback：临时 spawn ACP 获取 capabilities（无 RuntimeManager 时使用）。"""
    client = AcpClientHandler(
        runtime=descriptor.id,
        conversation_id="session-probe",
        turn_id="session-probe",
        output_queue=asyncio.Queue(),
        approvals=services.approvals,
    )
    process = None
    try:
        logger.info("  [legacy] spawning: %s", command)
        async with acp.spawn_agent_process(
            client,
            command[0],
            *command[1:],
            env=env,
            cwd=str(services.workspace),
            observers=[client.observe_stream],
            use_unstable_protocol=True,
        ) as (conn, process):
            initialize_result = await asyncio.wait_for(
                conn.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=acp_schema.ClientCapabilities(
                        fs=acp_schema.FileSystemCapabilities(
                            read_text_file=False,
                            write_text_file=False,
                        ),
                        terminal=False,
                    ),
                    client_info=acp_schema.Implementation(
                        name="code-lite",
                        title="code-lite",
                        version="0.1.4",
                    ),
                ),
                timeout=30,
            )
            logger.info("  [legacy] initialized, agent_info=%s",
                        getattr(initialize_result, "agent_info", None))
            session_result = await asyncio.wait_for(
                conn.new_session(
                    cwd=str(services.workspace),
                    mcp_servers=[],
                ),
                timeout=30,
            )
            logger.info("  [legacy] session/new returned session_id=%s", session_result.session_id)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(conn.close_session(session_result.session_id), timeout=5)

            return build_session_capabilities(
                agent_id=agent_id,
                agent_label=agent_label,
                adapter_kind="acp",
                status=descriptor.status,
                session_result=session_result,
                default_mode=default_mode,
                runtime=descriptor.id,
            )
    finally:
        if process is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(process.wait(), timeout=5)
