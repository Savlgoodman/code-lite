"""
code-lite proxy_server — 中继服务器

职责：
1. 接受 host（code-lite 后端）和 remote（ui-remote 前端）的 WebSocket 连接
2. 通过 hello 握手建立房间（roomId = SHA256(pairKey)）
3. 盲转发同一房间内的消息帧，不解析 payload
4. 心跳保活 + 超时驱逐

安全边界：
- 中继只持有 roomId（SHA256 哈希），不持有原始 pairKey
- payload 不解析、不记录、不缓存
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

# ── 常量 ───

PING_INTERVAL_S = 20.0          # 应用层心跳间隔
PING_TIMEOUT_S = 60.0           # 心跳超时阈值（连续无响应则驱逐）

app = FastAPI(title="code-lite relay")


# ─── 数据模型 ───

class Role(str, Enum):
    HOST = "host"
    REMOTE = "remote"


@dataclass
class RemoteClient:
    peer_id: str
    ws: WebSocket
    connected_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)


@dataclass
class Room:
    room_id: str
    host: WebSocket | None = None
    remotes: dict[str, RemoteClient] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    last_host_seen: float = 0.0


class RoomRegistry:
    """内存房间注册表。中继无状态，重启后各端自动重连。"""

    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    def get_or_create(self, room_id: str) -> Room:
        if room_id not in self._rooms:
            self._rooms[room_id] = Room(room_id=room_id)
        return self._rooms[room_id]

    def get(self, room_id: str) -> Room | None:
        return self._rooms.get(room_id)

    def remove_if_empty(self, room_id: str) -> None:
        room = self._rooms.get(room_id)
        if room and room.host is None and not room.remotes:
            del self._rooms[room_id]

    def all_rooms(self) -> list[Room]:
        return list(self._rooms.values())


registry = RoomRegistry()


# ─── 工具函数 ───

def make_envelope(type_: str, **fields: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {"type": type_}
    envelope.update({k: v for k, v in fields.items() if v is not None})
    return envelope


async def safe_send_json(ws: WebSocket, data: dict) -> bool:
    try:
        await ws.send_json(data)
        return True
    except Exception:
        return False


async def safe_send_text(ws: WebSocket, text: str) -> bool:
    try:
        await ws.send_text(text)
        return True
    except Exception:
        return False


# ─── 握手 ───

async def handle_hello(ws: WebSocket, payload: dict, room: Room) -> dict | None:
    """处理 hello 握手。返回发给客户端的响应，或 None（已发 error）"""
    role_str = payload.get("role", "")
    if role_str not in ("host", "remote"):
        await safe_send_json(ws, make_envelope("error", error="bad_role"))
        return None

    if role_str == "host":
        if room.host is not None:
            await safe_send_json(ws, make_envelope("error", error="room_has_host"))
            return None
        room.host = ws
        room.last_host_seen = time.time()
        logger.info("host joined room %s (%d waiting remotes)", room.room_id[:12], len(room.remotes))
        # 如果有等待中的 remote，通知它们 host 上线
        for remote in room.remotes.values():
            await safe_send_json(remote.ws, make_envelope("host.online"))
        return make_envelope("ready", role="host")

    else:
        # remote
        peer_id = str(uuid.uuid4())[:8]
        room.remotes[peer_id] = RemoteClient(peer_id=peer_id, ws=ws)
        if room.host is None:
            logger.info("remote %s joined room %s (host offline, waiting)", peer_id, room.room_id[:12])
            return make_envelope("waiting", role="remote", peerId=peer_id)
        else:
            logger.info("remote %s joined room %s, host IS online, sending host.online + ready", peer_id, room.room_id[:12])
            await safe_send_json(room.host, make_envelope("peer.joined", peerId=peer_id))
            await safe_send_json(ws, make_envelope("host.online"))
            return make_envelope("ready", role="remote", peerId=peer_id)


# ─── 消息转发 ───

async def handle_msg_from_remote(room: Room, peer_id: str, payload: dict) -> None:
    """remote → host：强制覆盖 peerId 防伪造，包中继信封。"""
    if room.host is None:
        return
    # 强制使用真实 peerId
    payload["peerId"] = peer_id
    envelope = {"type": "msg", "payload": payload, "peerId": peer_id}
    await safe_send_text(room.host, json.dumps(envelope, ensure_ascii=False))


async def handle_msg_from_host(room: Room, payload: dict) -> None:
    """host → remote：按 peerId 路由，* 表示广播。包中继信封。"""
    target = payload.get("peerId")
    envelope = {"type": "msg", "payload": payload}
    text = json.dumps(envelope, ensure_ascii=False)
    if target == "*" or target is None:
        for remote in list(room.remotes.values()):
            await safe_send_text(remote.ws, text)
    else:
        remote = room.remotes.get(str(target))
        if remote:
            await safe_send_text(remote.ws, text)


# ─── 连接处理 ───

@app.websocket("/ws")
async def relay_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    room: Room | None = None
    peer_id: str | None = None
    role: Role | None = None
    last_pong: float = time.time()

    try:
        # ── 握手阶段 ──
        raw = await ws.receive_text()
        hello = json.loads(raw) if raw else {}
        if not isinstance(hello, dict) or hello.get("type") != "hello":
            await safe_send_json(ws, make_envelope("error", error="expected_hello"))
            return

        room_id = str(hello.get("roomId") or "").strip()
        if not room_id:
            await safe_send_json(ws, make_envelope("error", error="bad_room"))
            return

        room = registry.get_or_create(room_id)
        resp = await handle_hello(ws, hello, room)
        if resp is None:
            return
        await safe_send_json(ws, resp)

        role_val = resp.get("role", "")
        role = Role(role_val) if role_val else None
        peer_id = resp.get("peerId")

        # ── 数据转发 + 心跳循环 ──
        pong_queue: asyncio.Queue[None] = asyncio.Queue()

        async def pump_incoming() -> None:
            nonlocal last_pong
            while True:
                raw = await ws.receive_text()
                last_pong = time.time()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                msg_type = msg.get("type", "")
                if msg_type == "ping":
                    await safe_send_json(ws, make_envelope("pong"))
                    continue
                if msg_type == "pong":
                    await pong_queue.put(None)
                    continue
                if msg_type == "msg":
                    payload = msg.get("payload")
                    if isinstance(payload, dict):
                        if role == Role.REMOTE and peer_id:
                            logger.debug("remote %s → host: %s", peer_id, payload.get("method", "?"))
                            await handle_msg_from_remote(room, peer_id, payload)
                        elif role == Role.HOST:
                            logger.debug("host → remote(peer=%s): %s", payload.get("peerId", "*"), payload.get("method", "?"))
                            await handle_msg_from_host(room, payload)

        async def heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(PING_INTERVAL_S)
                if time.time() - last_pong > PING_TIMEOUT_S:
                    raise TimeoutError("heartbeat timeout")
                await safe_send_json(ws, make_envelope("ping"))
                try:
                    await asyncio.wait_for(pong_queue.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    raise TimeoutError("pong timeout")

        receive_task = asyncio.create_task(pump_incoming())
        heartbeat_task = asyncio.create_task(heartbeat_loop())

        done, pending = await asyncio.wait(
            [receive_task, heartbeat_task],
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except (Exception, asyncio.CancelledError):
                pass

    except WebSocketDisconnect:
        pass
    except (Exception, asyncio.CancelledError):
        pass
    finally:
        # ── 清理 ──
        if room and role == Role.HOST:
            room.host = None
            room.last_host_seen = time.time()
            for remote in list(room.remotes.values()):
                await safe_send_json(remote.ws, make_envelope("host.offline"))
            logger.info("host left room %s", room.room_id[:12])
        elif room and role == Role.REMOTE and peer_id:
            room.remotes.pop(peer_id, None)
            if room.host:
                await safe_send_json(room.host, make_envelope("peer.left", peerId=peer_id))
            logger.info("remote %s left room %s", peer_id, room.room_id[:12])

        if room:
            registry.remove_if_empty(room.room_id)


# ─── 管理端点（调试用）──

@app.get("/health")
async def health() -> dict:
    rooms = registry.all_rooms()
    return {
        "rooms": len(rooms),
        "details": [
            {
                "roomId": r.room_id[:12],
                "hasHost": r.host is not None,
                "remoteCount": len(r.remotes),
            }
            for r in rooms
        ],
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="code-lite relay server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18766)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )
