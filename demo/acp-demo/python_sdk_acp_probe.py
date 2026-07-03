from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
from collections import Counter
from contextlib import suppress
from pathlib import Path
from typing import Any

try:
    import acp
    from acp import schema as acp_schema
    from acp.agent.connection import AgentSideConnection
    from acp.exceptions import RequestError
except ModuleNotFoundError:
    acp = None  # type: ignore[assignment]
    acp_schema = None  # type: ignore[assignment]
    AgentSideConnection = None  # type: ignore[assignment]
    RequestError = None  # type: ignore[assignment]


JsonObject = dict[str, Any]


def print_json(label: str, payload: Any) -> None:
    print(json.dumps({label: to_jsonable(payload)}, ensure_ascii=False, indent=2))


def to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [to_jsonable(item) for item in value]
    return value


def require_acp() -> None:
    if acp is None:
        print("Missing dependency: agent-client-protocol", file=sys.stderr)
        print(
            "Run with: uv run --with agent-client-protocol python .\\demo\\acp-demo\\python_sdk_acp_probe.py",
            file=sys.stderr,
        )
        raise SystemExit(2)


def split_command_line(command_line: str) -> list[str]:
    return shlex.split(command_line, posix=os.name != "nt")


def resolve_executable(command: str) -> str:
    path = Path(command)
    if path.is_absolute() or len(path.parts) > 1:
        return str(path)

    candidates = [command]
    if os.name == "nt" and not Path(command).suffix:
        candidates = [f"{command}.cmd", f"{command}.exe", f"{command}.bat", command]

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return command


def default_codex_acp_command() -> list[str]:
    return [resolve_executable("npx"), "-y", "@agentclientprotocol/codex-acp"]


def default_mock_command() -> list[str]:
    return [sys.executable, str(Path(__file__).resolve()), "--mock-agent-server"]


class MockSdkAgent:
    def __init__(self) -> None:
        self.client: Any | None = None
        self.session_id = "sdk-mock-session-001"

    def on_connect(self, conn: Any) -> None:
        self.client = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: Any | None = None,
        client_info: Any | None = None,
        **_: Any,
    ) -> Any:
        return acp_schema.InitializeResponse(
            protocol_version=protocol_version,
            agent_info=acp_schema.Implementation(
                name="code-lite-sdk-mock-agent",
                title="code-lite SDK Mock Agent",
                version="0.1.0",
            ),
            agent_capabilities=acp_schema.AgentCapabilities(
                auth=acp_schema.AgentAuthCapabilities(),
                load_session=False,
                prompt_capabilities=acp_schema.PromptCapabilities(embedded_context=True),
                session_capabilities=acp_schema.SessionCapabilities(
                    close=acp_schema.SessionCloseCapabilities(),
                ),
            ),
            auth_methods=[],
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **_: Any,
    ) -> Any:
        return acp_schema.NewSessionResponse(
            session_id=self.session_id,
            modes=acp_schema.SessionModeState(
                current_mode_id="read-only",
                available_modes=[
                    acp_schema.SessionMode(id="read-only", name="Read only"),
                    acp_schema.SessionMode(id="agent", name="Agent"),
                ],
            ),
            config_options=[
                acp_schema.SessionConfigOptionBoolean(
                    id="mock-safe-mode",
                    name="Mock safe mode",
                    current_value=True,
                    type="boolean",
                )
            ],
        )

    async def prompt(
        self,
        prompt: list[Any],
        session_id: str,
        message_id: str | None = None,
        **_: Any,
    ) -> Any:
        if self.client is None:
            raise RuntimeError("mock agent client connection is not ready")

        prompt_text = "\n".join(str(getattr(block, "text", "")) for block in prompt).strip()
        tool_call = acp_schema.ToolCallUpdate(
            tool_call_id="sdk-mock-tool-1",
            title="模拟需要审批的文件修改",
            kind="edit",
            status="pending",
            raw_input={"path": "README.md", "note": "mock 不会写入文件"},
        )

        await self.client.session_update(
            session_id=session_id,
            update=acp.update_agent_message_text(f"SDK mock 收到：{prompt_text}\n"),
        )
        await self.client.session_update(
            session_id=session_id,
            update=acp.start_tool_call(
                "sdk-mock-tool-1",
                "模拟需要审批的文件修改",
                kind="edit",
                status="pending",
                raw_input={"path": "README.md", "note": "mock 不会写入文件"},
            ),
        )
        permission = await self.client.request_permission(
            session_id=session_id,
            tool_call=tool_call,
            options=[
                acp_schema.PermissionOption(
                    option_id="allow-once",
                    name="Allow once",
                    kind="allow_once",
                ),
                acp_schema.PermissionOption(
                    option_id="reject-once",
                    name="Reject once",
                    kind="reject_once",
                ),
            ],
        )
        selected = getattr(getattr(permission, "outcome", None), "option_id", None)

        if selected == "allow-once":
            await self.client.session_update(
                session_id=session_id,
                update=acp.update_tool_call(
                    "sdk-mock-tool-1",
                    status="completed",
                    raw_output={"written": False, "reason": "mock only"},
                ),
            )
            final_text = "审批通过。mock agent 只返回事件，不写入文件。"
        else:
            await self.client.session_update(
                session_id=session_id,
                update=acp.update_tool_call(
                    "sdk-mock-tool-1",
                    status="failed",
                    raw_output={"reason": "approval rejected"},
                ),
            )
            final_text = "审批拒绝。mock agent 已停止模拟工具执行。"

        await self.client.session_update(
            session_id=session_id,
            update=acp_schema.UsageUpdate(session_update="usage_update", used=512, size=8192),
        )
        await self.client.session_update(
            session_id=session_id,
            update=acp_schema.SessionInfoUpdate(
                session_update="session_info_update",
                title="SDK mock session",
            ),
        )
        await self.client.session_update(
            session_id=session_id,
            update=acp.update_agent_message_text(final_text),
        )
        return acp_schema.PromptResponse(stop_reason="end_turn")

    async def close_session(self, session_id: str, **_: Any) -> Any:
        return acp_schema.CloseSessionResponse()


async def run_mock_agent_server() -> int:
    require_acp()
    reader, writer = await acp.stdio_streams()
    conn = AgentSideConnection(MockSdkAgent(), writer, reader, listening=False, use_unstable_protocol=True)
    await conn.listen()
    return 0


class CodeLiteProbeClient:
    def __init__(
        self,
        *,
        permission_decision: str,
        workspace: Path,
        show_wire: bool,
        show_stderr: bool,
        emit_events: bool,
    ) -> None:
        self.permission_decision = permission_decision
        self.workspace = workspace.resolve()
        self.show_wire = show_wire
        self.show_stderr = show_stderr
        self.emit_events = emit_events
        self.raw_method_counts: Counter[str] = Counter()
        self.raw_update_counts: Counter[str] = Counter()
        self.update_counts: Counter[str] = Counter()
        self.usage_updates: list[JsonObject] = []
        self.permission_requests: list[JsonObject] = []
        self.client_method_requests: list[JsonObject] = []
        self.compaction_signals: list[JsonObject] = []
        self.compact_command_available = False
        self.stderr_lines: list[str] = []

    def observe_stream(self, event: Any) -> None:
        direction = getattr(getattr(event, "direction", None), "value", str(getattr(event, "direction", "")))
        message = getattr(event, "message", {})
        method = message.get("method")
        if method:
            self.raw_method_counts[f"{direction}:{method}"] += 1
        if method == "session/update":
            update = message.get("params", {}).get("update", {})
            kind = update.get("sessionUpdate")
            if kind:
                self.raw_update_counts[str(kind)] += 1
            if kind == "available_commands_update":
                commands = update.get("availableCommands", [])
                self.compact_command_available = any(
                    isinstance(command, dict) and command.get("name") == "compact" for command in commands
                )
            elif "compact" in json.dumps(update, ensure_ascii=False).lower():
                self.compaction_signals.append({"direction": direction, "message": message})
        if self.show_wire:
            print_json(f"wire.{direction}", message)

    def emit_code_lite_event(self, payload: JsonObject) -> None:
        if self.emit_events:
            print_json("codeLiteEvent", payload)

    async def session_update(self, session_id: str, update: Any, **_: Any) -> None:
        kind = str(getattr(update, "session_update", "unknown"))
        self.update_counts[kind] += 1
        raw_update = to_jsonable(update)

        if kind == "usage_update":
            usage = {
                "used": getattr(update, "used", None),
                "size": getattr(update, "size", None),
                "cost": to_jsonable(getattr(update, "cost", None)),
            }
            self.usage_updates.append(usage)
            self.emit_code_lite_event(
                {
                    "type": "agent.usage.updated",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "context": {
                        "usedTokens": usage["used"],
                        "maxTokens": usage["size"],
                        "source": "acp.usage_update",
                    },
                    "cost": usage["cost"],
                },
            )
            return

        if kind == "agent_message_chunk":
            content = getattr(update, "content", None)
            self.emit_code_lite_event(
                {
                    "type": "agent.text.delta",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "text": getattr(content, "text", ""),
                    "messageId": getattr(update, "message_id", None),
                },
            )
            return

        if kind == "agent_thought_chunk":
            content = getattr(update, "content", None)
            self.emit_code_lite_event(
                {
                    "type": "agent.reasoning.delta",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "text": getattr(content, "text", ""),
                    "messageId": getattr(update, "message_id", None),
                },
            )
            return

        if kind == "tool_call":
            self.emit_code_lite_event(
                {
                    "type": "agent.tool.started",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "toolCallId": getattr(update, "tool_call_id", None),
                    "title": getattr(update, "title", None),
                    "kind": getattr(update, "kind", None),
                    "status": getattr(update, "status", None),
                    "details": to_jsonable(getattr(update, "raw_input", None)),
                },
            )
            return

        if kind == "tool_call_update":
            status = getattr(update, "status", None)
            event_type = {
                "completed": "agent.tool.completed",
                "failed": "agent.tool.failed",
                "in_progress": "agent.tool.delta",
                "pending": "agent.tool.delta",
            }.get(str(status), "agent.tool.delta")
            self.emit_code_lite_event(
                {
                    "type": event_type,
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "toolCallId": getattr(update, "tool_call_id", None),
                    "title": getattr(update, "title", None),
                    "status": status,
                    "details": to_jsonable(getattr(update, "raw_output", None)),
                    "content": to_jsonable(getattr(update, "content", None)),
                },
            )
            return

        if kind == "plan":
            self.emit_code_lite_event(
                {
                    "type": "agent.plan.updated",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "entries": raw_update.get("entries", []),
                },
            )
            return

        self.emit_code_lite_event(
            {
                "type": "agent.runtime.raw",
                "runtime": "acp-sdk-probe",
                "nativeSessionId": session_id,
                "runtimeRaw": raw_update,
            },
        )

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **_: Any,
    ) -> Any:
        selected = self._select_permission_option(options)
        raw_options = [to_jsonable(option) for option in options]
        raw_tool_call = to_jsonable(tool_call)
        request = {
            "sessionId": session_id,
            "toolCall": raw_tool_call,
            "options": raw_options,
            "selectedOptionId": getattr(selected, "option_id", None),
            "decision": self.permission_decision,
        }
        self.permission_requests.append(request)
        self.emit_code_lite_event(
            {
                "type": "approval.required",
                "runtime": "acp-sdk-probe",
                "nativeSessionId": session_id,
                "toolCallId": getattr(tool_call, "tool_call_id", None),
                "title": getattr(tool_call, "title", "ACP permission request"),
                "kind": getattr(tool_call, "kind", "other"),
                "details": raw_tool_call,
                "options": raw_options,
            },
        )

        if selected is None:
            self.emit_code_lite_event(
                {
                    "type": "approval.decided",
                    "runtime": "acp-sdk-probe",
                    "nativeSessionId": session_id,
                    "decision": "cancelled",
                },
            )
            return acp_schema.RequestPermissionResponse(
                outcome=acp_schema.DeniedOutcome(outcome="cancelled"),
            )

        self.emit_code_lite_event(
            {
                "type": "approval.decided",
                "runtime": "acp-sdk-probe",
                "nativeSessionId": session_id,
                "decision": getattr(selected, "option_id", None),
            },
        )
        return acp_schema.RequestPermissionResponse(
            outcome=acp_schema.AllowedOutcome(
                outcome="selected",
                option_id=getattr(selected, "option_id"),
            ),
        )

    def _select_permission_option(self, options: list[Any]) -> Any | None:
        if self.permission_decision == "cancelled":
            return None

        desired_kind = {
            "allow-once": "allow_once",
            "reject-once": "reject_once",
        }.get(self.permission_decision)
        for option in options:
            if getattr(option, "option_id", None) == self.permission_decision:
                return option
        if desired_kind:
            for option in options:
                if getattr(option, "kind", None) == desired_kind:
                    return option
        prefix = "allow" if self.permission_decision.startswith("allow") else "reject"
        for option in options:
            if str(getattr(option, "kind", "")).startswith(prefix):
                return option
        return options[0] if options else None

    async def read_text_file(
        self,
        path: str,
        session_id: str,
        limit: int | None = None,
        line: int | None = None,
        **_: Any,
    ) -> Any:
        self.client_method_requests.append({"method": "fs/read_text_file", "path": path, "sessionId": session_id})
        raise RequestError.internal_error({"details": "fs/read_text_file is disabled in this probe"})

    async def write_text_file(self, content: str, path: str, session_id: str, **_: Any) -> Any:
        self.client_method_requests.append({"method": "fs/write_text_file", "path": path, "sessionId": session_id})
        raise RequestError.internal_error({"details": "fs/write_text_file is disabled in this probe"})

    async def create_terminal(
        self,
        command: str,
        session_id: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: list[Any] | None = None,
        output_byte_limit: int | None = None,
        **_: Any,
    ) -> Any:
        self.client_method_requests.append(
            {
                "method": "terminal/create",
                "command": command,
                "args": args,
                "cwd": cwd,
                "sessionId": session_id,
            }
        )
        raise RequestError.internal_error({"details": "terminal/create is disabled in this probe"})

    async def terminal_output(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        self.client_method_requests.append(
            {"method": "terminal/output", "terminalId": terminal_id, "sessionId": session_id}
        )
        raise RequestError.internal_error({"details": "terminal/output is disabled in this probe"})

    async def release_terminal(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        self.client_method_requests.append(
            {"method": "terminal/release", "terminalId": terminal_id, "sessionId": session_id}
        )
        return None

    async def wait_for_terminal_exit(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        self.client_method_requests.append(
            {"method": "terminal/wait_for_exit", "terminalId": terminal_id, "sessionId": session_id}
        )
        raise RequestError.internal_error({"details": "terminal/wait_for_exit is disabled in this probe"})

    async def kill_terminal(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        self.client_method_requests.append(
            {"method": "terminal/kill", "terminalId": terminal_id, "sessionId": session_id}
        )
        return None


async def drain_stderr(process: Any, probe_client: CodeLiteProbeClient) -> None:
    stderr = getattr(process, "stderr", None)
    if stderr is None:
        return
    while True:
        line = await stderr.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").rstrip()
        if not text:
            continue
        probe_client.stderr_lines.append(text)
        if probe_client.show_stderr:
            print_json("agentStderr", text)


def build_codex_env(args: argparse.Namespace, temp_root: Path) -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("NO_BROWSER", "1")
    env.setdefault("INITIAL_AGENT_MODE", args.initial_agent_mode)
    env.setdefault("APP_SERVER_LOGS", str(temp_root / "codex-acp-logs"))

    if args.isolated_codex_home:
        codex_home = temp_root / "codex-home"
        codex_home.mkdir(parents=True, exist_ok=True)
        env["CODEX_HOME"] = str(codex_home)

    if args.codex_path:
        env["CODEX_PATH"] = str(Path(args.codex_path).resolve())

    if args.codex_config:
        env["CODEX_CONFIG"] = args.codex_config

    return env


def summarize_initialize(result: Any) -> JsonObject:
    raw = to_jsonable(result)
    return {
        "protocolVersion": raw.get("protocolVersion"),
        "agentInfo": raw.get("agentInfo"),
        "agentCapabilities": raw.get("agentCapabilities"),
        "authMethods": raw.get("authMethods", []),
    }


def summarize_session(result: Any) -> JsonObject:
    raw = to_jsonable(result)
    config_options = raw.get("configOptions") or []
    modes = raw.get("modes") or {}
    available_modes = modes.get("availableModes") or []
    models = raw.get("models") or {}
    available_models = models.get("availableModels") or []
    return {
        "sessionId": raw.get("sessionId"),
        "modes": {
            "currentModeId": modes.get("currentModeId"),
            "availableModeIds": [mode.get("id") for mode in available_modes if isinstance(mode, dict)],
        }
        if modes
        else None,
        "models": {
            "currentModelId": models.get("currentModelId"),
            "availableModelCount": len(available_models),
            "availableModelIdsSample": [
                model.get("modelId") for model in available_models[:8] if isinstance(model, dict)
            ],
        }
        if models
        else None,
        "configOptionIds": [option.get("id") for option in config_options if isinstance(option, dict)],
        "configOptionsCount": len(config_options),
    }


async def run_probe(args: argparse.Namespace) -> int:
    require_acp()

    if args.agent == "codex" and args.prompt and not args.allow_real_turn:
        print("Refusing to send a real Codex prompt without --allow-real-turn.", file=sys.stderr)
        return 2

    temp_workspace_manager: tempfile.TemporaryDirectory[str] | None = None
    if args.temp_workspace:
        temp_workspace_manager = tempfile.TemporaryDirectory(prefix="code-lite-acp-sdk-workspace-")
        workspace = Path(temp_workspace_manager.name)
    else:
        workspace = Path(args.workspace)
    workspace = workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)

    command = build_agent_command(args)
    print_json("agentCommand", command)
    print_json("workspace", str(workspace))

    with tempfile.TemporaryDirectory(prefix="code-lite-acp-sdk-") as temp_dir:
        temp_root = Path(temp_dir)
        env = build_codex_env(args, temp_root) if args.agent == "codex" else dict(os.environ)
        print_json(
            "runtimeEnvSummary",
            {
                "NO_BROWSER": env.get("NO_BROWSER", "<unset>"),
                "INITIAL_AGENT_MODE": env.get("INITIAL_AGENT_MODE", "<unset>"),
                "APP_SERVER_LOGS": env.get("APP_SERVER_LOGS", "<unset>"),
                "CODEX_HOME": env.get("CODEX_HOME", "<user default>"),
                "CODEX_PATH": env.get("CODEX_PATH", "<package default>"),
                "CODEX_CONFIG": "<set>" if env.get("CODEX_CONFIG") else "<unset>",
            },
        )

        probe_client = CodeLiteProbeClient(
            permission_decision=args.permission_decision,
            workspace=workspace,
            show_wire=args.show_wire,
            show_stderr=args.show_stderr,
            emit_events=not args.summary_only,
        )
        client_capabilities = acp_schema.ClientCapabilities(
            fs=acp_schema.FileSystemCapabilities(read_text_file=False, write_text_file=False),
            terminal=False,
        )
        client_info = acp_schema.Implementation(
            name="code-lite-python-sdk-acp-probe",
            title="code-lite Python SDK ACP Probe",
            version="0.1.0",
        )

        initialize_result = None
        session_result = None
        prompt_result = None
        process_returncode = None
        stderr_task: asyncio.Task[None] | None = None
        try:
            async with acp.spawn_agent_process(
                probe_client,
                command[0],
                *command[1:],
                env=env,
                cwd=str(workspace),
                observers=[probe_client.observe_stream],
                use_unstable_protocol=True,
            ) as (conn, process):
                stderr_task = asyncio.create_task(drain_stderr(process, probe_client))
                initialize_result = await asyncio.wait_for(
                    conn.initialize(
                        protocol_version=acp.PROTOCOL_VERSION,
                        client_capabilities=client_capabilities,
                        client_info=client_info,
                    ),
                    timeout=args.timeout,
                )
                print_json("initializeResult", initialize_result)

                session_result = await asyncio.wait_for(
                    conn.new_session(cwd=str(workspace), mcp_servers=[]),
                    timeout=args.timeout,
                )
                print_json("sessionNewResult", session_result)

                if args.prompt:
                    prompt_result = await asyncio.wait_for(
                        conn.prompt(
                            session_id=session_result.session_id,
                            prompt=[acp.text_block(args.prompt)],
                        ),
                        timeout=args.prompt_timeout,
                    )
                    print_json("promptResult", prompt_result)

                with suppress(Exception):
                    await asyncio.wait_for(conn.close_session(session_result.session_id), timeout=5)
                process_returncode = process.returncode
        finally:
            if stderr_task is not None:
                stderr_task.cancel()
                with suppress(asyncio.CancelledError):
                    await stderr_task

        probe_file = workspace / args.probe_file
        summary = {
            "agent": args.agent,
            "initialize": summarize_initialize(initialize_result) if initialize_result is not None else None,
            "session": summarize_session(session_result) if session_result is not None else None,
            "promptResult": to_jsonable(prompt_result),
            "observed": {
                "rawMethodCounts": dict(sorted(probe_client.raw_method_counts.items())),
                "rawUpdateCounts": dict(sorted(probe_client.raw_update_counts.items())),
                "updateCounts": dict(sorted(probe_client.update_counts.items())),
                "usageUpdates": probe_client.usage_updates,
                "latestUsage": probe_client.usage_updates[-1] if probe_client.usage_updates else None,
                "permissionRequests": probe_client.permission_requests,
                "clientMethodRequests": probe_client.client_method_requests,
                "compactCommandAvailable": probe_client.compact_command_available,
                "compactionSignals": probe_client.compaction_signals,
                "stderrLineCount": len(probe_client.stderr_lines),
                "stderrTail": probe_client.stderr_lines[-5:],
            },
            "findings": {
                "contextUsage": "observed" if probe_client.usage_updates else "not_observed",
                "approval": "observed" if probe_client.permission_requests else "not_observed",
                "compaction": "observed" if probe_client.compaction_signals else "not_observed",
                "compactCommand": "observed" if probe_client.compact_command_available else "not_observed",
                "standardCompactionField": "not_present_in_acp_sdk_schema",
            },
            "safety": {
                "workspace": str(workspace),
                "tempWorkspace": bool(args.temp_workspace),
                "probeFile": str(probe_file),
                "probeFileExists": probe_file.exists(),
                "processReturnCodeBeforeCleanup": process_returncode,
            },
        }
        print_json("probeSummary", summary)

    if temp_workspace_manager is not None:
        temp_workspace_manager.cleanup()
    return 0


def build_agent_command(args: argparse.Namespace) -> list[str]:
    if args.agent_command:
        command = split_command_line(args.agent_command)
    elif args.agent == "mock":
        command = default_mock_command()
    else:
        command = default_codex_acp_command()
    return [resolve_executable(command[0]), *command[1:]]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe ACP agents with the official Python SDK")
    parser.add_argument("--mock-agent-server", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--agent", choices=["mock", "codex"], default="mock")
    parser.add_argument("--agent-command", default=None, help="Override ACP agent command line")
    parser.add_argument("--workspace", default=".", help="Workspace cwd passed to session/new")
    parser.add_argument("--temp-workspace", action="store_true", help="Run the probe in a temporary workspace")
    parser.add_argument("--probe-file", default="code_lite_acp_permission_probe.txt")
    parser.add_argument("--prompt", default="请用一句话回复，并演示 ACP usage 与审批事件。")
    parser.add_argument("--allow-real-turn", action="store_true", help="Required when --agent codex sends a prompt")
    parser.add_argument(
        "--permission-decision",
        choices=["allow-once", "reject-once", "cancelled"],
        default="reject-once",
    )
    parser.add_argument(
        "--initial-agent-mode",
        choices=["read-only", "agent", "agent-full-access"],
        default="read-only",
    )
    parser.add_argument("--isolated-codex-home", action="store_true")
    parser.add_argument("--codex-path", default=None)
    parser.add_argument("--codex-config", default=None)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--prompt-timeout", type=float, default=180)
    parser.add_argument("--show-wire", action="store_true")
    parser.add_argument("--show-stderr", action="store_true")
    parser.add_argument("--summary-only", action="store_true", help="Suppress mapped code-lite event output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.mock_agent_server:
        return asyncio.run(run_mock_agent_server())
    return asyncio.run(run_probe(args))


if __name__ == "__main__":
    raise SystemExit(main())
