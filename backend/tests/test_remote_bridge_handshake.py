"""RemoteBridge host 握手回归测试。

聚焦一个曾导致"疯狂爆破中继"的 bug：remote 先连中继（waiting），host 后上线时，
中继会先给 host 发一批 peer.joined 再发 ready（见 proxy_server.handle_hello）。
旧的 host 握手只 recv 一帧并断言首帧即 ready，于是把 peer.joined 误判为 rejected
直接 return；而 _run 的退避 sleep 只在 except 分支，正常 return 会立即重连，形成
reconnect storm。此测试用假 WS 锁定：握手容忍 ready 之前的 peer.joined，并登记该 peer。
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.remote_bridge import RemoteBridge, RemoteBridgeConfig


class _FakeWS:
    """最小 websockets.ClientConnection 替身：按脚本吐帧，记录发送。"""

    def __init__(self, inbound: list[dict]) -> None:
        # 握手后主循环会继续 async for；用一个不再产出的迭代器让它自然结束。
        self._inbound = list(inbound)
        self.sent: list[str] = []
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:
        if not self._inbound:
            raise AssertionError("recv called with no scripted frames left")
        return json.dumps(self._inbound.pop(0))

    def __aiter__(self):
        return self

    async def __anext__(self):
        # 握手消费完脚本帧后，主循环的 async for 立即结束（房间静默）。
        raise StopAsyncIteration

    async def close(self) -> None:
        self.closed = True


class _RecordingBus:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def publish(self, channel: str, event: dict) -> None:
        self.events.append(event)


class RemoteBridgeHandshakeTest(unittest.IsolatedAsyncioTestCase):
    def _make_bridge(self, tmp: Path) -> tuple[RemoteBridge, _RecordingBus]:
        bus = _RecordingBus()
        bridge = RemoteBridge(tmp / "remote.json", SimpleNamespace(event_bus=bus))
        bridge._config = RemoteBridgeConfig(
            enabled=True, relay_url="ws://x/ws", pair_key="k", room_id="r" * 64,
        )
        bridge._running = True
        return bridge, bus

    async def test_peer_joined_before_ready_is_tolerated(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            bridge, bus = self._make_bridge(Path(d))
            fake = _FakeWS([
                {"type": "peer.joined", "peerId": "abc123"},
                {"type": "ready", "role": "host"},
            ])

            # patch websockets.connect 返回一个 async ctx manager 包住 fake ws
            import code_lite_backend.services.remote_bridge as rb

            class _Ctx:
                async def __aenter__(self_inner):
                    return fake
                async def __aexit__(self_inner, *a):
                    return False

            orig = rb.websockets.connect
            rb.websockets.connect = lambda *a, **k: _Ctx()
            try:
                # 不抛异常即证明 peer.joined 未被误判为 rejected（否则会抛 ConnectionError）。
                await bridge._connect_and_run()
            finally:
                rb.websockets.connect = orig

            # 握手期间收到的 peer 必须被登记（会广播 remote.peer.joined）；否则该设备的
            # RPC 会被 _handle_rpc 当成未知 peer 丢弃。连接结束时 _remote_peers 会被清空，
            # 故断言在登记时刻发出的事件，而非结束态的字典。
            joined = [e for e in bus.events if e.get("type") == "remote.peer.joined"]
            self.assertEqual([e["peerId"] for e in joined], ["abc123"])

    async def test_real_rejection_raises(self) -> None:
        """真正的拒绝（room_has_host 等）必须抛异常，交由 _run 退避重连，
        而不是被当成 peer.joined 吞掉。"""
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            bridge, _bus = self._make_bridge(Path(d))
            fake = _FakeWS([{"type": "error", "error": "room_has_host"}])

            import code_lite_backend.services.remote_bridge as rb

            class _Ctx:
                async def __aenter__(self_inner):
                    return fake
                async def __aexit__(self_inner, *a):
                    return False

            orig = rb.websockets.connect
            rb.websockets.connect = lambda *a, **k: _Ctx()
            try:
                with self.assertRaises(Exception):
                    await bridge._connect_and_run()
            finally:
                rb.websockets.connect = orig


if __name__ == "__main__":
    unittest.main()
