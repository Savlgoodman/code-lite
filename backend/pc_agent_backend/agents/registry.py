from __future__ import annotations

from pc_agent_backend.agents.claude_code import ClaudeCodeAgentAdapter
from pc_agent_backend.agents.codex import CodexAgentAdapter
from pc_agent_backend.agents.errors import UnsupportedAgentAdapterError
from pc_agent_backend.agents.nanobot import NanobotAgentAdapter
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
        return CodexAgentAdapter(
            runtime_config=runtime_config,
            approvals=approvals,
            agent_runtime_config_store=agent_runtime_config_store,
        )
    if name in {"claude", "claude_code", "claudecode"}:
        return ClaudeCodeAgentAdapter()
    raise UnsupportedAgentAdapterError(f"unsupported agent adapter: {name}")
