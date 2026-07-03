from __future__ import annotations

from pc_agent_backend.agents.acp import AcpAgentAdapter
from pc_agent_backend.agents.nanobot import NanobotAgentAdapter
from pc_agent_backend.agents.runtimes import CODEX_DESCRIPTOR, get_descriptor
from pc_agent_backend.agents.router import AgentRouterAdapter
from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.schemas.agent import AgentAdapter
from pc_agent_backend.services.approvals import ApprovalBroker
from pc_agent_backend.services.agent_runtime_config import AgentRuntimeConfigStore


def create_agent_adapter(
    *,
    runtime_config: RuntimeConfig,
    approvals: ApprovalBroker,
    agent_runtime_config_store: AgentRuntimeConfigStore,
) -> AgentAdapter:
    name = runtime_config.agent_adapter
    if name in {"auto", "router", "runtime"}:
        return AgentRouterAdapter(
            runtime_config=runtime_config,
            approvals=approvals,
            agent_runtime_config_store=agent_runtime_config_store,
        )
    if name == "nanobot":
        return NanobotAgentAdapter(runtime_config=runtime_config, approvals=approvals)
    if name == "codex":
        return AcpAgentAdapter(
            runtime="codex",
            descriptor=CODEX_DESCRIPTOR,
            runtime_config=runtime_config,
            approvals=approvals,
            agent_runtime_config_store=agent_runtime_config_store,
        )
    # 通用 ACP adapter：通过 descriptor 支持任意 runtime
    descriptor = get_descriptor(name)
    if descriptor is not None:
        return AcpAgentAdapter(
            runtime=name,
            descriptor=descriptor,
            runtime_config=runtime_config,
            approvals=approvals,
            agent_runtime_config_store=agent_runtime_config_store,
        )
    from pc_agent_backend.agents.placeholders import PlaceholderAgentAdapter
    return PlaceholderAgentAdapter(name)
