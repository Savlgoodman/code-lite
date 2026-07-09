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
    def test_config_update_runtime_event_is_compact(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            recorder = ConversationRecorder(ConversationStore(Path(directory)))
            turn = recorder.start_turn(conversation_id="conv-1", prompt="configure")

            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=str(turn.assistant_message["id"]),
                event={
                    "type": "agent.config.updated",
                    "configOptions": [
                        {
                            "id": "fast-mode",
                            "currentValue": "on",
                            "options": [
                                {
                                    "description": "Default speed, normal usage",
                                    "name": "Off",
                                    "value": "off",
                                },
                                {
                                    "description": "1.5x speed, increased usage",
                                    "name": "On",
                                    "value": "on",
                                },
                            ],
                        },
                        {
                            "id": "reasoning_effort",
                            "currentValue": "xhigh",
                        },
                    ],
                    "metadata": {
                        "runtime": "codex",
                        "rawUpdate": {
                            "sessionUpdate": "config_update",
                            "configOptions": [
                                {
                                    "id": "fast-mode",
                                    "currentValue": "on",
                                    "options": [
                                        {
                                            "description": "Default speed, normal usage",
                                            "name": "Off",
                                            "value": "off",
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            )

            runtime_event = turn.assistant_message["runtimeEvents"][0]
            self.assertNotIn("configOptions", runtime_event)
            self.assertEqual(runtime_event["configOptionIds"], ["fast-mode", "reasoning_effort"])
            self.assertEqual(runtime_event["configOptionValues"]["fast-mode"], "on")
            self.assertNotIn("rawUpdate", runtime_event["metadata"])
            self.assertEqual(runtime_event["metadata"]["rawUpdateSummary"]["configOptionIds"], ["fast-mode"])

    def test_existing_runtime_events_are_compacted_on_next_turn(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            store = ConversationStore(Path(directory))
            store.save_session(
                "conv-1",
                {
                    "id": "conv-1",
                    "title": "configure",
                    "preview": "configure",
                    "status": "idle",
                },
            )
            store.save_messages(
                "conv-1",
                [
                    {
                        "id": "assistant-old",
                        "role": "assistant",
                        "content": "",
                        "createdAt": 1,
                        "toolCalls": [],
                        "runtimeEvents": [
                            {
                                "type": "agent.config.updated",
                                "createdAt": 2,
                                "configOptions": [
                                    {
                                        "id": "fast-mode",
                                        "currentValue": "on",
                                        "options": [{"name": "On", "value": "on"}],
                                    },
                                ],
                                "metadata": {
                                    "runtime": "codex",
                                    "rawUpdate": {
                                        "configOptions": [
                                            {
                                                "id": "fast-mode",
                                                "currentValue": "on",
                                                "options": [{"name": "On", "value": "on"}],
                                            },
                                        ],
                                    },
                                },
                            },
                        ],
                    },
                ],
            )

            recorder = ConversationRecorder(store)
            turn = recorder.start_turn(conversation_id="conv-1", prompt="next")

            old_event = turn.messages[0]["runtimeEvents"][0]
            self.assertNotIn("configOptions", old_event)
            self.assertEqual(old_event["createdAt"], 2)
            self.assertEqual(old_event["configOptionIds"], ["fast-mode"])
            self.assertNotIn("rawUpdate", old_event["metadata"])

    def test_tool_call_projection_saves_diff_artifact(self) -> None:
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
            metadata = tool_call["metadata"]
            self.assertNotIn("rawUpdate", metadata)
            self.assertEqual(metadata["rawUpdateSummary"]["contentTypes"], ["diff"])
            self.assertEqual(metadata["fileDiffs"][0]["path"], "README.md")
            self.assertEqual(metadata["fileDiffs"][0]["added"], 2)
            self.assertEqual(metadata["fileDiffs"][0]["removed"], 0)

            diff_id = metadata["fileDiffs"][0]["diffId"]
            artifact = Path(directory) / "conv-1" / "diffs" / f"{diff_id}.json"
            self.assertTrue(artifact.exists())
            self.assertIn('"oldText": "# Demo\\n"', artifact.read_text(encoding="utf-8"))

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
            self.assertNotIn("rawUpdate", tool_call["metadata"])
            self.assertEqual(tool_call["metadata"]["rawUpdateSummary"]["status"], "completed")
            self.assertEqual(tool_call["metadata"]["fileDiffs"][0]["path"], diff_content[0]["path"])
            self.assertEqual(tool_call["metadata"]["fileDiffs"][0]["added"], 1)
            self.assertEqual(tool_call["metadata"]["fileDiffs"][0]["removed"], 0)

    def test_project_agent_event_for_ui_strips_raw_diff(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            recorder = ConversationRecorder(ConversationStore(Path(directory)))
            event = {
                "type": "agent.tool.started",
                "conversationId": "conv-1",
                "turnId": "turn-1",
                "toolCallId": "call-edit-1",
                "name": "Editing files",
                "metadata": {
                    "runtime": "codex",
                    "rawUpdate": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call-edit-1",
                        "content": [
                            {
                                "type": "diff",
                                "path": "hello.py",
                                "newText": "print(\"hello\")\n",
                            }
                        ],
                    },
                },
            }

            projected = recorder.project_agent_event_for_ui(
                conversation_id="conv-1",
                event=event,
            )

            metadata = projected["metadata"]
            self.assertNotIn("rawUpdate", metadata)
            self.assertEqual(metadata["fileDiffs"][0]["diffId"], "call-edit-1-0")
            self.assertEqual(metadata["fileDiffs"][0]["added"], 1)
            self.assertEqual(metadata["rawUpdateSummary"]["contentTypes"], ["diff"])
            self.assertFalse((Path(directory) / "conv-1" / "diffs" / "call-edit-1-0.json").exists())


if __name__ == "__main__":
    unittest.main()
