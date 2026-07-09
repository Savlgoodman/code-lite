"""
code-lite 后端远程桥接服务

职责：
1. 管理 pair key（生成、存储、轮换）
2. 主动出站连接中继服务器
3. 将中继收到的 remote RPC 转发到本地 WS 处理器
4. 将本地事件总线的事件转发到中继给 remote
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TYPE_CHECKING

import websockets
from websockets.exceptions import ConnectionClosed

if TYPE_CHECKING:
    from code_lite_backend.services.runtime import AppServices

logger = logging.getLogger(__name__)


def _envelope(kind: str, **fields: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {"v": 1, "kind": kind}
    envelope.update({k: v for k, v in fields.items() if v is not None})
    return envelope


def _get_rpc_handlers() -> dict[str, Any]:
    """懒加载 WS RPC handlers，避免循环导入"""
    from code_lite_backend.api.routes.ws import (
        _handle_approval_decision,
        _handle_conversation_config_update,
        _handle_conversation_create,
        _handle_conversation_get,
        _handle_conversation_list,
        _handle_input_response,
        _handle_subscribe,
        _handle_turn_cancel,
        _handle_turn_start,
    )
    return {
        "subscribe": _handle_subscribe,
        "turn.start": _handle_turn_start,
        "turn.cancel": _handle_turn_cancel,
        "approval.decision": _handle_approval_decision,
        "input.response": _handle_input_response,
        "conversation.list": _handle_conversation_list,
        "conversation.get": _handle_conversation_get,
        "conversation.create": _handle_conversation_create,
        "conversation.config.update": _handle_conversation_config_update,
    }


@dataclass
class RemoteBridgeConfig:
    """远程桥接配置"""
    enabled: bool = False
    relay_url: str = "ws://localhost:18766/ws"
    pair_key: str = ""  # hex string
    room_id: str = ""   # SHA256(pair_key) hex


class _FakeWebSocket:
    """伪装 WebSocket 对象，让 WS RPC handler 能通过它发送响应到中继。"""

    def __init__(self, real_ws: websockets.ClientConnection, peer_id: str) -> None:
        self._real_ws = real_ws
        self._peer_id = peer_id

    async def send_json(self, data: dict) -> None:
        envelope = {"type": "msg", "payload": data, "peerId": self._peer_id}
        await self._real_ws.send(json.dumps(envelope, ensure_ascii=False))


class RemoteBridge:
    """远程桥接服务"""

    def __init__(self, config_path: Path, services: Any) -> None:
        self._config_path = config_path
        self._services = services
        self._config = self._load_config()
        self._ws: websockets.ClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._running = False
        self._remote_peers: dict[str, _FakeWebSocket] = {}  # peerId -> fake WS
        self._pump_tasks: dict[str, asyncio.Task] = {}  # channel -> pump task

    @property
    def config(self) -> RemoteBridgeConfig:
        return self._config

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._running

    @property
    def connected_peers(self) -> list[str]:
        return list(self._remote_peers.keys())

    def _load_config(self) -> RemoteBridgeConfig:
        if self._config_path.exists():
            data = json.loads(self._config_path.read_text())
            return RemoteBridgeConfig(
                enabled=data.get("enabled", False),
                relay_url=data.get("relay_url", "ws://localhost:18766/ws"),
                pair_key=data.get("pair_key", ""),
                room_id=data.get("room_id", ""),
            )
        return RemoteBridgeConfig()

    def save_config(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        self._config_path.write_text(json.dumps({
            "enabled": self._config.enabled,
            "relay_url": self._config.relay_url,
            "pair_key": self._config.pair_key,
            "room_id": self._config.room_id,
        }, indent=2))

    def generate_pair_key(self) -> str:
        key = secrets.token_hex(16)
        self._config.pair_key = key
        self._config.room_id = hashlib.sha256(key.encode()).hexdigest()
        self.save_config()
        return key

    async def start(self) -> None:
        if not self._config.enabled or not self._config.pair_key:
            return
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        for t in self._pump_tasks.values():
            t.cancel()
        self._pump_tasks.clear()
        self._remote_peers.clear()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()

    async def _run(self) -> None:
        while self._running:
            try:
                await self._connect_and_run()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("remote bridge disconnected: %s", e)
                if self._running:
                    await asyncio.sleep(5)

    async def _connect_and_run(self) -> None:
        logger.info("connecting to relay %s (room %s)", self._config.relay_url, self._config.room_id[:12])
        async with websockets.connect(self._config.relay_url) as ws:
            self._ws = ws
            await ws.send(json.dumps({
                "type": "hello",
                "role": "host",
                "roomId": self._config.room_id,
            }))
            resp = json.loads(await ws.recv())
            logger.info("relay hello response: %s", resp)
            if resp.get("type") != "ready":
                logger.error("relay rejected: %s", resp)
                return
            logger.info("connected to relay, starting event pump")

            # 启动事件泵：把本地事件总线的事件转发到中继
            self._start_event_pumps()

            try:
                async for raw in ws:
                    if not self._running:
                        break
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    msg_type = msg.get("type", "")
                    if msg_type == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                    elif msg_type == "peer.joined":
                        peer_id = msg.get("peerId", "")
                        logger.info("remote peer joined: %s", peer_id)
                        self._remote_peers[peer_id] = _FakeWebSocket(ws, peer_id)
                    elif msg_type == "peer.left":
                        peer_id = msg.get("peerId", "")
                        logger.info("remote peer left: %s", peer_id)
                        self._remote_peers.pop(peer_id, None)
                    elif msg_type == "msg":
                        payload = msg.get("payload", {})
                        peer_id = msg.get("peerId", "")
                        logger.info("msg from peer %s: method=%s", peer_id, payload.get("method", "?"))
                        await self._handle_rpc(payload, peer_id)
                    elif msg_type == "host.offline":
                        pass  # 不应该收到
            finally:
                self._ws = None
                self._stop_event_pumps()
                self._remote_peers.clear()

    async def _handle_rpc(self, payload: dict, peer_id: str) -> None:
        """将中继收到的 RPC 路由到本地 WS handler"""
        kind = payload.get("kind", "")
        if kind != "req":
            return
        method = payload.get("method", "")
        request_id = payload.get("requestId")
        rpc_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}

        fake_ws = self._remote_peers.get(peer_id)
        if not fake_ws:
            logger.warning("rpc from unknown peer %s: %s", peer_id, method)
            return

        services = self._services

        try:
            handlers = _get_rpc_handlers()
            if method == "unsubscribe":
                channel = str(rpc_payload.get("channel") or "")
                task = self._pump_tasks.pop(channel, None)
                if task is not None:
                    task.cancel()
                await fake_ws.send_json(_envelope("result", requestId=request_id, payload={"ok": True}))
            elif method in handlers:
                handler = handlers[method]
                if method == "subscribe":
                    await handler(fake_ws, services, request_id, rpc_payload, self._pump_tasks)
                else:
                    await handler(fake_ws, services, request_id, rpc_payload)
            else:
                await fake_ws.send_json(_envelope(
                    "error", requestId=request_id,
                    payload={"code": "method_not_implemented", "method": method},
                ))
        except Exception:
            logger.exception("rpc dispatch failed: method=%s peer=%s", method, peer_id)
            try:
                await fake_ws.send_json(_envelope(
                    "error", requestId=request_id,
                    payload={"code": "internal_error"},
                ))
            except Exception:
                pass

    # ── 事件泵：本地 bus → 中继 → remote ──

    def _start_event_pumps(self) -> None:
        bus = self._services.event_bus
        if bus is None:
            return
        # 订阅全局频道（会话列表事件）
        self._subscribe_pump("*")

    def _subscribe_pump(self, channel: str) -> None:
        bus = self._services.event_bus
        if bus is None:
            return
        subscription = bus.subscribe(channel)
        ws = self._ws
        if ws is None:
            return

        async def pump() -> None:
            try:
                async for event in subscription:
                    if not self._running or self._ws is None:
                        break
                    envelope = {
                        "type": "msg",
                        "payload": {
                            "v": 1,
                            "kind": "event",
                            "channel": channel,
                            "seq": event.get("sequence"),
                            "payload": event,
                        },
                        "peerId": "*",  # 广播给所有 remote
                    }
                    await self._ws.send(json.dumps(envelope, ensure_ascii=False))
            except (ConnectionClosed, asyncio.CancelledError):
                pass
            except Exception:
                logger.exception("event pump failed for channel=%s", channel)
            finally:
                subscription.close()

        self._pump_tasks[channel] = asyncio.create_task(pump())

    def _stop_event_pumps(self) -> None:
        for t in self._pump_tasks.values():
            t.cancel()
        self._pump_tasks.clear()

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        self.save_config()
