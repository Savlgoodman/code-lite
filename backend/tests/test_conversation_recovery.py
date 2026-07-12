from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.conversation_recorder import ConversationRecorder
from code_lite_backend.storage.conversations import ConversationStore


class IncrementalPersistenceTest(unittest.TestCase):
    def test_text_delta_flushes_partial_turn_to_disk(self) -> None:
        with TemporaryDirectory() as directory:
            store = ConversationStore(Path(directory))
            recorder = ConversationRecorder(store)
            turn = recorder.start_turn(conversation_id="conv-1", prompt="你好")
            assistant_id = str(turn.assistant_message["id"])

            # 首个 text.delta 应立即落盘（该会话尚无节流时间戳）
            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=assistant_id,
                event={"type": "agent.text.delta", "delta": "部分回答"},
            )

            # 模拟进程被硬杀：不调用 finish_turn，直接从磁盘读取
            persisted = store.get_conversation("conv-1")
            self.assertIsNotNone(persisted)
            messages = persisted["messages"]
            assistant = next(m for m in messages if m["id"] == assistant_id)
            self.assertEqual(assistant["content"], "部分回答")
            self.assertEqual(persisted["session"]["status"], "running")

    def test_discard_turn_marks_interrupted_and_persists(self) -> None:
        with TemporaryDirectory() as directory:
            store = ConversationStore(Path(directory))
            recorder = ConversationRecorder(store)
            turn = recorder.start_turn(conversation_id="conv-1", prompt="写代码")
            assistant_id = str(turn.assistant_message["id"])
            recorder.apply_agent_event(
                conversation_id="conv-1",
                assistant_message_id=assistant_id,
                event={"type": "agent.text.delta", "delta": "开始"},
            )

            recorder.discard_turn("conv-1")

            persisted = store.get_conversation("conv-1")
            assistant = next(m for m in persisted["messages"] if m["id"] == assistant_id)
            self.assertFalse(assistant.get("streaming"))
            self.assertIn("中断", assistant.get("error") or "")
            self.assertEqual(assistant["content"], "开始")
            self.assertEqual(persisted["session"]["status"], "idle")


class ReconcileInterruptedSessionsTest(unittest.TestCase):
    def test_running_session_is_reconciled_to_idle(self) -> None:
        with TemporaryDirectory() as directory:
            store = ConversationStore(Path(directory))
            store.save_session(
                "conv-1",
                {"id": "conv-1", "title": "t", "preview": "p", "status": "running", "updatedAt": 111},
            )
            store.save_messages(
                "conv-1",
                [
                    {"id": "u", "role": "user", "content": "hi", "createdAt": 1, "toolCalls": []},
                    {
                        "id": "a",
                        "role": "assistant",
                        "content": "partial",
                        "createdAt": 2,
                        "streaming": True,
                        "toolCalls": [],
                    },
                ],
            )

            repaired = store.reconcile_interrupted_sessions()

            self.assertEqual(repaired, 1)
            persisted = store.get_conversation("conv-1")
            self.assertEqual(persisted["session"]["status"], "idle")
            # 保留原 updatedAt，不顶到列表最前
            self.assertEqual(persisted["session"]["updatedAt"], 111)
            assistant = persisted["messages"][1]
            self.assertFalse(assistant.get("streaming"))
            self.assertIn("中断", assistant.get("error") or "")
            self.assertEqual(assistant["content"], "partial")

    def test_idle_session_is_untouched(self) -> None:
        with TemporaryDirectory() as directory:
            store = ConversationStore(Path(directory))
            store.save_session(
                "conv-1",
                {"id": "conv-1", "title": "t", "preview": "p", "status": "idle", "updatedAt": 222},
            )
            store.save_messages(
                "conv-1",
                [{"id": "a", "role": "assistant", "content": "done", "createdAt": 2, "toolCalls": []}],
            )

            repaired = store.reconcile_interrupted_sessions()

            self.assertEqual(repaired, 0)
            persisted = store.get_conversation("conv-1")
            self.assertEqual(persisted["session"]["status"], "idle")
            self.assertNotIn("error", persisted["messages"][0])


if __name__ == "__main__":
    unittest.main()
