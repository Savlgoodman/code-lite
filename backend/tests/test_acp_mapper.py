from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import acp
from acp import schema as acp_schema

from code_lite_backend.agents.acp.mapper import AcpEventMapper, EventContext


def text_update(text: str, *, message_id: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        session_update="agent_message_chunk",
        content={"type": "text", "text": text},
        message_id=message_id,
    )


def thought_update(text: str, *, message_id: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        session_update="agent_thought_chunk",
        content={"type": "text", "text": text},
        message_id=message_id,
    )


def tool_call_update() -> object:
    return acp.start_tool_call(
        "call-edit-1",
        "Editing files",
        kind="edit",
        status="in_progress",
        raw_input={"path": "README.md"},
        content=[
            acp_schema.FileEditToolCallContent(
                type="diff",
                path="README.md",
                oldText="# Demo\n",
                newText="# Demo\n\nChanged.\n",
            )
        ],
    )


def tool_completed_update() -> object:
    return acp.update_tool_call(
        "call-edit-1",
        status="completed",
        raw_output={"written": True},
        content=[
            acp_schema.FileEditToolCallContent(
                type="diff",
                path="README.md",
                oldText="# Demo\n",
                newText="# Demo\n\nChanged.\n",
            )
        ],
    )


class AcpEventMapperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.ctx = EventContext(
            conversation_id="conv-1",
            turn_id="turn-1",
            runtime="claude_code",
            native_session_id="native-1",
        )

    def test_strips_history_prefix_snapshot_on_new_turn(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")
        mapper.start_turn(text_baseline="old answer")

        event = mapper.map_update(text_update("old answernew answer"), self.ctx)

        self.assertIsNotNone(event)
        self.assertEqual(event["delta"], "new answer")

    def test_strips_history_replayed_as_chunks(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")
        mapper.start_turn(text_baseline="old answer")

        self.assertIsNone(
            mapper.map_update(
                text_update("old ", message_id="00000000-0000-0000-0000-000000000001"),
                self.ctx,
            )
        )
        self.assertIsNone(
            mapper.map_update(
                text_update("answer", message_id="00000000-0000-0000-0000-000000000001"),
                self.ctx,
            )
        )
        event = mapper.map_update(text_update("new answer"), self.ctx)

        self.assertIsNotNone(event)
        self.assertEqual(event["delta"], "new answer")

    def test_does_not_strip_partial_history_without_message_id(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")
        mapper.start_turn(text_baseline="old answer")

        event = mapper.map_update(text_update("old "), self.ctx)

        self.assertIsNotNone(event)
        self.assertEqual(event["delta"], "old ")

    def test_does_not_strip_short_history_without_message_id(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")
        mapper.start_turn(text_baseline="OK")

        event = mapper.map_update(text_update("OK, continuing"), self.ctx)

        self.assertIsNotNone(event)
        self.assertEqual(event["delta"], "OK, continuing")

    def test_drops_seen_native_message_id_after_new_turn(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")

        first = mapper.map_update(text_update("old answer", message_id="00000000-0000-0000-0000-000000000001"), self.ctx)
        self.assertIsNotNone(first)
        self.assertEqual(first["delta"], "old answer")

        mapper.start_turn()
        replay = mapper.map_update(
            text_update("old answer", message_id="00000000-0000-0000-0000-000000000001"),
            self.ctx,
        )

        self.assertIsNone(replay)

    def test_reasoning_uses_independent_history_baseline(self) -> None:
        mapper = AcpEventMapper(runtime="claude_code")
        mapper.start_turn(reasoning_baseline="old thought")

        event = mapper.map_update(thought_update("old thoughtnew thought"), self.ctx)

        self.assertIsNotNone(event)
        self.assertEqual(event["type"], "agent.reasoning.delta")
        self.assertEqual(event["delta"], "new thought")

    def test_tool_call_keeps_raw_update_payload(self) -> None:
        mapper = AcpEventMapper(runtime="codex")

        event = mapper.map_update(tool_call_update(), self.ctx)

        self.assertIsNotNone(event)
        metadata = event.get("metadata")
        self.assertIsInstance(metadata, dict)
        raw_update = metadata["rawUpdate"]
        self.assertEqual(raw_update["rawInput"]["path"], "README.md")
        self.assertEqual(raw_update["content"][0]["type"], "diff")

    def test_tool_completion_keeps_raw_update_payload(self) -> None:
        mapper = AcpEventMapper(runtime="codex")

        event = mapper.map_update(tool_completed_update(), self.ctx)

        self.assertIsNotNone(event)
        metadata = event.get("metadata")
        self.assertIsInstance(metadata, dict)
        raw_update = metadata["rawUpdate"]
        self.assertTrue(raw_update["rawOutput"]["written"])
        self.assertEqual(raw_update["content"][0]["newText"], "# Demo\n\nChanged.\n")


if __name__ == "__main__":
    unittest.main()
