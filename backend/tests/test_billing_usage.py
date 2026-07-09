from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.billing_usage import BillingUsageRecorder


class FakePriceStore:
    def get_prices(self) -> dict:
        return {
            "currency": "USD",
            "stale": False,
            "models": {
                "gpt-5.5": {
                    "currency": "USD",
                    "inputCostPerToken": 0.001,
                    "outputCostPerToken": 0.002,
                    "cachedReadCostPerToken": 0.0001,
                    "cachedWriteCostPerToken": 0.0005,
                    "sourceModelId": "gpt-5.5",
                }
            },
        }


def timestamp_ms(value: str) -> int:
    return int(datetime.fromisoformat(value).timestamp() * 1000)


class BillingUsageRecorderTest(unittest.IsolatedAsyncioTestCase):
    async def test_queue_writes_daily_usage_with_cost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = BillingUsageRecorder(Path(tmp) / "billing", FakePriceStore())
            await recorder.start()
            recorder.enqueue_turn_usage(
                conversation_id="conv-1",
                turn_id="turn-1",
                assistant_message_id="assistant-1",
                workspace=Path(tmp) / "workspace",
                agent_id="codex",
                agent_label="Codex",
                model_metadata={
                    "runtimeModel": "gpt-5.5[xhigh]",
                    "model": "gpt-5.5[xhigh]",
                    "label": "GPT 5.5",
                },
                usage={
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "cachedReadTokens": 20,
                    "cachedWriteTokens": 2,
                    "thoughtTokens": 3,
                    "totalTokens": 40,
                    "source": "acp.prompt_response.usage",
                },
                created_at_ms=timestamp_ms("2026-07-06T10:20:00+08:00"),
            )
            await recorder.stop()

            files = list((Path(tmp) / "billing" / "daily").glob("*.json"))
            self.assertEqual(len(files), 1)
            daily = json.loads(files[0].read_text(encoding="utf-8"))

            self.assertEqual(daily["totals"]["turns"], 1)
            self.assertEqual(daily["totals"]["totalTokens"], 40)
            self.assertAlmostEqual(daily["totals"]["estimatedCostUsd"], 0.029)
            self.assertEqual(len(daily["entries"]), 1)
            entry = daily["entries"][0]
            self.assertNotIn("content", entry)
            self.assertNotIn("prompt", entry)
            self.assertTrue(entry["workspaceKey"].startswith("sha256:"))
            self.assertEqual(entry["cost"]["priceModelId"], "gpt-5.5")

    async def test_fast_mode_keeps_tokens_and_multiplies_cost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = BillingUsageRecorder(Path(tmp) / "billing", FakePriceStore())
            await recorder.start()
            recorder.enqueue_turn_usage(
                conversation_id="conv-fast",
                turn_id="turn-fast",
                assistant_message_id="assistant-fast",
                workspace=Path(tmp) / "workspace",
                agent_id="codex",
                agent_label="Codex",
                model_metadata={
                    "runtimeModel": "gpt-5.5[xhigh]",
                    "fastMode": {
                        "enabled": True,
                        "requested": True,
                        "configApplied": True,
                        "applied": True,
                        "effective": True,
                        "speedMode": "fast",
                        "displayRate": "1.5x",
                        "runtimeConfigId": "fast-mode",
                        "runtimeValue": "on",
                        "billingMultiplier": 2,
                    },
                },
                usage={
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "cachedReadTokens": 20,
                    "cachedWriteTokens": 2,
                    "thoughtTokens": 3,
                    "totalTokens": 40,
                    "source": "acp.prompt_response.usage",
                },
                created_at_ms=timestamp_ms("2026-07-06T10:20:00+08:00"),
            )
            await recorder.stop()

            files = list((Path(tmp) / "billing" / "daily").glob("*.json"))
            daily = json.loads(files[0].read_text(encoding="utf-8"))

            self.assertEqual(daily["totals"]["totalTokens"], 40)
            self.assertAlmostEqual(daily["totals"]["estimatedCostUsd"], 0.058)
            entry = daily["entries"][0]
            self.assertEqual(entry["fastMode"]["enabled"], True)
            self.assertEqual(entry["fastMode"]["effective"], True)
            self.assertEqual(entry["fastMode"]["billingMultiplier"], 2)
            self.assertAlmostEqual(entry["cost"]["baseEstimatedCostUsd"], 0.029)
            self.assertAlmostEqual(entry["cost"]["estimatedCostUsd"], 0.058)

    async def test_fast_mode_requested_but_not_effective_uses_normal_cost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = BillingUsageRecorder(Path(tmp) / "billing", FakePriceStore())
            await recorder.start()
            recorder.enqueue_turn_usage(
                conversation_id="conv-fast-fallback",
                turn_id="turn-fast-fallback",
                assistant_message_id="assistant-fast-fallback",
                workspace=Path(tmp) / "workspace",
                agent_id="codex",
                agent_label="Codex",
                model_metadata={
                    "runtimeModel": "gpt-5.5[xhigh]",
                    "fastMode": {
                        "enabled": True,
                        "requested": True,
                        "configApplied": True,
                        "applied": False,
                        "effective": False,
                        "effectiveReason": "runtime option fast-mode is unavailable for the selected model",
                        "runtimeConfigId": "fast-mode",
                        "runtimeValue": "on",
                        "billingMultiplier": 1,
                    },
                },
                usage={
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "cachedReadTokens": 20,
                    "cachedWriteTokens": 2,
                    "thoughtTokens": 3,
                    "totalTokens": 40,
                    "source": "acp.prompt_response.usage",
                },
                created_at_ms=timestamp_ms("2026-07-06T10:20:00+08:00"),
            )
            await recorder.stop()

            files = list((Path(tmp) / "billing" / "daily").glob("*.json"))
            daily = json.loads(files[0].read_text(encoding="utf-8"))
            entry = daily["entries"][0]

            self.assertEqual(entry["fastMode"]["requested"], True)
            self.assertEqual(entry["fastMode"]["enabled"], False)
            self.assertEqual(entry["fastMode"]["effective"], False)
            self.assertEqual(entry["fastMode"]["billingMultiplier"], 1)
            self.assertAlmostEqual(entry["cost"]["baseEstimatedCostUsd"], 0.029)
            self.assertAlmostEqual(entry["cost"]["estimatedCostUsd"], 0.029)

    async def test_duplicate_turn_is_upserted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = BillingUsageRecorder(Path(tmp) / "billing", FakePriceStore())
            await recorder.start()
            for total in (10, 25):
                recorder.enqueue_turn_usage(
                    conversation_id="conv-1",
                    turn_id="turn-1",
                    assistant_message_id="assistant-1",
                    workspace=Path(tmp) / "workspace",
                    agent_id="codex",
                    agent_label="Codex",
                    model_metadata={"runtimeModel": "gpt-5.5[xhigh]"},
                    usage={
                        "inputTokens": total,
                        "outputTokens": 0,
                        "totalTokens": total,
                        "source": "acp.prompt_response.usage",
                    },
                    created_at_ms=timestamp_ms("2026-07-06T10:20:00+08:00"),
                )
            await recorder.stop()

            files = list((Path(tmp) / "billing" / "daily").glob("*.json"))
            daily = json.loads(files[0].read_text(encoding="utf-8"))

            self.assertEqual(len(daily["entries"]), 1)
            self.assertEqual(daily["totals"]["turns"], 1)
            self.assertEqual(daily["totals"]["totalTokens"], 25)
            self.assertEqual(daily["totals"]["inputTokens"], 25)

    async def test_unknown_price_counts_tokens_without_cost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = BillingUsageRecorder(Path(tmp) / "billing", FakePriceStore())
            await recorder.start()
            recorder.enqueue_turn_usage(
                conversation_id="conv-2",
                turn_id="turn-2",
                assistant_message_id="assistant-2",
                workspace=Path(tmp) / "workspace",
                agent_id="claude_code",
                agent_label="Claude Code",
                model_metadata={"runtimeModel": "unknown-model"},
                usage={
                    "inputTokens": 3,
                    "outputTokens": 4,
                    "totalTokens": 7,
                    "source": "acp.prompt_response.usage",
                },
                created_at_ms=timestamp_ms("2026-07-06T10:20:00+08:00"),
            )
            await recorder.stop()

            summary = recorder.get_range_summary("2026-07-06", "2026-07-06")
            self.assertEqual(summary["totals"]["totalTokens"], 7)
            self.assertEqual(summary["totals"]["unknownCostTurns"], 1)
            self.assertEqual(summary["totals"]["estimatedCostUsd"], 0)


if __name__ == "__main__":
    unittest.main()
