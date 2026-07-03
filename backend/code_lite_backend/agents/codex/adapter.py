from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections import deque
from pathlib import Path
from typing import Any, AsyncIterator

import acp
from acp import schema as acp_schema
from acp.exceptions import RequestError

from code_lite_backend.agents.risk import describe_risk, risk_level
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.schemas.agent import AgentAdapterCapabilities, AgentEvent, AgentRunRequest
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.approvals import ApprovalBroker


def _to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_to_jsonable(item) for item in value]
    return value


def _text_from_content(content: Any) -> str:
    if content is None:
        return ""
    text = getattr(content, "text", None)
    if text is not None:
        return str(text)
    if isinstance(content, dict):
        return str(content.get("text") or "")
    return str(content)


def _format_json(value: Any) -> str:
    try:
        return json.dumps(_to_jsonable(value), ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


def _permission_option_id(option: Any) -> str:
    return str(getattr(option, "option_id", None) or getattr(option, "optionId", None) or "")


def _permission_option_kind(option: Any) -> str:
    return str(getattr(option, "kind", "") or "")


def _choose_permission_option(options: list[Any], *, allowed: bool) -> Any | None:
    if not options:
        return None

    desired_prefix = "allow" if allowed else "reject"
    desired_kinds = (
        ["allow_once", "allow_always"]
        if allowed
        else ["reject_once", "reject_always"]
    )
    for kind in desired_kinds:
        for option in options:
            if _permission_option_kind(option) == kind:
                return option
    for option in options:
        if _permission_option_kind(option).startswith(desired_prefix):
            return option
    return options[0] if allowed else None


def _usage_event_payload(update: Any) -> dict[str, Any]:
    used = getattr(update, "used", None)
    size = getattr(update, "size", None)
    usage: dict[str, Any] = {
        "totalTokens": used,
        "contextUsedTokens": used,
        "contextWindowTokens": size,
        "source": "acp.usage_update",
    }
    return {key: value for key, value in usage.items() if value is not None}


def _models_payload(session_result: Any) -> dict[str, Any]:
    raw = _to_jsonable(session_result)
    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, dict):
        return {
            "currentModelId": None,
            "models": [],
        }
    available = models.get("availableModels") if isinstance(models.get("availableModels"), list) else []
    parsed = []
    for item in available:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("modelId") or item.get("id") or "").strip()
        if not model_id:
            continue
        parsed.append({
            "id": model_id,
            "label": str(item.get("name") or model_id),
            "description": item.get("description"),
            "source": "codex-acp",
        })
    return {
        "currentModelId": models.get("currentModelId"),
        "models": parsed,
    }


class CodexAcpClient:
    def __init__(
        self,
        *,
        conversation_id: str,
        output_queue: asyncio.Queue[AgentEvent],
        approvals: ApprovalBroker,
        turn_id: str,
    ) -> None:
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.output_queue = output_queue
        self.approvals = approvals
        self.native_session_id: str | None = None
        self.latest_usage: dict[str, Any] | None = None
        self.stderr_tail: deque[str] = deque(maxlen=20)

    def observe_stream(self, event: Any) -> None:
        message = getattr(event, "message", {})
        if not isinstance(message, dict):
            return
        method = message.get("method")
        if method == "session/update":
            params = message.get("params")
            if isinstance(params, dict):
                session_id = params.get("sessionId")
                if session_id:
                    self.native_session_id = str(session_id)

    async def session_update(self, session_id: str, update: Any, **_: Any) -> None:
        self.native_session_id = session_id
        kind = str(getattr(update, "session_update", "unknown"))

        if kind == "agent_message_chunk":
            await self._put({
                "type": "agent.text.delta",
                "delta": _text_from_content(getattr(update, "content", None)),
                "metadata": self._metadata(),
            })
            return

        if kind == "agent_thought_chunk":
            await self._put({
                "type": "agent.reasoning.delta",
                "delta": _text_from_content(getattr(update, "content", None)),
                "metadata": self._metadata(),
            })
            return

        if kind == "tool_call":
            tool_call_id = str(getattr(update, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
            name = str(getattr(update, "title", None) or getattr(update, "kind", None) or "codex tool")
            raw_input = _to_jsonable(getattr(update, "raw_input", None))
            await self._put({
                "type": "agent.tool.started",
                "toolCallId": tool_call_id,
                "name": name,
                "arguments": raw_input,
                "risk": risk_level(str(getattr(update, "kind", "") or name)),
                "metadata": {
                    **self._metadata(),
                    "status": getattr(update, "status", None),
                    "kind": getattr(update, "kind", None),
                },
            })
            return

        if kind == "tool_call_update":
            status = str(getattr(update, "status", "") or "")
            tool_call_id = str(getattr(update, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
            name = str(getattr(update, "title", None) or "codex tool")
            raw_output = _to_jsonable(getattr(update, "raw_output", None))
            content = _to_jsonable(getattr(update, "content", None))
            if status == "completed":
                await self._put({
                    "type": "agent.tool.completed",
                    "toolCallId": tool_call_id,
                    "name": name,
                    "result": raw_output if raw_output is not None else content,
                    "metadata": {
                        **self._metadata(),
                        "status": status,
                    },
                })
            elif status == "failed":
                await self._put({
                    "type": "agent.tool.failed",
                    "toolCallId": tool_call_id,
                    "name": name,
                    "error": _format_json(raw_output) if raw_output else "Codex tool failed",
                    "metadata": {
                        **self._metadata(),
                        "status": status,
                        "content": content,
                    },
                })
            return

        if kind == "usage_update":
            self.latest_usage = _usage_event_payload(update)
            return

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **_: Any,
    ) -> Any:
        self.native_session_id = session_id
        tool_call_id = str(getattr(tool_call, "tool_call_id", None) or f"tool-{uuid.uuid4().hex}")
        name = str(getattr(tool_call, "title", None) or getattr(tool_call, "kind", None) or "Codex permission")
        kind = str(getattr(tool_call, "kind", None) or name)
        risk = risk_level(kind)
        description = describe_risk(kind)
        approval_id = f"approval-{uuid.uuid4().hex}"
        future = await self.approvals.create(
            approval_id=approval_id,
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
        )
        await self._put({
            "type": "approval.required",
            "approvalId": approval_id,
            "toolCallId": tool_call_id,
            "name": name,
            "arguments": _to_jsonable(tool_call),
            "argumentsText": _format_json(tool_call),
            "risk": risk,
            **description,
            "metadata": {
                **self._metadata(),
                "options": [_to_jsonable(option) for option in options],
            },
        })

        allowed = await future
        selected = _choose_permission_option(options, allowed=allowed)
        if selected is None:
            return acp_schema.RequestPermissionResponse(
                outcome=acp_schema.DeniedOutcome(outcome="cancelled"),
            )

        return acp_schema.RequestPermissionResponse(
            outcome=acp_schema.AllowedOutcome(
                outcome="selected",
                optionId=_permission_option_id(selected),
            ),
        )

    async def read_text_file(self, path: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite fs gateway is disabled"})

    async def write_text_file(self, content: str, path: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite fs gateway is disabled"})

    async def create_terminal(self, command: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def terminal_output(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def release_terminal(self, session_id: str, terminal_id: str, **_: Any) -> None:
        return None

    async def wait_for_terminal_exit(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def kill_terminal(self, session_id: str, terminal_id: str, **_: Any) -> None:
        return None

    async def _put(self, event: dict[str, Any]) -> None:
        await self.output_queue.put({
            "conversationId": self.conversation_id,
            "turnId": self.turn_id,
            **event,
        })

    def _metadata(self) -> dict[str, Any]:
        metadata = {
            "runtime": "codex-acp",
            "nativeSessionId": self.native_session_id,
        }
        return {key: value for key, value in metadata.items() if value is not None}


class CodexAgentAdapter:
    name = "codex"
    capabilities = AgentAdapterCapabilities(
        streaming=True,
        tool_registration=False,
        tool_approval=True,
        session_state=True,
        notes=["使用 ACP Python SDK 启动 codex-acp，并映射为 code-lite AgentEvent。"],
    )

    def __init__(
        self,
        *,
        runtime_config: RuntimeConfig,
        approvals: ApprovalBroker,
        agent_runtime_config_store: AgentRuntimeConfigStore,
    ) -> None:
        self._runtime_config = runtime_config
        self._approvals = approvals
        self._agent_runtime_config_store = agent_runtime_config_store
        self._active_tasks: dict[str, asyncio.Task[None]] = {}

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
        client = CodexAcpClient(
            conversation_id=request.conversation_id,
            output_queue=output_queue,  # type: ignore[arg-type]
            approvals=self._approvals,
            turn_id=request.turn_id,
        )
        producer = asyncio.create_task(self._run_codex_turn(request, client, output_queue))
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
        command = self._agent_runtime_config_store.codex_command()
        env = self._agent_runtime_config_store.codex_env()
        client = CodexAcpClient(
            conversation_id="model-probe",
            output_queue=asyncio.Queue(),
            approvals=self._approvals,
            turn_id="model-probe",
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
                    conn.new_session(cwd=str(workspace), mcp_servers=[]),
                    timeout=30,
                )
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(conn.close_session(session_result.session_id), timeout=5)
                payload = _models_payload(session_result)
                payload["agentInfo"] = _to_jsonable(getattr(initialize_result, "agent_info", None))
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

    async def _run_codex_turn(
        self,
        request: AgentRunRequest,
        client: CodexAcpClient,
        output_queue: asyncio.Queue[AgentEvent | None],
    ) -> None:
        command = self._agent_runtime_config_store.codex_command()
        env = self._agent_runtime_config_store.codex_env()
        stderr_task: asyncio.Task[None] | None = None
        process: Any | None = None
        try:
            await output_queue.put({
                "type": "agent.run.started",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "model": request.model_metadata or None,
                "metadata": {
                    "runtime": "codex-acp",
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
                await output_queue.put({
                    "type": "agent.run.completed",
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "usage": client.latest_usage,
                    "result": {
                        "stopReason": getattr(prompt_result, "stop_reason", None),
                        "runtime": "codex-acp",
                        "nativeSessionId": client.native_session_id,
                        "agentInfo": _to_jsonable(getattr(initialize_result, "agent_info", None)),
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
                "error": f"Codex ACP 启动失败：{exc}",
            })
        except Exception as exc:
            stderr = "\n".join(client.stderr_tail)
            suffix = f"\n\nCodex stderr:\n{stderr}" if stderr else ""
            await output_queue.put({
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"Codex ACP 运行失败：{type(exc).__name__}: {exc}{suffix}",
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

    async def _drain_stderr(self, process: Any, client: CodexAcpClient) -> None:
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

    async def _configure_session(self, conn: Any, session_result: Any, request: AgentRunRequest) -> None:
        session_id = str(session_result.session_id)
        mode = self._agent_runtime_config_store.codex_mode(request.access_mode)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(conn.set_session_mode(session_id=session_id, mode_id=mode), timeout=10)

        model = str(request.runtime_model or request.model_metadata.get("model") or "").strip()
        available_model_ids = self._available_model_ids(session_result)
        if model and model in available_model_ids:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(conn.set_session_model(session_id=session_id, model_id=model), timeout=10)

        reasoning_effort = (request.reasoning_effort or request.model_metadata.get("reasoningEffort") or "").strip()
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

    def _available_model_ids(self, session_result: Any) -> set[str]:
        raw = _to_jsonable(session_result)
        models = raw.get("models") if isinstance(raw, dict) else None
        available = models.get("availableModels") if isinstance(models, dict) else []
        result: set[str] = set()
        for item in available if isinstance(available, list) else []:
            if isinstance(item, dict):
                model_id = str(item.get("modelId") or item.get("id") or "").strip()
                if model_id:
                    result.add(model_id)
        return result
