from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from code_lite_backend.agents import create_agent_adapter
from code_lite_backend.agents.acp.runtime_manager import AcpRuntimeManager
from code_lite_backend.api.router import api_router
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore
from code_lite_backend.services.billing_prices import BillingPriceStore
from code_lite_backend.services.billing_usage import BillingUsageRecorder
from code_lite_backend.services.conversation_recorder import ConversationRecorder
from code_lite_backend.services.inputs import InputBroker
from code_lite_backend.services.model_config import ModelConfigStore
from code_lite_backend.services.runtime import AppServices
from code_lite_backend.storage.attachments import AttachmentStore
from code_lite_backend.storage.conversations import ConversationStore
from code_lite_backend.storage.diff_artifacts import DiffArtifactStore
from code_lite_backend.storage.event_store import ConversationEventStore
from code_lite_backend.version import BACKEND_VERSION

logger = logging.getLogger(__name__)


def create_app(runtime_config: RuntimeConfig, workspace: Path) -> FastAPI:
    approvals = ApprovalBroker()
    inputs = InputBroker()
    attachment_store = AttachmentStore(runtime_config.attachments_dir)
    conversation_store = ConversationStore(runtime_config.record_dir)
    diff_artifact_store = DiffArtifactStore(runtime_config.record_dir)
    event_store = ConversationEventStore(runtime_config.record_dir)
    billing_price_store = BillingPriceStore(runtime_config.cache_dir)
    billing_usage_recorder = BillingUsageRecorder(runtime_config.billing_dir, billing_price_store)
    model_config_store = ModelConfigStore(runtime_config)
    agent_runtime_config_store = AgentRuntimeConfigStore(runtime_config)
    runtime_manager = AcpRuntimeManager(conversation_store=conversation_store)
    services = AppServices(
        runtime_config=runtime_config,
        workspace=workspace,
        approvals=approvals,
        inputs=inputs,
        attachment_store=attachment_store,
        conversation_store=conversation_store,
        conversation_recorder=ConversationRecorder(conversation_store, diff_artifact_store),
        diff_artifact_store=diff_artifact_store,
        billing_price_store=billing_price_store,
        billing_usage_recorder=billing_usage_recorder,
        model_config_store=model_config_store,
        agent_runtime_config_store=agent_runtime_config_store,
        agent_adapter=create_agent_adapter(
            runtime_config=runtime_config,
            approvals=approvals,
            inputs=inputs,
            attachment_store=attachment_store,
            agent_runtime_config_store=agent_runtime_config_store,
            runtime_manager=runtime_manager,
        ),
        runtime_manager=runtime_manager,
        event_store=event_store,
    )
    app = FastAPI(title="Code Lite Backend", version=BACKEND_VERSION)
    app.state.services = services

    @app.on_event("startup")
    async def _startup() -> None:
        await billing_usage_recorder.start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        logger.info("Shutting down billing usage recorder...")
        await billing_usage_recorder.stop()
        logger.info("Shutting down ACP runtime manager...")
        await runtime_manager.close_all()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    return app
