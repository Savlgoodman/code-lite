from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Protocol


AgentEvent = dict[str, Any]


@dataclass(frozen=True)
class TextInputBlock:
    type: str
    text: str


@dataclass(frozen=True)
class ImageAttachmentSource:
    kind: str
    attachment_id: str


@dataclass(frozen=True)
class ImageInputBlock:
    type: str
    mime_type: str
    source: ImageAttachmentSource
    name: str | None = None
    size_bytes: int | None = None
    width: int | None = None
    height: int | None = None
    sha256: str | None = None
    was_compressed: bool | None = None


UserInputBlock = TextInputBlock | ImageInputBlock


@dataclass(frozen=True)
class AgentRunRequest:
    conversation_id: str
    turn_id: str
    prompt: str
    workspace: Path
    agent_id: str | None = None
    agent_label: str | None = None
    access_mode: str | None = None
    model_id: str | None = None
    model_preset_id: str | None = None
    runtime_model: str | None = None
    model_metadata: dict[str, Any] = field(default_factory=dict)
    reasoning_effort: str | None = None
    fast_mode: str | None = None
    input_blocks: list[UserInputBlock] = field(default_factory=list)


@dataclass(frozen=True)
class AgentAdapterCapabilities:
    streaming: bool = True
    tool_registration: bool = False
    tool_approval: bool = False
    session_state: bool = False
    notes: list[str] = field(default_factory=list)


class AgentAdapter(Protocol):
    name: str
    capabilities: AgentAdapterCapabilities

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        ...

    async def cancel_turn(self, turn_id: str) -> bool:
        ...
