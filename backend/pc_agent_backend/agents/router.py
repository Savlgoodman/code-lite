from __future__ import annotations

from typing import AsyncIterator

from pc_agent_backend.agents.codex import CodexAgentAdapter
from pc_agent_backend.agents.nanobot import NanobotAgentAdapter
from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.schemas.agent import AgentAdapterCapabilities, AgentEvent, AgentRunRequest
from pc_agent_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from pc_agent_backend.services.approvals import ApprovalBroker


class AgentRouterAdapter:
    name = "router"
    capabilities = AgentAdapterCapabilities(
        streaming=True,
        tool_registration=True,
        tool_approval=True,
        session_state=True,
        notes=["根据 Agent Runtime 设置动态路由到 Codex 或 nanobot adapter。"],
    )

    def __init__(
        self,
        *,
        runtime_config: RuntimeConfig,
        approvals: ApprovalBroker,
        agent_runtime_config_store: AgentRuntimeConfigStore,
    ) -> None:
        self._agent_runtime_config_store = agent_runtime_config_store
        self._adapters = {
            "codex": CodexAgentAdapter(
                runtime_config=runtime_config,
                approvals=approvals,
                agent_runtime_config_store=agent_runtime_config_store,
            ),
            "nanobot": NanobotAgentAdapter(runtime_config=runtime_config, approvals=approvals),
        }

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        adapter_name = self._agent_runtime_config_store.resolve_adapter(request.agent_id)
        adapter = self._adapters.get(adapter_name)
        if adapter is None:
            yield {
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"{adapter_name} adapter 尚未实现。",
            }
            return

        async for event in adapter.stream_turn(request):
            yield event

    async def cancel_turn(self, turn_id: str) -> bool:
        cancelled = False
        for adapter in self._adapters.values():
            cancelled = await adapter.cancel_turn(turn_id) or cancelled
        return cancelled
