from __future__ import annotations

import asyncio
from typing import Awaitable, Callable


class ActiveTurnRegistry:
    """会话级活动 turn 注册表（0709 设计 5.1.1）。

    turn 在会话拥有的后台 task 中执行，与发起它的连接无关：
    连接断开只影响 NDJSON/WS 中继，不取消 task；只有显式 cancel 才停。
    每个 conversationId 同一时刻至多一个活动 turn。
    """

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def is_running(self, conversation_id: str) -> bool:
        task = self._tasks.get(conversation_id)
        return task is not None and not task.done()

    def active_turn_task(self, conversation_id: str) -> asyncio.Task[None] | None:
        task = self._tasks.get(conversation_id)
        if task is not None and not task.done():
            return task
        return None

    def start(
        self,
        conversation_id: str,
        run: Callable[[], Awaitable[None]],
    ) -> asyncio.Task[None]:
        """为会话启动一个后台 turn task。若已有活动 turn，抛出 RuntimeError。"""
        if self.is_running(conversation_id):
            raise RuntimeError(f"conversation {conversation_id} already has an active turn")
        task = asyncio.create_task(run())
        self._tasks[conversation_id] = task

        def _cleanup(completed: asyncio.Task[None]) -> None:
            if self._tasks.get(conversation_id) is completed:
                self._tasks.pop(conversation_id, None)

        task.add_done_callback(_cleanup)
        return task
