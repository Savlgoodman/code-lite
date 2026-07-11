from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


JsonObject = dict[str, Any]


def print_json(label: str, payload: JsonObject | list[Any] | str | None) -> None:
    print(json.dumps({label: payload}, ensure_ascii=False, indent=2))


def json_dumps_line(message: JsonObject) -> bytes:
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def make_request(message_id: int, method: str, params: JsonObject | None = None) -> JsonObject:
    request: JsonObject = {"jsonrpc": "2.0", "id": message_id, "method": method}
    if params is not None:
        request["params"] = params
    return request


def make_response(message_id: int, result: JsonObject | None) -> JsonObject:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def make_error_response(message_id: int, code: int, message: str) -> JsonObject:
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {
            "code": code,
            "message": message,
        },
    }


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
    executable = resolve_executable("npx")
    return [executable, "-y", "@agentclientprotocol/codex-acp"]


class AcpProcessClient:
    def __init__(
        self,
        *,
        command: list[str],
        env: dict[str, str],
        show_wire: bool,
        permission_decision: str,
    ) -> None:
        self.command = [resolve_executable(command[0]), *command[1:]]
        self.env = env
        self.show_wire = show_wire
        self.permission_decision = permission_decision
        self.next_id = 1
        self.pending: dict[int, asyncio.Future[JsonObject]] = {}
        self.proc: asyncio.subprocess.Process | None = None
        self.session_updates: list[JsonObject] = []

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
        )
        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())

    async def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.stdin is not None and not self.proc.stdin.is_closing():
            self.proc.stdin.close()
            try:
                await self.proc.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.proc.kill()
                await self.proc.wait()

    async def request(
        self,
        method: str,
        params: JsonObject | None = None,
        *,
        timeout: float = 30,
    ) -> JsonObject | None:
        message_id = self.next_id
        self.next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[JsonObject] = loop.create_future()
        self.pending[message_id] = future
        await self._send(make_request(message_id, method, params))
        response = await asyncio.wait_for(future, timeout=timeout)
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"], ensure_ascii=False))
        return response.get("result")

    async def _send(self, message: JsonObject) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("ACP process is not running")
        if self.show_wire:
            print_json("wire.client_to_agent", message)
        self.proc.stdin.write(json_dumps_line(message))
        await self.proc.stdin.drain()

    async def _read_stdout(self) -> None:
        if self.proc is None or self.proc.stdout is None:
            return
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                return
            try:
                message = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as error:
                print_json("invalidAgentStdout", {"error": str(error), "line": line.decode("utf-8", errors="replace")})
                continue

            if self.show_wire:
                print_json("wire.agent_to_client", message)

            if "id" in message and ("result" in message or "error" in message) and "method" not in message:
                future = self.pending.pop(int(message["id"]), None)
                if future is not None and not future.done():
                    future.set_result(message)
                continue

            method = message.get("method")
            if method == "session/update":
                self.session_updates.append(message.get("params", {}))
                for event in map_session_update(message):
                    print_json("codeLiteEvent", event)
                continue

            if method == "session/request_permission":
                await self._handle_permission_request(message)
                continue

            if "id" in message and method:
                await self._handle_agent_request(message)
                continue

            print_json("agentNotification", message)

    async def _read_stderr(self) -> None:
        if self.proc is None or self.proc.stderr is None:
            return
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                print_json("agentStderr", text)

    async def _handle_permission_request(self, message: JsonObject) -> None:
        params = message.get("params", {})
        tool_call = params.get("toolCall", {})
        request_id = int(message["id"])
        approval_id = f"acp_appr_{request_id}"
        print_json(
            "codeLiteEvent",
            {
                "type": "approval.required",
                "approvalId": approval_id,
                "runtime": "codex-acp",
                "kind": tool_call.get("kind", "other"),
                "title": tool_call.get("title", "Codex ACP permission request"),
                "details": tool_call,
                "options": params.get("options", []),
            },
        )
        await self._send(
            make_response(
                request_id,
                {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": self.permission_decision,
                    }
                },
            )
        )
        print_json(
            "codeLiteEvent",
            {
                "type": "approval.decided",
                "approvalId": approval_id,
                "decision": self.permission_decision,
                "decidedBy": "codex-acp-smoke",
            },
        )

    async def _handle_agent_request(self, message: JsonObject) -> None:
        method = str(message.get("method"))
        request_id = int(message["id"])
        if method.startswith("fs/") or method.startswith("terminal/"):
            await self._send(
                make_error_response(
                    request_id,
                    -32000,
                    f"{method} is disabled by this smoke client",
                )
            )
            return
        await self._send(make_error_response(request_id, -32601, f"unsupported client method: {method}"))


def map_session_update(message: JsonObject) -> list[JsonObject]:
    params = message.get("params", {})
    update = params.get("update", {})
    session_id = params.get("sessionId")
    update_type = update.get("sessionUpdate")

    if update_type == "agent_message_chunk":
        content = update.get("content", {})
        return [
            {
                "type": "agent.text.delta",
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "messageId": update.get("messageId"),
                "text": content.get("text", ""),
            }
        ]

    if update_type == "plan":
        return [
            {
                "type": "agent.plan.updated",
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "entries": update.get("entries", []),
            }
        ]

    if update_type == "tool_call":
        return [
            {
                "type": "agent.tool.started",
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "toolCallId": update.get("toolCallId"),
                "title": update.get("title"),
                "kind": update.get("kind"),
                "status": update.get("status"),
                "details": update.get("rawInput", {}),
            }
        ]

    if update_type == "tool_call_update":
        status = update.get("status")
        event_type = {
            "completed": "agent.tool.completed",
            "failed": "agent.tool.failed",
            "in_progress": "agent.tool.delta",
            "pending": "agent.tool.delta",
        }.get(status, "agent.tool.delta")
        events = [
            {
                "type": event_type,
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "toolCallId": update.get("toolCallId"),
                "status": status,
                "title": update.get("title"),
                "content": update.get("content", []),
                "details": update.get("rawOutput", {}),
            }
        ]
        for content in update.get("content", []):
            if content.get("type") == "diff":
                events.append(
                    {
                        "type": "agent.file_change.delta",
                        "runtime": "codex-acp",
                        "nativeSessionId": session_id,
                        "path": content.get("path"),
                        "oldText": content.get("oldText"),
                        "newText": content.get("newText"),
                    }
                )
        return events

    if update_type == "usage_update":
        return [
            {
                "type": "agent.usage.updated",
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "context": {
                    "usedTokens": update.get("used"),
                    "maxTokens": update.get("size"),
                    "source": "acp.usage_update",
                },
                "cost": update.get("cost"),
            }
        ]

    if update_type == "config_option_update":
        return [
            {
                "type": "agent.session.config.updated",
                "runtime": "codex-acp",
                "nativeSessionId": session_id,
                "configOptions": update.get("configOptions", []),
            }
        ]

    return [
        {
            "type": "agent.runtime.raw",
            "runtime": "codex-acp",
            "nativeSessionId": session_id,
            "runtimeRaw": update,
        }
    ]


def build_env(args: argparse.Namespace, temp_dir: str) -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("NO_BROWSER", "1")
    env.setdefault("INITIAL_AGENT_MODE", args.initial_agent_mode)
    env.setdefault("APP_SERVER_LOGS", str(Path(temp_dir) / "codex-acp-logs"))

    if args.isolated_codex_home:
        codex_home = Path(temp_dir) / "codex-home"
        codex_home.mkdir(parents=True, exist_ok=True)
        env["CODEX_HOME"] = str(codex_home)

    if args.codex_path:
        env["CODEX_PATH"] = str(Path(args.codex_path).resolve())

    if args.codex_config:
        env["CODEX_CONFIG"] = args.codex_config

    return env


async def run_smoke(args: argparse.Namespace) -> int:
    if args.prompt and not args.allow_real_turn:
        print("Refusing to send a real prompt without --allow-real-turn.", file=sys.stderr)
        print("Initialize/session smoke does not call the model; prompt mode may call Codex.", file=sys.stderr)
        return 2

    command = split_command_line(args.agent_command) if args.agent_command else default_codex_acp_command()
    print_json("agentCommand", command)

    with tempfile.TemporaryDirectory(prefix="code-lite-codex-acp-") as temp_dir:
        env = build_env(args, temp_dir)
        printed_env = {
            "NO_BROWSER": env.get("NO_BROWSER"),
            "INITIAL_AGENT_MODE": env.get("INITIAL_AGENT_MODE"),
            "APP_SERVER_LOGS": env.get("APP_SERVER_LOGS"),
            "CODEX_HOME": env.get("CODEX_HOME", "<user default>"),
            "CODEX_PATH": env.get("CODEX_PATH", "<package default>"),
            "CODEX_CONFIG": "<set>" if env.get("CODEX_CONFIG") else "<unset>",
        }
        print_json("runtimeEnvSummary", printed_env)

        client = AcpProcessClient(
            command=command,
            env=env,
            show_wire=args.show_wire,
            permission_decision=args.permission_decision,
        )
        await client.start()
        try:
            initialize = await client.request(
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {
                            "readTextFile": False,
                            "writeTextFile": False,
                        },
                        "terminal": False,
                    },
                    "clientInfo": {
                        "name": "code-lite-codex-acp-smoke",
                        "title": "code-lite Codex ACP Smoke",
                        "version": "0.1.0",
                    },
                },
                timeout=args.timeout,
            )
            print_json("initializeResult", initialize)

            session_id = None
            if args.session_new or args.prompt:
                session = await client.request(
                    "session/new",
                    {
                        "cwd": str(Path(args.workspace).resolve()),
                        "mcpServers": [],
                    },
                    timeout=args.timeout,
                )
                print_json("sessionNewResult", session)
                if isinstance(session, dict):
                    session_id = session.get("sessionId")

            if args.prompt:
                if not session_id:
                    raise RuntimeError("session/new did not return sessionId")
                prompt_result = await client.request(
                    "session/prompt",
                    {
                        "sessionId": session_id,
                        "prompt": [
                            {
                                "type": "text",
                                "text": args.prompt,
                            }
                        ],
                    },
                    timeout=args.prompt_timeout,
                )
                print_json("promptResult", prompt_result)

            return 0
        finally:
            await client.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke test Codex through the ACP stdio adapter")
    parser.add_argument(
        "--agent-command",
        default=None,
        help="Command line for Codex ACP server. Default: npx -y @agentclientprotocol/codex-acp",
    )
    parser.add_argument("--workspace", default=".", help="Workspace cwd passed to session/new")
    parser.add_argument("--session-new", action="store_true", help="Also call session/new after initialize")
    parser.add_argument("--prompt", default=None, help="Send a real prompt after session/new")
    parser.add_argument(
        "--allow-real-turn",
        action="store_true",
        help="Required with --prompt because it may call Codex and the model",
    )
    parser.add_argument(
        "--isolated-codex-home",
        action="store_true",
        help="Use a temporary CODEX_HOME instead of the user's default Codex home",
    )
    parser.add_argument("--codex-path", default=None, help="Optional explicit Codex executable for CODEX_PATH")
    parser.add_argument("--codex-config", default=None, help="Optional JSON string for CODEX_CONFIG")
    parser.add_argument(
        "--initial-agent-mode",
        default="read-only",
        choices=["read-only", "agent", "agent-full-access"],
        help="INITIAL_AGENT_MODE passed to codex-acp",
    )
    parser.add_argument(
        "--permission-decision",
        default="reject-once",
        choices=["allow-once", "reject-once"],
        help="Decision returned for ACP permission requests during prompt mode",
    )
    parser.add_argument("--timeout", type=float, default=45, help="Timeout for initialize/session requests")
    parser.add_argument("--prompt-timeout", type=float, default=180, help="Timeout for prompt requests")
    parser.add_argument("--show-wire", action="store_true", help="Print raw ACP JSON-RPC messages")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return asyncio.run(run_smoke(args))


if __name__ == "__main__":
    raise SystemExit(main())
