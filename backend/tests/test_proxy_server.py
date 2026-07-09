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
    await ws.send(json.dumps({"type": "hello", "role": role, "roomId": room_id}))
    return json.loads(await ws.recv())


async def _send_msg(ws, payload: dict) -> None:
    await ws.send(json.dumps({"type": "msg", "payload": payload}))


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
                # host 先收到 peer.joined，消耗掉
                joined = await _recv_json(ws1)
                self.assertEqual(joined["type"], "peer.joined")
                await _send_msg(ws2, {"peerId": "fake-id", "body": "hello"})
                msg = await _recv_json(ws1)
                self.assertEqual(msg["peerId"], peer_id)
                self.assertEqual(msg["body"], "hello")

    async def test_msg_forwarding_host_to_remote(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-msg2")
            async with websockets.connect(RELAY_URI) as ws2:
                resp = await _send_hello(ws2, "remote", "room-msg2")
                peer_id = resp["peerId"]
                await _send_msg(ws1, {"peerId": peer_id, "body": "hi-remote"})
                msg = await _recv_json(ws2)
                self.assertEqual(msg["body"], "hi-remote")

    async def test_broadcast_to_all_remotes(self) -> None:
        async with websockets.connect(RELAY_URI) as ws1:
            await _send_hello(ws1, "host", "room-bc")
            async with websockets.connect(RELAY_URI) as ws2:
                await _send_hello(ws2, "remote", "room-bc")
                async with websockets.connect(RELAY_URI) as ws3:
                    await _send_hello(ws3, "remote", "room-bc")
                    await _send_msg(ws1, {"peerId": "*", "body": "broadcast"})
                    m2 = await _recv_json(ws2)
                    m3 = await _recv_json(ws3)
                    self.assertEqual(m2["body"], "broadcast")
                    self.assertEqual(m3["body"], "broadcast")

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
