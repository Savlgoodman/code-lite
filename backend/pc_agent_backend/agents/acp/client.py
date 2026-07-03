from __future__ import annotations

import asyncio
import uuid
from collections import deque
from typing import Any

from acp.exceptions import RequestError

from pc_agent_backend.agents.acp.approvals import (
    build_allowed_response,
    build_denied_response,
    choose_permission_option,
)
from pc_agent_backend.agents.acp.mapper import (
    AcpEventMapper,
    EventContext,
    extract_usage,
)
from pc_agent_backend.agents.acp.mapper import (
    UsageSnapshot,
)
from pc_agent_backend.schemas.agent import AgentEvent
from pc_agent_backend.services.approvals import ApprovalBroker


class AcpClientHandler:
    """通用 ACP client handler。

    接收 ACP SDK 的回调，通过 AcpEventMapper 映射为 code-lite AgentEvent，
    并推送到 output queue。
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
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.output_queue = output_queue
        self.approvals = approvals
        self.mapper = AcpEventMapper(runtime=runtime)
        self.native_session_id: str | None = None
        self.latest_usage: UsageSnapshot | None = None
        self.stderr_tail: deque[str] = deque(maxlen=20)

    @property
    def context(self) -> EventContext:
        return EventContext(
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
            runtime=self.runtime,
            native_session_id=self.native_session_id,
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
        self.native_session_id = session_id
        kind = str(getattr(update, "session_update", "unknown"))

        if kind == "usage_update":
            self.latest_usage = extract_usage(update)
            return

        event = self.mapper.map_update(update, self.context)
        if event is not None:
            await self._put(event)

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **_: Any,
    ) -> Any:
        self.native_session_id = session_id
        approval_id = f"approval-{uuid.uuid4().hex}"
        future = await self.approvals.create(
            approval_id=approval_id,
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
        )
        event = self.mapper.map_permission_request(
            tool_call=tool_call,
            options=options,
            ctx=self.context,
            approval_id=approval_id,
        )
        await self._put(event)

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
        await self.output_queue.put({
            "conversationId": self.conversation_id,
            "turnId": self.turn_id,
            **event,
        })
