from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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

    # 已订阅同频道则先撤销旧订阅
    existing = tasks.pop(channel, None)
    if existing is not None:
        existing.cancel()

    subscription = bus.subscribe(channel)  # 无 await
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
            else:
                # 其余 RPC 方法在阶段二接入
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
