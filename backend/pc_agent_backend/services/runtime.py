from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.schemas.agent import AgentAdapter
from pc_agent_backend.services.approvals import ApprovalBroker
from pc_agent_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from pc_agent_backend.services.conversation_recorder import ConversationRecorder
from pc_agent_backend.services.model_config import ModelConfigStore
from pc_agent_backend.storage.conversations import ConversationStore


@dataclass
class AppServices:
    runtime_config: RuntimeConfig
    workspace: Path
    approvals: ApprovalBroker
    conversation_store: ConversationStore
    conversation_recorder: ConversationRecorder
    model_config_store: ModelConfigStore
    agent_runtime_config_store: AgentRuntimeConfigStore
    agent_adapter: AgentAdapter
