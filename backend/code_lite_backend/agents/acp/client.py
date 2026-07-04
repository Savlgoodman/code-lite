from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any

from acp.exceptions import RequestError

from code_lite_backend.agents.acp.approvals import (
    build_allowed_response,
    build_denied_response,
    choose_permission_option,
)
from code_lite_backend.agents.acp.mapper import (
    AcpEventMapper,
    EventContext,
    extract_usage,
)
from code_lite_backend.agents.acp.mapper import (
    UsageSnapshot,
)
from code_lite_backend.schemas.agent import AgentEvent
from code_lite_backend.services.approvals import ApprovalBroker

logger = logging.getLogger(__name__)


@dataclass
class TurnRoute:
    """一个 turn 的路由信息：事件发往哪个 queue。"""
    conversation_id: str
    turn_id: str
    output_queue: asyncio.Queue[AgentEvent]
    native_session_id: str | None = None
    latest_usage: UsageSnapshot | None = None


class AcpClientHandler:
    """通用 ACP client handler（支持多路复用）。

    接收 ACP SDK 的回调，通过 session_id 路由到正确的 turn。
    多个 conversation 可以共享同一个 connection/handler，
    每个 turn 注册一个 TurnRoute，事件按 session_id 路由。
    """

    def __init__(
        self,
        *,
        runtime: str,
        conversation_id: str,
        turn_id: str,
        output_queue: asyncio.Queue[AgentEvent],
        approvals: ApprovalBroker,
    ) -> None:
        self.runtime = runtime
        self.approvals = approvals
        self.mapper = AcpEventMapper(runtime=runtime)
        self.stderr_tail: deque[str] = deque(maxlen=50)

        # 多路复用路由表：native_session_id -> TurnRoute
        self._routes: dict[str, TurnRoute] = {}
        # 为了向后兼容，保留当前活跃的 conversation/turn 信息
        # 当只有一个 route 时使用它，多个 route 时按 session_id 路由
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.output_queue = output_queue
        self.native_session_id: str | None = None
        self.latest_usage: UsageSnapshot | None = None

    def register_turn(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        output_queue: asyncio.Queue[AgentEvent],
        native_session_id: str | None = None,
    ) -> TurnRoute:
        """注册一个 turn 的路由。"""
        route = TurnRoute(
            conversation_id=conversation_id,
            turn_id=turn_id,
            output_queue=output_queue,
            native_session_id=native_session_id,
        )
        if native_session_id:
            self._routes[native_session_id] = route
        # 同时保存为默认 route（单 session 场景兼容）
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.output_queue = output_queue
        self.native_session_id = native_session_id
        logger.debug(
            "Registered turn route: %s/%s -> session %s",
            conversation_id[:12], turn_id[:12],
            (native_session_id or "?")[:12],
        )
        return route

    def update_route_session(self, native_session_id: str, conversation_id: str) -> None:
        """更新 route 的 native_session_id 映射（session 创建后调用）。"""
        # 找到匹配的 route（按 conversation_id）
        for session_id, route in list(self._routes.items()):
            if route.conversation_id == conversation_id:
                if session_id != native_session_id:
                    self._routes.pop(session_id, None)
                self._routes[native_session_id] = route
                route.native_session_id = native_session_id
                break
        # 更新默认
        self.native_session_id = native_session_id

    def _resolve_route(self, session_id: str | None = None) -> TurnRoute | None:
        """根据 session_id 解析路由。"""
        if session_id and session_id in self._routes:
            return self._routes[session_id]
        # fallback: 如果只有一个 route，用它
        if len(self._routes) == 1:
            return next(iter(self._routes.values()))
        # fallback: 返回当前默认
        if self.output_queue is not None:
            return TurnRoute(
                conversation_id=self.conversation_id,
                turn_id=self.turn_id,
                output_queue=self.output_queue,
                native_session_id=self.native_session_id,
            )
        return None

    def remove_turn(self, conversation_id: str) -> None:
        """移除一个 conversation 的所有路由。"""
        to_remove = [
            sid for sid, route in self._routes.items()
            if route.conversation_id == conversation_id
        ]
        for sid in to_remove:
            del self._routes[sid]

    @property
    def context(self) -> EventContext:
        return EventContext(
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
            runtime=self.runtime,
            native_session_id=self.native_session_id,
        )

    def _context_for(self, route: TurnRoute) -> EventContext:
        return EventContext(
            conversation_id=route.conversation_id,
            turn_id=route.turn_id,
            runtime=self.runtime,
            native_session_id=route.native_session_id,
        )

    def observe_stream(self, event: Any) -> None:
        """Raw JSON-RPC observer，追踪 native session ID。"""
        message = getattr(event, "message", {})
        if not isinstance(message, dict):
            return
        method = message.get("method")
        if method == "session/update":
            params = message.get("params")
            if isinstance(params, dict):
                session_id = params.get("sessionId")
                if session_id:
                    self.native_session_id = str(session_id)

    async def session_update(self, session_id: str, update: Any, **_: Any) -> None:
        route = self._resolve_route(session_id)
        if route is None:
            logger.warning("session_update for unknown session %s, dropping", session_id[:12] if session_id else "?")
            return

        kind = str(getattr(update, "session_update", "unknown"))

        if kind == "usage_update":
            usage = extract_usage(update)
            route.latest_usage = usage
            usage_dict = usage.to_dict()
            if usage_dict:
                await self._put_to(route, {
                    "type": "agent.context.updated",
                    "context": usage_dict,
                })
            return

        ctx = self._context_for(route)
        event = self.mapper.map_update(update, ctx)
        if event is not None:
            await self._put_to(route, event)

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **_: Any,
    ) -> Any:
        route = self._resolve_route(session_id)
        if route is None:
            logger.warning("request_permission for unknown session %s, denying", session_id[:12] if session_id else "?")
            return build_denied_response()

        approval_id = f"approval-{uuid.uuid4().hex}"
        future = await self.approvals.create(
            approval_id=approval_id,
            conversation_id=route.conversation_id,
            turn_id=route.turn_id,
        )
        ctx = self._context_for(route)
        event = self.mapper.map_permission_request(
            tool_call=tool_call,
            options=options,
            ctx=ctx,
            approval_id=approval_id,
        )
        await self._put_to(route, event)

        allowed = await future
        selected = choose_permission_option(options, allowed=allowed)
        if selected is None:
            return build_denied_response()
        return build_allowed_response(selected)

    async def read_text_file(self, path: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite fs gateway is disabled"})

    async def write_text_file(self, content: str, path: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite fs gateway is disabled"})

    async def create_terminal(self, command: str, session_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def terminal_output(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def release_terminal(self, session_id: str, terminal_id: str, **_: Any) -> None:
        return None

    async def wait_for_terminal_exit(self, session_id: str, terminal_id: str, **_: Any) -> Any:
        raise RequestError.internal_error({"details": "code-lite terminal gateway is disabled"})

    async def kill_terminal(self, session_id: str, terminal_id: str, **_: Any) -> None:
        return None

    async def _put(self, event: dict[str, Any]) -> None:
        """向后兼容的 _put（使用默认 route）。"""
        await self.output_queue.put({
            "conversationId": self.conversation_id,
            "turnId": self.turn_id,
            **event,
        })

    async def _put_to(self, route: TurnRoute, event: dict[str, Any]) -> None:
        """发送到指定 route 的 queue。"""
        await route.output_queue.put({
            "conversationId": route.conversation_id,
            "turnId": route.turn_id,
            **event,
        })
