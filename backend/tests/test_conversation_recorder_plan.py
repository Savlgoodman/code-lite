from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.conversation_recorder import _merge_plan_snapshot


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


if __name__ == "__main__":
    unittest.main()
