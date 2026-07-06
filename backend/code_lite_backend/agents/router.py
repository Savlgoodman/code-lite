from __future__ import annotations

import logging
from pathlib import Path
from typing import AsyncIterator

from code_lite_backend.agents.acp import AcpAgentAdapter
from code_lite_backend.agents.acp.runtime_manager import AcpRuntimeManager
from code_lite_backend.agents.nanobot import NanobotAgentAdapter
from code_lite_backend.agents.runtimes import get_descriptor
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.schemas.agent import AgentAdapterCapabilities, AgentEvent, AgentRunRequest
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.approvals import ApprovalBroker

logger = logging.getLogger(__name__)


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
        runtime_manager: AcpRuntimeManager | None = None,
    ) -> None:
        self._runtime_config = runtime_config
        self._approvals = approvals
        self._agent_runtime_config_store = agent_runtime_config_store
        self._runtime_manager = runtime_manager
        # 预创建常用 adapter；ACP runtime 按需懒加载
        self._adapters: dict[str, object] = {
            "nanobot": NanobotAgentAdapter(runtime_config=runtime_config, approvals=approvals),
        }

    def _get_or_create_adapter(self, adapter_name: str) -> object | None:
        """获取或懒加载 adapter。所有 ACP runtime 通过 descriptor 动态创建。"""
        existing = self._adapters.get(adapter_name)
        if existing is not None:
            return existing

        # ACP runtime：通过 descriptor 创建
        descriptor = get_descriptor(adapter_name)
        if descriptor is None:
            return None

        adapter = AcpAgentAdapter(
            runtime=adapter_name,
            descriptor=descriptor,
            runtime_config=self._runtime_config,
            approvals=self._approvals,
            agent_runtime_config_store=self._agent_runtime_config_store,
            runtime_manager=self._runtime_manager,
        )
        self._adapters[adapter_name] = adapter
        logger.info("Router created ACP adapter for runtime=%s", adapter_name)
        return adapter

    async def stream_turn(self, request: AgentRunRequest) -> AsyncIterator[AgentEvent]:
        adapter_name = self._agent_runtime_config_store.resolve_adapter(request.agent_id)
        logger.info("Router routing turn to adapter=%s (agent_id=%s)", adapter_name, request.agent_id)
        adapter = self._get_or_create_adapter(adapter_name)
        if adapter is None:
            logger.error("Router: no adapter for %s", adapter_name)
            yield {
                "type": "agent.run.failed",
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "error": f"不支持的 agent: {adapter_name}",
            }
            return

        async for event in adapter.stream_turn(request):  # type: ignore[attr-defined]
            yield event

    async def cancel_turn(self, turn_id: str) -> bool:
        cancelled = False
        for adapter in self._adapters.values():
            cancelled = await adapter.cancel_turn(turn_id) or cancelled  # type: ignore[attr-defined]
        return cancelled

    async def list_models(self, adapter_id: str, workspace: Path) -> dict[str, object]:
        adapter_name = self._agent_runtime_config_store.resolve_adapter(adapter_id)
        adapter = self._get_or_create_adapter(adapter_name)
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
