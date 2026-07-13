from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.storage.conversations import atomic_write_json, now_ms


SCHEMA_VERSION = 1
DEFAULT_MODEL = "gpt-image-2"


class ImageConfigError(ValueError):
    pass


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _preview_secret(value: str) -> str:
    if not value:
        return ""
    return f"末尾 4 位：{value[-4:]}" if len(value) > 4 else "已保存"


def _provider_name_from_url(base_url: str) -> str:
    value = base_url.strip().removeprefix("https://").removeprefix("http://").split("/", 1)[0]
    return value or "图片供应商"


def _empty_config() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "imageProviders": []}


class ImageProviderConfigStore:
    """图片生成供应商配置：仅 url + apiKey（+ 可选名称/默认模型）。

    与 ModelConfigStore 分离，独立落 image_config.json，避免两个 store 互相覆盖
    app_config.json 顶层字段。API Key 仅后端持有，接口一律遮蔽。
    """

    def __init__(self, runtime_config: RuntimeConfig) -> None:
        self._path = runtime_config.image_config_path

    def load(self) -> dict[str, Any]:
        config = self._normalize(_read_json_object(self._path))
        return config

    def save(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize(config)
        atomic_write_json(self._path, normalized)
        return normalized

    def list_providers(self) -> list[dict[str, Any]]:
        config = self.load()
        return [self._public_provider(provider) for provider in config["imageProviders"]]

    def create_provider(
        self,
        *,
        name: str,
        base_url: str,
        api_key: str,
        default_model: str = DEFAULT_MODEL,
    ) -> dict[str, Any]:
        base_url = base_url.strip().rstrip("/")
        api_key = api_key.strip()
        name = name.strip() or _provider_name_from_url(base_url)
        default_model = default_model.strip() or DEFAULT_MODEL
        if not base_url:
            raise ImageConfigError("Base URL 不能为空")
        if not api_key:
            raise ImageConfigError("API Key 不能为空")

        config = self.load()
        provider = {
            "id": f"imgprovider_{uuid.uuid4().hex[:12]}",
            "name": name,
            "baseUrl": base_url,
            "apiKey": api_key,
            "defaultModel": default_model,
            "enabled": True,
            "createdAt": now_ms(),
            "updatedAt": now_ms(),
        }
        config["imageProviders"].append(provider)
        self.save(config)
        return self._public_provider(provider)

    def update_provider(self, provider_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        config = self.load()
        provider = self._find_provider(config, provider_id)
        if provider is None:
            raise ImageConfigError("供应商不存在")
        if "name" in patch:
            name = str(patch.get("name") or "").strip()
            if name:
                provider["name"] = name
        if "baseUrl" in patch:
            base_url = str(patch.get("baseUrl") or "").strip().rstrip("/")
            if not base_url:
                raise ImageConfigError("Base URL 不能为空")
            provider["baseUrl"] = base_url
        if "apiKey" in patch:
            api_key = str(patch.get("apiKey") or "").strip()
            if api_key:
                provider["apiKey"] = api_key
        if "defaultModel" in patch:
            provider["defaultModel"] = str(patch.get("defaultModel") or "").strip() or DEFAULT_MODEL
        if "enabled" in patch:
            provider["enabled"] = bool(patch.get("enabled"))
        provider["updatedAt"] = now_ms()
        self.save(config)
        return self._public_provider(provider)

    def delete_provider(self, provider_id: str) -> None:
        config = self.load()
        if self._find_provider(config, provider_id) is None:
            raise ImageConfigError("供应商不存在")
        config["imageProviders"] = [
            item for item in config["imageProviders"] if item.get("id") != provider_id
        ]
        self.save(config)

    def provider_connection(self, provider_id: str) -> dict[str, str]:
        config = self.load()
        provider = self._find_provider(config, provider_id)
        if provider is None:
            raise ImageConfigError("供应商不存在")
        if not provider.get("enabled", True):
            raise ImageConfigError("供应商已停用")
        return {
            "baseUrl": str(provider.get("baseUrl") or ""),
            "apiKey": str(provider.get("apiKey") or ""),
            "defaultModel": str(provider.get("defaultModel") or DEFAULT_MODEL),
        }

    def _normalize(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = _empty_config()
        providers = config.get("imageProviders") if isinstance(config.get("imageProviders"), list) else []
        seen: set[str] = set()
        for item in providers:
            if not isinstance(item, dict):
                continue
            provider_id = str(item.get("id") or "").strip() or f"imgprovider_{uuid.uuid4().hex[:12]}"
            while provider_id in seen:
                provider_id = f"imgprovider_{uuid.uuid4().hex[:12]}"
            seen.add(provider_id)
            normalized["imageProviders"].append({
                "id": provider_id,
                "name": str(item.get("name") or provider_id),
                "baseUrl": str(item.get("baseUrl") or "").strip().rstrip("/"),
                "apiKey": str(item.get("apiKey") or ""),
                "defaultModel": str(item.get("defaultModel") or DEFAULT_MODEL),
                "enabled": item.get("enabled", True) is not False,
                "createdAt": int(item.get("createdAt") or now_ms()),
                "updatedAt": int(item.get("updatedAt") or now_ms()),
            })
        return normalized

    @staticmethod
    def _find_provider(config: dict[str, Any], provider_id: str) -> dict[str, Any] | None:
        for provider in config.get("imageProviders", []):
            if provider.get("id") == provider_id:
                return provider
        return None

    @staticmethod
    def _public_provider(provider: dict[str, Any]) -> dict[str, Any]:
        api_key = str(provider.get("apiKey") or "")
        return {
            "id": provider.get("id"),
            "name": provider.get("name"),
            "baseUrl": provider.get("baseUrl"),
            "defaultModel": provider.get("defaultModel"),
            "enabled": provider.get("enabled", True),
            "createdAt": provider.get("createdAt"),
            "updatedAt": provider.get("updatedAt"),
            "hasApiKey": bool(api_key),
            "apiKeyPreview": _preview_secret(api_key),
        }
