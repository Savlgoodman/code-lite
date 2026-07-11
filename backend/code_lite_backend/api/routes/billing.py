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


@router.get("/billing/usage/today")
async def get_today_billing_usage(
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    return JSONResponse(services.billing_usage_recorder.get_today_summary())


@router.get("/billing/usage/daily")
async def get_daily_billing_usage(
    date: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        summary = services.billing_usage_recorder.get_daily_summary(date)
    except ValueError:
        return JSONResponse({"error": "invalid date"}, status_code=400)
    return JSONResponse(summary)


@router.get("/billing/usage/range")
async def get_range_billing_usage(
    start: str,
    end: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        summary = services.billing_usage_recorder.get_range_summary(start, end)
    except ValueError:
        return JSONResponse({"error": "invalid date range"}, status_code=400)
    return JSONResponse(summary)
