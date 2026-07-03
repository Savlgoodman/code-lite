from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tomllib
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from pc_agent_backend.api.dependencies import get_services
from pc_agent_backend.core.process_utils import run_hidden
from pc_agent_backend.core.paths import REPO_ROOT
from pc_agent_backend.services.agent_runtime_config import AgentRuntimeConfigError
from pc_agent_backend.services.model_config import ModelConfigError
from pc_agent_backend.services.runtime import AppServices
from pc_agent_backend.version import APP_VERSION, BACKEND_VERSION


router = APIRouter()


def _format_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(max(0, size))
    unit_index = 0
    while amount >= 1024 and unit_index < len(units) - 1:
        amount /= 1024
        unit_index += 1

    if amount >= 10 or unit_index == 0:
        return f"{amount:.0f} {units[unit_index]}"
    return f"{amount:.1f} {units[unit_index]}"


def _directory_size(path: Path) -> int:
    if not path.exists():
        return 0

    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def _read_json_version(path: Path) -> str:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "待检测"
    return str(payload.get("version") or "待检测")


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def _read_pyproject_version(path: Path) -> str:
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return "待检测"
    return str(payload.get("project", {}).get("version") or "待检测")


def _run_git(args: list[str], workspace: Path) -> str:
    try:
        result = run_hidden(
            ["git", *args],
            cwd=workspace,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return "待检测"

    if result.returncode != 0:
        return "待检测"
    return result.stdout.strip() or "待检测"


def _sanitize_remote(remote: str) -> str:
    if remote == "待检测":
        return remote

    parsed = urlparse(remote)
    if not parsed.netloc or "@" not in parsed.netloc:
        return remote

    host = parsed.netloc.rsplit("@", 1)[-1]
    return urlunparse((parsed.scheme, host, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _collect_about_info(services: AppServices) -> dict[str, Any]:
    runtime_config = services.runtime_config
    data_sections = [
        ("配置", runtime_config.config_dir),
        ("会话记录", runtime_config.record_dir),
        ("日志", runtime_config.logs_dir),
        ("缓存", runtime_config.cache_dir),
    ]
    section_usage = []
    for label, path in data_sections:
        size = _directory_size(path)
        section_usage.append({
            "label": label,
            "path": str(path),
            "bytes": size,
            "size": _format_bytes(size),
        })

    total_size = _directory_size(runtime_config.data_dir)
    workspace = services.workspace
    remote = _sanitize_remote(_run_git(["config", "--get", "remote.origin.url"], workspace))
    app_version = os.environ.get("REPAIR_AGENT_APP_VERSION") or _read_json_version(REPO_ROOT / "package.json")
    if app_version == "待检测":
        app_version = APP_VERSION
    backend_version = os.environ.get("REPAIR_AGENT_BACKEND_VERSION") or _read_pyproject_version(
        REPO_ROOT / "backend" / "pyproject.toml"
    )
    if backend_version == "待检测":
        backend_version = BACKEND_VERSION

    return {
        "appVersion": app_version,
        "backendVersion": backend_version,
        "runtimeEnv": runtime_config.env or "默认",
        "agentAdapter": runtime_config.agent_adapter,
        "workspace": str(workspace),
        "dataDir": str(runtime_config.data_dir),
        "dataDirBytes": total_size,
        "dataDirSize": _format_bytes(total_size),
        "git": {
            "remote": remote,
            "branch": _run_git(["branch", "--show-current"], workspace),
            "commit": _run_git(["rev-parse", "--short", "HEAD"], workspace),
        },
        "dataUsage": section_usage,
    }


def _model_endpoint_candidates(base_url: str) -> list[str]:
    normalized = base_url.strip().rstrip("/")
    if not normalized:
        return []

    if normalized.endswith("/models"):
        return [normalized]

    candidates = [f"{normalized}/models"]
    if not normalized.endswith("/v1"):
        candidates.append(f"{normalized}/v1/models")
    return list(dict.fromkeys(candidates))


def _extract_model_ids(payload: Any) -> list[str]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if data is None and isinstance(payload, dict):
        data = payload.get("models")

    if isinstance(data, dict):
        data = list(data.values())

    models: list[str] = []
    if not isinstance(data, list):
        return models

    for item in data:
        if isinstance(item, str):
            model_id = item
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("name") or item.get("model")
        else:
            model_id = None

        if model_id:
            models.append(str(model_id))

    return sorted(set(models))


def _probe_models(base_url: str, api_key: str) -> dict[str, Any]:
    last_error = "无法获取模型列表"
    for endpoint in _model_endpoint_candidates(base_url):
        request = Request(
            endpoint,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
        except HTTPError as error:
            last_error = f"模型列表接口返回 {error.code}"
            continue
        except (OSError, URLError, TimeoutError, json.JSONDecodeError):
            last_error = "无法获取模型列表"
            continue

        models = _extract_model_ids(payload)
        if models:
            return {"endpoint": endpoint, "models": models}
        last_error = "模型列表为空"

    raise RuntimeError(last_error)


@router.get("/settings/about")
async def settings_about(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    return await asyncio.to_thread(_collect_about_info, services)


@router.post("/settings/model-providers/models")
async def probe_model_provider_models(payload: dict[str, Any]) -> JSONResponse:
    base_url = str(payload.get("baseUrl") or "").strip()
    api_key = str(payload.get("apiKey") or "").strip()

    if not base_url or not api_key:
        return JSONResponse({"error": "baseUrl and apiKey are required"}, status_code=400)

    try:
        result = await asyncio.to_thread(_probe_models, base_url, api_key)
    except RuntimeError as error:
        return JSONResponse({"error": str(error)}, status_code=502)

    return JSONResponse(result)


@router.get("/settings/model-providers")
async def list_model_providers(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    return await asyncio.to_thread(services.model_config_store.list_settings)


@router.get("/settings/agent-runtimes")
async def list_agent_runtimes(services: AppServices = Depends(get_services)) -> dict[str, Any]:
    return await asyncio.to_thread(services.agent_runtime_config_store.list_settings)


@router.patch("/settings/agent-runtimes/active")
async def update_active_agent_runtime(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        settings = await asyncio.to_thread(
            services.agent_runtime_config_store.update_active_adapter,
            str(payload.get("adapter") or ""),
        )
    except AgentRuntimeConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(settings)


@router.get("/settings/agent-runtimes/{runtime_id}/models")
async def list_agent_runtime_models(
    runtime_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    runtime_settings = services.agent_runtime_config_store.load()["agentRuntimes"]
    runtime = runtime_settings.get(runtime_id)
    if runtime is None:
        return JSONResponse({"error": "Agent runtime 不存在"}, status_code=404)
    adapter = str(runtime.get("adapter") or runtime_id)
    try:
        if not hasattr(services.agent_adapter, "list_models"):
            return JSONResponse({
                "adapter": adapter,
                "currentModelId": None,
                "models": [],
            })
        if getattr(services.agent_adapter, "name", "") == "router":
            result = await services.agent_adapter.list_models(adapter, services.workspace)  # type: ignore[attr-defined]
        else:
            result = await services.agent_adapter.list_models(services.workspace)  # type: ignore[attr-defined]
    except Exception as error:
        return JSONResponse({"error": f"获取 Agent 模型失败：{type(error).__name__}: {error}"}, status_code=502)
    return JSONResponse(result)


@router.patch("/settings/agent-runtimes/{runtime_id}")
async def update_agent_runtime(
    runtime_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        runtime = await asyncio.to_thread(
            services.agent_runtime_config_store.update_runtime,
            runtime_id,
            payload,
        )
    except AgentRuntimeConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(runtime)


@router.post("/settings/agent-runtimes/{runtime_id}/install")
async def install_agent_runtime(
    runtime_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        runtime = await asyncio.to_thread(
            services.agent_runtime_config_store.install_runtime,
            runtime_id,
        )
    except AgentRuntimeConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(runtime)


@router.post("/settings/model-providers")
async def create_model_provider(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        provider = await asyncio.to_thread(
            services.model_config_store.create_provider,
            name=str(payload.get("name") or ""),
            base_url=str(payload.get("baseUrl") or ""),
            api_key=str(payload.get("apiKey") or ""),
            protocol=str(payload.get("protocol") or "openai"),
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(provider)


@router.patch("/settings/model-providers/{provider_id}")
async def update_model_provider(
    provider_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        provider = await asyncio.to_thread(
            services.model_config_store.update_provider,
            provider_id,
            payload,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(provider)


@router.delete("/settings/model-providers/{provider_id}")
async def delete_model_provider(
    provider_id: str,
    payload: dict[str, Any] | None = None,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    replacement_model_id = str((payload or {}).get("replacementModelId") or "").strip() or None
    try:
        settings = await asyncio.to_thread(
            services.model_config_store.delete_provider,
            provider_id,
            replacement_model_id=replacement_model_id,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(settings)


@router.post("/settings/model-providers/{provider_id}/models/refresh")
async def refresh_model_provider_models(
    provider_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        connection = await asyncio.to_thread(services.model_config_store.provider_connection, provider_id)
        result = await asyncio.to_thread(_probe_models, connection["baseUrl"], connection["apiKey"])
        provider = await asyncio.to_thread(
            services.model_config_store.update_models_cache,
            provider_id,
            endpoint=str(result.get("endpoint") or ""),
            models=list(result.get("models") or []),
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except RuntimeError as error:
        return JSONResponse({"error": str(error)}, status_code=502)
    return JSONResponse(provider)


@router.post("/settings/model-providers/{provider_id}/models")
async def add_model_provider_models(
    provider_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    raw_models = payload.get("models")
    if isinstance(raw_models, list):
        models = [model for model in raw_models if isinstance(model, dict)]
    else:
        models = [payload]
    try:
        settings = await asyncio.to_thread(
            services.model_config_store.add_models,
            provider_id,
            models,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(settings)


@router.patch("/settings/models/default")
async def update_default_model(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        settings = await asyncio.to_thread(
            services.model_config_store.update_default,
            default_strategy=str(payload.get("defaultStrategy") or "last_used"),
            default_model_id=str(payload.get("defaultModelId") or "").strip() or None,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(settings)


@router.patch("/settings/models/{model_id}")
async def update_model(
    model_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        model = await asyncio.to_thread(
            services.model_config_store.update_model,
            model_id,
            payload,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(model)


@router.delete("/settings/models/{model_id}")
async def delete_model(
    model_id: str,
    payload: dict[str, Any] | None = None,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    replacement_model_id = str((payload or {}).get("replacementModelId") or "").strip() or None
    try:
        settings = await asyncio.to_thread(
            services.model_config_store.delete_model,
            model_id,
            replacement_model_id=replacement_model_id,
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(settings)


@router.post("/settings/model-providers/default")
async def save_default_model_provider(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    base_url = str(payload.get("baseUrl") or "").strip()
    api_key = str(payload.get("apiKey") or "").strip()
    model = str(payload.get("model") or "").strip()
    supports_reasoning = bool(payload.get("supportsReasoning"))

    if not base_url or not api_key or not model:
        return JSONResponse({"error": "baseUrl, apiKey and model are required"}, status_code=400)

    try:
        provider = await asyncio.to_thread(
            services.model_config_store.create_provider,
            name="自定义供应商",
            base_url=base_url,
            api_key=api_key,
            protocol="openai",
        )
        settings = await asyncio.to_thread(
            services.model_config_store.add_models,
            str(provider["id"]),
            [
                {
                    "model": model,
                    "label": f"PC Agent 默认模型 ({model})",
                    "capabilities": {
                        "reasoning": supports_reasoning,
                    },
                    "generation": {
                        "reasoningEffort": "medium" if supports_reasoning else "none",
                    },
                }
            ],
        )
        first_model = next(
            item for item in settings["models"] if item["providerId"] == provider["id"] and item["model"] == model
        )
        settings = await asyncio.to_thread(
            services.model_config_store.update_default,
            default_strategy="fixed",
            default_model_id=str(first_model["id"]),
        )
    except ModelConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse({
        "configPath": str(services.runtime_config.nanobot_config_path),
        "model": model,
        "modelPreset": first_model["modelPresetId"],
        "provider": provider["id"],
        "settings": settings,
    })
