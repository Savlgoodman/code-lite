from __future__ import annotations

import asyncio
import base64
import json
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from code_lite_backend.api.dependencies import get_services
from code_lite_backend.services.feature_config import DEFAULT_IMAGE_PROMPT
from code_lite_backend.services.image_config import (
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ImageConfigError,
)
from code_lite_backend.services.prompt_optimize import optimize_prompt as optimize_with_model
from code_lite_backend.services.runtime import AppServices


router = APIRouter()

ALLOWED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
# ── 供应商 CRUD ──

@router.get("/image/providers")
async def list_image_providers(services: AppServices = Depends(get_services)) -> JSONResponse:
    providers = await asyncio.to_thread(services.image_provider_config_store.list_providers)
    return JSONResponse({"providers": providers})


@router.post("/image/providers")
async def create_image_provider(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        provider = await asyncio.to_thread(
            services.image_provider_config_store.create_provider,
            name=str(payload.get("name") or ""),
            base_url=str(payload.get("baseUrl") or ""),
            api_key=str(payload.get("apiKey") or ""),
            default_model=str(payload.get("defaultModel") or "gpt-image-2"),
            request_timeout_seconds=payload.get(
                "requestTimeoutSeconds",
                DEFAULT_REQUEST_TIMEOUT_SECONDS,
            ),
        )
    except ImageConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(provider)


@router.patch("/image/providers/{provider_id}")
async def update_image_provider(
    provider_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        provider = await asyncio.to_thread(
            services.image_provider_config_store.update_provider,
            provider_id,
            payload,
        )
    except ImageConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(provider)


@router.delete("/image/providers/{provider_id}")
async def delete_image_provider(
    provider_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        await asyncio.to_thread(services.image_provider_config_store.delete_provider, provider_id)
    except ImageConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse({"ok": True})


# ── 生成任务 CRUD ──

@router.get("/image/records")
async def list_image_records(services: AppServices = Depends(get_services)) -> JSONResponse:
    records = await asyncio.to_thread(services.image_record_store.list_records)
    return JSONResponse({"records": records})


@router.post("/image/records")
async def create_image_record(services: AppServices = Depends(get_services)) -> JSONResponse:
    record = await asyncio.to_thread(services.image_record_store.create_record)
    return JSONResponse(record)


@router.get("/image/records/{record_id}")
async def get_image_record(
    record_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        record = await asyncio.to_thread(services.image_record_store.get_record, record_id)
    except (FileNotFoundError, ValueError) as error:
        return JSONResponse({"error": str(error)}, status_code=404)
    return JSONResponse(record)


@router.delete("/image/records/{record_id}")
async def delete_image_record(
    record_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        await asyncio.to_thread(services.image_record_store.delete_record, record_id)
    except (FileNotFoundError, ValueError) as error:
        return JSONResponse({"error": str(error)}, status_code=404)
    return JSONResponse({"ok": True})


# ── 参考图 ──

@router.post("/image/records/{record_id}/references")
async def upload_reference(
    record_id: str,
    file: UploadFile = File(...),
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    mime_type = (file.content_type or "").strip().lower()
    if mime_type not in ALLOWED_IMAGE_MIME_TYPES:
        return JSONResponse({"error": f"不支持的图片类型：{mime_type or 'unknown'}"}, status_code=400)
    data = await file.read()
    await file.close()
    try:
        asset = await asyncio.to_thread(
            services.image_record_store.save_reference,
            record_id,
            mime_type=mime_type,
            data=data,
        )
    except FileNotFoundError as error:
        return JSONResponse({"error": str(error)}, status_code=404)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse(asset)


@router.delete("/image/records/{record_id}/references/{image_id}")
async def delete_reference(
    record_id: str,
    image_id: str,
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    try:
        await asyncio.to_thread(services.image_record_store.delete_reference, record_id, image_id)
    except FileNotFoundError as error:
        return JSONResponse({"error": str(error)}, status_code=404)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    return JSONResponse({"ok": True})


# ── 二进制访问 ──

@router.get("/image/records/{record_id}/images/{image_id}")
async def get_generated_image(
    record_id: str,
    image_id: str,
    services: AppServices = Depends(get_services),
) -> Response:
    return _serve_image(services, record_id, "images", image_id)


@router.get("/image/records/{record_id}/references/{image_id}")
async def get_reference_image(
    record_id: str,
    image_id: str,
    services: AppServices = Depends(get_services),
) -> Response:
    return _serve_image(services, record_id, "references", image_id)


def _serve_image(services: AppServices, record_id: str, kind: str, image_id: str) -> Response:
    try:
        file_path, mime_type, file_name = services.image_record_store.image_file(record_id, kind, image_id)
    except (FileNotFoundError, ValueError):
        return JSONResponse({"error": "图片不存在"}, status_code=404)
    return FileResponse(file_path, media_type=mime_type, filename=file_name)


# ── 生成 ──

@router.post("/image/records/{record_id}/generate")
async def generate_image(
    record_id: str,
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    provider_id = str(payload.get("providerId") or "").strip()
    model = str(payload.get("model") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not provider_id:
        return JSONResponse({"error": "请选择图片生成供应商"}, status_code=400)
    if not model:
        return JSONResponse({"error": "请填写模型 ID"}, status_code=400)
    if not prompt:
        return JSONResponse({"error": "请输入提示词"}, status_code=400)

    try:
        n = int(payload.get("n") or 1)
    except (TypeError, ValueError):
        n = 1
    n = max(1, min(n, 4))
    size = str(payload.get("size") or "auto").strip() or "auto"
    quality = str(payload.get("quality") or "auto").strip() or "auto"
    reference_ids = [str(item) for item in (payload.get("referenceImageIds") or []) if str(item).strip()]

    try:
        connection = await asyncio.to_thread(
            services.image_provider_config_store.provider_connection,
            provider_id,
        )
    except ImageConfigError as error:
        return JSONResponse({"error": str(error)}, status_code=400)

    request_snapshot = {
        "providerId": provider_id,
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "quality": quality,
        "referenceImageIds": reference_ids,
    }
    run_id = f"run_{uuid.uuid4().hex[:16]}"

    # 读取参考图二进制（用于 edits multipart）。
    reference_files: list[tuple[bytes, str]] = []
    for ref_id in reference_ids:
        try:
            path, mime_type, _ = services.image_record_store.image_file(record_id, "references", ref_id)
            reference_files.append((path.read_bytes(), mime_type))
        except (FileNotFoundError, ValueError):
            continue

    try:
        raw_images = await asyncio.to_thread(
            _call_image_provider,
            base_url=connection["baseUrl"],
            api_key=connection["apiKey"],
            model=model,
            prompt=prompt,
            n=n,
            size=size,
            quality=quality,
            reference_files=reference_files,
            request_timeout_seconds=int(connection["requestTimeoutSeconds"]),
        )
    except RuntimeError as error:
        run = await asyncio.to_thread(
            services.image_record_store.append_run,
            record_id,
            run_id=run_id,
            request=request_snapshot,
            images=[],
            error=str(error),
        )
        return JSONResponse(run, status_code=502)
    except FileNotFoundError as error:
        return JSONResponse({"error": str(error)}, status_code=404)

    # 落盘生成图。
    stored_images: list[dict[str, Any]] = []
    for image in raw_images:
        stored_images.append(
            await asyncio.to_thread(
                services.image_record_store.write_generated_image,
                record_id,
                mime_type=image.get("mimeType") or "image/png",
                data=image["data"],
                revised_prompt=image.get("revisedPrompt"),
            )
        )

    run = await asyncio.to_thread(
        services.image_record_store.append_run,
        record_id,
        run_id=run_id,
        request=request_snapshot,
        images=stored_images,
    )
    return JSONResponse(run)


@router.post("/image/optimize-prompt")
async def optimize_prompt(
    payload: dict[str, Any],
    services: AppServices = Depends(get_services),
) -> JSONResponse:
    prompt = str(payload.get("prompt") or "").strip()
    style = str(payload.get("style") or "").strip()
    if not prompt:
        return JSONResponse({"error": "请输入待优化的提示词"}, status_code=400)

    feature_settings = await asyncio.to_thread(services.feature_config_store.get_prompt_optimize)
    if not feature_settings.get("imageEnabled", True):
        return JSONResponse({"error": "生图提示词优化已在设置中关闭"}, status_code=400)

    # modelId 优先取请求参数，否则回退到功能设置里配置的默认优化模型。
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

    system_prompt = str(feature_settings.get("imagePrompt") or "").strip() or DEFAULT_IMAGE_PROMPT
    user_content = prompt if not style else f"{prompt}\n\n偏好风格：{style}"
    try:
        optimized = await asyncio.to_thread(
            optimize_with_model,
            base_url=connection["baseUrl"],
            api_key=connection["apiKey"],
            model=resolved.model,
            system_prompt=system_prompt,
            user_prompt=user_content,
        )
    except RuntimeError as error:
        return JSONResponse({"error": str(error)}, status_code=502)
    return JSONResponse({"prompt": optimized})


# ── 外部供应商调用（stdlib urllib，与 settings.py 一致，不新增依赖）──

def _image_endpoint(base_url: str, path: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/v1"):
        return f"{normalized}/{path}"
    return f"{normalized}/v1/{path}"


def _is_timeout_error(error: BaseException) -> bool:
    reason = getattr(error, "reason", None)
    message = f"{error} {reason or ''}".lower()
    return (
        isinstance(error, TimeoutError)
        or isinstance(reason, TimeoutError)
        or "timed out" in message
        or "timeout" in message
    )


def _decode_image_data(
    item: dict[str, Any],
    api_key: str,
    request_timeout_seconds: int,
) -> tuple[bytes, str] | None:
    b64 = item.get("b64_json")
    if isinstance(b64, str) and b64:
        try:
            return base64.b64decode(b64), "image/png"
        except (ValueError, TypeError):
            return None
    url = item.get("url")
    if isinstance(url, str) and url:
        request = Request(url, headers={"Authorization": f"Bearer {api_key}"}, method="GET")
        try:
            with urlopen(request, timeout=request_timeout_seconds) as response:
                mime_type = response.headers.get("Content-Type", "image/png").split(";")[0].strip()
                return response.read(), mime_type or "image/png"
        except (OSError, URLError, TimeoutError) as error:
            if _is_timeout_error(error):
                raise RuntimeError(f"图片下载超时（{request_timeout_seconds} 秒）") from error
            return None
    return None


def _call_image_provider(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    n: int,
    size: str,
    quality: str,
    reference_files: list[tuple[bytes, str]],
    request_timeout_seconds: int,
) -> list[dict[str, Any]]:
    if reference_files:
        endpoint = _image_endpoint(base_url, "images/edits")
        body, content_type = _build_multipart(model, prompt, n, size, quality, reference_files)
        request = Request(
            endpoint,
            data=body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": content_type},
            method="POST",
        )
    else:
        endpoint = _image_endpoint(base_url, "images/generations")
        request_body = json.dumps({
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": size,
            "quality": quality,
            "response_format": "url",
        }).encode("utf-8")
        request = Request(
            endpoint,
            data=request_body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )

    try:
        with urlopen(request, timeout=request_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except HTTPError as error:
        if error.code == 403:
            raise RuntimeError("内容安全策略拦截，请调整提示词后重试") from error
        if error.code == 402:
            raise RuntimeError("供应商余额不足") from error
        if error.code == 401:
            raise RuntimeError("API Key 无效") from error
        raise RuntimeError(f"图片生成接口返回 {error.code}") from error
    except (OSError, URLError, TimeoutError) as error:
        if _is_timeout_error(error):
            raise RuntimeError(f"图片生成请求超时（{request_timeout_seconds} 秒）") from error
        raise RuntimeError("无法连接图片生成供应商") from error
    except json.JSONDecodeError as error:
        raise RuntimeError("图片生成供应商返回内容无法解析") from error

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        raise RuntimeError("图片生成供应商未返回图片")

    images: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        decoded = _decode_image_data(item, api_key, request_timeout_seconds)
        if decoded is None:
            continue
        image_bytes, mime_type = decoded
        images.append({
            "data": image_bytes,
            "mimeType": mime_type,
            "revisedPrompt": item.get("revised_prompt"),
        })
    if not images:
        raise RuntimeError("图片生成结果为空")
    return images


def _build_multipart(
    model: str,
    prompt: str,
    n: int,
    size: str,
    quality: str,
    reference_files: list[tuple[bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"----codelite{uuid.uuid4().hex}"
    lines: list[bytes] = []
    delimiter = f"--{boundary}".encode("utf-8")

    def add_field(name: str, value: str) -> None:
        lines.append(delimiter)
        lines.append(f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"))
        lines.append(b"")
        lines.append(value.encode("utf-8"))

    add_field("model", model)
    add_field("prompt", prompt)
    add_field("n", str(n))
    add_field("size", size)
    add_field("quality", quality)
    add_field("response_format", "url")

    for index, (data, mime_type) in enumerate(reference_files):
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime_type, "png")
        lines.append(delimiter)
        lines.append(
            f'Content-Disposition: form-data; name="image"; filename="reference_{index}.{ext}"'.encode("utf-8")
        )
        lines.append(f"Content-Type: {mime_type}".encode("utf-8"))
        lines.append(b"")
        lines.append(data)

    lines.append(f"--{boundary}--".encode("utf-8"))
    lines.append(b"")
    body = b"\r\n".join(lines)
    return body, f"multipart/form-data; boundary={boundary}"
