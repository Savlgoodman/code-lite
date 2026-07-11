from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from code_lite_backend.api.routes.conversations import create_conversation_record
from code_lite_backend.api.routes.turns import prepare_and_start_turn
from code_lite_backend.services.event_bus import GLOBAL_CHANNEL
from code_lite_backend.services.runtime import AppServices
from code_lite_backend.services.sync_protocol import (
    broadcast_to_all,
    create_sync_event,
    SyncEvents,
)

logger = logging.getLogger(__name__)

router = APIRouter()

WIRE_VERSION = 1


def _envelope(kind: str, **fields: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {"v": WIRE_VERSION, "kind": kind}
    envelope.update({key: value for key, value in fields.items() if value is not None})
    return envelope


async def _send(ws: WebSocket, message: dict[str, Any]) -> None:
    await ws.send_json(message)


def _ensure_channel_pump(
    ws: WebSocket,
    services: AppServices,
    channel: str,
    tasks: dict[str, asyncio.Task[None]],
) -> bool:
    """确保本连接已订阅某频道并在后台把事件泵给客户端。

    幂等：已订阅则直接返回 False（未新建）。新建订阅返回 True。
    订阅在返回前同步完成（bus.subscribe 无 await），供 turn.start 在启动 turn 前
    先订阅，杜绝 draft 会话的早期事件竞态。
    """
    if channel in tasks and not tasks[channel].done():
        return False
    bus = services.event_bus
    if bus is None:
        return False
    subscription = bus.subscribe(channel)  # 无 await

    async def pump() -> None:
        try:
            async for event in subscription:
                await _send(
                    ws,
                    _envelope("event", channel=channel, seq=event.get("sequence"), payload=event),
                )
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            logger.exception("ws pump failed for channel=%s", channel)
        finally:
            subscription.close()

    tasks[channel] = asyncio.create_task(pump())
    return True


async def _handle_subscribe(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
    tasks: dict[str, asyncio.Task[None]],
) -> None:
    """订阅一个会话频道：先回快照，再持续推增量事件（0709 设计 5.2）。

    订阅总线与取快照之间不能有 await：单线程 asyncio 下 turn 任务无法在其间穿插，
    因此快照恰好反映订阅时刻状态，之后缓冲的事件严格更新，不丢不重。
    """
    bus = services.event_bus
    if bus is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "bus_unavailable"}))
        return

    channel = str(payload.get("channel") or "").strip()
    if not channel:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_channel"}))
        return

    # 已订阅同频道则先撤销旧订阅，保证快照与增量对齐
    existing = tasks.pop(channel, None)
    if existing is not None:
        existing.cancel()

    _ensure_channel_pump(ws, services, channel, tasks)  # 订阅同步建立
    snapshot: dict[str, Any] | None = None
    latest_sequence = 0
    if channel != GLOBAL_CHANNEL:
        snapshot = services.conversation_recorder.snapshot(channel)  # 无 await
        if services.event_store is not None:
            latest_sequence = await services.event_store.get_latest_sequence(channel)

    await _send(
        ws,
        _envelope(
            "snapshot",
            channel=channel,
            requestId=request_id,
            payload={
                "snapshot": snapshot,
                "latestSequence": latest_sequence,
            },
        ),
    )


async def _handle_turn_start(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
    tasks: dict[str, asyncio.Task[None]],
) -> None:
    """启动一个 turn。事件通过会话频道 event 回流，result 仅回带受理信息。

    关键：在启动 turn 前先解析出 conversationId 并订阅该频道，杜绝 draft 会话
    (无 conversationId) 的早期事件竞态——由后端保证订阅早于 turn 任务启动。
    """
    # 预解析 conversationId（draft 场景后端生成），注入 payload 后再订阅，保证频道一致
    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        conversation_id = services.conversation_recorder.create_conversation_id()
        payload = {**payload, "conversationId": conversation_id}
    _ensure_channel_pump(ws, services, conversation_id, tasks)  # 订阅早于 turn 启动

    outcome = await prepare_and_start_turn(services, payload)
    if outcome.busy:
        await _send(
            ws,
            _envelope("error", requestId=request_id, payload={"code": "busy", "conversationId": outcome.conversation_id}),
        )
        return
    if outcome.error is not None:
        await _send(
            ws,
            _envelope(
                "error",
                requestId=request_id,
                payload={"code": "turn_start_failed", "error": outcome.error, "conversationId": outcome.conversation_id},
            ),
        )
        return
    await _send(
        ws,
        _envelope(
            "result",
            requestId=request_id,
            payload={"conversationId": outcome.conversation_id, "turnId": outcome.turn_id},
        ),
    )


async def _handle_turn_cancel(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    turn_id = str(payload.get("turnId") or "").strip()
    if turn_id:
        await services.agent_adapter.cancel_turn(turn_id)
        await services.approvals.reject_all()
        await services.inputs.cancel_all()
    await _send(ws, _envelope("result", requestId=request_id, payload={"ok": True}))


async def _handle_approval_decision(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    approval_id = str(payload.get("approvalId") or "").strip()
    decision = str(payload.get("decision") or "").strip()
    resolved = await services.approvals.resolve(approval_id, decision == "allow")
    await _send(ws, _envelope("result", requestId=request_id, payload={"ok": resolved is not None}))


async def _handle_input_response(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    input_request_id = str(payload.get("inputRequestId") or "").strip()
    action = str(payload.get("action") or "").lower()
    if action not in {"accept", "decline", "cancel"}:
        action = "cancel"
    content = payload.get("content")
    pending = await services.inputs.resolve(
        input_request_id,
        action=action,  # type: ignore[arg-type]
        content=content if isinstance(content, dict) else None,
    )
    if pending is not None:
        services.conversation_recorder.update_session(
            pending.conversation_id,
            {"status": "running" if action in {"accept", "decline"} else "error"},
        )
    await _send(ws, _envelope("result", requestId=request_id, payload={"ok": pending is not None}))


async def _handle_conversation_list(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    sessions = services.conversation_store.list_sessions()
    await _send(ws, _envelope("result", requestId=request_id, payload={"sessions": sessions}))


async def _handle_fs_list(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """列出宿主机某目录下的子目录，供远端新建会话时浏览工作区路径。

    仅返回目录（新建会话选的是工作区文件夹，无需列文件）。path 为空时返回
    用户 home 目录内容 + 盘符（Windows）作为浏览起点。远端需 operator 权限
    （见 remote_bridge._METHOD_MIN_ROLE），故仅已配对且授权的设备可浏览。
    """
    import os
    import string as _string
    from pathlib import Path

    raw = str(payload.get("path") or "").strip()

    def _drives() -> list[dict[str, Any]]:
        # Windows 盘符列表（浏览起点之一）；非 Windows 返回空
        if os.name != "nt":
            return []
        found: list[dict[str, Any]] = []
        for letter in _string.ascii_uppercase:
            root = f"{letter}:\\"
            if os.path.exists(root):
                found.append({"name": root, "path": root, "isDir": True})
        return found

    try:
        if not raw:
            base = Path.home()
        else:
            base = Path(raw).expanduser()
            try:
                base = base.resolve()
            except OSError:
                base = base.absolute()

        if not base.exists() or not base.is_dir():
            await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_a_directory", "path": str(base)}))
            return

        entries: list[dict[str, Any]] = []
        try:
            for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
                try:
                    if not child.is_dir():
                        continue
                    name = child.name
                    if name.startswith("."):
                        continue  # 跳过隐藏目录，减少噪音
                    entries.append({"name": name, "path": str(child), "isDir": True})
                except OSError:
                    continue
        except PermissionError:
            await _send(ws, _envelope("error", requestId=request_id, payload={"code": "permission_denied", "path": str(base)}))
            return

        parent = str(base.parent) if base.parent != base else None
        await _send(ws, _envelope("result", requestId=request_id, payload={
            "path": str(base),
            "parent": parent,
            "entries": entries,
            "drives": _drives(),
        }))
    except Exception:
        logger.exception("fs.list failed for path=%s", raw)
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "internal_error"}))


async def _handle_fs_mkdir(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """在宿主机某目录下新建一个文件夹，供远端浏览器创建工作区目录。

    要求 operator 权限（见 remote_bridge._METHOD_MIN_ROLE）。name 只允许单层
    文件夹名，禁止路径分隔符与 .. 以防跳出父目录。返回新目录信息。
    """
    import os
    from pathlib import Path

    raw_parent = str(payload.get("path") or "").strip()
    name = str(payload.get("name") or "").strip()

    if not raw_parent:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_path"}))
        return
    if not name:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_name"}))
        return
    # 只允许单层名字，拒绝分隔符/上跳/盘符，防止越出父目录
    if name in (".", "..") or "/" in name or "\\" in name or os.sep in name or (os.altsep and os.altsep in name) or ":" in name:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_name"}))
        return

    try:
        parent = Path(raw_parent).expanduser()
        try:
            parent = parent.resolve()
        except OSError:
            parent = parent.absolute()

        if not parent.exists() or not parent.is_dir():
            await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_a_directory", "path": str(parent)}))
            return

        target = parent / name
        if target.exists():
            await _send(ws, _envelope("error", requestId=request_id, payload={"code": "already_exists", "path": str(target)}))
            return

        try:
            target.mkdir()
        except PermissionError:
            await _send(ws, _envelope("error", requestId=request_id, payload={"code": "permission_denied", "path": str(parent)}))
            return

        await _send(ws, _envelope("result", requestId=request_id, payload={
            "path": str(target),
            "name": name,
            "isDir": True,
        }))
    except Exception:
        logger.exception("fs.mkdir failed for path=%s name=%s", raw_parent, name)
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "internal_error"}))


async def _handle_conversation_get(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    conversation_id = str(payload.get("conversationId") or "").strip()
    # 活动态优先（含运行中 turn 的累积文本），回退落盘
    snapshot = services.conversation_recorder.snapshot(conversation_id)
    if snapshot is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return
    await _send(ws, _envelope("result", requestId=request_id, payload=snapshot))


async def _handle_conversation_create(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    result = create_conversation_record(services, payload)
    await _send(ws, _envelope("result", requestId=request_id, payload=result))
    # 会话列表变更广播到全局频道，供其他端实时更新列表
    if services.event_bus is not None:
        services.event_bus.publish(
            GLOBAL_CHANNEL,
            {"type": "conversation.created", "session": result["session"]},
        )


async def _handle_conversation_config_update(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_conversation_id"}))
        return
    config = payload.get("config")
    if not isinstance(config, dict):
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_config"}))
        return
    # 复用 HTTP 路由的保存 + 广播逻辑（设计 5.3）
    try:
        session = services.conversation_store._read_session(conversation_id)
    except ValueError:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_conversation_id"}))
        return
    if session is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return
    updates = {**session, "config": config}
    updated = services.conversation_store.save_session(conversation_id, updates)
    changed_by = str(payload.get("_changedBy") or "host")
    # 配置变更走统一 sync 协议（0710）：会话频道供选择器跟随，全局频道备用。
    if services.event_bus is not None:
        broadcast_to_all(services.event_bus, conversation_id, SyncEvents.CONFIG_BATCH, {
            "conversationId": conversation_id,
            "changes": config,
            "changedBy": changed_by,
        })
    await _send(ws, _envelope("result", requestId=request_id, payload={"session": updated}))


async def _handle_conversation_archive(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """归档/取消归档会话，并广播到全局频道（0710 第 5.2 节，远端也能发起）。"""
    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_conversation_id"}))
        return
    archived = bool(payload.get("archived"))
    try:
        session = services.conversation_store.update_archive_state(conversation_id, archived=archived)
    except ValueError:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_conversation_id"}))
        return
    if session is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return
    if archived and services.runtime_manager is not None:
        await services.runtime_manager.close_session_for_conversation(
            conversation_id, delete_binding=False, close_empty_connection=True,
        )
    if services.event_bus is not None and archived:
        services.event_bus.publish(GLOBAL_CHANNEL, {"type": "conversation.archived", "session": session})
    await _send(ws, _envelope("result", requestId=request_id, payload={"session": session}))


async def _handle_conversation_delete(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """删除会话，并广播到全局频道（0710 第 5.2 节，远端也能发起）。"""
    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_conversation_id"}))
        return
    try:
        deleted = services.conversation_store.delete_conversation(conversation_id)
    except ValueError:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_conversation_id"}))
        return
    if not deleted:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return
    if services.runtime_manager is not None:
        await services.runtime_manager.close_session_for_conversation(
            conversation_id, delete_binding=True, close_empty_connection=True,
        )
    services.attachment_store.delete_conversation(conversation_id)
    if services.event_bus is not None:
        services.event_bus.publish(
            GLOBAL_CHANNEL, {"type": "conversation.deleted", "session": {"id": conversation_id}},
        )
    await _send(ws, _envelope("result", requestId=request_id, payload={"ok": True}))


async def _handle_session_initialize(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """初始化会话并返回 SessionCapabilities（0710 第 3.3 节，远端也能进入会话）。"""
    from code_lite_backend.api.routes.sessions import initialize_session_core

    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_conversation_id"}))
        return
    result, error = await initialize_session_core(services, conversation_id)
    if error is not None:
        await _send(ws, _envelope("error", requestId=request_id, payload=error))
        return
    await _send(ws, _envelope("result", requestId=request_id, payload=result))


async def _handle_diff_get(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """拉取 diff 全文（0710 第 3.3 节，远端按需懒加载，不随事件推全文）。"""
    conversation_id = str(payload.get("conversationId") or "").strip()
    diff_id = str(payload.get("diffId") or "").strip()
    if not conversation_id or not diff_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_params"}))
        return
    try:
        diff = services.diff_artifact_store.load_diff(conversation_id, diff_id)
    except ValueError:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_diff_id"}))
        return
    if diff is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return
    await _send(ws, _envelope("result", requestId=request_id, payload={"diff": diff}))


async def _handle_attachment_upload(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """上传图片附件（远端 WS 通道）：接收 base64 编码的图片数据，存储并返回元数据。

    桌面端用 HTTP multipart upload；远端没有 HTTP 通道，用此 RPC 替代。
    payload:
      conversationId, turnId, fileName, mimeType, data (base64 string),
      width, height, wasCompressed.
    """
    import base64
    import io

    from code_lite_backend.storage.attachments import (
        ALLOWED_IMAGE_MIME_TYPES,
        MAX_IMAGES_PER_TURN,
    )

    conversation_id = str(payload.get("conversationId") or "").strip()
    turn_id = str(payload.get("turnId") or "").strip()
    file_name = str(payload.get("fileName") or "").strip() or "image"
    mime_type = str(payload.get("mimeType") or "").strip().lower()
    data_b64 = str(payload.get("data") or "")
    width = payload.get("width")
    height = payload.get("height")
    was_compressed = payload.get("wasCompressed")

    if not conversation_id or not turn_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_params"}))
        return
    if mime_type not in ALLOWED_IMAGE_MIME_TYPES:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "unsupported_mime_type", "mimeType": mime_type}))
        return
    if not data_b64:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_data"}))
        return

    conversation = services.conversation_store.get_conversation(conversation_id)
    if conversation is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "conversation_not_found"}))
        return

    try:
        data_bytes = base64.b64decode(data_b64)
    except Exception:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "invalid_base64"}))
        return

    stream = io.BytesIO(data_bytes)
    try:
        metadata = services.attachment_store.save_image(
            conversation_id=conversation_id,
            turn_id=turn_id,
            filename=file_name,
            mime_type=mime_type,
            stream=stream,
            width=int(width) if isinstance(width, (int, float)) and width > 0 else None,
            height=int(height) if isinstance(height, (int, float)) and height > 0 else None,
            was_compressed=bool(was_compressed) if was_compressed is not None else None,
        )
        await _send(ws, _envelope("result", requestId=request_id, payload={"attachment": metadata}))
    except ValueError as exc:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "save_failed", "error": str(exc)}))


async def _handle_attachment_get(
    ws: WebSocket,
    services: AppServices,
    request_id: str | None,
    payload: dict[str, Any],
) -> None:
    """获取图片附件（远端 WS 通道）：返回 base64 编码的图片数据。

    桌面端用 HTTP GET；远端没有 HTTP 通道，用此 RPC 替代。
    payload: conversationId, attachmentId
    返回: {data: base64 string, mimeType, name}
    """
    import base64

    conversation_id = str(payload.get("conversationId") or "").strip()
    attachment_id = str(payload.get("attachmentId") or "").strip()

    if not conversation_id or not attachment_id:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "missing_params"}))
        return

    stored = services.attachment_store.load_image(conversation_id, attachment_id)
    if stored is None:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_found"}))
        return

    try:
        data_bytes = stored.image_path.read_bytes()
        data_b64 = base64.b64encode(data_bytes).decode("ascii")
        await _send(ws, _envelope("result", requestId=request_id, payload={
            "data": data_b64,
            "mimeType": str(stored.metadata.get("mimeType") or "image/jpeg"),
            "name": str(stored.metadata.get("name") or "image"),
        }))
    except Exception as exc:
        await _send(ws, _envelope("error", requestId=request_id, payload={"code": "read_failed", "error": str(exc)}))


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """本地/远程订阅入口（0709 阶段一）。

    当前实现只读订阅：subscribe -> snapshot -> 增量 event。
    控制命令（turn.start 等）在阶段二接入；此端点为纯新增，不影响 HTTP 路径。
    """
    services: AppServices = ws.app.state.services
    await ws.accept()
    tasks: dict[str, asyncio.Task[None]] = {}
    try:
        while True:
            message = await ws.receive_json()
            if not isinstance(message, dict):
                continue
            kind = str(message.get("kind") or "")
            method = str(message.get("method") or "")
            request_id = message.get("requestId")
            payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}

            if kind != "req":
                continue
            if method == "subscribe":
                await _handle_subscribe(ws, services, request_id, payload, tasks)
            elif method == "unsubscribe":
                channel = str(payload.get("channel") or "")
                task = tasks.pop(channel, None)
                if task is not None:
                    task.cancel()
                await _send(ws, _envelope("result", requestId=request_id, payload={"ok": True}))
            elif method == "turn.start":
                await _handle_turn_start(ws, services, request_id, payload, tasks)
            elif method == "turn.cancel":
                await _handle_turn_cancel(ws, services, request_id, payload)
            elif method == "approval.decision":
                await _handle_approval_decision(ws, services, request_id, payload)
            elif method == "input.response":
                await _handle_input_response(ws, services, request_id, payload)
            elif method == "conversation.list":
                await _handle_conversation_list(ws, services, request_id, payload)
            elif method == "conversation.get":
                await _handle_conversation_get(ws, services, request_id, payload)
            elif method == "fs.list":
                await _handle_fs_list(ws, services, request_id, payload)
            elif method == "fs.mkdir":
                await _handle_fs_mkdir(ws, services, request_id, payload)
            elif method == "conversation.create":
                await _handle_conversation_create(ws, services, request_id, payload)
            elif method == "conversation.config.update":
                await _handle_conversation_config_update(ws, services, request_id, payload)
            elif method == "conversation.archive":
                await _handle_conversation_archive(ws, services, request_id, payload)
            elif method == "conversation.delete":
                await _handle_conversation_delete(ws, services, request_id, payload)
            elif method == "session.initialize":
                await _handle_session_initialize(ws, services, request_id, payload)
            elif method == "diff.get":
                await _handle_diff_get(ws, services, request_id, payload)
            elif method == "remote.config.get":
                bridge = services.remote_bridge
                cfg = bridge.config if bridge else None
                await _send(ws, _envelope("result", requestId=request_id, payload={
                    "enabled": cfg.enabled if cfg else False,
                    "relayUrl": cfg.relay_url if cfg else "",
                    "pairKey": cfg.pair_key if cfg else "",
                    "roomId": cfg.room_id if cfg else "",
                    "defaultReadonly": cfg.default_readonly if cfg else False,
                }))
            elif method == "remote.config.update":
                bridge = services.remote_bridge
                if not bridge:
                    await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_available"}))
                else:
                    changes = {}
                    if "enabled" in payload:
                        changes["enabled"] = bool(payload["enabled"])
                    if "relayUrl" in payload:
                        changes["relay_url"] = str(payload["relayUrl"])
                    if "pairKey" in payload:
                        key = str(payload["pairKey"]).strip()
                        if key:
                            import hashlib
                            changes["pair_key"] = key
                            changes["room_id"] = hashlib.sha256(key.encode()).hexdigest()
                    if "defaultReadonly" in payload:
                        changes["default_readonly"] = bool(payload["defaultReadonly"])
                    bridge.update_config(**changes)
                    if changes.get("enabled") and bridge.config.pair_key:
                        await bridge.stop()
                        await bridge.start()
                    elif changes.get("enabled") is False:
                        await bridge.stop()
                    await _send(ws, _envelope("result", requestId=request_id, payload={
                        "enabled": bridge.config.enabled,
                        "relayUrl": bridge.config.relay_url,
                        "pairKey": bridge.config.pair_key,
                        "roomId": bridge.config.room_id,
                    }))
            elif method == "remote.peers.list":
                bridge = services.remote_bridge
                peers = bridge.peer_list() if bridge else []
                await _send(ws, _envelope("result", requestId=request_id, payload={"peers": peers}))
            elif method == "remote.peer.authorize":
                bridge = services.remote_bridge
                peer_id = str(payload.get("peerId") or "").strip()
                role = str(payload.get("role") or "operator").strip()
                ok = bool(bridge and peer_id and bridge.authorize_peer(peer_id, role))
                await _send(ws, _envelope("result", requestId=request_id, payload={"ok": ok}))
            elif method == "remote.peer.kick":
                bridge = services.remote_bridge
                peer_id = str(payload.get("peerId") or "").strip()
                ok = bool(bridge and peer_id and await bridge.kick_peer(peer_id))
                await _send(ws, _envelope("result", requestId=request_id, payload={"ok": ok}))
            elif method == "remote.config.generate_key":
                bridge = services.remote_bridge
                if not bridge:
                    await _send(ws, _envelope("error", requestId=request_id, payload={"code": "not_available"}))
                else:
                    key = bridge.generate_pair_key()
                    bridge.update_config(enabled=True)
                    await bridge.stop()
                    await bridge.start()
                    await _send(ws, _envelope("result", requestId=request_id, payload={
                        "pairKey": key,
                        "roomId": bridge.config.room_id,
                    }))
            elif method == "attachment.upload":
                await _handle_attachment_upload(ws, services, request_id, payload)
            elif method == "attachment.get":
                await _handle_attachment_get(ws, services, request_id, payload)
            else:
                await _send(
                    ws,
                    _envelope("error", requestId=request_id, payload={"code": "method_not_implemented", "method": method}),
                )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("ws endpoint error")
    finally:
        for task in tasks.values():
            task.cancel()
