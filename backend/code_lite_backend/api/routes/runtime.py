from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.get("/runtimes/acp/status")
async def acp_runtime_status(
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    if services.runtime_manager is None:
        return JSONResponse({"connectionMode": "unavailable", "connections": []})
    return JSONResponse(services.runtime_manager.status_snapshot())


@router.post("/runtimes/acp/cleanup")
async def acp_runtime_cleanup(
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    if services.runtime_manager is None:
        return JSONResponse({"closed": False})
    await services.runtime_manager.close_all()
    return JSONResponse({"closed": True})
