from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.acp.client_capabilities import build_client_capabilities
from code_lite_backend.agents.acp.connection import build_code_lite_client_router
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.inputs import InputBroker


class FakeElicitationClient:
    def __init__(self) -> None:
        self.raw: dict[str, Any] | None = None
        self.completed: str | None = None

    async def create_elicitation(self, raw: dict[str, Any], **_: Any) -> dict[str, str]:
        self.raw = raw
        return {"action": "decline"}

    async def complete_elicitation(self, elicitation_id: str, **_: Any) -> None:
        self.completed = elicitation_id


class AcpElicitationTest(unittest.TestCase):
    def test_claude_declares_form_elicitation_capability(self) -> None:
        claude_caps = build_client_capabilities("claude_code").model_dump(by_alias=True, exclude_none=True)
        codex_caps = build_client_capabilities("codex").model_dump(by_alias=True, exclude_none=True)

        self.assertIn("elicitation", claude_caps)
        self.assertIn("form", claude_caps["elicitation"])
        self.assertNotIn("elicitation", codex_caps)

    def test_router_handles_unstable_elicitation_methods(self) -> None:
        async def scenario() -> None:
            client = FakeElicitationClient()
            router = build_code_lite_client_router(client, use_unstable_protocol=True)  # type: ignore[arg-type]
            payload = {
                "mode": "form",
                "message": "选择方案",
                "sessionId": "session-1",
                "requestedSchema": {"type": "object", "properties": {}},
            }

            result = await router("elicitation/create", payload, False)
            await router("elicitation/complete", {"elicitationId": "input-1"}, True)

            self.assertEqual(result, {"action": "decline"})
            self.assertEqual(client.raw, payload)
            self.assertEqual(client.completed, "input-1")

        asyncio.run(scenario())

    def test_client_handler_waits_for_input_response(self) -> None:
        async def scenario() -> None:
            output_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            inputs = InputBroker()
            handler = AcpClientHandler(
                runtime="claude_code",
                conversation_id="conv-1",
                turn_id="turn-1",
                output_queue=output_queue,
                approvals=ApprovalBroker(),
                inputs=inputs,
            )

            task = asyncio.create_task(
                handler.create_elicitation({
                    "mode": "form",
                    "message": "请选择实现方案",
                    "sessionId": "session-1",
                    "toolCallId": "tool-1",
                    "requestedSchema": {
                        "type": "object",
                        "properties": {
                            "question_0": {
                                "type": "string",
                                "oneOf": [{"const": "A", "title": "方案 A"}],
                            }
                        },
                    },
                })
            )
            event = await asyncio.wait_for(output_queue.get(), timeout=1)
            self.assertEqual(event["type"], "agent.input.required")
            self.assertEqual(event["conversationId"], "conv-1")
            self.assertEqual(event["message"], "请选择实现方案")
            self.assertEqual(event["toolCallId"], "tool-1")

            pending = await inputs.resolve(
                event["inputRequestId"],
                action="accept",
                content={"question_0": "A"},
            )
            self.assertIsNotNone(pending)
            result = await asyncio.wait_for(task, timeout=1)

            self.assertEqual(result.action, "accept")
            self.assertEqual(result.content, {"question_0": "A"})

        asyncio.run(scenario())

    def test_client_handler_accepts_nested_form_mode_payload(self) -> None:
        async def scenario() -> None:
            output_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            inputs = InputBroker()
            handler = AcpClientHandler(
                runtime="claude_code",
                conversation_id="conv-1",
                turn_id="turn-1",
                output_queue=output_queue,
                approvals=ApprovalBroker(),
                inputs=inputs,
            )

            task = asyncio.create_task(
                handler.create_elicitation({
                    "message": "请选择实现范围",
                    "mode": {
                        "sessionId": "session-1",
                        "toolCallId": "tool-1",
                        "requestedSchema": {
                            "type": "object",
                            "properties": {
                                "question_0": {
                                    "type": "string",
                                    "oneOf": [{"const": "MVP", "title": "先做 MVP"}],
                                }
                            },
                        },
                    },
                })
            )
            event = await asyncio.wait_for(output_queue.get(), timeout=1)

            self.assertEqual(event["type"], "agent.input.required")
            self.assertEqual(event["toolCallId"], "tool-1")
            self.assertEqual(event["schema"]["properties"]["question_0"]["type"], "string")
            await inputs.resolve(event["inputRequestId"], action="decline")
            result = await asyncio.wait_for(task, timeout=1)

            self.assertEqual(result.action, "decline")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
