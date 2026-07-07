from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.conversation_recorder import _merge_plan_snapshot
from code_lite_backend.storage.conversations import ConversationStore
from code_lite_backend.services.conversation_recorder import ConversationRecorder


def acp_plan(*contents: str) -> dict[str, object]:
    return {
        "entries": [
            {
                "content": content,
                "id": f"plan-entry-{index}",
                "status": "pending",
            }
            for index, content in enumerate(contents)
        ],
        "source": "acp.plan",
    }


class ConversationRecorderPlanTest(unittest.TestCase):
    def test_acp_plan_update_replaces_previous_snapshot(self) -> None:
        current = acp_plan("确认问题", "修改实现", "验证结果")
        next_plan = acp_plan("验证结果")

        merged = _merge_plan_snapshot(current, next_plan)

        self.assertEqual(merged, next_plan)

    def test_empty_acp_plan_clears_previous_snapshot(self) -> None:
        current = acp_plan("确认问题", "修改实现", "验证结果")
        next_plan = {"entries": [], "source": "acp.plan"}

        self.assertIsNone(_merge_plan_snapshot(current, next_plan))


class ConversationRecorderToolMetadataTest(unittest.TestCase):
    def test_tool_call_projection_keeps_event_metadata(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            recorder = ConversationRecorder(ConversationStore(Path(directory)))
            turn = recorder.start_turn(conversation_id="conv-1", prompt="edit")
            metadata = {
                "runtime": "codex",
                "rawUpdate": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-edit-1",
                    "content": [
                        {
                            "type": "diff",
                            "path": "README.md",
                            "oldText": "# Demo\n",
                            "newText": "# Demo\n\nChanged.\n",
                        }
                    ],
                },
            }

            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=str(turn.assistant_message["id"]),
                event={
                    "type": "agent.tool.completed",
                    "toolCallId": "call-edit-1",
                    "name": "Editing files",
                    "result": {"written": True},
                    "metadata": metadata,
                },
            )

            tool_call = turn.assistant_message["toolCalls"][0]
            self.assertEqual(tool_call["metadata"]["rawUpdate"]["content"][0]["type"], "diff")

    def test_tool_call_completed_keeps_started_diff_metadata(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            recorder = ConversationRecorder(ConversationStore(Path(directory)))
            turn = recorder.start_turn(conversation_id="conv-1", prompt="create file")
            diff_content = [
                {
                    "type": "diff",
                    "path": "hello_world.py",
                    "newText": "print(\"hello world\")\n",
                }
            ]

            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=str(turn.assistant_message["id"]),
                event={
                    "type": "agent.tool.started",
                    "toolCallId": "call-edit-1",
                    "name": "Editing files",
                    "arguments": None,
                    "metadata": {
                        "runtime": "codex",
                        "status": "in_progress",
                        "rawUpdate": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": "call-edit-1",
                            "status": "in_progress",
                            "content": diff_content,
                        },
                    },
                },
            )
            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=str(turn.assistant_message["id"]),
                event={
                    "type": "agent.tool.completed",
                    "toolCallId": "call-edit-1",
                    "name": "tool",
                    "result": None,
                    "metadata": {
                        "runtime": "codex",
                        "status": "completed",
                        "rawUpdate": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call-edit-1",
                            "status": "completed",
                        },
                    },
                },
            )

            tool_call = turn.assistant_message["toolCalls"][0]
            self.assertEqual(tool_call["name"], "Editing files")
            self.assertEqual(tool_call["status"], "complete")
            self.assertEqual(tool_call["metadata"]["status"], "completed")
            self.assertEqual(tool_call["metadata"]["rawUpdate"]["status"], "completed")
            self.assertEqual(tool_call["metadata"]["rawUpdate"]["content"], diff_content)


if __name__ == "__main__":
    unittest.main()
