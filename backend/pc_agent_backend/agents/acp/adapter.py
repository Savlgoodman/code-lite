from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any, AsyncIterator

import acp
from acp import schema as acp_schema

from pc_agent_backend.agents.acp.capabilities import (
    extract_available_model_ids,
    parse_models_from_session_result,
)
from pc_agent_backend.agents.acp.client import AcpClientHandler
from pc_agent_backend.agents.acp.mapper import to_jsonable
from pc_agent_backend.agents.runtimes import (
    RuntimeDescriptor,
    codex_env,
    resolve_codex_mode,
)
from pc_agent_backend.agents.runtimes import CODEX_DESCRIPTOR
from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.schemas.agent import (
    AgentAdapterCapabilities,
    AgentEvent,
    AgentRunRequest,
)
from pc_agent_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from pc_agent_backend.services.approvals import ApprovalBroker


class AcpAgentAdapter:
    """通用 ACP agent adapter。

    所有 ACP runtime（Codex、Claude Code、opencode）共用此 adapter。
    差异通过 RuntimeDescriptor 隔离。
    """

    def __init__(
        self,
        *,
        runtime: str,
        descriptor: RuntimeDescriptor,
        runtime_config: RuntimeConfig,
        approvals: ApprovalBroker,
        agent_runtime_config_store: AgentRuntimeConfigStore,
    ) -> None:
        self.name = runtime
        self.descriptor = descriptor
        self._runtime_config = runtime_config
        self._approvals = approvals
        self._agent_runtime_config_store = agent_runtime_config_store
        self._active_tasks: dict[str, asyncio.Task[None]] = {}

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
        command = self._resolve_command()
        env = self._resolve_env()
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
        command = self._resolve_command()
        env = self._resolve_env()
        stderr_task: asyncio.Task[None] | None = None
        process: Any | None = None
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
            async with acp.spawn_agent_process(
                client,
                command[0],
                *command[1:],
                env=env,
                cwd=str(request.workspace),
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
                    conn.new_session(cwd=str(request.workspace), mcp_servers=[]),
                    timeout=30,
                )
                client.native_session_id = str(session_result.session_id)
                await self._configure_session(conn, session_result, request)
                prompt_result = await conn.prompt(
                    session_id=session_result.session_id,
                    prompt=[acp.text_block(request.prompt)],
                )
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(conn.close_session(session_result.session_id), timeout=5)
                await output_queue.put({
                    "type": "agent.text.completed",
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                })
                usage_dict = client.latest_usage.to_dict() if client.latest_usage else None
                await output_queue.put({
                    "type": "agent.run.completed",
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "usage": usage_dict,
                    "result": {
                        "stopReason": getattr(prompt_result, "stop_reason", None),
                        "runtime": self.descriptor.id,
                        "nativeSessionId": client.native_session_id,
                        "agentInfo": to_jsonable(getattr(initialize_result, "agent_info", None)),
                    },
                })
        except asyncio.CancelledError:
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": "用户取消了当前任务。",
            })
            raise
        except FileNotFoundError as exc:
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"{self.descriptor.label} ACP 启动失败：{exc}",
            })
        except Exception as exc:
            stderr = "\n".join(client.stderr_tail)
            suffix = f"\n\n{self.descriptor.label} stderr:\n{stderr}" if stderr else ""
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"{self.descriptor.label} ACP 运行失败：{type(exc).__name__}: {exc}{suffix}",
            })
        finally:
            if stderr_task is not None:
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stderr_task
            if process is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=5)
            await output_queue.put(None)

    async def _configure_session(
        self, conn: Any, session_result: Any, request: AgentRunRequest
    ) -> None:
        session_id = str(session_result.session_id)

        # 设置模式
        mode = self._resolve_mode(request.access_mode)
        if mode:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    conn.set_session_mode(session_id=session_id, mode_id=mode),
                    timeout=10,
                )

        # 设置模型
        model = str(
            request.runtime_model or request.model_metadata.get("model") or ""
        ).strip()
        available_model_ids = extract_available_model_ids(session_result)
        if model and model in available_model_ids:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    conn.set_session_model(session_id=session_id, model_id=model),
                    timeout=10,
                )

        # 设置 reasoning effort（通用 config option）
        reasoning_effort = (
            request.reasoning_effort or request.model_metadata.get("reasoningEffort") or ""
        ).strip()
        if reasoning_effort and reasoning_effort != "none":
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    conn.set_config_option(
                        session_id=session_id,
                        config_id="reasoning_effort",
                        value=reasoning_effort,
                    ),
                    timeout=10,
                )

    def _resolve_command(self) -> list[str]:
        """解析当前 runtime 的可执行命令。"""
        if self.name == "codex":
            return self._agent_runtime_config_store.codex_command()
        # 后续 Claude Code 和 opencode 在此添加分支
        return self.descriptor.default_command

    def _resolve_env(self) -> dict[str, str]:
        """解析当前 runtime 的环境变量。"""
        if self.name == "codex":
            runtime_config = self._agent_runtime_config_store.load()
            codex_runtime = runtime_config["agentRuntimes"].get("codex", {})
            logs_dir = str(self._runtime_config.logs_dir / "codex-acp")
            isolated_home = None
            if codex_runtime.get("configMode") == "isolated":
                codex_home = self._runtime_config.data_dir / "runtime-state" / "codex-home"
                codex_home.mkdir(parents=True, exist_ok=True)
                isolated_home = str(codex_home)
            return codex_env(codex_runtime, logs_dir=logs_dir, isolated_codex_home=isolated_home)
        return dict(__import__("os").environ)

    def _resolve_mode(self, fallback: str | None = None) -> str | None:
        """解析当前 runtime 的模式。"""
        if self.name == "codex":
            return resolve_codex_mode(fallback)
        # 后续 runtime 在此添加
        return None

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
