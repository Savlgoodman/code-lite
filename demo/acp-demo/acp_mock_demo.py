from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any


JsonObject = dict[str, Any]


def write_json_line(message: JsonObject) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    sys.stdout.buffer.write(payload.encode("utf-8"))
    sys.stdout.buffer.flush()


async def read_json_line(reader: asyncio.StreamReader) -> JsonObject | None:
    line = await reader.readline()
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


def make_request(message_id: int, method: str, params: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "id": message_id, "method": method, "params": params}


def make_response(message_id: int, result: JsonObject | None) -> JsonObject:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def make_notification(method: str, params: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "method": method, "params": params}


def acp_update(session_id: str, update: JsonObject) -> JsonObject:
    return make_notification(
        "session/update",
        {
            "sessionId": session_id,
            "update": update,
        },
    )


async def run_mock_server() -> int:
    session_id = "sess_mock_001"
    permission_request_id = 1001

    while True:
        raw_line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not raw_line:
            return 0
        message = json.loads(raw_line.decode("utf-8"))
        method = message.get("method")
        message_id = message.get("id")

        if method == "initialize":
            write_json_line(
                make_response(
                    message_id,
                    {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": False,
                            "promptCapabilities": {
                                "image": False,
                                "audio": False,
                                "embeddedContext": True,
                            },
                            "mcpCapabilities": {
                                "http": False,
                                "sse": False,
                            },
                            "sessionCapabilities": {
                                "close": {},
                            },
                        },
                        "agentInfo": {
                            "name": "code-lite-mock-acp-agent",
                            "title": "code-lite Mock ACP Agent",
                            "version": "0.1.0",
                        },
                        "authMethods": [],
                    },
                )
            )
            continue

        if method == "session/new":
            write_json_line(
                make_response(
                    message_id,
                    {
                        "sessionId": session_id,
                        "configOptions": [
                            {
                                "id": "mode",
                                "name": "Mode",
                                "category": "mode",
                                "type": "select",
                                "currentValue": "ask",
                                "options": [
                                    {
                                        "value": "ask",
                                        "name": "Ask",
                                        "description": "Request permission before simulated changes",
                                    },
                                    {
                                        "value": "readonly",
                                        "name": "Read Only",
                                        "description": "Do not simulate modifying tools",
                                    },
                                ],
                            },
                            {
                                "id": "model",
                                "name": "Model",
                                "category": "model",
                                "type": "select",
                                "currentValue": "mock-model",
                                "options": [
                                    {
                                        "value": "mock-model",
                                        "name": "Mock Model",
                                        "description": "No network or model call",
                                    }
                                ],
                            },
                        ],
                    },
                )
            )
            continue

        if method == "session/prompt":
            prompt_blocks = message.get("params", {}).get("prompt", [])
            prompt_text = " ".join(
                block.get("text", "")
                for block in prompt_blocks
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()

            write_json_line(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "plan",
                        "entries": [
                            {
                                "content": "建立 ACP 会话并模拟一次工具调用",
                                "priority": "high",
                                "status": "completed",
                            },
                            {
                                "content": "向 client 请求审批",
                                "priority": "high",
                                "status": "in_progress",
                            },
                        ],
                    },
                )
            )
            write_json_line(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg_mock_agent_001",
                        "content": {
                            "type": "text",
                            "text": f"收到 prompt：{prompt_text or '空 prompt'}。下面模拟一次需要审批的文件修改。",
                        },
                    },
                )
            )
            write_json_line(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call_mock_edit",
                        "title": "模拟修改 README.md",
                        "kind": "edit",
                        "status": "pending",
                        "rawInput": {
                            "path": str(Path.cwd() / "README.md"),
                            "description": "仅模拟 diff，不写入文件",
                        },
                    },
                )
            )
            write_json_line(
                make_request(
                    permission_request_id,
                    "session/request_permission",
                    {
                        "sessionId": session_id,
                        "toolCall": {
                            "toolCallId": "call_mock_edit",
                            "title": "模拟修改 README.md",
                            "kind": "edit",
                            "status": "pending",
                            "rawInput": {
                                "path": str(Path.cwd() / "README.md"),
                                "description": "仅模拟 diff，不写入文件",
                            },
                        },
                        "options": [
                            {
                                "optionId": "allow-once",
                                "name": "Allow once",
                                "kind": "allow_once",
                            },
                            {
                                "optionId": "reject-once",
                                "name": "Reject",
                                "kind": "reject_once",
                            },
                        ],
                    },
                )
            )

            permission_response_raw = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not permission_response_raw:
                return 0
            permission_response = json.loads(permission_response_raw.decode("utf-8"))
            outcome = permission_response.get("result", {}).get("outcome", {})
            selected = outcome.get("optionId")

            if selected == "allow-once":
                write_json_line(
                    acp_update(
                        session_id,
                        {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call_mock_edit",
                            "status": "in_progress",
                        },
                    )
                )
                write_json_line(
                    acp_update(
                        session_id,
                        {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call_mock_edit",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "diff",
                                    "path": str(Path.cwd() / "README.md"),
                                    "oldText": "# Demo\n",
                                    "newText": "# Demo\n\nACP mock change approved.\n",
                                }
                            ],
                            "rawOutput": {
                                "written": False,
                                "reason": "mock demo only",
                            },
                        },
                    )
                )
                final_text = "审批已允许。demo 只生成 diff 事件，没有写入文件。"
            else:
                write_json_line(
                    acp_update(
                        session_id,
                        {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call_mock_edit",
                            "status": "failed",
                            "content": [
                                {
                                    "type": "content",
                                    "content": {
                                        "type": "text",
                                        "text": "用户拒绝了模拟修改。",
                                    },
                                }
                            ],
                        },
                    )
                )
                final_text = "审批已拒绝。demo 停止模拟工具执行。"

            write_json_line(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "usage_update",
                        "used": 128,
                        "size": 8192,
                        "cost": {
                            "amount": 0,
                            "currency": "USD",
                        },
                    },
                )
            )
            write_json_line(
                acp_update(
                    session_id,
                    {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "msg_mock_agent_002",
                        "content": {
                            "type": "text",
                            "text": final_text,
                        },
                    },
                )
            )
            write_json_line(make_response(message_id, {"stopReason": "end_turn"}))
            continue

        if method == "session/close":
            write_json_line(make_response(message_id, {}))
            return 0

        write_json_line(
            {
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {
                    "code": -32601,
                    "message": f"unsupported method: {method}",
                },
            }
        )


class AcpMockClient:
    def __init__(self, *, show_wire: bool, decision: str) -> None:
        self.show_wire = show_wire
        self.decision = decision
        self.next_id = 1
        self.pending: dict[int, asyncio.Future[JsonObject]] = {}
        self.proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).resolve()),
            "--server",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())

    async def close(self) -> None:
        if self.proc is None:
            return
        try:
            await self.request("session/close", {"sessionId": "sess_mock_001"})
        except Exception:
            pass
        await self.proc.wait()

    async def request(self, method: str, params: JsonObject) -> JsonObject | None:
        message_id = self.next_id
        self.next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[JsonObject] = loop.create_future()
        self.pending[message_id] = future
        await self._send(make_request(message_id, method, params))
        response = await asyncio.wait_for(future, timeout=10)
        return response.get("result")

    async def _send(self, message: JsonObject) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("ACP process is not running")
        if self.show_wire:
            print_event("wire.client_to_agent", message)
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        self.proc.stdin.write(payload.encode("utf-8"))
        await self.proc.stdin.drain()

    async def _read_stdout(self) -> None:
        if self.proc is None or self.proc.stdout is None:
            return
        while True:
            message = await read_json_line(self.proc.stdout)
            if message is None:
                return
            if self.show_wire:
                print_event("wire.agent_to_client", message)
            if "id" in message and ("result" in message or "error" in message) and "method" not in message:
                future = self.pending.pop(int(message["id"]), None)
                if future is not None and not future.done():
                    future.set_result(message)
                continue
            method = message.get("method")
            if method == "session/update":
                for event in map_acp_update_to_code_lite_events(message):
                    print_event("codeLiteEvent", event)
                continue
            if method == "session/request_permission":
                await self._handle_permission_request(message)
                continue
            print_event("unhandledAgentMessage", message)

    async def _read_stderr(self) -> None:
        if self.proc is None or self.proc.stderr is None:
            return
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                return
            print_event("agentStderr", {"text": line.decode("utf-8", errors="replace").rstrip()})

    async def _handle_permission_request(self, message: JsonObject) -> None:
        params = message.get("params", {})
        tool_call = params.get("toolCall", {})
        approval_id = f"appr_{message.get('id')}"
        print_event(
            "codeLiteEvent",
            {
                "type": "approval.required",
                "approvalId": approval_id,
                "runtime": "mock-acp",
                "kind": tool_call.get("kind", "other"),
                "title": tool_call.get("title", "ACP permission request"),
                "details": tool_call,
                "options": params.get("options", []),
            },
        )
        await self._send(
            make_response(
                int(message["id"]),
                {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": self.decision,
                    }
                },
            )
        )
        print_event(
            "codeLiteEvent",
            {
                "type": "approval.decided",
                "approvalId": approval_id,
                "decision": self.decision,
                "decidedBy": "demo-client",
            },
        )


def map_acp_update_to_code_lite_events(message: JsonObject) -> list[JsonObject]:
    params = message.get("params", {})
    session_id = params.get("sessionId")
    update = params.get("update", {})
    kind = update.get("sessionUpdate")

    if kind == "plan":
        return [
            {
                "type": "agent.plan.updated",
                "runtime": "mock-acp",
                "nativeSessionId": session_id,
                "entries": update.get("entries", []),
            }
        ]

    if kind == "agent_message_chunk":
        content = update.get("content", {})
        return [
            {
                "type": "agent.text.delta",
                "runtime": "mock-acp",
                "nativeSessionId": session_id,
                "messageId": update.get("messageId"),
                "text": content.get("text", ""),
            }
        ]

    if kind == "tool_call":
        return [
            {
                "type": "agent.tool.started",
                "runtime": "mock-acp",
                "nativeSessionId": session_id,
                "toolCallId": update.get("toolCallId"),
                "title": update.get("title"),
                "kind": update.get("kind"),
                "status": update.get("status"),
                "details": update.get("rawInput", {}),
            }
        ]

    if kind == "tool_call_update":
        status = update.get("status")
        event_type = {
            "in_progress": "agent.tool.delta",
            "completed": "agent.tool.completed",
            "failed": "agent.tool.failed",
        }.get(status, "agent.tool.delta")
        events = [
            {
                "type": event_type,
                "runtime": "mock-acp",
                "nativeSessionId": session_id,
                "toolCallId": update.get("toolCallId"),
                "status": status,
                "content": update.get("content", []),
                "details": update.get("rawOutput", {}),
            }
        ]
        for content in update.get("content", []):
            if content.get("type") == "diff":
                events.append(
                    {
                        "type": "agent.file_change.delta",
                        "runtime": "mock-acp",
                        "nativeSessionId": session_id,
                        "path": content.get("path"),
                        "oldText": content.get("oldText"),
                        "newText": content.get("newText"),
                    }
                )
        return events

    if kind == "usage_update":
        return [
            {
                "type": "agent.usage.updated",
                "runtime": "mock-acp",
                "nativeSessionId": session_id,
                "context": {
                    "usedTokens": update.get("used"),
                    "maxTokens": update.get("size"),
                    "source": "acp.usage_update",
                },
                "cost": update.get("cost"),
            }
        ]

    return [
        {
            "type": "agent.runtime.raw",
            "runtime": "mock-acp",
            "nativeSessionId": session_id,
            "runtimeRaw": update,
        }
    ]


def print_event(label: str, payload: JsonObject) -> None:
    print(json.dumps({label: payload}, ensure_ascii=False, indent=2))


async def run_client(args: argparse.Namespace) -> int:
    client = AcpMockClient(show_wire=args.show_wire, decision=args.decision)
    await client.start()
    initialize = await client.request(
        "initialize",
        {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": True,
                    "writeTextFile": False,
                },
                "terminal": False,
            },
            "clientInfo": {
                "name": "code-lite-acp-demo",
                "title": "code-lite ACP Demo Client",
                "version": "0.1.0",
            },
        },
    )
    print_event("initializeResult", initialize or {})

    session = await client.request(
        "session/new",
        {
            "cwd": str(Path(args.workspace).resolve()),
            "mcpServers": [],
        },
    )
    print_event("sessionNewResult", session or {})
    session_id = (session or {}).get("sessionId", "sess_mock_001")

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
    )
    print_event("promptResult", prompt_result or {})
    await client.close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Safe ACP mock client/server demo")
    parser.add_argument("--server", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--prompt", default="请模拟一次需要审批的文件修改")
    parser.add_argument("--workspace", default=".")
    parser.add_argument(
        "--decision",
        choices=["allow-once", "reject-once"],
        default="allow-once",
        help="Permission decision returned by the mock client",
    )
    parser.add_argument("--show-wire", action="store_true", help="Print raw JSON-RPC messages")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.server:
        return asyncio.run(run_mock_server())
    return asyncio.run(run_client(args))


if __name__ == "__main__":
    raise SystemExit(main())
