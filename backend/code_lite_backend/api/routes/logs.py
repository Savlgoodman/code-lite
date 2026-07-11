from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.runtime import AppServices

router = APIRouter()

LOG_FILES: dict[str, str] = {
    "api": "api.jsonl",
    "acp": "acp.jsonl",
    "python": "python.jsonl",
    "runtime.stderr": "runtime-stderr.jsonl",
    "diagnostic": "diagnostics.jsonl",
}


def _current_logs_dir(services: AppServices) -> Path:
    return services.runtime_config.logs_dir / "current"


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def _read_tail_lines(path: Path, limit: int) -> list[str]:
    if not path.exists() or limit <= 0:
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines[-limit:]


def _parse_log_line(line: str, fallback_category: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return {
            "level": "info",
            "category": fallback_category,
            "message": line,
        }
    return payload if isinstance(payload, dict) else None


@router.get("/logs/files")
async def list_log_files(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    logs_dir = _current_logs_dir(services)
    files = []
    for category, filename in LOG_FILES.items():
        path = logs_dir / filename
        size = path.stat().st_size if path.exists() else 0
        files.append({
            "category": category,
            "name": filename,
            "path": str(path),
            "exists": path.exists(),
            "bytes": size,
            "size": _format_bytes(size),
        })
    return {
        "logsDir": str(logs_dir),
        "files": files,
    }


@router.get("/logs/tail")
async def tail_logs(
    category: str = Query(default="all"),
    level: str = Query(default="all"),
    runtime: str = Query(default="all"),
    query: str = Query(default=""),
    limit: int = Query(default=300, ge=1, le=2000),
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    logs_dir = _current_logs_dir(services)
    selected = LOG_FILES.items() if category == "all" else [(category, LOG_FILES.get(category, ""))]
    entries: list[dict[str, Any]] = []
    for log_category, filename in selected:
        if not filename:
            continue
        for line in _read_tail_lines(logs_dir / filename, limit):
            entry = _parse_log_line(line, log_category)
            if entry is None:
                continue
            entries.append(entry)

    level_filter = level.lower()
    runtime_filter = runtime.lower()
    text_filter = query.strip().lower()
    filtered = []
    for entry in entries:
        if level_filter != "all" and str(entry.get("level") or "").lower() != level_filter:
            continue
        if runtime_filter != "all" and str(entry.get("runtime") or "").lower() != runtime_filter:
            continue
        if text_filter:
            haystack = json.dumps(entry, ensure_ascii=False).lower()
            if text_filter not in haystack:
                continue
        filtered.append(entry)

    filtered.sort(key=lambda item: str(item.get("timestamp") or ""))
    return JSONResponse({
        "logsDir": str(logs_dir),
        "entries": filtered[-limit:],
    })


@router.get("/logs/diagnostics/{conversation_id}")
async def conversation_diagnostics(
    conversation_id: str,
    limit: int = Query(default=100, ge=1, le=1000),
    services: AppServices = Depends(get_services),
) -> dict[str, Any]:
    logs_dir = _current_logs_dir(services)
    entries = []
    for line in _read_tail_lines(logs_dir / LOG_FILES["diagnostic"], limit * 4):
        entry = _parse_log_line(line, "diagnostic")
        if entry is not None and entry.get("conversationId") == conversation_id:
            entries.append(entry)
    return {
        "conversationId": conversation_id,
        "entries": entries[-limit:],
    }
