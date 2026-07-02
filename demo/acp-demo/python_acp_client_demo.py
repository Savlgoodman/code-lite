from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable


JsonObject = dict[str, Any]
RequestHandler = Callable[[JsonObject], Awaitable[JsonObject]]
NotificationHandler = Callable[[JsonObject], Awaitable[None]]


def json_line(message: JsonObject) -> bytes:
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def request_message(message_id: int, method: str, params: JsonObject | None = None) -> JsonObject:
    message: JsonObject = {"jsonrpc": "2.0", "id": message_id, "method": method}
    if params is not None:
        message["params"] = params
    return message


def response_message(message_id: int, result: JsonObject | None = None) -> JsonObject:
    return {"jsonrpc": "2.0", "id": message_id, "result": result or {}}


def notification_message(method: str, params: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "method": method, "params": params}


def error_response(message_id: int, code: int, message: str) -> JsonObject:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


async def read_stdin_json() -> JsonObject | None:
    line = await asyncio.to_thread(sys.stdin.buffer.readline)
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


def write_stdout_json(message: JsonObject) -> None:
    sys.stdout.buffer.write(json_line(message))
    sys.stdout.buffer.flush()


def acp_update(session_id: str, update: JsonObject) -> JsonObject:
    return notification_message("session/update", {"sessionId": session_id, "update": update})


async def run_mock_acp_server() -> int:
    session_id = "mock-session-001"
    permission_request_id = 9001

    while True:
        message = await read_stdin_json()
        if message is None:
            return 0

        method = message.get("method")
        message_id = int(message.get("id", 0))

        if method == "initialize":
            write_stdout_json(
                response_message(
                    message_id,
                    {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": False,
                            "promptCapabilities": {"image": False, "embeddedContext": True},
                            "sessionCapabilities": {"close": {}},
                        },
                        "agentInfo": {
                            "name": "mock-python-acp-agent",
                            "title": "Mock Python ACP Agent",
                            "version": "0.1.0",
                        },
                        "authMethods": [],
                    },
                )
            )
            continue

        if method == "session/new":
            write_stdout_json(
                response_message(
                    message_id,
                    {
                        "sessionId": session_id,
                        "modes": {
                            "currentModeId": "read-only",
                            "availableModes": [
                                {"id": "read-only", "name": "Read only"},
                                {"id": "agent", "name": "Agent"},
                            ],
                        },
                        "configOptions": [],
                    },
                )
            )
            continue

        if method == "session/prompt":
            prompt = extract_prompt_text(message.get("params", {}).get("prompt", []))
            write_stdout_json(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg-1",
                        "content": {"type": "text", "text": f"Python ACP client 收到：{prompt}\n"},
                    },
                )
            )
            write_stdout_json(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tool-1",
                        "title": "模拟文件修改",
                        "kind": "edit",
                        "status": "pending",
                        "rawInput": {"path": "README.md", "note": "demo 不会写文件"},
                    },
                )
            )
            write_stdout_json(
                request_message(
                    permission_request_id,
                    "session/request_permission",
                    {
                        "sessionId": session_id,
                        "toolCall": {
                            "toolCallId": "tool-1",
                            "title": "模拟文件修改",
                            "kind": "edit",
                            "rawInput": {"path": "README.md", "note": "demo 不会写文件"},
                        },
                        "options": [
                            {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                            {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
                        ],
                    },
                )
            )

            permission_response = await read_stdin_json()
            selected = (
                permission_response
                and permission_response.get("result", {}).get("outcome", {}).get("optionId")
            )
            if selected == "allow-once":
                write_stdout_json(
                    acp_update(
                        session_id,
                        {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "tool-1",
                            "status": "completed",
                            "rawOutput": {"written": False, "reason": "mock only"},
                        },
                    )
                )
                final_text = "审批通过。mock server 只返回事件，没有写入文件。"
            else:
                write_stdout_json(
                    acp_update(
                        session_id,
                        {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "tool-1",
                            "status": "failed",
                            "rawOutput": {"reason": "approval rejected"},
                        },
                    )
                )
                final_text = "审批拒绝。mock server 已停止模拟工具执行。"

            write_stdout_json(
                acp_update(
                    session_id,
                    {"sessionUpdate": "usage_update", "used": 256, "size": 8192},
                )
            )
            write_stdout_json(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg-2",
                        "content": {"type": "text", "text": final_text},
                    },
                )
            )
            write_stdout_json(response_message(message_id, {"stopReason": "end_turn"}))
            continue

        if method == "session/cancel":
            write_stdout_json(response_message(message_id, {"ok": True}))
            continue

        if method == "session/close":
            write_stdout_json(response_message(message_id, {"ok": True}))
            return 0

        write_stdout_json(error_response(message_id, -32601, f"unsupported method: {method}"))


def extract_prompt_text(blocks: Any) -> str:
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(parts).strip()


class JsonRpcStdioClient:
    def __init__(
        self,
        command: list[str],
        *,
        show_wire: bool = False,
        request_handler: RequestHandler | None = None,
        notification_handler: NotificationHandler | None = None,
    ) -> None:
        self.command = command
        self.show_wire = show_wire
        self.request_handler = request_handler
        self.notification_handler = notification_handler
        self.next_id = 1
        self.pending: dict[int, asyncio.Future[JsonObject]] = {}
        self.process: asyncio.subprocess.Process | None = None
        self.reader_task: asyncio.Task[None] | None = None
        self.stderr_task: asyncio.Task[None] | None = None

    async def __aenter__(self) -> JsonRpcStdioClient:
        await self.start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.reader_task = asyncio.create_task(self._read_stdout())
        self.stderr_task = asyncio.create_task(self._read_stderr())

    async def close(self) -> None:
        if self.process is None:
            return
        if self.process.returncode is None:
            try:
                await self.request("session/close", {"sessionId": "mock-session-001"}, timeout=2)
            except Exception:
                pass
        if self.process.stdin is not None and not self.process.stdin.is_closing():
            self.process.stdin.close()
            try:
                await self.process.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except asyncio.TimeoutError:
            self.process.kill()
            await self.process.wait()

    async def request(self, method: str, params: JsonObject | None = None, *, timeout: float = 10) -> JsonObject:
        message_id = self.next_id
        self.next_id += 1
        future: asyncio.Future[JsonObject] = asyncio.get_running_loop().create_future()
        self.pending[message_id] = future
        await self._send(request_message(message_id, method, params))
        response = await asyncio.wait_for(future, timeout=timeout)
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"], ensure_ascii=False))
        return response.get("result", {})

    async def _send(self, message: JsonObject) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("ACP process is not running")
        if self.show_wire:
            print_json("wire.client_to_agent", message)
        self.process.stdin.write(json_line(message))
        await self.process.stdin.drain()

    async def _read_stdout(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        while True:
            line = await self.process.stdout.readline()
            if not line:
                return
            message = json.loads(line.decode("utf-8"))
            if self.show_wire:
                print_json("wire.agent_to_client", message)

            if "id" in message and ("result" in message or "error" in message) and "method" not in message:
                future = self.pending.pop(int(message["id"]), None)
                if future is not None and not future.done():
                    future.set_result(message)
                continue

            if "id" in message and "method" in message:
                await self._handle_request(message)
                continue

            if "method" in message and self.notification_handler is not None:
                await self.notification_handler(message)

    async def _read_stderr(self) -> None:
        if self.process is None or self.process.stderr is None:
            return
        while True:
            line = await self.process.stderr.readline()
            if not line:
                return
            print_json("agentStderr", line.decode("utf-8", errors="replace").rstrip())

    async def _handle_request(self, message: JsonObject) -> None:
        message_id = int(message["id"])
        if self.request_handler is None:
            await self._send(error_response(message_id, -32601, "client request handler not configured"))
            return
        try:
            result = await self.request_handler(message)
            await self._send(response_message(message_id, result))
        except Exception as exc:
            await self._send(error_response(message_id, -32000, f"{type(exc).__name__}: {exc}"))


class CodeLiteAcpDemo:
    def __init__(self, *, decision: str, show_wire: bool) -> None:
        self.conversation_id = f"conv_{uuid.uuid4().hex[:8]}"
        self.turn_id = f"turn_{uuid.uuid4().hex[:8]}"
        self.decision = decision
        self.show_wire = show_wire
        self.session_id = ""
        self.usage: JsonObject | None = None

    async def run(self, prompt: str) -> None:
        command = [sys.executable, str(Path(__file__).resolve()), "--mock-server"]
        async with JsonRpcStdioClient(
            command,
            show_wire=self.show_wire,
            request_handler=self.handle_agent_request,
            notification_handler=self.handle_notification,
        ) as client:
            print_json("demo", {"message": "Python JSON-RPC stdio client started", "command": command})
            initialize = await client.request(
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": True, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {"name": "code-lite-python-acp-demo", "version": "0.1.0"},
                },
            )
            print_json("initializeResult", initialize)

            session = await client.request("session/new", {"cwd": str(Path.cwd()), "mcpServers": []})
            self.session_id = str(session["sessionId"])
            print_json("sessionNewResult", session)
            print_json(
                "codeLiteEvent",
                {"type": "agent.run.started", "conversationId": self.conversation_id, "turnId": self.turn_id},
            )
            prompt_result = await client.request(
                "session/prompt",
                {
                    "sessionId": self.session_id,
                    "prompt": [{"type": "text", "text": prompt}],
                },
            )
            print_json("promptResult", prompt_result)
            print_json(
                "codeLiteEvent",
                {
                    "type": "agent.text.completed",
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                },
            )
            print_json(
                "codeLiteEvent",
                {
                    "type": "agent.run.completed",
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                    "result": prompt_result,
                    "usage": self.usage,
                },
            )

    async def handle_agent_request(self, message: JsonObject) -> JsonObject:
        method = message.get("method")
        if method != "session/request_permission":
            raise RuntimeError(f"unsupported agent request: {method}")

        params = message.get("params", {})
        tool_call = params.get("toolCall", {})
        approval_id = f"approval-{message['id']}"
        print_json(
            "codeLiteEvent",
            {
                "type": "approval.required",
                "conversationId": self.conversation_id,
                "turnId": self.turn_id,
                "approvalId": approval_id,
                "toolCallId": tool_call.get("toolCallId"),
                "name": tool_call.get("title", "ACP permission request"),
                "arguments": tool_call.get("rawInput", {}),
                "argumentsText": json.dumps(tool_call.get("rawInput", {}), ensure_ascii=False),
                "risk": "medium",
                "purpose": "ACP mock server 请求执行一个模拟工具调用。",
                "impact": "demo 不会写入文件，只验证审批回路。",
                "risks": ["真实 runtime 中类似请求可能代表文件修改或命令执行。"],
                "rollback": "本 demo 无需回滚。",
            },
        )
        print_json(
            "codeLiteEvent",
            {
                "type": "approval.decided",
                "conversationId": self.conversation_id,
                "turnId": self.turn_id,
                "approvalId": approval_id,
                "decision": self.decision,
            },
        )
        return {"outcome": {"outcome": "selected", "optionId": self.decision}}

    async def handle_notification(self, message: JsonObject) -> None:
        if message.get("method") != "session/update":
            print_json("unhandledNotification", message)
            return

        params = message.get("params", {})
        update = params.get("update", {})
        kind = update.get("sessionUpdate")

        if kind == "agent_message_chunk":
            content = update.get("content", {})
            print_json(
                "codeLiteEvent",
                {
                    "type": "agent.text.delta",
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                    "delta": content.get("text", ""),
                },
            )
            return

        if kind == "tool_call":
            print_json(
                "codeLiteEvent",
                {
                    "type": "agent.tool.started",
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                    "toolCallId": update.get("toolCallId"),
                    "name": update.get("title", update.get("kind", "tool")),
                    "arguments": update.get("rawInput", {}),
                    "risk": "medium",
                },
            )
            return

        if kind == "tool_call_update":
            status = update.get("status")
            event_type = "agent.tool.completed" if status == "completed" else "agent.tool.failed"
            print_json(
                "codeLiteEvent",
                {
                    "type": event_type,
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                    "toolCallId": update.get("toolCallId"),
                    "name": "模拟文件修改",
                    "result": update.get("rawOutput", {}),
                },
            )
            return

        if kind == "usage_update":
            self.usage = {
                "promptTokens": update.get("used"),
                "completionTokens": 0,
                "totalTokens": update.get("used"),
                "contextWindowTokens": update.get("size"),
            }
            print_json(
                "codeLiteEvent",
                {
                    "type": "agent.runtime.raw",
                    "conversationId": self.conversation_id,
                    "turnId": self.turn_id,
                    "runtimeRaw": update,
                },
            )
            return

        print_json("unhandledSessionUpdate", update)


def print_json(label: str, payload: Any) -> None:
    print(json.dumps({label: payload}, ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Python ACP client demo for code-lite")
    parser.add_argument("--mock-server", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--prompt", default="请演示 Python 作为 ACP client 的完整流程")
    parser.add_argument("--decision", choices=["allow-once", "reject-once"], default="allow-once")
    parser.add_argument("--show-wire", action="store_true", help="Print raw JSON-RPC wire messages")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.mock_server:
        return asyncio.run(run_mock_acp_server())
    demo = CodeLiteAcpDemo(decision=args.decision, show_wire=args.show_wire)
    asyncio.run(demo.run(args.prompt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
