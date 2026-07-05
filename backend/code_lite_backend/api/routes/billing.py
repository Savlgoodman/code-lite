from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices


router = APIRouter()


@router.get("/billing/prices")
async def get_billing_prices(
    force_refresh: bool = False,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    prices = services.billing_price_store.get_prices(force_refresh=force_refresh)
    return JSONResponse(prices)
