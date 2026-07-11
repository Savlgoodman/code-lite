from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal


InputAction = Literal["accept", "decline", "cancel"]


@dataclass(frozen=True)
class InputResponse:
    action: InputAction
    content: dict[str, Any] | None = None


@dataclass(frozen=True)
class PendingInput:
    conversation_id: str
    future: asyncio.Future[InputResponse]
    turn_id: str
    # 创建输入请求时的展示 payload（agent.input.required 事件体），供重新附着时回传快照。
    payload: dict[str, Any] = field(default_factory=dict)


class InputBroker:
    def __init__(self) -> None:
        self._pending: dict[str, PendingInput] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        *,
        input_id: str,
        conversation_id: str,
        turn_id: str,
        payload: dict[str, Any] | None = None,
    ) -> asyncio.Future[InputResponse]:
        async with self._lock:
            future = asyncio.get_running_loop().create_future()
            self._pending[input_id] = PendingInput(
                conversation_id=conversation_id,
                future=future,
                turn_id=turn_id,
                payload=dict(payload or {}),
            )
            return future

    def list_for_conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        """返回某会话所有挂起输入请求的展示 payload（重新附着时恢复卡片用）。"""
        return [
            dict(pending.payload)
            for pending in self._pending.values()
            if pending.conversation_id == conversation_id and pending.payload
        ]

    async def resolve(
        self,
        input_id: str,
        *,
        action: InputAction,
        content: dict[str, Any] | None = None,
    ) -> PendingInput | None:
        async with self._lock:
            pending = self._pending.pop(input_id, None)
        if pending is None or pending.future.done():
            return None
        pending.future.set_result(InputResponse(action=action, content=content))
        return pending

    async def cancel_all(self) -> None:
        async with self._lock:
            futures = [pending.future for pending in self._pending.values()]
            self._pending.clear()
        for future in futures:
            if not future.done():
                future.set_result(InputResponse(action="cancel"))

    async def cancel_for_conversations(self, conversation_ids: set[str]) -> None:
        async with self._lock:
            matched = [
                input_id
                for input_id, pending in self._pending.items()
                if pending.conversation_id in conversation_ids
            ]
            futures = [self._pending.pop(input_id).future for input_id in matched]
        for future in futures:
            if not future.done():
                future.set_result(InputResponse(action="cancel"))
