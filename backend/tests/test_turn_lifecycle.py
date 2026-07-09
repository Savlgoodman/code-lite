from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.schemas.agent import AgentAdapterCapabilities, AgentRunRequest


class FakeAdapter:
    """确定性假 adapter：按脚本产出事件，可在中途插入延迟以模拟长任务。"""

    name = "fake"
    capabilities = AgentAdapterCapabilities()

    def __init__(self, pre_complete_delay: float = 0.0) -> None:
        self._pre_complete_delay = pre_complete_delay
        self.cancelled: list[str] = []

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[dict[str, Any]]:
        base = {"conversationId": request.conversation_id, "turnId": request.turn_id}
        yield {"type": "agent.run.started", **base}
        yield {"type": "agent.text.delta", **base, "delta": "hello "}
        if self._pre_complete_delay:
            await asyncio.sleep(self._pre_complete_delay)
        yield {"type": "agent.text.delta", **base, "delta": "world"}
        yield {"type": "agent.text.completed", **base}
        yield {"type": "agent.run.completed", **base, "usage": {}, "result": {}}

    async def cancel_turn(self, turn_id: str) -> bool:
        self.cancelled.append(turn_id)
        return True


def _make_app(pre_complete_delay: float = 0.0):
    directory = tempfile.mkdtemp()
    runtime_config = resolve_runtime_config(
        workspace=Path(directory),
        config_override=None,
        data_dir_override=Path(directory),
        agent_adapter_override="router",
    )
    app = create_app(runtime_config=runtime_config, workspace=Path(directory))
    app.state.services.agent_adapter = FakeAdapter(pre_complete_delay=pre_complete_delay)
    return app


def _create_conversation(client: TestClient) -> str:
    response = client.post("/api/conversations", json={"agentId": "codex"})
    assert response.status_code == 200, response.text
    return response.json()["session"]["id"]


class TurnLifecycleTest(unittest.TestCase):
    def test_normal_turn_streams_and_persists(self) -> None:
        """非 remote 主路径（WS RPC）：事件经总线回流并落盘。"""
        app = _make_app()
        with TestClient(app) as client:
            conversation_id = _create_conversation(client)
            types: list[str] = []
            text = ""
            with client.websocket_connect("/api/ws") as ws:
                # 先订阅该会话频道
                ws.send_json({
                    "v": 1, "kind": "req", "method": "subscribe",
                    "requestId": "s1", "payload": {"channel": conversation_id},
                })
                snapshot = ws.receive_json()
                self.assertEqual(snapshot["kind"], "snapshot")

                # 发起 turn
                ws.send_json({
                    "v": 1, "kind": "req", "method": "turn.start", "requestId": "t1",
                    "payload": {"conversationId": conversation_id, "input": "hi", "turnId": "turn-1"},
                })

                for _ in range(50):
                    msg = ws.receive_json()
                    if msg["kind"] == "event":
                        event = msg["payload"]
                        types.append(event["type"])
                        if event["type"] == "agent.text.delta":
                            text += event["delta"]
                        if event["type"] == "agent.run.completed":
                            break

            self.assertIn("conversation.turn.started", types)
            self.assertEqual(types[-1], "agent.run.completed")
            self.assertEqual(text, "hello world")

            loaded = client.get(f"/api/conversations/{conversation_id}").json()
            messages = loaded["messages"]
            assistant = [m for m in messages if m["role"] == "assistant"][-1]
            self.assertEqual(assistant["content"], "hello world")
            self.assertFalse(assistant.get("streaming", False))
            self.assertEqual(loaded["session"]["status"], "idle")

    def test_turn_survives_client_disconnect(self) -> None:
        """0709 5.1.1：发起端中途断开，后台 turn 继续跑完并落盘。"""
        app = _make_app(pre_complete_delay=0.6)
        with TestClient(app) as client:
            conversation_id = _create_conversation(client)
            # 先订阅频道，发起 turn，然后断开
            with client.websocket_connect("/api/ws") as ws:
                ws.send_json({
                    "v": 1, "kind": "req", "method": "subscribe",
                    "requestId": "s1", "payload": {"channel": conversation_id},
                })
                ws.receive_json()  # snapshot
                ws.send_json({
                    "v": 1, "kind": "req", "method": "turn.start", "requestId": "t1",
                    "payload": {"conversationId": conversation_id, "input": "hi", "turnId": "turn-1"},
                })
                # 读取消息直到收到一个 event（跳过可能的 result ack / turn.lock），然后断开
                got_event = False
                for _ in range(10):
                    msg = ws.receive_json()
                    if msg["kind"] == "event":
                        event = msg["payload"]
                        # 第一个 event 可能是 turn.lock 或 conversation.turn.started
                        self.assertIn(event["type"], {"turn.lock", "conversation.turn.started"})
                        got_event = True
                        break
                self.assertTrue(got_event, "expected conversation.turn.started event before disconnect")
                # 退出 with：连接断开，后台 turn 应继续

            # 轮询直到后台 turn 完成并落盘
            deadline = time.time() + 5
            assistant_content = ""
            status = ""
            while time.time() < deadline:
                loaded = client.get(f"/api/conversations/{conversation_id}").json()
                status = loaded["session"]["status"]
                assistants = [m for m in loaded["messages"] if m["role"] == "assistant"]
                if assistants and not assistants[-1].get("streaming", False):
                    assistant_content = assistants[-1]["content"]
                    break
                time.sleep(0.1)

            self.assertEqual(assistant_content, "hello world")
            self.assertEqual(status, "idle")

    def test_active_turn_registry_interlock(self) -> None:
        """会话级串行互锁机制（0709 第 6 节）：同一会话第二个 turn 被拒。

        直接测 ActiveTurnRegistry；HTTP 层的 busy 拒绝依赖真实并发，
        TestClient 的单后台线程模型无法复现该竞态，故在此层验证机制正确性。
        """
        from code_lite_backend.services.turn_registry import ActiveTurnRegistry

        async def scenario() -> None:
            registry = ActiveTurnRegistry()
            started = asyncio.Event()
            release = asyncio.Event()

            async def slow_turn() -> None:
                started.set()
                await release.wait()

            registry.start("conv-1", slow_turn)
            await started.wait()
            self.assertTrue(registry.is_running("conv-1"))
            with self.assertRaises(RuntimeError):
                registry.start("conv-1", slow_turn)
            release.set()
            await asyncio.sleep(0.05)
            self.assertFalse(registry.is_running("conv-1"))

        asyncio.run(scenario())


class WsTurnRpcTest(unittest.TestCase):
    def test_ws_turn_start_flows_events_over_channel(self) -> None:
        """WS turn.start：先订阅会话频道，turn.start 后事件经 event 回流。"""
        app = _make_app()
        with TestClient(app) as client:
            conversation_id = _create_conversation(client)
            with client.websocket_connect("/api/ws") as ws:
                # 先订阅该会话频道
                ws.send_json({
                    "v": 1, "kind": "req", "method": "subscribe",
                    "requestId": "s1", "payload": {"channel": conversation_id},
                })
                snapshot = ws.receive_json()
                self.assertEqual(snapshot["kind"], "snapshot")

                # 发起 turn
                ws.send_json({
                    "v": 1, "kind": "req", "method": "turn.start", "requestId": "t1",
                    "payload": {"conversationId": conversation_id, "input": "hi", "turnId": "turn-1"},
                })

                # 收集事件直到 result 与 run.completed 都到达
                text = ""
                types: list[str] = []
                got_result = False
                completed = False
                for _ in range(50):
                    msg = ws.receive_json()
                    if msg["kind"] == "result" and msg.get("requestId") == "t1":
                        got_result = True
                        self.assertEqual(msg["payload"]["conversationId"], conversation_id)
                    elif msg["kind"] == "event":
                        event = msg["payload"]
                        types.append(event["type"])
                        if event["type"] == "agent.text.delta":
                            text += event["delta"]
                        if event["type"] == "agent.run.completed":
                            completed = True
                    if got_result and completed:
                        break

                self.assertTrue(got_result)
                self.assertIn("conversation.turn.started", types)
                self.assertEqual(text, "hello world")
                self.assertEqual(types[-1], "agent.run.completed")

    def test_ws_turn_start_without_prior_subscribe_draft(self) -> None:
        """draft 场景：不先 subscribe、不带 conversationId，turn.start 后端自动订阅，
        仍能收到从 turn.started 起的完整事件（无早期事件竞态）。"""
        app = _make_app()
        with TestClient(app) as client:
            with client.websocket_connect("/api/ws") as ws:
                ws.send_json({
                    "v": 1, "kind": "req", "method": "turn.start", "requestId": "t1",
                    "payload": {"input": "hi", "turnId": "turn-1", "agentId": "codex"},
                })
                text = ""
                types: list[str] = []
                conversation_id = ""
                got_result = False
                completed = False
                for _ in range(60):
                    msg = ws.receive_json()
                    if msg["kind"] == "result" and msg.get("requestId") == "t1":
                        got_result = True
                        conversation_id = msg["payload"]["conversationId"]
                    elif msg["kind"] == "event":
                        event = msg["payload"]
                        types.append(event["type"])
                        if event["type"] == "agent.text.delta":
                            text += event["delta"]
                        if event["type"] == "agent.run.completed":
                            completed = True
                    if got_result and completed:
                        break

                self.assertTrue(got_result)
                self.assertTrue(conversation_id)
                self.assertIn("conversation.turn.started", types)
                self.assertEqual(text, "hello world")


if __name__ == "__main__":
    unittest.main()
