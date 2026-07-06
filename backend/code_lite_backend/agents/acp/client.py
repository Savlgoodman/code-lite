from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
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

_KNOWN_SESSION_UPDATE_KINDS = {
    "agent_message_chunk",
    "agent_thought_chunk",
    "available_commands_update",
    "config_option_update",
    "current_mode_update",
    "plan",
    "session_info_update",
    "tool_call",
    "tool_call_update",
    "usage_update",
}


class AcpClientHandler:
    """Per-conversation ACP client handler。

    每个 ACP connection 对应一个 handler，只服务于一个 conversation。
    不需要多路复用——connection 隔离保证了事件不会串。
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
        self.stderr_tail: deque[str] = deque(maxlen=50)

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
        direction = str(getattr(getattr(event, "direction", None), "value", getattr(event, "direction", "unknown")))
        if method == "session/update":
            params = message.get("params")
            if isinstance(params, dict):
                session_id = params.get("sessionId")
                if session_id:
                    self.native_session_id = str(session_id)
                update = params.get("update")
                update_kind = ""
                if isinstance(update, dict):
                    update_kind = str(update.get("sessionUpdate") or update.get("session_update") or "")
                if update_kind and update_kind not in _KNOWN_SESSION_UPDATE_KINDS:
                    self._put_raw_rpc(
                        method=str(method),
                        direction=direction,
                        rpc_kind="session_update",
                        message=message,
                        update_kind=update_kind,
                    )
            return

        if method and direction == "incoming":
            self._put_raw_rpc(
                method=str(method),
                direction=direction,
                rpc_kind="request" if "id" in message else "notification",
                message=message,
            )

    async def session_update(self, session_id: str, update: Any, **_: Any) -> None:
        self.native_session_id = session_id
        kind = str(getattr(update, "session_update", "unknown"))

        if kind == "usage_update":
            self.latest_usage = extract_usage(update)
            # 推送 agent.context.updated 事件（供前端 ContextRing 实时更新）
            usage_dict = self.latest_usage.to_dict()
            if usage_dict:
                await self._put({
                    "type": "agent.context.updated",
                    "context": usage_dict,
                })
            return

        event = self.mapper.map_update(update, self.context)
        if event is not None:
            if event.get("type") == "agent.raw.update":
                logger.info(
                    "ACP unhandled session/update forwarded: %s",
                    event.get("updateKind"),
                    extra={
                        "category": "acp",
                        "runtime": self.runtime,
                        "conversationId": self.conversation_id,
                        "turnId": self.turn_id,
                        "nativeSessionId": self.native_session_id,
                        "stage": "session.update.raw",
                        "fields": {"updateKind": event.get("updateKind")},
                    },
                )
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

    def _put_raw_rpc(
        self,
        *,
        method: str,
        direction: str,
        rpc_kind: str,
        message: dict[str, Any],
        update_kind: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "direction": direction,
            "message": message,
            "method": method,
            "rpcKind": rpc_kind,
        }
        if update_kind:
            payload["updateKind"] = update_kind
        event = self.mapper.map_raw_rpc_event(payload, self.context)
        if update_kind:
            event["updateKind"] = update_kind
        logger.info(
            "ACP raw JSON-RPC forwarded: %s",
            method,
            extra={
                "category": "acp",
                "runtime": self.runtime,
                "conversationId": self.conversation_id,
                "turnId": self.turn_id,
                "nativeSessionId": self.native_session_id,
                "stage": "jsonrpc.raw",
                "fields": {
                    "direction": direction,
                    "method": method,
                    "rpcKind": rpc_kind,
                    "updateKind": update_kind,
                },
            },
        )
        self.output_queue.put_nowait({
            "conversationId": self.conversation_id,
            "turnId": self.turn_id,
            **event,
        })
