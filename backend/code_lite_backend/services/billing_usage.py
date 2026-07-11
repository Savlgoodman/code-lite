from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import date as date_type
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from code_lite_backend.storage.conversations import atomic_write_json, now_ms, read_json

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
DAILY_DIR_NAME = "daily"
TOKEN_FIELDS = (
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens",
)


@dataclass(frozen=True)
class BillingUsageWriteTask:
    entry_id: str
    local_date: str
    entry: dict[str, Any]
    enqueued_at_ms: int
    attempt: int = 0


class BillingUsageRecorder:
    def __init__(self, billing_dir: Path, price_store: Any) -> None:
        self._writer = BillingUsageWriter(billing_dir=billing_dir, price_store=price_store)
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._writer.run(), name="billing-usage-writer")

    async def stop(self) -> None:
        await self._writer.drain(timeout=3.0)
        self._writer.request_stop()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=1.0)
            except asyncio.TimeoutError:
                logger.warning("Timed out while stopping billing usage writer")

    def enqueue_turn_usage(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        assistant_message_id: str,
        workspace: Path,
        agent_id: str,
        agent_label: str | None,
        model_metadata: dict[str, Any] | None,
        usage: dict[str, Any] | None,
        created_at_ms: int | None = None,
    ) -> str | None:
        if not isinstance(usage, dict) or not usage:
            return None

        timestamp = int(created_at_ms or now_ms())
        local_dt = datetime.fromtimestamp(timestamp / 1000).astimezone()
        local_date = local_dt.strftime("%Y-%m-%d")
        entry_id = f"{conversation_id}:{turn_id}:{assistant_message_id}"
        normalized_usage, confidence = _normalize_usage(usage)
        model_info = model_metadata or {}
        model_id = _model_value(model_info.get("runtimeModel")) or _model_value(model_info.get("model")) or "unknown"
        model_label = _model_value(model_info.get("label")) or _model_value(model_info.get("model")) or model_id
        model_candidates = _build_model_candidates([model_id, model_label, _model_value(model_info.get("model"))])
        fast_mode = _normalize_fast_mode_metadata(model_info.get("fastMode"))
        workspace_path = _resolve_workspace(workspace)

        entry = {
            "id": entry_id,
            "timestamp": timestamp,
            "createdAtIso": datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat(),
            "localDate": local_date,
            "localHour": local_dt.strftime("%H"),
            "conversationId": conversation_id,
            "turnId": turn_id,
            "workspaceKey": _workspace_key(workspace_path),
            "workspaceLabel": workspace_path.name or str(workspace_path),
            "runtime": agent_id,
            "agentId": agent_id,
            "agentLabel": agent_label or agent_id,
            "modelId": model_id,
            "modelLabel": model_label,
            "modelCandidates": model_candidates,
            "usage": normalized_usage,
            "confidence": confidence,
        }
        if fast_mode:
            entry["fastMode"] = fast_mode
        self._writer.enqueue(
            BillingUsageWriteTask(
                entry_id=entry_id,
                local_date=local_date,
                entry=entry,
                enqueued_at_ms=now_ms(),
            )
        )
        return entry_id

    def get_today_summary(self) -> dict[str, Any]:
        return self.get_daily_summary(_local_today())

    def get_daily_summary(self, date: str) -> dict[str, Any]:
        return _summary_from_daily(self._writer.read_daily(date))

    def get_range_summary(self, start_date: str, end_date: str) -> dict[str, Any]:
        dates = _date_range(start_date, end_date)
        summaries = [self.get_daily_summary(date) for date in dates]
        totals = _empty_totals()
        models: dict[str, dict[str, Any]] = {}
        series: list[dict[str, Any]] = []

        for summary in summaries:
            _add_totals(totals, summary.get("totals") or {})
            for model in summary.get("models") or []:
                key = str(model.get("key") or f"{model.get('runtime')}:{model.get('modelId')}")
                target = models.setdefault(key, {"key": key, **_empty_totals()})
                for field in ("runtime", "modelId", "modelLabel", "priceModelId"):
                    if model.get(field) is not None:
                        target[field] = model[field]
                _add_totals(target, model)
            for point in summary.get("series") or []:
                series.append({**point, "date": summary.get("date")})

        return {
            "startDate": start_date,
            "endDate": end_date,
            "currency": "USD",
            "totals": totals,
            "models": sorted(models.values(), key=lambda item: int(item.get("totalTokens") or 0), reverse=True),
            "series": series,
        }


class BillingUsageWriter:
    def __init__(self, billing_dir: Path, price_store: Any, *, max_retries: int = 3) -> None:
        self._billing_dir = billing_dir
        self._daily_dir = billing_dir / DAILY_DIR_NAME
        self._price_store = price_store
        self._max_retries = max_retries
        self._queue: asyncio.Queue[BillingUsageWriteTask] = asyncio.Queue()
        self._stop_requested = False
        self._daily_dir.mkdir(parents=True, exist_ok=True)

    def enqueue(self, task: BillingUsageWriteTask) -> None:
        self._queue.put_nowait(task)

    def request_stop(self) -> None:
        self._stop_requested = True

    async def drain(self, timeout: float = 3.0) -> None:
        try:
            await asyncio.wait_for(self._queue.join(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Timed out draining billing usage queue; pending=%d", self._queue.qsize())

    async def run(self) -> None:
        while not self._stop_requested or not self._queue.empty():
            try:
                task = await asyncio.wait_for(self._queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue

            batch = [task]
            while len(batch) < 100:
                try:
                    batch.append(self._queue.get_nowait())
                except asyncio.QueueEmpty:
                    break

            try:
                await self._flush_batch(batch)
            except Exception as exc:
                logger.warning("Failed to flush billing usage batch: %s", exc)
                await self._retry_batch(batch)
            finally:
                for _ in batch:
                    self._queue.task_done()

    def read_daily(self, date: str) -> dict[str, Any]:
        return _read_daily(self._daily_path(date), date=date)

    async def _flush_batch(self, batch: list[BillingUsageWriteTask]) -> None:
        prices = await asyncio.to_thread(self._price_store.get_prices)
        grouped: dict[str, list[BillingUsageWriteTask]] = {}
        for task in batch:
            grouped.setdefault(task.local_date, []).append(task)

        for date, tasks in grouped.items():
            daily = _read_daily(self._daily_path(date), date=date)
            entries_by_id = {
                str(entry.get("id")): entry
                for entry in daily.get("entries", [])
                if isinstance(entry, dict) and entry.get("id")
            }
            for task in tasks:
                entry = _enrich_cost(task.entry, prices)
                entries_by_id[task.entry_id] = entry

            entries = sorted(entries_by_id.values(), key=lambda item: int(item.get("timestamp") or 0))
            next_daily = _build_daily(date=date, entries=entries)
            atomic_write_json(self._daily_path(date), next_daily)

    async def _retry_batch(self, batch: list[BillingUsageWriteTask]) -> None:
        for task in batch:
            if task.attempt >= self._max_retries:
                logger.warning("Dropping billing usage task after retries: %s", task.entry_id)
                continue
            await asyncio.sleep(min(0.1 * (task.attempt + 1), 1.0))
            self.enqueue(
                BillingUsageWriteTask(
                    entry_id=task.entry_id,
                    local_date=task.local_date,
                    entry=task.entry,
                    enqueued_at_ms=task.enqueued_at_ms,
                    attempt=task.attempt + 1,
                )
            )

    def _daily_path(self, date: str) -> Path:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("invalid billing date")
        return self._daily_dir / f"{date}.json"


def _normalize_usage(usage: dict[str, Any]) -> tuple[dict[str, Any], str]:
    input_tokens = _number(usage.get("inputTokens")) or _number(usage.get("promptTokens"))
    output_tokens = _number(usage.get("outputTokens")) or _number(usage.get("completionTokens"))
    cached_read_tokens = _number(usage.get("cachedReadTokens"))
    cached_write_tokens = _number(usage.get("cachedWriteTokens"))
    thought_tokens = _number(usage.get("thoughtTokens"))
    has_breakdown = any(value > 0 for value in (
        input_tokens,
        output_tokens,
        cached_read_tokens,
        cached_write_tokens,
        thought_tokens,
    ))
    source = str(usage.get("source") or "")
    raw_total = _number(usage.get("totalTokens"))
    total_tokens = raw_total if has_breakdown or source != "acp.usage_update" else 0
    if has_breakdown and total_tokens <= 0:
        total_tokens = input_tokens + output_tokens + cached_read_tokens + cached_write_tokens + thought_tokens

    result: dict[str, Any] = {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedReadTokens": cached_read_tokens,
        "cachedWriteTokens": cached_write_tokens,
        "thoughtTokens": thought_tokens,
        "totalTokens": total_tokens,
    }
    for key in ("contextUsedTokens", "contextWindowTokens"):
        value = _number(usage.get(key))
        if value:
            result[key] = value
    if source:
        result["source"] = source

    confidence = "measured" if has_breakdown else "partial"
    return result, confidence


def _enrich_cost(entry: dict[str, Any], prices: dict[str, Any]) -> dict[str, Any]:
    usage = entry.get("usage") if isinstance(entry.get("usage"), dict) else {}
    fast_mode = entry.get("fastMode") if isinstance(entry.get("fastMode"), dict) else {}
    billing_multiplier = _billing_multiplier(fast_mode)
    match = _find_price(entry.get("modelCandidates") or [], prices)
    if match is None:
        return {
            **entry,
            "cost": {
                "currency": "USD",
                "estimatedCostUsd": 0,
                "baseEstimatedCostUsd": 0,
                "billingMultiplier": billing_multiplier,
                "matched": False,
                "priceStale": bool(prices.get("stale")),
            },
        }

    price_model_id, price = match
    input_cost = _number(usage.get("inputTokens")) * _number(price.get("inputCostPerToken"))
    output_cost = _number(usage.get("outputTokens")) * _number(price.get("outputCostPerToken"))
    thought_cost = _number(usage.get("thoughtTokens")) * _number(price.get("outputCostPerToken"))
    cached_read_cost = _number(usage.get("cachedReadTokens")) * _number(
        price.get("cachedReadCostPerToken"), fallback=price.get("inputCostPerToken")
    )
    cached_write_cost = _number(usage.get("cachedWriteTokens")) * _number(
        price.get("cachedWriteCostPerToken"), fallback=price.get("inputCostPerToken")
    )
    base_cost = input_cost + output_cost + thought_cost + cached_read_cost + cached_write_cost
    return {
        **entry,
        "cost": {
            "currency": price.get("currency") or prices.get("currency") or "USD",
            "estimatedCostUsd": base_cost * billing_multiplier,
            "baseEstimatedCostUsd": base_cost,
            "billingMultiplier": billing_multiplier,
            "inputCostUsd": input_cost,
            "outputCostUsd": output_cost,
            "cachedReadCostUsd": cached_read_cost,
            "cachedWriteCostUsd": cached_write_cost,
            "thoughtCostUsd": thought_cost,
            "priceModelId": price_model_id,
            "priceSource": "litellm",
            "priceStale": bool(prices.get("stale")),
            "matched": True,
        },
    }


def _build_daily(*, date: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
    totals = _empty_totals()
    models: dict[str, dict[str, Any]] = {}
    hours: dict[str, dict[str, Any]] = {}
    timezone_name = datetime.now().astimezone().tzname() or ""

    for entry in entries:
        usage = entry.get("usage") if isinstance(entry.get("usage"), dict) else {}
        cost = entry.get("cost") if isinstance(entry.get("cost"), dict) else {}
        item_totals = _totals_from_usage(usage, cost)
        _add_totals(totals, item_totals)
        if not bool(cost.get("matched")):
            totals["unknownCostTurns"] += 1

        model_key = f"{entry.get('runtime') or 'unknown'}:{entry.get('modelId') or 'unknown'}"
        model = models.setdefault(
            model_key,
            {
                "key": model_key,
                "runtime": entry.get("runtime") or "unknown",
                "modelId": entry.get("modelId") or "unknown",
                "modelLabel": entry.get("modelLabel") or entry.get("modelId") or "unknown",
                **_empty_totals(),
            },
        )
        _add_totals(model, item_totals)
        if cost.get("priceModelId"):
            model["priceModelId"] = cost["priceModelId"]
        if not bool(cost.get("matched")):
            model["unknownCostTurns"] += 1

        hour_key = str(entry.get("localHour") or "00")
        hour = hours.setdefault(hour_key, _empty_totals())
        _add_totals(hour, item_totals)
        if not bool(cost.get("matched")):
            hour["unknownCostTurns"] += 1

    return {
        "schemaVersion": SCHEMA_VERSION,
        "date": date,
        "timezone": timezone_name,
        "updatedAt": now_ms(),
        "currency": "USD",
        "totals": totals,
        "models": models,
        "hours": hours,
        "entries": entries,
    }


def _summary_from_daily(daily: dict[str, Any]) -> dict[str, Any]:
    hours = daily.get("hours") if isinstance(daily.get("hours"), dict) else {}
    models = daily.get("models") if isinstance(daily.get("models"), dict) else {}
    entries = daily.get("entries") if isinstance(daily.get("entries"), list) else []
    return {
        "date": daily.get("date"),
        "timezone": daily.get("timezone") or "",
        "currency": daily.get("currency") or "USD",
        "totals": daily.get("totals") or _empty_totals(),
        "models": sorted(models.values(), key=lambda item: int(item.get("totalTokens") or 0), reverse=True),
        "series": [
            {"bucket": f"{hour}:00", **values}
            for hour, values in sorted(hours.items())
            if isinstance(values, dict)
        ],
        "recentEntries": [
            _public_entry(entry)
            for entry in sorted(entries, key=lambda item: int(item.get("timestamp") or 0), reverse=True)[:20]
            if isinstance(entry, dict)
        ],
    }


def _read_daily(path: Path, *, date: str) -> dict[str, Any]:
    try:
        payload = read_json(path, _empty_daily(date))
    except (OSError, json.JSONDecodeError, ValueError):
        logger.warning("Failed to read billing daily file: %s", path)
        return _empty_daily(date)
    return payload if isinstance(payload, dict) else _empty_daily(date)


def _empty_daily(date: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "date": date,
        "timezone": datetime.now().astimezone().tzname() or "",
        "updatedAt": None,
        "currency": "USD",
        "totals": _empty_totals(),
        "models": {},
        "hours": {},
        "entries": [],
    }


def _empty_totals() -> dict[str, Any]:
    return {
        "turns": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cachedReadTokens": 0,
        "cachedWriteTokens": 0,
        "thoughtTokens": 0,
        "totalTokens": 0,
        "estimatedCostUsd": 0.0,
        "unknownCostTurns": 0,
    }


def _totals_from_usage(usage: dict[str, Any], cost: dict[str, Any]) -> dict[str, Any]:
    return {
        "turns": 1,
        "inputTokens": _number(usage.get("inputTokens")),
        "outputTokens": _number(usage.get("outputTokens")),
        "cachedReadTokens": _number(usage.get("cachedReadTokens")),
        "cachedWriteTokens": _number(usage.get("cachedWriteTokens")),
        "thoughtTokens": _number(usage.get("thoughtTokens")),
        "totalTokens": _number(usage.get("totalTokens")),
        "estimatedCostUsd": float(cost.get("estimatedCostUsd") or 0),
        "unknownCostTurns": 0,
    }


def _add_totals(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key in ("turns", *TOKEN_FIELDS, "unknownCostTurns"):
        target[key] = int(target.get(key) or 0) + int(source.get(key) or 0)
    target["estimatedCostUsd"] = float(target.get("estimatedCostUsd") or 0) + float(source.get("estimatedCostUsd") or 0)


def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry.get("id"),
        "timestamp": entry.get("timestamp"),
        "createdAtIso": entry.get("createdAtIso"),
        "localDate": entry.get("localDate"),
        "localHour": entry.get("localHour"),
        "conversationId": entry.get("conversationId"),
        "turnId": entry.get("turnId"),
        "workspaceKey": entry.get("workspaceKey"),
        "workspaceLabel": entry.get("workspaceLabel"),
        "runtime": entry.get("runtime"),
        "agentId": entry.get("agentId"),
        "agentLabel": entry.get("agentLabel"),
        "modelId": entry.get("modelId"),
        "modelLabel": entry.get("modelLabel"),
        "usage": entry.get("usage"),
        "cost": entry.get("cost"),
        "confidence": entry.get("confidence"),
        "fastMode": entry.get("fastMode"),
    }


def _find_price(candidates: list[Any], prices: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    models = prices.get("models")
    if not isinstance(models, dict):
        return None
    direct_candidates = _build_model_candidates([str(candidate) for candidate in candidates])
    for candidate in direct_candidates:
        price = models.get(candidate)
        if isinstance(price, dict):
            return candidate, price

    normalized_candidates = {_normalize_model_key(candidate) for candidate in direct_candidates}
    for model_id, price in models.items():
        if _normalize_model_key(str(model_id)) in normalized_candidates and isinstance(price, dict):
            return str(model_id), price
    return None


def _build_model_candidates(values: list[str]) -> list[str]:
    candidates: list[str] = []
    for value in values:
        trimmed = value.strip()
        if not trimmed or trimmed == "unknown":
            continue
        candidates.append(trimmed)
        candidates.append(re.sub(r"^\w+/", "", trimmed))
        candidates.append(re.sub(r"\[[^\]]+\]$", "", trimmed))
        candidates.append(re.sub(r"\[[^\]]+\]$", "", re.sub(r"^\w+/", "", trimmed)))
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _normalize_model_key(value: str) -> str:
    return re.sub(
        r"^-+|-+$",
        "",
        re.sub(r"[^a-z0-9.]+", "-", re.sub(r"\[[^\]]+\]$", "", re.sub(r"^\w+/", "", value.strip().lower()))),
    )


def _number(value: Any, *, fallback: Any = 0) -> int | float:
    candidate = fallback if value is None else value
    if isinstance(candidate, bool) or candidate is None:
        return 0
    if isinstance(candidate, int | float):
        return candidate
    if isinstance(candidate, str):
        try:
            parsed = float(candidate)
        except ValueError:
            return 0
        return int(parsed) if parsed.is_integer() else parsed
    return 0


def _billing_multiplier(fast_mode: dict[str, Any]) -> int | float:
    multiplier = _number(fast_mode.get("billingMultiplier"), fallback=1)
    return multiplier if multiplier > 0 else 1


def _normalize_fast_mode_metadata(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    requested = value.get("requested")
    config_applied = value.get("configApplied")
    effective = value.get("effective")
    applied = value.get("applied")
    enabled = bool(value.get("enabled")) and effective is True
    multiplier = _billing_multiplier(value)
    if not enabled:
        multiplier = 1
    result = {
        "requested": requested if isinstance(requested, bool) else bool(value.get("enabled")),
        "enabled": enabled,
        "configApplied": config_applied if isinstance(config_applied, bool) else None,
        "applied": applied if isinstance(applied, bool) else None,
        "effective": effective if isinstance(effective, bool) else None,
        "effectiveSource": str(value.get("effectiveSource") or "") or None,
        "effectiveUnknown": value.get("effectiveUnknown") if isinstance(value.get("effectiveUnknown"), bool) else None,
        "effectiveReason": str(value.get("effectiveReason") or "") or None,
        "speedMode": str(value.get("speedMode") or ("fast" if enabled else "normal")),
        "displayRate": str(value.get("displayRate") or ("1.5x" if enabled else "1x")),
        "runtimeConfigId": value.get("runtimeConfigId"),
        "runtimeValue": str(value.get("runtimeValue") or ("on" if enabled else "off")),
        "runtimeOptionPresent": (
            value.get("runtimeOptionPresent")
            if isinstance(value.get("runtimeOptionPresent"), bool)
            else None
        ),
        "billingMultiplier": multiplier,
    }
    return {key: item for key, item in result.items() if item is not None}


def _model_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _resolve_workspace(workspace: Path) -> Path:
    try:
        return workspace.expanduser().resolve()
    except OSError:
        return workspace.expanduser().absolute()


def _workspace_key(workspace: Path) -> str:
    return f"sha256:{hashlib.sha256(str(workspace).encode('utf-8')).hexdigest()}"


def _local_today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def _date_range(start_date: str, end_date: str) -> list[str]:
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    if end < start:
        start, end = end, start
    days = (end - start).days
    return [
        date_type.fromordinal(start.toordinal() + offset).strftime("%Y-%m-%d")
        for offset in range(days + 1)
    ]
