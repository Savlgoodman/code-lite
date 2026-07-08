from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from acp.exceptions import RequestError
from acp import schema as acp_schema

from code_lite_backend.agents.acp.approvals import (
    build_allowed_response,
    build_denied_response,
    choose_permission_option,
)
from code_lite_backend.agents.acp.mapper import (
    AcpEventMapper,
    EventContext,
    extract_usage,
    to_jsonable,
)
from code_lite_backend.agents.acp.mapper import (
    UsageSnapshot,
)
from code_lite_backend.core.structured_logging import sanitize_log_value
from code_lite_backend.schemas.agent import AgentEvent
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.inputs import InputBroker, InputResponse


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


def _input_response_to_acp(response: InputResponse) -> Any:
    if response.action == "accept":
        return acp_schema.AcceptElicitationResponse(
            action="accept",
            content=response.content or {},
        )
    if response.action == "decline":
        return acp_schema.DeclineElicitationResponse(action="decline")
    return acp_schema.CancelElicitationResponse(action="cancel")


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_dict(*values: Any) -> dict[str, Any] | None:
    for value in values:
        if isinstance(value, dict):
            return value
    return None


def _first_string(*values: Any) -> str:
    for value in values:
        if value is not None and value != "":
            return str(value)
    return ""


@dataclass
class AcpSessionRoute:
    """Routes one native ACP session back to one code-lite conversation."""

    runtime: str
    conversation_id: str
    turn_id: str
    native_session_id: str
    output_queue: asyncio.Queue[AgentEvent | None] | None
    mapper: AcpEventMapper
    latest_usage: UsageSnapshot | None = None
    suppress_output: bool = False
    active_prompt: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def context(self) -> EventContext:
        return EventContext(
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
            runtime=self.runtime,
            native_session_id=self.native_session_id,
        )


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
        inputs: InputBroker,
    ) -> None:
        self.runtime = runtime
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.output_queue = output_queue
        self.approvals = approvals
        self.inputs = inputs
        self.mapper = AcpEventMapper(runtime=runtime)
        self.native_session_id: str | None = None
        self.latest_usage: UsageSnapshot | None = None
        self.stderr_tail: deque[str] = deque(maxlen=50)
        self.suppress_output = False
        self._routes: dict[str, AcpSessionRoute] = {}

    @property
    def context(self) -> EventContext:
        return EventContext(
            conversation_id=self.conversation_id,
            turn_id=self.turn_id,
            runtime=self.runtime,
            native_session_id=self.native_session_id,
        )

    def register_route(
        self,
        *,
        session_id: str,
        conversation_id: str,
        turn_id: str,
        output_queue: asyncio.Queue[AgentEvent | None],
        text_baseline: str = "",
        reasoning_baseline: str = "",
        suppress_output: bool = False,
    ) -> AcpSessionRoute:
        mapper = AcpEventMapper(runtime=self.runtime)
        mapper.start_turn(
            text_baseline=text_baseline,
            reasoning_baseline=reasoning_baseline,
        )
        route = AcpSessionRoute(
            runtime=self.runtime,
            conversation_id=conversation_id,
            turn_id=turn_id,
            native_session_id=session_id,
            output_queue=output_queue,
            mapper=mapper,
            suppress_output=suppress_output,
            active_prompt=True,
        )
        self._routes[session_id] = route
        self.native_session_id = session_id
        return route

    def detach_route(self, session_id: str) -> None:
        route = self._routes.get(session_id)
        if route is None:
            return
        route.output_queue = None
        route.active_prompt = False

    def remove_route(self, session_id: str) -> None:
        self._routes.pop(session_id, None)

    def get_latest_usage(self, session_id: str | None) -> UsageSnapshot | None:
        if session_id:
            route = self._routes.get(session_id)
            if route is not None:
                return route.latest_usage
        return self.latest_usage

    def get_route(self, session_id: str | None) -> AcpSessionRoute | None:
        return self._route_for_session(session_id)

    def _route_for_session(self, session_id: str | None) -> AcpSessionRoute | None:
        if not session_id:
            return None
        return self._routes.get(session_id)

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
        route = self._route_for_session(session_id)
        kind = str(getattr(update, "session_update", "unknown"))

        if kind == "usage_update":
            usage = extract_usage(update)
            self.latest_usage = usage
            if route is not None:
                route.latest_usage = usage
            # 推送 agent.context.updated 事件（供前端 ContextRing 实时更新）
            usage_dict = usage.to_dict()
            if usage_dict:
                await self._put({
                    "type": "agent.context.updated",
                    "context": usage_dict,
                    "metadata": {
                        "runtime": self.runtime,
                        "nativeSessionId": self.native_session_id,
                        "rawUpdate": sanitize_log_value(to_jsonable(update)),
                    },
                }, route=route)
            return

        mapper = route.mapper if route is not None else self.mapper
        context = route.context if route is not None else self.context
        event = mapper.map_update(update, context)
        if event is not None:
            if event.get("type") == "agent.raw.update":
                logger.info(
                    "ACP unhandled session/update forwarded: %s",
                    event.get("updateKind"),
                    extra={
                        "category": "acp",
                        "runtime": self.runtime,
                        "conversationId": context.conversation_id,
                        "turnId": context.turn_id,
                        "nativeSessionId": self.native_session_id,
                        "stage": "session.update.raw",
                        "fields": {"updateKind": event.get("updateKind")},
                    },
                )
            await self._put(event, route=route)

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **_: Any,
    ) -> Any:
        self.native_session_id = session_id
        route = self._route_for_session(session_id)
        context = route.context if route is not None else self.context
        approval_id = f"approval-{uuid.uuid4().hex}"
        future = await self.approvals.create(
            approval_id=approval_id,
            conversation_id=context.conversation_id,
            turn_id=context.turn_id,
        )
        event = self.mapper.map_permission_request(
            tool_call=tool_call,
            options=options,
            ctx=context,
            approval_id=approval_id,
        )
        await self._put(event, route=route)

        allowed = await future
        selected = choose_permission_option(options, allowed=allowed)
        if selected is None:
            return build_denied_response()
        return build_allowed_response(selected)

    async def create_elicitation(self, raw: dict[str, Any], **_: Any) -> Any:
        mode_payload = _dict_or_empty(raw.get("mode"))
        mode = _first_string(
            raw.get("mode") if not isinstance(raw.get("mode"), dict) else None,
            mode_payload.get("type"),
            mode_payload.get("mode"),
        )
        if not mode and _first_dict(
            mode_payload.get("requestedSchema"),
            mode_payload.get("requested_schema"),
            mode_payload.get("schema"),
        ):
            mode = "form"
        if mode != "form":
            return acp_schema.CancelElicitationResponse(action="cancel")

        session_id = _first_string(
            raw.get("sessionId"),
            raw.get("session_id"),
            mode_payload.get("sessionId"),
            mode_payload.get("session_id"),
            self.native_session_id,
        )
        if session_id:
            self.native_session_id = session_id
        route = self._route_for_session(session_id)
        context = route.context if route is not None else self.context
        requested_schema = _first_dict(
            raw.get("requestedSchema"),
            raw.get("requested_schema"),
            raw.get("schema"),
            mode_payload.get("requestedSchema"),
            mode_payload.get("requested_schema"),
            mode_payload.get("schema"),
        ) or {"type": "object", "properties": {}}
        tool_call_id = _first_string(
            raw.get("toolCallId"),
            raw.get("tool_call_id"),
            mode_payload.get("toolCallId"),
            mode_payload.get("tool_call_id"),
        ) or None
        input_id = f"input-{uuid.uuid4().hex}"
        future = await self.inputs.create(
            input_id=input_id,
            conversation_id=context.conversation_id,
            turn_id=context.turn_id,
        )
        await self._put({
            "type": "agent.input.required",
            "inputRequestId": input_id,
            "mode": mode,
            "message": str(raw.get("message") or "需要你的输入"),
            "schema": requested_schema,
            "toolCallId": tool_call_id,
            "metadata": {
                "runtime": self.runtime,
                "nativeSessionId": self.native_session_id,
                "source": "acp.elicitation.create",
                "rawInput": sanitize_log_value(raw),
            },
        }, route=route)

        response = await future
        return _input_response_to_acp(response)

    async def complete_elicitation(self, elicitation_id: str, **_: Any) -> None:
        await self._put({
            "type": "agent.input.completed",
            "inputRequestId": str(elicitation_id),
            "metadata": {
                "runtime": self.runtime,
                "nativeSessionId": self.native_session_id,
                "source": "acp.elicitation.complete",
            },
        })

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

    async def _put(self, event: dict[str, Any], *, route: AcpSessionRoute | None = None) -> None:
        if route is not None:
            if route.suppress_output or route.output_queue is None:
                return
            await route.output_queue.put({
                "conversationId": route.conversation_id,
                "turnId": route.turn_id,
                **event,
            })
            return
        if self.suppress_output:
            return
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
        session_id = None
        params = message.get("params")
        if isinstance(params, dict):
            raw_session_id = params.get("sessionId") or params.get("session_id")
            if raw_session_id:
                session_id = str(raw_session_id)
        route = self._route_for_session(session_id)
        context = route.context if route is not None else self.context
        mapper = route.mapper if route is not None else self.mapper
        event = mapper.map_raw_rpc_event(payload, context)
        if update_kind:
            event["updateKind"] = update_kind
        if route is not None:
            if route.suppress_output or route.output_queue is None:
                return
        elif self.suppress_output:
            return
        logger.info(
            "ACP raw JSON-RPC forwarded: %s",
            method,
            extra={
                "category": "acp",
                "runtime": self.runtime,
                "conversationId": context.conversation_id,
                "turnId": context.turn_id,
                "nativeSessionId": context.native_session_id,
                "stage": "jsonrpc.raw",
                "fields": {
                    "direction": direction,
                    "method": method,
                    "rpcKind": rpc_kind,
                    "updateKind": update_kind,
                },
            },
        )
        output_queue = route.output_queue if route is not None else self.output_queue
        output_queue.put_nowait({
            "conversationId": context.conversation_id,
            "turnId": context.turn_id,
            **event,
        })
