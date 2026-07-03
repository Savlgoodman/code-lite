from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import acp
from acp import schema as acp_schema

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.acp.mapper import to_jsonable
from code_lite_backend.agents.runtimes import CODEX_DESCRIPTOR
from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.agent_runtime_config import _string_list
from code_lite_backend.schemas.session import (
    SessionCapabilities,
    build_nanobot_session_capabilities,
    build_session_capabilities,
)
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.post("/sessions/{conversation_id}/initialize")
async def initialize_session(
    conversation_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    """进入对话时调用，初始化 ACP session 并返回 SessionCapabilities。

    前端根据 SessionCapabilities 动态渲染权限模式、模型选择、思考强度等控件。
    """
    agent_id = services.agent_runtime_config_store.resolve_adapter(None)
    agent_metadata = services.agent_runtime_config_store.agent_summary(agent_id)
    agent_label = str(agent_metadata.get("label") or agent_id)

    if agent_id == "nanobot":
        caps = build_nanobot_session_capabilities(
            model_config_store=services.model_config_store,
        )
        return JSONResponse(caps.to_dict())

    if agent_id == "codex":
        descriptor = CODEX_DESCRIPTOR
    else:
        from code_lite_backend.agents.runtimes import get_descriptor
        descriptor = get_descriptor(agent_id)
        if descriptor is None:
            return JSONResponse({
                "error": f"不支持的 agent: {agent_id}",
            }, status_code=400)

    try:
        caps = await _initialize_acp_session(
            agent_id=agent_id,
            agent_label=agent_label,
            descriptor=descriptor,
            services=services,
        )
        return JSONResponse(caps.to_dict())
    except Exception as exc:
        return JSONResponse({
            "error": f"初始化 session 失败: {type(exc).__name__}: {exc}",
        }, status_code=502)


async def _initialize_acp_session(
    *,
    agent_id: str,
    agent_label: str,
    descriptor: Any,
    services: AppServices,
) -> SessionCapabilities:
    """启动 ACP 连接，创建 session，构建 SessionCapabilities。"""
    agent_runtime_config_store = services.agent_runtime_config_store
    runtime_config = services.runtime_config

    if agent_id == "codex":
        command = agent_runtime_config_store.codex_command()
        env = agent_runtime_config_store.codex_env()
        default_mode = agent_runtime_config_store.codex_mode()
    elif agent_id == "claude_code":
        runtime_settings = agent_runtime_config_store.load()["agentRuntimes"]
        claude_runtime = runtime_settings.get("claude_code", {})
        command = _string_list(claude_runtime.get("command"))
        if not command:
            command = agent_runtime_config_store.managed_claude_command()
        env = dict(__import__("os").environ)
        default_mode = str(claude_runtime.get("mode") or descriptor.default_mode)
    else:
        command = descriptor.default_command
        env = dict(__import__("os").environ)
        default_mode = descriptor.default_mode

    client = AcpClientHandler(
        runtime=descriptor.id,
        conversation_id="session-probe",
        turn_id="session-probe",
        output_queue=asyncio.Queue(),
        approvals=services.approvals,
    )
    process = None
    try:
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
            session_result = await asyncio.wait_for(
                conn.new_session(
                    cwd=str(services.workspace),
                    mcp_servers=[],
                ),
                timeout=30,
            )
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
