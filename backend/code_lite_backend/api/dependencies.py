from __future__ import annotations

from fastapi import Request

from code_lite_backend.services.runtime import AppServices


def get_services(request: Request) -> AppServices:
    return request.app.state.services
