from __future__ import annotations

import asyncio
import json
import os
import platform
import subprocess
import time
from typing import Any

from fastapi import APIRouter

from code_lite_backend.core.process_utils import run_hidden


router = APIRouter()


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _clamp_percent(value: Any) -> int | None:
    number = _to_int(value)
    if number is None:
        return None
    return max(0, min(100, number))


def _format_bytes(value: Any) -> str | None:
    size = _to_int(value)
    if size is None or size <= 0:
        return None

    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(size)
    unit_index = 0
    while amount >= 1024 and unit_index < len(units) - 1:
        amount /= 1024
        unit_index += 1

    if amount >= 10 or unit_index == 0:
        return f"{amount:.0f} {units[unit_index]}"
    return f"{amount:.1f} {units[unit_index]}"


def _join_parts(*parts: Any) -> str | None:
    values = [str(part).strip() for part in parts if str(part or "").strip()]
    return " ".join(values) if values else None


def _run_windows_probe() -> dict[str, Any]:
    script = r"""
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$computer = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | Select-Object -First 1
$gpuLoad = $null
try {
  $samples = (Get-Counter "\GPU Engine(*)\Utilization Percentage" -ErrorAction SilentlyContinue).CounterSamples
  if ($samples) {
    $gpuLoad = [Math]::Round([Math]::Min(100, ($samples | Measure-Object -Property CookedValue -Sum).Sum), 0)
  }
} catch {
  $gpuLoad = $null
}
[pscustomobject]@{
  cpuName = $cpu.Name
  cpuCores = $cpu.NumberOfCores
  cpuLogicalProcessors = $cpu.NumberOfLogicalProcessors
  cpuLoad = $cpu.LoadPercentage
  computerManufacturer = $computer.Manufacturer
  computerModel = $computer.Model
  totalPhysicalMemory = $computer.TotalPhysicalMemory
  boardManufacturer = $board.Manufacturer
  boardProduct = $board.Product
  osCaption = $os.Caption
  osVersion = $os.Version
  osBuildNumber = $os.BuildNumber
  totalVisibleMemoryKb = $os.TotalVisibleMemorySize
  freePhysicalMemoryKb = $os.FreePhysicalMemory
  gpuName = $gpu.Name
  gpuMemoryBytes = $gpu.AdapterRAM
  gpuLoad = $gpuLoad
} | ConvertTo-Json -Compress -Depth 3
"""
    result = run_hidden(
        ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=8,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return {}
    return json.loads(result.stdout)


def _collect_system_overview() -> dict[str, Any]:
    raw: dict[str, Any] = {}
    if os.name == "nt":
        try:
            raw = _run_windows_probe()
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            raw = {}

    total_memory = _to_int(raw.get("totalPhysicalMemory"))
    if total_memory is None:
        total_visible_kb = _to_int(raw.get("totalVisibleMemoryKb"))
        total_memory = total_visible_kb * 1024 if total_visible_kb else None

    free_memory_kb = _to_int(raw.get("freePhysicalMemoryKb"))
    memory_used = None
    memory_detail = _format_bytes(total_memory)
    if total_memory and free_memory_kb is not None:
        used_memory = max(0, total_memory - free_memory_kb * 1024)
        memory_used = _clamp_percent(round(used_memory / total_memory * 100))
        memory_detail = f"{_format_bytes(used_memory) or '待检测'} / {_format_bytes(total_memory) or '待检测'}"

    cpu_cores = _to_int(raw.get("cpuCores"))
    cpu_logical = _to_int(raw.get("cpuLogicalProcessors")) or os.cpu_count()
    cpu_core_label = None
    if cpu_cores and cpu_logical:
        cpu_core_label = f"{cpu_cores} 核 / {cpu_logical} 线程"
    elif cpu_logical:
        cpu_core_label = f"{cpu_logical} 逻辑处理器"

    os_label = _join_parts(raw.get("osCaption"), f"Build {raw.get('osBuildNumber')}" if raw.get("osBuildNumber") else None)
    if not os_label:
        os_label = _join_parts(platform.system(), platform.release())

    profile = [
        {"label": "CPU 型号", "value": raw.get("cpuName") or platform.processor() or "待检测"},
        {"label": "CPU 核心", "value": cpu_core_label or "待检测"},
        {"label": "内存", "value": _format_bytes(total_memory) or "待检测"},
        {"label": "主板", "value": _join_parts(raw.get("boardManufacturer"), raw.get("boardProduct")) or "待检测"},
        {"label": "显卡", "value": raw.get("gpuName") or "待检测"},
        {"label": "显存", "value": _format_bytes(raw.get("gpuMemoryBytes")) or "待检测"},
        {"label": "设备型号", "value": _join_parts(raw.get("computerManufacturer"), raw.get("computerModel")) or "待检测"},
        {"label": "操作系统", "value": os_label or "待检测"},
    ]

    usage = [
        {
            "id": "cpu",
            "label": "CPU 占用",
            "value": _clamp_percent(raw.get("cpuLoad")),
            "detail": cpu_core_label or "待检测",
        },
        {
            "id": "gpu",
            "label": "GPU 占用",
            "value": _clamp_percent(raw.get("gpuLoad")),
            "detail": raw.get("gpuName") or "待检测",
        },
        {
            "id": "memory",
            "label": "内存占用",
            "value": memory_used,
            "detail": memory_detail or "待检测",
        },
    ]

    return {
        "collectedAt": int(time.time() * 1000),
        "profile": profile,
        "usage": usage,
    }


@router.get("/system/overview")
async def system_overview() -> dict[str, Any]:
    return await asyncio.to_thread(_collect_system_overview)
