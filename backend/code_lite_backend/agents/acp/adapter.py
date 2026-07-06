from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import acp
from acp import schema as acp_schema

from code_lite_backend.agents.acp.capabilities import (
    parse_models_from_session_result,
)
from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.acp.mapper import extract_prompt_response_usage, to_jsonable
from code_lite_backend.agents.acp.runtime_manager import AcpRuntimeManager
from code_lite_backend.agents.runtimes import RuntimeDescriptor, get_runtime_profile
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.core.structured_logging import DiagnosticError, log_diagnostic
from code_lite_backend.schemas.agent import (
    AgentAdapterCapabilities,
    AgentEvent,
    AgentRunRequest,
)
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.approvals import ApprovalBroker

logger = logging.getLogger(__name__)


class AcpAgentAdapter:
    """通用 ACP agent adapter。

    所有 ACP runtime（Codex、Claude Code、opencode）共用此 adapter。
    差异通过 RuntimeDescriptor 隔离。

    使用 AcpRuntimeManager 管理常驻连接，实现跨 turn 复用。
    """

    def __init__(
        self,
        *,
        runtime: str,
        descriptor: RuntimeDescriptor,
        runtime_config: RuntimeConfig,
        approvals: ApprovalBroker,
        agent_runtime_config_store: AgentRuntimeConfigStore,
        runtime_manager: AcpRuntimeManager | None = None,
    ) -> None:
        self.name = runtime
        self.descriptor = descriptor
        self._runtime_config = runtime_config
        self._approvals = approvals
        self._agent_runtime_config_store = agent_runtime_config_store
        self._active_tasks: dict[str, asyncio.Task[None]] = {}
        self._runtime_manager = runtime_manager or AcpRuntimeManager()
        self._profile = get_runtime_profile(runtime)
        if self._profile is None:
            raise ValueError(f"Unsupported ACP runtime profile: {runtime}")

    @property
    def capabilities(self) -> AgentAdapterCapabilities:
        return AgentAdapterCapabilities(
            streaming=True,
            tool_registration=False,
            tool_approval=True,
            session_state=True,
            notes=[f"使用 ACP Python SDK 启动 {self.descriptor.label}，并映射为 code-lite AgentEvent。"],
        )

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        prompt = request.prompt.strip()
        if not prompt:
            yield {
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": "输入不能为空。",
            }
            return

        output_queue: asyncio.Queue[AgentEvent | None] = asyncio.Queue()
        client = AcpClientHandler(
            runtime=self.descriptor.id,
            conversation_id=request.conversation_id,
            turn_id=request.turn_id,
            output_queue=output_queue,  # type: ignore[arg-type]
            approvals=self._approvals,
        )
        producer = asyncio.create_task(self._run_turn(request, client, output_queue))
        self._active_tasks[request.turn_id] = producer
        try:
            while True:
                event = await output_queue.get()
                if event is None:
                    break
                yield event
        finally:
            self._active_tasks.pop(request.turn_id, None)
            if not producer.done():
                producer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await producer

    async def cancel_turn(self, turn_id: str) -> bool:
        task = self._active_tasks.get(turn_id)
        if task is None or task.done():
            return False
        task.cancel()
        await self._approvals.reject_all()
        return True

    async def list_models(self, workspace: Path) -> dict[str, Any]:
        """启动临时 ACP session，提取可用模型列表。"""
        command = self._profile.resolve_command(self._agent_runtime_config_store)
        env = self._profile.build_env(self._agent_runtime_config_store, self._runtime_config)
        client = AcpClientHandler(
            runtime=self.descriptor.id,
            conversation_id="model-probe",
            turn_id="model-probe",
            output_queue=asyncio.Queue(),
            approvals=self._approvals,
        )
        stderr_task: asyncio.Task[None] | None = None
        process: Any | None = None
        try:
            async with acp.spawn_agent_process(
                client,
                command[0],
                *command[1:],
                env=env,
                cwd=str(workspace),
                observers=[client.observe_stream],
                use_unstable_protocol=True,
            ) as (conn, process):
                stderr_task = asyncio.create_task(self._drain_stderr(process, client))
                initialize_result = await asyncio.wait_for(
                    conn.initialize(
                        protocol_version=acp.PROTOCOL_VERSION,
                        client_capabilities=_build_client_capabilities(),
                        client_info=acp_schema.Implementation(
                            name="code-lite",
                            title="code-lite",
                            version="0.1.4",
                        ),
                    ),
                    timeout=30,
                )
                session_result = await asyncio.wait_for(
                    conn.new_session(cwd=str(workspace), mcp_servers=[]),
                    timeout=30,
                )
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(conn.close_session(session_result.session_id), timeout=5)
                payload = parse_models_from_session_result(session_result, self.descriptor.id)
                payload["agentInfo"] = to_jsonable(getattr(initialize_result, "agent_info", None))
                payload["command"] = command
                return payload
        except FileNotFoundError as exc:
            diagnostic = DiagnosticError(
                code="acp.model_probe_command_not_found",
                message=f"{self.descriptor.label} 模型探测失败：{exc}",
                category="acp",
                stage="model_probe.spawn",
                runtime=self.descriptor.id,
                conversation_id="model-probe",
                turn_id="model-probe",
                retryable=True,
                user_action="请在设置页安装或修正该 Agent Runtime 的 ACP 命令。",
                details={"errorType": type(exc).__name__, "command": command},
            )
            log_diagnostic(self._runtime_config.logs_dir, diagnostic)
            logger.error(
                "ACP model probe process not found for %s: %s",
                self.name,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": "model-probe",
                    "turnId": "model-probe",
                    "stage": "model_probe.spawn",
                },
            )
            raise
        except Exception as exc:
            diagnostic = DiagnosticError(
                code="acp.model_probe_failed",
                message=f"{self.descriptor.label} 模型探测失败：{type(exc).__name__}: {exc}",
                category="acp",
                stage="model_probe",
                runtime=self.descriptor.id,
                conversation_id="model-probe",
                turn_id="model-probe",
                retryable=True,
                user_action="请查看设置页日志中的 ACP 与 runtime stderr 详情。",
                details={
                    "errorType": type(exc).__name__,
                    "command": command,
                    "stderrTail": list(client.stderr_tail),
                },
            )
            log_diagnostic(self._runtime_config.logs_dir, diagnostic)
            logger.exception(
                "ACP model probe failed for %s",
                self.name,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": "model-probe",
                    "turnId": "model-probe",
                    "stage": "model_probe",
                },
            )
            raise
        finally:
            if stderr_task is not None:
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stderr_task
            if process is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=5)

    async def _run_turn(
        self,
        request: AgentRunRequest,
        client: AcpClientHandler,
        output_queue: asyncio.Queue[AgentEvent | None],
    ) -> None:
        command = self._profile.resolve_command(self._agent_runtime_config_store)
        env = self._profile.build_env(self._agent_runtime_config_store, self._runtime_config)
        logger.info(
            "Starting turn %s for conversation %s (runtime=%s, command=%s)",
            request.turn_id, request.conversation_id, self.name, command[0],
        )
        logger.info(
            "[_run_turn] model_id=%s runtime_model=%s access_mode=%s reasoning_effort=%s model_metadata=%s",
            request.model_id, request.runtime_model, request.access_mode,
            request.reasoning_effort, request.model_metadata,
        )
        try:
            await output_queue.put({
                "type": "agent.run.started",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "model": request.model_metadata or None,
                "metadata": {
                    "runtime": self.descriptor.id,
                    "command": command,
                },
            })

            # 使用 RuntimeManager 确保连接存在（每个 conversation 独立连接）
            connection = await self._runtime_manager.ensure_connection(
                descriptor=self.descriptor,
                command=command,
                env=env,
                workspace=request.workspace,
                conversation_id=request.conversation_id,
                approvals=self._approvals,
            )
            logger.info("Connection ready for %s (conversation=%s)", self.name, request.conversation_id[:12])

            # 获取 conversation lock（串行化同一会话的 prompt）
            lock = self._runtime_manager.get_turn_lock(request.conversation_id)
            async with lock:
                connection_sdk = connection.sdk_connection
                original_handler = connection._client_handler

                # 直接更新 handler 状态（不需要多路复用——每个 connection 只有一个 handler，
                # 只服务于一个 conversation）
                if original_handler is not None:
                    original_handler.conversation_id = request.conversation_id
                    original_handler.turn_id = request.turn_id
                    original_handler.output_queue = output_queue  # type: ignore[assignment]
                    original_handler.native_session_id = None
                    baselines = self._runtime_manager.load_text_baselines(request.conversation_id)
                    original_handler.mapper.start_turn(
                        text_baseline=baselines["content"],
                        reasoning_baseline=baselines["reasoning"],
                    )

                # 确保 native session 存在
                binding = await self._runtime_manager.ensure_session(
                    connection=connection,
                    conversation_id=request.conversation_id,
                    workspace=request.workspace,
                )

                if original_handler is not None:
                    original_handler.native_session_id = binding.native_session_id
                client.native_session_id = binding.native_session_id
                logger.info(
                    "Session bound: %s -> native %s",
                    request.conversation_id[:12], binding.native_session_id[:12],
                )

                await self._profile.apply_turn_config(
                    conn=connection_sdk,
                    session_id=binding.native_session_id,
                    request=request,
                )

                # 发送 prompt
                logger.info("Sending prompt to session %s", binding.native_session_id[:12])
                prompt_result = await connection_sdk.prompt(
                    session_id=binding.native_session_id,
                    prompt=[acp.text_block(request.prompt)],
                    message_id=str(uuid.uuid4()),
                )
                logger.info("Prompt completed for %s (stop=%s)", request.turn_id, getattr(prompt_result, "stop_reason", None))

                await output_queue.put({
                    "type": "agent.text.completed",
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                })
                # 获取 usage：优先使用 PromptResponse.usage（包含完整分项），否则 fallback 到 usage_update
                prompt_usage = getattr(prompt_result, "usage", None)
                if prompt_usage is not None:
                    usage_snapshot = extract_prompt_response_usage(prompt_usage)
                    # 合并 usage_update 的 context window 数据
                    handler_usage = original_handler.latest_usage if original_handler else None
                    if handler_usage:
                        usage_snapshot.context_used_tokens = handler_usage.context_used_tokens
                        usage_snapshot.context_window_tokens = handler_usage.context_window_tokens
                    elif client.latest_usage:
                        usage_snapshot.context_used_tokens = client.latest_usage.context_used_tokens
                        usage_snapshot.context_window_tokens = client.latest_usage.context_window_tokens
                    usage_dict = usage_snapshot.to_dict()
                else:
                    handler_usage = original_handler.latest_usage if original_handler else None
                    usage_dict = (
                        handler_usage.to_dict() if handler_usage else
                        client.latest_usage.to_dict() if client.latest_usage else
                        None
                    )
                await output_queue.put({
                    "type": "agent.run.completed",
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "usage": usage_dict,
                    "result": {
                        "stopReason": getattr(prompt_result, "stop_reason", None),
                        "runtime": self.descriptor.id,
                        "nativeSessionId": binding.native_session_id,
                        "agentInfo": to_jsonable(getattr(connection.initialize_result, "agent_info", None)),
                    },
                })

        except asyncio.CancelledError:
            logger.info("Turn %s cancelled", request.turn_id)
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": "用户取消了当前任务。",
            })
            raise
        except FileNotFoundError as exc:
            diagnostic = DiagnosticError(
                code="acp.command_not_found",
                message=f"{self.descriptor.label} ACP 启动失败：{exc}",
                category="acp",
                stage="spawn",
                runtime=self.descriptor.id,
                conversation_id=request.conversation_id,
                turn_id=request.turn_id,
                retryable=True,
                user_action="请在设置页安装或修正该 Agent Runtime 的 ACP 命令。",
                details={"errorType": type(exc).__name__, "command": command},
            )
            log_diagnostic(self._runtime_config.logs_dir, diagnostic)
            logger.error(
                "ACP process not found for %s: %s",
                self.name,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "stage": "spawn",
                },
            )
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": diagnostic.message,
                "diagnostic": diagnostic.to_dict(),
            })
        except Exception as exc:
            logger.exception(
                "Turn %s failed for conversation %s",
                request.turn_id,
                request.conversation_id,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "stage": "prompt",
                },
            )
            # 尝试从 connection 获取 stderr
            connection = self._runtime_manager.get_connection_for_conversation(request.conversation_id)
            stderr = ""
            if connection is not None:
                stderr = "\n".join(connection.stderr_ring_buffer)
            suffix = f"\n\n{self.descriptor.label} stderr:\n{stderr}" if stderr else ""
            diagnostic = DiagnosticError(
                code="acp.prompt_failed",
                message=f"{self.descriptor.label} ACP 运行失败：{type(exc).__name__}: {exc}",
                category="acp",
                stage="prompt",
                runtime=self.descriptor.id,
                conversation_id=request.conversation_id,
                turn_id=request.turn_id,
                native_session_id=client.native_session_id,
                retryable=True,
                user_action="请查看设置页日志中的 ACP 与 runtime stderr 详情。",
                details={
                    "errorType": type(exc).__name__,
                    "stderrTail": list(connection.stderr_ring_buffer) if connection is not None else [],
                },
            )
            log_diagnostic(self._runtime_config.logs_dir, diagnostic)
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"{diagnostic.message}{suffix}",
                "diagnostic": diagnostic.to_dict(),
            })
        finally:
            await output_queue.put(None)

    async def _drain_stderr(self, process: Any, client: AcpClientHandler) -> None:
        stderr = getattr(process, "stderr", None)
        if stderr is None:
            return
        while True:
            line = await stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                client.stderr_tail.append(text)


def _build_client_capabilities() -> acp_schema.ClientCapabilities:
    """构建 ACP client capabilities（compat mode）。"""
    return acp_schema.ClientCapabilities(
        fs=acp_schema.FileSystemCapabilities(
            read_text_file=False,
            write_text_file=False,
        ),
        terminal=False,
    )
