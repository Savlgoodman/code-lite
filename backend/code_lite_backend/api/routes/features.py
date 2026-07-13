from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.feature_config import DEFAULT_CODE_PROMPT
from code_lite_backend.services.prompt_optimize import optimize_prompt as optimize_with_model
from code_lite_backend.services.runtime import AppServices


router = APIRouter()

# 提示词模板里可用的项目文档占位符 -> 对应根目录文件名。
_DOC_PLACEHOLDERS = {
    "{AGENTS.md}": "AGENTS.md",
    "{CLAUDE.md}": "CLAUDE.md",
}
# 单个占位文档注入上限，避免超长文档撑爆上下文。
_MAX_DOC_BYTES = 32 * 1024


@router.get("/settings/features")
async def get_features(services: AppServices = Depends(get_services)) -> JSONResponse:
    settings = await asyncio.to_thread(services.feature_config_store.get_prompt_optimize)
    return JSONResponse({"promptOptimize": settings})


@router.patch("/settings/features")
async def update_features(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    prompt_optimize = payload.get("promptOptimize") if isinstance(payload.get("promptOptimize"), dict) else payload
    settings = await asyncio.to_thread(
        services.feature_config_store.update_prompt_optimize,
        prompt_optimize,
    )
    return JSONResponse({"promptOptimize": settings})


@router.post("/settings/optimize-code-prompt")
async def optimize_code_prompt(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "请输入待优化的提示词"}, status_code=400)

    feature_settings = await asyncio.to_thread(services.feature_config_store.get_prompt_optimize)
    if not feature_settings.get("codeEnabled", False):
        return JSONResponse({"error": "code agent 提示词优化已在设置中关闭"}, status_code=400)

    model_id = str(payload.get("modelId") or "").strip() or str(feature_settings.get("modelId") or "").strip()
    if not model_id:
        return JSONResponse({"error": "请在设置的功能页选择用于优化的文本模型"}, status_code=400)

    resolved = await asyncio.to_thread(services.model_config_store.resolve_model, model_id)
    if resolved is None:
        return JSONResponse({"error": "文本模型不存在或未启用"}, status_code=400)
    connection = await asyncio.to_thread(
        services.model_config_store.provider_connection,
        resolved.provider_id,
    )

    # 优化模板里的 {AGENTS.md}/{CLAUDE.md} 占位符用工作区根目录对应文档内容替换，
    # 让优化后的提示词更了解项目情况。workspace 可由请求指定（会话工作区），否则用后端默认工作区。
    workspace = _resolve_workspace(str(payload.get("workspace") or "").strip(), services.workspace)
    template = str(feature_settings.get("codePrompt") or "").strip() or DEFAULT_CODE_PROMPT
    system_prompt = _inject_project_docs(template, workspace)

    try:
        optimized = await asyncio.to_thread(
            optimize_with_model,
            base_url=connection["baseUrl"],
            api_key=connection["apiKey"],
            model=resolved.model,
            system_prompt=system_prompt,
            user_prompt=prompt,
        )
    except RuntimeError as error:
        return JSONResponse({"error": str(error)}, status_code=502)
    return JSONResponse({"prompt": optimized})


def _resolve_workspace(raw: str, default_workspace: Path) -> Path:
    if not raw:
        return default_workspace
    try:
        candidate = Path(raw).expanduser()
        return candidate if candidate.is_dir() else default_workspace
    except OSError:
        return default_workspace


def _inject_project_docs(template: str, workspace: Path) -> str:
    result = template
    for placeholder, file_name in _DOC_PLACEHOLDERS.items():
        if placeholder not in result:
            continue
        result = result.replace(placeholder, _read_doc(workspace, file_name))
    return result


def _read_doc(workspace: Path, file_name: str) -> str:
    try:
        path = (workspace / file_name).resolve()
        workspace_resolved = workspace.resolve()
    except OSError:
        return f"(无法定位 {file_name})"
    # 只读工作区根目录下的文档，防目录穿越。
    if path.parent != workspace_resolved or not path.is_file():
        return f"(未找到根目录 {file_name})"
    try:
        with path.open("rb") as handle:
            raw = handle.read(_MAX_DOC_BYTES + 1)
    except OSError:
        return f"(无法读取 {file_name})"
    text = raw[:_MAX_DOC_BYTES].decode("utf-8", errors="replace")
    if len(raw) > _MAX_DOC_BYTES:
        text += "\n\n... (文档过长，已截断)"
    return text
