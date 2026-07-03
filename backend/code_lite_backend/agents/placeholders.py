from __future__ import annotations

from typing import AsyncIterator

from code_lite_backend.schemas.agent import AgentAdapterCapabilities, AgentEvent, AgentRunRequest


class PlaceholderAgentAdapter:
    capabilities = AgentAdapterCapabilities(
        streaming=True,
        tool_registration=False,
        tool_approval=False,
        session_state=False,
        notes=["预留适配层，尚未接入真实 SDK。"],
    )

    def __init__(self, name: str) -> None:
        self.name = name

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        yield {
            "type": "agent.run.failed",
            "conversationId": request.conversation_id,
            "turnId": request.turn_id,
            "error": f"{self.name} adapter 尚未实现。",
        }

    async def cancel_turn(self, turn_id: str) -> bool:
        return False
