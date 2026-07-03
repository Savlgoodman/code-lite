from __future__ import annotations

import asyncio
from dataclasses import dataclass


class ToolApprovalRejected(RuntimeError):
    pass


@dataclass(frozen=True)
class PendingApproval:
    conversation_id: str
    future: asyncio.Future[bool]
    turn_id: str


class ApprovalBroker:
    def __init__(self) -> None:
        self._pending: dict[str, PendingApproval] = {}
        self._lock = asyncio.Lock()

    async def create(self, *, approval_id: str, conversation_id: str, turn_id: str) -> asyncio.Future[bool]:
        async with self._lock:
            future = asyncio.get_running_loop().create_future()
            self._pending[approval_id] = PendingApproval(
                conversation_id=conversation_id,
                future=future,
                turn_id=turn_id,
            )
            return future

    async def resolve(self, approval_id: str, decision: bool) -> PendingApproval | None:
        async with self._lock:
            pending = self._pending.pop(approval_id, None)
        if pending is None or pending.future.done():
            return None
        pending.future.set_result(decision)
        return pending

    async def reject_all(self) -> None:
        async with self._lock:
            futures = [pending.future for pending in self._pending.values()]
            self._pending.clear()
        for future in futures:
            if not future.done():
                future.set_result(False)
