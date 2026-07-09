from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from code_lite_backend.api.routes.conversations import create_conversation_record
from code_lite_backend.api.routes.turns import prepare_and_start_turn
from code_lite_backend.services.event_bus import GLOBAL_CHANNEL
from code_lite_backend.services.runtime import AppServices

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
    if services.event_bus is not None:
        services.event_bus.publish(
            conversation_id,
            {"type": "conversation.config.updated", "conversationId": conversation_id, "config": config},
        )
    await _send(ws, _envelope("result", requestId=request_id, payload={"session": updated}))


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
            elif method == "conversation.create":
                await _handle_conversation_create(ws, services, request_id, payload)
            elif method == "conversation.config.update":
                await _handle_conversation_config_update(ws, services, request_id, payload)
            elif method == "remote.config.get":
                bridge = services.remote_bridge
                cfg = bridge.config if bridge else None
                await _send(ws, _envelope("result", requestId=request_id, payload={
                    "enabled": cfg.enabled if cfg else False,
                    "relayUrl": cfg.relay_url if cfg else "",
                    "pairKey": cfg.pair_key if cfg else "",
                    "roomId": cfg.room_id if cfg else "",
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
