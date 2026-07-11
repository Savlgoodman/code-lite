from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.get("/health")
async def health(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    runtime_config = services.runtime_config
    adapter = services.agent_adapter
    return {
        "ok": True,
        "env": runtime_config.env,
        "dataDir": str(runtime_config.data_dir),
        "configPath": str(runtime_config.nanobot_config_path),
        "configExists": runtime_config.nanobot_config_path.exists(),
        "apiKeyPresent": bool(os.environ.get("DEEPSEEK_API_KEY")),
        "workspace": str(services.workspace),
        "agentAdapter": adapter.name,
        "agentCapabilities": {
            "streaming": adapter.capabilities.streaming,
            "toolRegistration": adapter.capabilities.tool_registration,
            "toolApproval": adapter.capabilities.tool_approval,
            "sessionState": adapter.capabilities.session_state,
            "notes": adapter.capabilities.notes,
        },
    }
