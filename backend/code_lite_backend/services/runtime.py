from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.schemas.agent import AgentAdapter
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.conversation_recorder import ConversationRecorder
from code_lite_backend.services.model_config import ModelConfigStore
from code_lite_backend.storage.conversations import ConversationStore


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
