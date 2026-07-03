from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

from code_lite_backend.agents.acp import AcpAgentAdapter
from code_lite_backend.agents.nanobot import NanobotAgentAdapter
from code_lite_backend.agents.runtimes import CODEX_DESCRIPTOR
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.schemas.agent import AgentAdapterCapabilities, AgentEvent, AgentRunRequest
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.approvals import ApprovalBroker


class AgentRouterAdapter:
    name = "router"
    capabilities = AgentAdapterCapabilities(
        streaming=True,
        tool_registration=True,
        tool_approval=True,
        session_state=True,
        notes=["根据 Agent Runtime 设置动态路由到 ACP 或 nanobot adapter。"],
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
            "codex": AcpAgentAdapter(
                runtime="codex",
                descriptor=CODEX_DESCRIPTOR,
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

    async def list_models(self, adapter_id: str, workspace: Path) -> dict[str, object]:
        adapter_name = self._agent_runtime_config_store.resolve_adapter(adapter_id)
        adapter = self._adapters.get(adapter_name)
        if adapter is None or not hasattr(adapter, "list_models"):
            return {
                "adapter": adapter_name,
                "currentModelId": None,
                "models": [],
            }
        result = await adapter.list_models(workspace)  # type: ignore[attr-defined]
        return {
            "adapter": adapter_name,
            **result,
        }
