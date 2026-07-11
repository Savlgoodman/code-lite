"""Relay server integration tests using websockets library directly.

FastAPI TestClient websocket support is unreliable on Windows,
so we use the websockets library with an embedded uvicorn server.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets

import uvicorn
from proxy_server.main import app, registry

RELAY_HOST = "127.0.0.1"
RELAY_PORT = 19876 + (int(time.time()) % 1000)  # avoid port conflicts
RELAY_URI = f"ws://{RELAY_HOST}:{RELAY_PORT}/ws"


def _run_server() -> uvicorn.Server:
    config = uvicorn.Config(app, host=RELAY_HOST, port=RELAY_PORT, log_level="error")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    return server


async def _send_hello(ws, role: str, room_id: str) -> dict:
    """发送 hello 握手，返回最终的 ready/waiting/error 响应。
    当 host 已在线时 remote 会先收到 host.online 再收到 ready，
    此函数自动消费中间的 host.online 消息。"""
    await ws.send(json.dumps({"type": "hello", "role": role, "roomId": room_id}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("type") in ("ready", "waiting", "error"):
            return msg
        # 跳过 host.online 等中间消息


async def _send_msg(ws, payload: dict, to: str | None = None) -> None:
    # 路由目标只放外层 to（0710 第 3.1 节）；业务 payload 为黑盒。
    envelope: dict = {"type": "msg", "payload": payload}
    if to is not None:
        envelope["to"] = to
    await ws.send(json.dumps(envelope))


async def _recv_json(ws):
    raw = await ws.recv()
    return json.loads(raw)


class RelayHandshakeTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._server = _run_server()
        # Wait for server to be ready
        time.sleep(0.5)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._server.should_exit = True

    def setUp(self) -> None:
        registry._rooms.clear()

    async def test_host_creates_room_and_gets_ready(self) -> None:
        async with websockets.connect(RELAY_URI) as ws:
            resp = await _send_hello(ws, "host", "room-abc")
            self.assertEqual(resp["type"], "ready")
            self.assertEqual(resp["role"], "host")
            room = registry.get("room-abc")
            self.assertIsNotNone(room)
            self.assertIsNotNone(room.host)

    async def test_second_host_rejected(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-xyz")
            async with websockets.connect(RELAY_URI) as ws2:
                resp = await _send_hello(ws2, "host", "room-xyz")
                self.assertEqual(resp["type"], "error")
                self.assertEqual(resp["error"], "room_has_host")

    async def test_remote_joins_host_room(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-r1")
            async with websockets.connect(RELAY_URI) as ws2:
                resp = await _send_hello(ws2, "remote", "room-r1")
                self.assertEqual(resp["type"], "ready")
                self.assertEqual(resp["role"], "remote")
                self.assertIn("peerId", resp)
                peer_id = resp["peerId"]
                joined = await _recv_json(ws1)
                self.assertEqual(joined["type"], "peer.joined")
                self.assertEqual(joined["peerId"], peer_id)

    async def test_remote_waits_for_host(self) -> None:
        async with websockets.connect(RELAY_URI) as ws:
            resp = await _send_hello(ws, "remote", "room-wait")
            self.assertEqual(resp["type"], "waiting")
            self.assertEqual(resp["role"], "remote")

    async def test_msg_forwarding_remote_to_host(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-msg")
            async with websockets.connect(RELAY_URI) as ws2:
                resp = await _send_hello(ws2, "remote", "room-msg")
                peer_id = resp["peerId"]
                joined = await _recv_json(ws1)
                self.assertEqual(joined["type"], "peer.joined")
                # remote 试图伪造 from（塞进外层无效，中继强制覆盖为真实 peerId）
                await ws2.send(json.dumps({"type": "msg", "from": "fake-id", "payload": {"body": "hello"}}))
                # 中继包一层 {"type":"msg","from":<真实 peerId>,"to":"host","payload":{...}}
                raw = await _recv_json(ws1)
                self.assertEqual(raw["from"], peer_id)
                self.assertEqual(raw["to"], "host")
                self.assertEqual(raw["payload"]["body"], "hello")

    async def test_msg_forwarding_host_to_remote(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-msg2")
            async with websockets.connect(RELAY_URI) as ws2:
                resp = await _send_hello(ws2, "remote", "room-msg2")
                peer_id = resp["peerId"]
                # 消耗 peer.joined
                await _recv_json(ws1)
                # host 用外层 to 定向到该 peer
                await _send_msg(ws1, {"body": "hi-remote"}, to=peer_id)
                raw = await _recv_json(ws2)
                self.assertEqual(raw["from"], "host")
                self.assertEqual(raw["payload"]["body"], "hi-remote")

    async def test_broadcast_to_all_remotes(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-bc")
            async with websockets.connect(RELAY_URI) as ws2:
                await _send_hello(ws2, "remote", "room-bc")
                async with websockets.connect(RELAY_URI) as ws3:
                    await _send_hello(ws3, "remote", "room-bc")
                    # 消耗两条 peer.joined
                    await _recv_json(ws1)
                    await _recv_json(ws1)
                    await _send_msg(ws1, {"body": "broadcast"}, to="*")
                    raw2 = await _recv_json(ws2)
                    raw3 = await _recv_json(ws3)
                    self.assertEqual(raw2["payload"]["body"], "broadcast")
                    self.assertEqual(raw3["payload"]["body"], "broadcast")

    async def test_directed_msg_no_crosstalk(self) -> None:
        """host 定向到某 peer 时，另一 peer 不应收到（0710 第 1.2 节回归）。"""
        async with websockets.connect(RELAY_URI) as host:
            await _send_hello(host, "host", "room-direct")
            async with websockets.connect(RELAY_URI) as r1:
                resp1 = await _send_hello(r1, "remote", "room-direct")
                peer1 = resp1["peerId"]
                await _recv_json(host)  # peer.joined for r1
                async with websockets.connect(RELAY_URI) as r2:
                    await _send_hello(r2, "remote", "room-direct")
                    await _recv_json(host)  # peer.joined for r2
                    # 只定向给 peer1
                    await _send_msg(host, {"body": "for-r1-only"}, to=peer1)
                    raw1 = await _recv_json(r1)
                    self.assertEqual(raw1["payload"]["body"], "for-r1-only")
                    # r2 不应收到：用超时确认无消息
                    with self.assertRaises(asyncio.TimeoutError):
                        await asyncio.wait_for(r2.recv(), timeout=0.5)

    async def test_cleanup_on_host_disconnect(self) -> None:
        ws1 = await websockets.connect(RELAY_URI)
        await _send_hello(ws1, "host", "room-cl")
        ws2 = await websockets.connect(RELAY_URI)
        resp = await _send_hello(ws2, "remote", "room-cl")
        # 消耗 peer.joined
        joined = await _recv_json(ws1)
        self.assertEqual(joined["type"], "peer.joined")
        # host 断开
        await ws1.close()
        # remote 应收到 host.offline
        msg = await _recv_json(ws2)
        self.assertEqual(msg["type"], "host.offline")
        await ws2.close()
        # remote 断开后房间应被完全清理
        self.assertIsNone(registry.get("room-cl"))

    async def test_host_receives_peer_joined_before_ready_when_remote_waiting(self) -> None:
        """回归：remote 先连（waiting），host 后上线时，中继会先给 host 发 peer.joined
        再发 ready。host 握手必须容忍 ready 之前的 peer.joined，否则会误判为 rejected
        并立即重连，打爆中继（reconnect storm）。此测试锁定该帧顺序。"""
        # remote 先连，进入 waiting
        remote = await websockets.connect(RELAY_URI)
        resp = await _send_hello(remote, "remote", "room-order")
        self.assertEqual(resp["type"], "waiting")

        # host 后上线：不走 _send_hello（它会跳过中间帧），逐帧断言顺序
        host = await websockets.connect(RELAY_URI)
        await host.send(json.dumps({"type": "hello", "role": "host", "roomId": "room-order"}))
        first = await _recv_json(host)
        self.assertEqual(first["type"], "peer.joined")
        self.assertEqual(first["peerId"], resp["peerId"])
        second = await _recv_json(host)
        self.assertEqual(second["type"], "ready")

        await host.close()
        await remote.close()

    async def test_bad_hello_rejected(self) -> None:
        async with websockets.connect(RELAY_URI) as ws:
            await ws.send(json.dumps({"type": "not_hello"}))
            resp = await _recv_json(ws)
            self.assertEqual(resp["type"], "error")

    async def test_ping_pong(self) -> None:
        async with websockets.connect(RELAY_URI) as ws:
            await _send_hello(ws, "host", "room-ping")
            await ws.send(json.dumps({"type": "ping"}))
            resp = await _recv_json(ws)
            self.assertEqual(resp["type"], "pong")


if __name__ == "__main__":
    unittest.main()
