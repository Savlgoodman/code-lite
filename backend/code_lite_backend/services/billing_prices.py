from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LITELLM_PRICE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
PRICE_CACHE_TTL_SECONDS = 24 * 60 * 60
PRICE_CACHE_NAME = "litellm_model_prices.json"


class BillingPriceStore:
    def __init__(self, cache_dir: Path) -> None:
        self._cache_path = cache_dir / PRICE_CACHE_NAME

    def get_prices(self, *, force_refresh: bool = False) -> dict[str, Any]:
        cached = self._read_cache()
        now = int(time.time())
        if not force_refresh and cached and self._is_fresh(cached, now):
            return cached

        try:
            prices = self._download_prices()
        except (OSError, HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            if cached:
                return {
                    **cached,
                    "stale": True,
                    "lastErrorAt": now,
                }
            return self._empty_result(now)

        result = {
            "source": LITELLM_PRICE_URL,
            "currency": "USD",
            "fetchedAt": now,
            "expiresAt": now + PRICE_CACHE_TTL_SECONDS,
            "stale": False,
            "models": self._normalize_prices(prices),
        }
        self._write_cache(result)
        return result

    def _is_fresh(self, cached: dict[str, Any], now: int) -> bool:
        expires_at = cached.get("expiresAt")
        return isinstance(expires_at, int | float) and expires_at > now

    def _read_cache(self) -> dict[str, Any] | None:
        if not self._cache_path.exists():
            return None
        try:
            payload = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _write_cache(self, value: dict[str, Any]) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self._cache_path.with_name(f"{self._cache_path.name}.{uuid.uuid4().hex}.tmp")
        temp_path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temp_path.replace(self._cache_path)

    def _download_prices(self) -> dict[str, Any]:
        request = Request(
            LITELLM_PRICE_URL,
            headers={
                "Accept": "application/json",
                "User-Agent": "code-lite/price-cache",
            },
            method="GET",
        )
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    def _normalize_prices(self, prices: dict[str, Any]) -> dict[str, Any]:
        normalized: dict[str, Any] = {}
        for model_id, raw in prices.items():
            if not isinstance(raw, dict):
                continue

            item = {
                "inputCostPerToken": _number(raw.get("input_cost_per_token")),
                "outputCostPerToken": _number(raw.get("output_cost_per_token")),
                "cachedReadCostPerToken": _number(
                    raw.get("cache_read_input_token_cost")
                    or raw.get("input_cost_per_token_cache_read")
                    or raw.get("cache_read_cost_per_token")
                ),
                "cachedWriteCostPerToken": _number(
                    raw.get("cache_creation_input_token_cost")
                    or raw.get("cache_creation_input_token_cost_above_1hr")
                    or raw.get("input_cost_per_token_cache_write")
                    or raw.get("cache_write_cost_per_token")
                ),
                "currency": "USD",
                "litellmProvider": raw.get("litellm_provider"),
                "mode": raw.get("mode"),
                "sourceModelId": str(model_id),
            }
            normalized[str(model_id)] = {key: value for key, value in item.items() if value is not None}
        return normalized

    def _empty_result(self, now: int) -> dict[str, Any]:
        return {
            "source": LITELLM_PRICE_URL,
            "currency": "USD",
            "fetchedAt": None,
            "expiresAt": now + PRICE_CACHE_TTL_SECONDS,
            "stale": True,
            "models": {},
        }


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None
