"""
code-lite 后端远程桥接服务

职责：
1. 管理 pair key（生成、存储、轮换）
2. 主动出站连接中继服务器
3. 转发中继消息到本地事件总线
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
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)


@dataclass
class RemoteBridgeConfig:
    """远程桥接配置"""
    enabled: bool = False
    relay_url: str = "ws://localhost:18766/ws"
    pair_key: str = ""  # hex string
    room_id: str = ""   # SHA256(pair_key) hex


class RemoteBridge:
    """远程桥接服务"""

    def __init__(self, config_path: Path, event_bus: Any) -> None:
        self._config_path = config_path
        self._event_bus = event_bus
        self._config = self._load_config()
        self._ws: websockets.ClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._running = False

    @property
    def config(self) -> RemoteBridgeConfig:
        return self._config

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._running

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
        """生成新的 pair key（128-bit 随机）"""
        key = secrets.token_hex(16)
        self._config.pair_key = key
        self._config.room_id = hashlib.sha256(key.encode()).hexdigest()
        self.save_config()
        return key

    async def start(self) -> None:
        """启动远程桥接（如果已启用）"""
        if not self._config.enabled or not self._config.pair_key:
            return
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """停止远程桥接"""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()

    async def _run(self) -> None:
        """主循环：连接中继、收发心跳、转发消息"""
        while self._running:
            try:
                await self._connect_and_run()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("remote bridge disconnected: %s", e)
                if self._running:
                    await asyncio.sleep(5)  # 重连延迟

    async def _connect_and_run(self) -> None:
        """单次连接生命周期"""
        logger.info("connecting to relay %s (room %s)", self._config.relay_url, self._config.room_id[:12])
        async with websockets.connect(self._config.relay_url) as ws:
            self._ws = ws
            # 发送 hello
            await ws.send(json.dumps({
                "type": "hello",
                "role": "host",
                "roomId": self._config.room_id,
            }))
            resp = json.loads(await ws.recv())
            if resp.get("type") != "ready":
                logger.error("relay rejected: %s", resp)
                return

            logger.info("connected to relay")
            # 主循环
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
                elif msg_type == "msg":
                    await self._handle_relay_message(msg.get("payload", {}))
                elif msg_type == "peer.joined":
                    logger.info("remote peer joined: %s", msg.get("peerId"))
                elif msg_type == "peer.left":
                    logger.info("remote peer left: %s", msg.get("peerId"))
            self._ws = None

    async def _handle_relay_message(self, payload: dict) -> None:
        """处理中继转发的消息（从 remote 来的 WS RPC）"""
        # payload 是标准的 WS 信封 {v, kind, method, payload, requestId, ...}
        kind = payload.get("kind", "")
        if kind != "req":
            return
        method = payload.get("method", "")
        # TODO: 路由到对应的 RPC handler（conversation.list, turn.start 等）
        logger.info("received RPC from remote: %s", method)

    def update_config(self, **kwargs: Any) -> None:
        """更新配置"""
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        self.save_config()
