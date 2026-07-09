from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

AgentEvent = dict[str, Any]

# 全局会话列表频道：会话增删改事件走此频道（见 0709 设计 5.3）。
GLOBAL_CHANNEL = "*"

# 单个订阅者队列的最大缓冲；超出则丢弃最旧事件并记一次告警，
# 避免慢订阅者拖垮 turn 执行或无限占用内存。
_DEFAULT_QUEUE_MAXSIZE = 1000


class Subscription:
    """单个订阅者。异步迭代即可消费事件。

    通过 `async for event in subscription:` 消费，或 `await subscription.get()`。
    调用 `close()` 或退出 `async with` 时自动从总线注销。
    """

    def __init__(self, bus: "SessionEventBus", channel: str, maxsize: int) -> None:
        self._bus = bus
        self._channel = channel
        self._queue: asyncio.Queue[AgentEvent] = asyncio.Queue(maxsize=maxsize)
        self._closed = False
        self._dropped = 0

    @property
    def channel(self) -> str:
        return self._channel

    def _offer(self, event: AgentEvent) -> None:
        """由总线调用，投递一个事件（非阻塞）。"""
        if self._closed:
            return
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # 丢弃最旧事件，保留最新（订阅者可用快照重新对齐）。
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 100 == 0:
                logger.warning(
                    "SessionEventBus subscriber on channel=%s is slow, dropped %d events",
                    self._channel,
                    self._dropped,
                )
            try:
                self._queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def get(self) -> AgentEvent:
        return await self._queue.get()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._bus._remove(self._channel, self)

    def __aiter__(self) -> "Subscription":
        return self

    async def __anext__(self) -> AgentEvent:
        if self._closed and self._queue.empty():
            raise StopAsyncIteration
        return await self._queue.get()

    async def __aenter__(self) -> "Subscription":
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.close()


class SessionEventBus:
    """进程内会话事件总线（见 0709 设计 5.1）。

    按 conversationId 分频道，publish 向该频道的所有订阅者 fan-out。
    与 turn 的发起连接无关：任一端订阅都能收到同一批事件。
    """

    def __init__(self, queue_maxsize: int = _DEFAULT_QUEUE_MAXSIZE) -> None:
        self._channels: dict[str, set[Subscription]] = {}
        self._queue_maxsize = queue_maxsize

    def subscribe(self, channel: str) -> Subscription:
        subscription = Subscription(self, channel, self._queue_maxsize)
        self._channels.setdefault(channel, set()).add(subscription)
        return subscription

    def _remove(self, channel: str, subscription: Subscription) -> None:
        subscribers = self._channels.get(channel)
        if subscribers is None:
            return
        subscribers.discard(subscription)
        if not subscribers:
            self._channels.pop(channel, None)

    def publish(self, channel: str, event: AgentEvent) -> None:
        """向某频道的所有订阅者投递事件（非阻塞、同步调用安全）。"""
        for subscription in tuple(self._channels.get(channel, ())):
            subscription._offer(event)

    def subscriber_count(self, channel: str) -> int:
        return len(self._channels.get(channel, ()))
