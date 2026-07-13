from __future__ import annotations

from fastapi import APIRouter

from code_lite_backend.api.routes import attachments, approvals, billing, conversations, health, image_gen, inputs, logs, runtime, sessions, settings, system, turns, ws


api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(logs.router)
api_router.include_router(billing.router)
api_router.include_router(runtime.router)
api_router.include_router(sessions.router)
api_router.include_router(settings.router)
api_router.include_router(image_gen.router)
api_router.include_router(system.router)
api_router.include_router(approvals.router)
api_router.include_router(inputs.router)
api_router.include_router(conversations.router)
api_router.include_router(attachments.router)
api_router.include_router(turns.router)
api_router.include_router(ws.router)
