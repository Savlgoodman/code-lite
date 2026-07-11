from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


class ToolApprovalRejected(RuntimeError):
    pass


@dataclass(frozen=True)
class PendingApproval:
    conversation_id: str
    future: asyncio.Future[bool]
    turn_id: str
    # 创建审批时的展示 payload（approval.required 事件体），供重新附着时回传快照。
    payload: dict[str, Any] = field(default_factory=dict)


class ApprovalBroker:
    def __init__(self) -> None:
        self._pending: dict[str, PendingApproval] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        *,
        approval_id: str,
        conversation_id: str,
        turn_id: str,
        payload: dict[str, Any] | None = None,
    ) -> asyncio.Future[bool]:
        async with self._lock:
            future = asyncio.get_running_loop().create_future()
            self._pending[approval_id] = PendingApproval(
                conversation_id=conversation_id,
                future=future,
                turn_id=turn_id,
                payload=dict(payload or {}),
            )
            return future

    async def resolve(self, approval_id: str, decision: bool) -> PendingApproval | None:
        async with self._lock:
            pending = self._pending.pop(approval_id, None)
        if pending is None or pending.future.done():
            return None
        pending.future.set_result(decision)
        return pending

    def list_for_conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        """返回某会话所有挂起审批的展示 payload（重新附着时恢复审批卡片用）。"""
        return [
            dict(pending.payload)
            for pending in self._pending.values()
            if pending.conversation_id == conversation_id and pending.payload
        ]

    async def reject_all(self) -> None:
        async with self._lock:
            futures = [pending.future for pending in self._pending.values()]
            self._pending.clear()
        for future in futures:
            if not future.done():
                future.set_result(False)

    async def reject_for_conversations(self, conversation_ids: set[str]) -> None:
        async with self._lock:
            matched = [
                approval_id
                for approval_id, pending in self._pending.items()
                if pending.conversation_id in conversation_ids
            ]
            futures = [self._pending.pop(approval_id).future for approval_id in matched]
        for future in futures:
            if not future.done():
                future.set_result(False)
