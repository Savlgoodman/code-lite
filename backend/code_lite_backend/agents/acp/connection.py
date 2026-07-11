from __future__ import annotations

import asyncio
from typing import Any, cast

from acp.client.router import build_client_router
from acp.client.connection import ClientSideConnection
from acp.connection import Connection
from acp.interfaces import Agent, Client
from acp.meta import CLIENT_METHODS
from acp.router import MessageRouter
from acp.schema import CompleteElicitationNotification
from pydantic import BaseModel, Field, model_validator


class RawCreateElicitationRequest(BaseModel):
    """宽松承接 ACP unstable elicitation/create payload。

    当前 agent-client-protocol Python SDK 的 schema/meta 已包含 elicitation，
    但 client router 还未注册该方法，且 CreateFormElicitationRequest 没有
    暴露 requestedSchema/sessionId 等组合字段。这里保留 raw payload，再交给
    AcpClientHandler 做兼容解析。
    """

    raw: dict[str, Any] = Field(default_factory=dict)
    field_meta: dict[str, Any] | None = Field(default=None, alias="_meta")

    @model_validator(mode="before")
    @classmethod
    def capture_raw_payload(cls, params: Any) -> dict[str, Any]:
        raw = params if isinstance(params, dict) else {}
        return {
            "raw": raw,
            "_meta": raw.get("_meta") if isinstance(raw.get("_meta"), dict) else None,
        }


def build_code_lite_client_router(client: Client, use_unstable_protocol: bool = False) -> MessageRouter:
    router = build_client_router(client, use_unstable_protocol=use_unstable_protocol)
    router.route_request(
        CLIENT_METHODS["elicitation_create"],
        RawCreateElicitationRequest,  # type: ignore[arg-type]
        client,
        "create_elicitation",
        unstable=True,
    )
    router.route_notification(
        CLIENT_METHODS["elicitation_complete"],
        CompleteElicitationNotification,
        client,
        "complete_elicitation",
        optional=True,
        unstable=True,
    )
    return router


class CodeLiteClientSideConnection(ClientSideConnection):
    """ClientSideConnection variant with ACP elicitation routes enabled."""

    def __init__(
        self,
        to_client: Client,
        input_stream: Any,
        output_stream: Any,
        *,
        use_unstable_protocol: bool = False,
        **connection_kwargs: Any,
    ) -> None:
        if not isinstance(input_stream, asyncio.StreamWriter) or not isinstance(output_stream, asyncio.StreamReader):
            raise TypeError("CodeLiteClientSideConnection requires asyncio StreamWriter/StreamReader")
        handler = build_code_lite_client_router(cast(Client, to_client), use_unstable_protocol=use_unstable_protocol)
        self._conn = Connection(handler, input_stream, output_stream, **connection_kwargs)
        if on_connect := getattr(to_client, "on_connect", None):
            on_connect(cast(Agent, self))
