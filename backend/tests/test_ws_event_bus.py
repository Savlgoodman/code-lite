from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.services.event_bus import SessionEventBus


class SessionEventBusTest(unittest.TestCase):
    def test_fanout_and_channel_isolation(self) -> None:
        async def scenario() -> None:
            bus = SessionEventBus()
            sub = bus.subscribe("conv1")
            bus.publish("conv1", {"type": "x", "n": 1})
            bus.publish("conv2", {"type": "y", "n": 99})
            bus.publish("conv1", {"type": "x", "n": 2})
            first = await sub.get()
            second = await sub.get()
            self.assertEqual(first["n"], 1)
            self.assertEqual(second["n"], 2)
            self.assertEqual(bus.subscriber_count("conv1"), 1)
            sub.close()
            self.assertEqual(bus.subscriber_count("conv1"), 0)

        asyncio.run(scenario())

    def test_multiple_subscribers_same_channel(self) -> None:
        async def scenario() -> None:
            bus = SessionEventBus()
            a = bus.subscribe("conv1")
            b = bus.subscribe("conv1")
            bus.publish("conv1", {"type": "x", "n": 7})
            self.assertEqual((await a.get())["n"], 7)
            self.assertEqual((await b.get())["n"], 7)
            a.close()
            b.close()

        asyncio.run(scenario())


class WsEndpointTest(unittest.TestCase):
    def _client(self) -> tuple[TestClient, object]:
        directory = tempfile.mkdtemp()
        runtime_config = resolve_runtime_config(
            workspace=Path(directory),
            config_override=None,
            data_dir_override=Path(directory),
            agent_adapter_override="router",
        )
        app = create_app(runtime_config=runtime_config, workspace=Path(directory))
        return TestClient(app), app

    def test_subscribe_snapshot_then_live_event(self) -> None:
        client, app = self._client()
        with client.websocket_connect("/api/ws") as ws:
            ws.send_json({
                "v": 1,
                "kind": "req",
                "method": "subscribe",
                "requestId": "r1",
                "payload": {"channel": "convA"},
            })
            snapshot = ws.receive_json()
            self.assertEqual(snapshot["kind"], "snapshot")
            self.assertEqual(snapshot["channel"], "convA")
            self.assertEqual(snapshot["requestId"], "r1")
            self.assertIsNone(snapshot["payload"]["snapshot"])

            app.state.services.event_bus.publish(
                "convA",
                {"type": "agent.text.delta", "sequence": 5, "conversationId": "convA", "delta": "hi"},
            )
            event = ws.receive_json()
            self.assertEqual(event["kind"], "event")
            self.assertEqual(event["seq"], 5)
            self.assertEqual(event["payload"]["delta"], "hi")

            ws.send_json({
                "v": 1,
                "kind": "req",
                "method": "unsubscribe",
                "requestId": "r2",
                "payload": {"channel": "convA"},
            })
            result = ws.receive_json()
            self.assertEqual(result["kind"], "result")
            self.assertEqual(result["requestId"], "r2")

    def test_unknown_method_returns_error(self) -> None:
        client, _ = self._client()
        with client.websocket_connect("/api/ws") as ws:
            ws.send_json({
                "v": 1,
                "kind": "req",
                "method": "turn.start",
                "requestId": "r9",
                "payload": {},
            })
            reply = ws.receive_json()
            self.assertEqual(reply["kind"], "error")
            self.assertEqual(reply["payload"]["code"], "method_not_implemented")


if __name__ == "__main__":
    unittest.main()
