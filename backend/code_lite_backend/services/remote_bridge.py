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


def _strip_archived_for_remote(data: dict[str, Any]) -> dict[str, Any]:
    """remote 出站边界：不向远端传输已归档会话（数据包层面剔除）。

    桌面端仍需 archived 会话（归档设置页/过滤），故过滤只落在 remote peer
    的出站边界，不动共享的 ws.py handler 与 chat-core 列表逻辑。

    覆盖两条路径：
    - conversation.list 结果：剔除 sessions 中 archived 的项。
    - GLOBAL_CHANNEL 上的 conversation.archived 事件：改写为 conversation.deleted，
      让已连接的远端把刚归档的会话从列表移除（否则该事件仍会携带会话数据）。
    """
    payload = data.get("payload")
    if not isinstance(payload, dict):
        return data
    kind = data.get("kind")
    if kind == "result" and isinstance(payload.get("sessions"), list):
        sessions = payload["sessions"]
        filtered = [
            s for s in sessions
            if not (isinstance(s, dict) and s.get("archived"))
        ]
        if len(filtered) != len(sessions):
            return {**data, "payload": {**payload, "sessions": filtered}}
        return data
    if kind == "event" and payload.get("type") == "conversation.archived":
        session = payload.get("session")
        sid = session.get("id") if isinstance(session, dict) else None
        if sid:
            return {
                **data,
                "payload": {"type": "conversation.deleted", "session": {"id": sid}},
            }
    return data


# 这些 handler 签名为 5 参（末位 tasks: 订阅/泵状态），其余为 4 参。
# turn.start 会在启动 turn 前先订阅会话频道（见 ws.py _handle_turn_start），
# 因此和 subscribe 一样需要 tasks；漏传会抛 TypeError 被吞，导致 turn 静默不启动。
_HANDLERS_NEEDING_TASKS = {"subscribe", "turn.start"}


def _get_rpc_handlers() -> dict[str, Any]:
    """懒加载 WS RPC handlers，避免循环导入"""
    from code_lite_backend.api.routes.ws import (
        _handle_approval_decision,
        _handle_attachment_get,
        _handle_attachment_upload,
        _handle_conversation_archive,
        _handle_conversation_config_update,
        _handle_conversation_create,
        _handle_conversation_delete,
        _handle_conversation_get,
        _handle_conversation_list,
        _handle_diff_get,
        _handle_fs_list,
        _handle_fs_mkdir,
        _handle_fs_read_file,
        _handle_input_response,
        _handle_session_initialize,
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
        "fs.list": _handle_fs_list,
        "fs.mkdir": _handle_fs_mkdir,
        "fs.readFile": _handle_fs_read_file,
        "conversation.create": _handle_conversation_create,
        "conversation.config.update": _handle_conversation_config_update,
        "conversation.archive": _handle_conversation_archive,
        "conversation.delete": _handle_conversation_delete,
        "session.initialize": _handle_session_initialize,
        "diff.get": _handle_diff_get,
        "attachment.upload": _handle_attachment_upload,
        "attachment.get": _handle_attachment_get,
    }


@dataclass
class RemoteBridgeConfig:
    """远程桥接配置"""
    enabled: bool = False
    relay_url: str = "ws://localhost:18766/ws"
    pair_key: str = ""  # hex string
    room_id: str = ""   # SHA256(pair_key) hex
    # 新接入设备默认是否只读（0710 第 6 节）。True=首连须宿主确认才可介入；
    # False=接入即 operator（默认，契合"随时介入"目标，但仍需首连确认）。
    default_readonly: bool = False


class _PeerSession:
    """每个远端 peer 的连接会话（0710 第 4.1 节）。

    - 冒充 WebSocket，让 ws.py 的 RPC handler 通过 send_json 把响应回给该 peer。
    - 持有 peer 独立的 pump_tasks（按 channel），避免多设备订阅同一会话时串台（1.4）。
    - 发送时路由字段只放外层中继信封 to/from（3.1），业务 payload 为黑盒。
    """

    def __init__(self, real_ws: websockets.ClientConnection, peer_id: str) -> None:
        self._real_ws = real_ws
        self.peer_id = peer_id
        self.pump_tasks: dict[str, asyncio.Task] = {}
        # 权限角色：pending（新接入未确认，只读）| viewer（只读）| operator（可介入）。
        # 见 docs/design/0710-REMOTE-CONTROL-PROTOCOL-FIX.md 第 6 节。
        self.role: str = "pending"
        self.connected_at: float = time.time()

    async def send_json(self, data: dict) -> None:
        # remote 出站边界统一过滤：已归档会话不进数据包（覆盖 list 结果 + archived 增量事件）。
        data = _strip_archived_for_remote(data)
        envelope = {"type": "msg", "to": self.peer_id, "from": "host", "payload": data}
        await self._real_ws.send(json.dumps(envelope, ensure_ascii=False))

    def cancel_pumps(self) -> None:
        for task in self.pump_tasks.values():
            task.cancel()
        self.pump_tasks.clear()


# 各 RPC 方法所需的最低权限等级（0710 第 3.3 节）。
# viewer 只读；operator 可发消息/审批/新建/归档/删除等介入操作。
_METHOD_MIN_ROLE: dict[str, str] = {
    "subscribe": "viewer",
    "unsubscribe": "viewer",
    "conversation.list": "viewer",
    "conversation.get": "viewer",
    "session.initialize": "viewer",
    "diff.get": "viewer",
    "attachment.get": "viewer",
    # 读取会话工作区内单个文件（聊天正文文件引用查看），限制在 workspace 内，viewer 可用。
    "fs.readFile": "viewer",
    # 目录浏览/新建会暴露并修改宿主机真实文件树，要求 operator（与新建会话同级）
    "fs.list": "operator",
    "fs.mkdir": "operator",
    "conversation.create": "operator",
    "conversation.config.update": "operator",
    "conversation.archive": "operator",
    "conversation.delete": "operator",
    "attachment.upload": "operator",
    "turn.start": "operator",
    "turn.cancel": "operator",
    "approval.decision": "operator",
    "input.response": "operator",
}

_ROLE_RANK: dict[str, int] = {"pending": 0, "viewer": 1, "operator": 2, "owner": 3}


def _role_allows(role: str, method: str) -> bool:
    required = _METHOD_MIN_ROLE.get(method, "operator")
    return _ROLE_RANK.get(role, 0) >= _ROLE_RANK.get(required, 2)


class RemoteBridge:
    """远程桥接服务"""

    def __init__(self, config_path: Path, services: Any) -> None:
        self._config_path = config_path
        self._services = services
        self._config = self._load_config()
        self._ws: websockets.ClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._running = False
        self._remote_peers: dict[str, _PeerSession] = {}  # peerId -> peer session

    @property
    def config(self) -> RemoteBridgeConfig:
        return self._config

    def peer_list(self) -> list[dict[str, Any]]:
        """当前已接入设备列表（供设置页展示 + 踢出，0710 第 6 节）。"""
        return [
            {"peerId": p.peer_id, "role": p.role, "connectedAt": p.connected_at}
            for p in self._remote_peers.values()
        ]

    def authorize_peer(self, peer_id: str, role: str = "operator") -> bool:
        """宿主确认某设备并赋予角色（viewer/operator）。"""
        peer = self._remote_peers.get(peer_id)
        if peer is None:
            return False
        if role not in ("viewer", "operator"):
            role = "operator"
        peer.role = role
        logger.info("peer %s authorized as %s", peer_id, role)
        return True

    async def kick_peer(self, peer_id: str) -> bool:
        """踢出设备：取消其订阅并拒绝后续命令（软断开，0710 第 6 节）。"""
        peer = self._remote_peers.pop(peer_id, None)
        if peer is None:
            return False
        peer.cancel_pumps()
        logger.info("peer %s kicked", peer_id)
        return True

    def _register_peer(self, peer_id: str) -> None:
        """登记（或覆盖）一个远端 peer 会话。

        握手阶段（中继在 host 重连时先补发 peer.joined 再发 ready）与主循环里的
        peer.joined 分支共用此逻辑，避免两处重复且保证 peer 一定被登记。
        """
        if not peer_id or self._ws is None:
            return
        logger.info("remote peer joined: %s", peer_id)
        # 每个 peer 一个独立会话（含独立 pump_tasks），互不串台（0710 第 4.1 节）。
        peer = _PeerSession(self._ws, peer_id)
        # 默认权限跟随配置（0709 设计 8.4）：远端默认 operator（随时介入），
        # 仅当宿主开启"新接入设备默认只读"时才落为 viewer，由宿主在设置页升权。
        peer.role = "viewer" if self._config.default_readonly else "operator"
        self._remote_peers[peer_id] = peer
        # 通知本地前端刷新设备列表（并可据此提示有新设备接入）
        self._notify_local({
            "type": "remote.peer.joined",
            "peerId": peer_id,
            "role": peer.role,
            "defaultReadonly": self._config.default_readonly,
        })

    def _notify_local(self, event: dict[str, Any]) -> None:
        """向本地前端（宿主）推一条 presence 事件，走全局频道总线。

        用于首连确认弹窗、设备列表刷新等。本地 WS 订阅了 "*" 频道。
        """
        bus = self._services.event_bus
        if bus is not None:
            bus.publish("*", event)

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
                default_readonly=data.get("default_readonly", False),
            )
        return RemoteBridgeConfig()

    def save_config(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        self._config_path.write_text(json.dumps({
            "enabled": self._config.enabled,
            "relay_url": self._config.relay_url,
            "pair_key": self._config.pair_key,
            "room_id": self._config.room_id,
            "default_readonly": self._config.default_readonly,
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
        for peer in self._remote_peers.values():
            peer.cancel_pumps()
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
            started = time.monotonic()
            try:
                await self._connect_and_run()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("remote bridge disconnected: %s", e)
            # 退避对所有退出路径生效（含正常 return），保证连接尝试之间至少间隔 5s，
            # 任何单点回归都不会把中继/CPU 打爆（reconnect storm 兜底）。
            if self._running:
                elapsed = time.monotonic() - started
                await asyncio.sleep(max(0.0, 5.0 - elapsed))

    async def _connect_and_run(self) -> None:
        logger.info("connecting to relay %s (room %s)", self._config.relay_url, self._config.room_id[:12])
        # max_size 放宽到 32 MiB：远端图片附件经 base64 走 WS，单张 10 MB 图片编码后约 13.3 MB，
        # 默认 1 MiB 会导致中继帧过大直接断开。此上限覆盖单条 attachment.upload 消息。
        async with websockets.connect(self._config.relay_url, max_size=32 * 1024 * 1024) as ws:
            self._ws = ws
            await ws.send(json.dumps({
                "type": "hello",
                "role": "host",
                "roomId": self._config.room_id,
            }))
            # 握手：等待 ready，但容忍 ready 之前先到达的控制帧。
            # 中继在 host 重连且房间已有等待中的 remote 时，会先补发一批 peer.joined
            # 再发 ready（见 proxy_server handle_hello）。旧代码只 recv 一次并断言首帧即
            # ready，于是把 peer.joined 误判为 rejected 直接 return；而 _run 的重连退避
            # 只在 except 分支，正常 return 会立即重连 → 疯狂爆破中继（reconnect storm）。
            pending_peers: list[str] = []
            while True:
                frame = json.loads(await ws.recv())
                ftype = frame.get("type")
                if ftype == "ready":
                    logger.info("connected to relay")
                    break
                if ftype == "peer.joined":
                    # 先缓存，待 self._ws 就位后统一登记（保持与主循环一致的 peer 会话）。
                    pending_peers.append(frame.get("peerId", ""))
                    continue
                if ftype == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    continue
                # 真正的拒绝（bad_room/room_has_host 等）：抛出交由 _run 退避重连。
                logger.error("relay rejected: %s", frame)
                raise ConnectionError(f"relay rejected: {frame}")

            # ready 之后 self._ws 已可用，登记握手期间收到的 peer。
            for pid in pending_peers:
                self._register_peer(pid)

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
                        self._register_peer(msg.get("peerId", ""))
                    elif msg_type == "peer.left":
                        peer_id = msg.get("peerId", "")
                        logger.info("remote peer left: %s", peer_id)
                        peer = self._remote_peers.pop(peer_id, None)
                        if peer is not None:
                            peer.cancel_pumps()
                        self._notify_local({"type": "remote.peer.left", "peerId": peer_id})
                    elif msg_type == "msg":
                        payload = msg.get("payload", {})
                        # 路由来源取自外层 from（中继强制覆盖为真实 peerId，防伪造）。
                        peer_id = msg.get("from", "")
                        if isinstance(payload, dict):
                            await self._handle_rpc(payload, peer_id)
                    elif msg_type == "host.offline":
                        pass  # 不应该收到
            finally:
                self._ws = None
                for peer in self._remote_peers.values():
                    peer.cancel_pumps()
                self._remote_peers.clear()

    async def _handle_rpc(self, payload: dict, peer_id: str) -> None:
        """将中继收到的 RPC 路由到本地 WS handler（每 peer 独立订阅状态）。"""
        kind = payload.get("kind", "")
        if kind != "req":
            return
        method = payload.get("method", "")
        request_id = payload.get("requestId")
        rpc_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}

        peer = self._remote_peers.get(peer_id)
        if peer is None:
            logger.warning("rpc from unknown peer %s: %s", peer_id, method)
            return

        # 权限校验（0710 第 6 节）：pending 设备只允许只读观看类方法，
        # 介入类方法（turn.start/审批/新建等）需宿主确认为 operator 后才放行。
        effective_role = "viewer" if peer.role == "pending" else peer.role
        if not _role_allows(effective_role, method):
            await peer.send_json(_envelope(
                "error", requestId=request_id,
                payload={"code": "forbidden", "method": method, "role": peer.role},
            ))
            return

        services = self._services

        try:
            handlers = _get_rpc_handlers()
            if method == "unsubscribe":
                channel = str(rpc_payload.get("channel") or "")
                task = peer.pump_tasks.pop(channel, None)
                if task is not None:
                    task.cancel()
                await peer.send_json(_envelope("result", requestId=request_id, payload={"ok": True}))
            elif method in handlers:
                handler = handlers[method]
                # 远端发起的 turn.start 注入 _startedBy 标记供 sync 协议识别来源
                if method == "turn.start":
                    rpc_payload = {**rpc_payload, "_startedBy": "remote"}
                # 远端发起的配置更新注入 _changedBy 标记
                if method == "conversation.config.update":
                    rpc_payload = {**rpc_payload, "_changedBy": "remote"}
                # subscribe 与 turn.start 需要 tasks 参数（订阅状态）；其余 handler 只需 4 参。
                # 见 docs/design/0710-REMOTE-CONTROL-PROTOCOL-FIX.md 第 1.1 节。
                # tasks 用 peer 独立的 pump_tasks，保证多设备互不串台（第 4.3 节）。
                if method in _HANDLERS_NEEDING_TASKS:
                    await handler(peer, services, request_id, rpc_payload, peer.pump_tasks)
                else:
                    await handler(peer, services, request_id, rpc_payload)
            else:
                await peer.send_json(_envelope(
                    "error", requestId=request_id,
                    payload={"code": "method_not_implemented", "method": method},
                ))
        except Exception:
            logger.exception("rpc dispatch failed: method=%s peer=%s", method, peer_id)
            try:
                await peer.send_json(_envelope(
                    "error", requestId=request_id,
                    payload={"code": "internal_error"},
                ))
            except Exception:
                pass

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        self.save_config()
