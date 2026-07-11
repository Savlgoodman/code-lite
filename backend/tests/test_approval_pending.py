from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.inputs import InputBroker


class ApprovalPendingTest(unittest.TestCase):
    def test_list_for_conversation_returns_payload(self) -> None:
        async def scenario() -> None:
            broker = ApprovalBroker()
            await broker.create(
                approval_id="approval-1",
                conversation_id="conv-1",
                turn_id="turn-1",
                payload={"type": "approval.required", "approvalId": "approval-1", "name": "execute"},
            )
            await broker.create(
                approval_id="approval-2",
                conversation_id="conv-2",
                turn_id="turn-2",
                payload={"type": "approval.required", "approvalId": "approval-2", "name": "edit"},
            )

            conv1 = broker.list_for_conversation("conv-1")
            self.assertEqual(len(conv1), 1)
            self.assertEqual(conv1[0]["approvalId"], "approval-1")
            self.assertEqual(broker.list_for_conversation("conv-2")[0]["name"], "edit")
            self.assertEqual(broker.list_for_conversation("conv-missing"), [])

        asyncio.run(scenario())

    def test_resolve_removes_from_pending_and_returns_record(self) -> None:
        async def scenario() -> None:
            broker = ApprovalBroker()
            future = await broker.create(
                approval_id="approval-1",
                conversation_id="conv-1",
                turn_id="turn-1",
                payload={"approvalId": "approval-1"},
            )
            resolved = await broker.resolve("approval-1", True)
            self.assertIsNotNone(resolved)
            self.assertEqual(resolved.conversation_id, "conv-1")
            self.assertEqual(resolved.turn_id, "turn-1")
            self.assertTrue(await future)
            # 已 pop：再次 resolve 返回 None，快照列表也清空。
            self.assertIsNone(await broker.resolve("approval-1", True))
            self.assertEqual(broker.list_for_conversation("conv-1"), [])

        asyncio.run(scenario())

    def test_reject_all_then_resolve_is_noop(self) -> None:
        async def scenario() -> None:
            broker = ApprovalBroker()
            future = await broker.create(
                approval_id="approval-1",
                conversation_id="conv-1",
                turn_id="turn-1",
                payload={"approvalId": "approval-1"},
            )
            await broker.reject_all()
            self.assertFalse(await future)
            # reject_all 后 resolve 命中 None（竞态：不再重复 set_result）。
            self.assertIsNone(await broker.resolve("approval-1", True))

        asyncio.run(scenario())

    def test_input_list_for_conversation(self) -> None:
        async def scenario() -> None:
            broker = InputBroker()
            await broker.create(
                input_id="input-1",
                conversation_id="conv-1",
                turn_id="turn-1",
                payload={"type": "agent.input.required", "inputRequestId": "input-1"},
            )
            listed = broker.list_for_conversation("conv-1")
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]["inputRequestId"], "input-1")
            resolved = await broker.resolve("input-1", action="accept", content={"k": "v"})
            self.assertIsNotNone(resolved)
            self.assertEqual(broker.list_for_conversation("conv-1"), [])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
