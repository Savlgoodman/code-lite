from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.storage.conversations import atomic_write_json, now_ms


SCHEMA_VERSION = 1
DEFAULT_CONTEXT_WINDOW_TOKENS = 65_536
DEFAULT_MAX_OUTPUT_TOKENS = 4_096
DEFAULT_TEMPERATURE = 0.1
DEFAULT_PROTOCOL = "openai"


class ModelConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedModel:
    model_id: str
    model_preset_id: str
    provider_id: str
    provider_name: str
    model: str
    label: str
    protocol: str
    context_window_tokens: int
    max_output_tokens: int
    reasoning_effort: str


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _slug(value: str, *, fallback: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower()).strip("_")
    return normalized or fallback


def _unique_id(prefix: str, seed: str, existing: set[str]) -> str:
    base = f"{prefix}_{_slug(seed, fallback=uuid.uuid4().hex[:8])}"
    candidate = base
    index = 2
    while candidate in existing:
        candidate = f"{base}_{index}"
        index += 1
    existing.add(candidate)
    return candidate


def _model_preset_id(model_id: str) -> str:
    return f"pc_{_slug(model_id, fallback='model')}"


def _provider_key(provider: dict[str, Any]) -> str:
    existing = str(provider.get("nanobotProviderKey") or "").strip()
    if existing:
        return existing
    return _slug(str(provider.get("name") or provider.get("id") or "custom"), fallback="custom")


def _as_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _as_float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _preview_secret(value: str) -> str:
    if not value:
        return ""
    return f"末尾 4 位：{value[-4:]}" if len(value) > 4 else "已保存"


def _model_label(model: str) -> str:
    return model.rsplit("/", 1)[-1] or model


def _empty_config() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "modelSettings": {
            "defaultStrategy": "last_used",
            "defaultModelId": None,
            "lastUsedModelId": None,
        },
        "llmProviders": [],
    }


class ModelConfigStore:
    def __init__(self, runtime_config: RuntimeConfig) -> None:
        self._runtime_config = runtime_config
        self._path = runtime_config.app_config_path
        self._nanobot_path = runtime_config.nanobot_config_path

    def load(self) -> dict[str, Any]:
        if not self._path.exists():
            config = self._migrate_from_nanobot_config()
            self.save(config, sync_nanobot=True)
            return config
        config = self._normalize(_read_json_object(self._path))
        self.save(config, sync_nanobot=False)
        return config

    def save(self, config: dict[str, Any], *, sync_nanobot: bool = True) -> dict[str, Any]:
        normalized = self._normalize(config)
        atomic_write_json(self._path, normalized)
        if sync_nanobot:
            self.sync_nanobot_config(normalized)
        return normalized

    def list_settings(self) -> dict[str, Any]:
        config = self.load()
        providers = config["llmProviders"]
        models = self._enabled_models(config, include_disabled=True)
        settings = config["modelSettings"]
        effective = self.effective_default_model(config=config)
        return {
            "providers": [self._public_provider(provider) for provider in providers],
            "models": [self._public_model(provider, model) for provider in providers for model in provider.get("models", [])],
            "defaultStrategy": settings.get("defaultStrategy"),
            "defaultModelId": settings.get("defaultModelId"),
            "lastUsedModelId": settings.get("lastUsedModelId"),
            "effectiveDefaultModelId": effective.model_id if effective else None,
            "hasModels": bool(models),
            "configPath": str(self._path),
            "nanobotConfigPath": str(self._nanobot_path),
        }

    def create_provider(
        self,
        *,
        name: str,
        base_url: str,
        api_key: str,
        protocol: str = DEFAULT_PROTOCOL,
    ) -> dict[str, Any]:
        name = name.strip() or self._provider_name_from_url(base_url)
        base_url = base_url.strip().rstrip("/")
        api_key = api_key.strip()
        protocol = self._normalize_protocol(protocol)
        if not base_url:
            raise ModelConfigError("Base URL 不能为空")
        if not api_key:
            raise ModelConfigError("API Key 不能为空")

        config = self.load()
        existing_ids = {str(provider.get("id")) for provider in config["llmProviders"]}
        provider_id = _unique_id("provider", name or base_url, existing_ids)
        existing_keys = {
            str(provider.get("nanobotProviderKey") or "")
            for provider in config["llmProviders"]
        }
        provider_key = self._unique_provider_key(
            self._suggest_provider_key(name, provider_id),
            existing_keys,
        )
        provider = {
            "id": provider_id,
            "name": name,
            "baseUrl": base_url,
            "apiKey": api_key,
            "protocol": protocol,
            "enabled": True,
            "modelsEndpoint": "",
            "lastModelsRefreshAt": None,
            "discoveredModels": [],
            "models": [],
            "nanobotProviderKey": provider_key,
        }
        config["llmProviders"].append(provider)
        self.save(config)
        return self._public_provider(provider)

    def update_provider(self, provider_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        config, provider = self._provider_for_update(provider_id)
        if "name" in patch:
            name = str(patch.get("name") or "").strip()
            if name:
                provider["name"] = name
        if "baseUrl" in patch:
            base_url = str(patch.get("baseUrl") or "").strip().rstrip("/")
            if not base_url:
                raise ModelConfigError("Base URL 不能为空")
            provider["baseUrl"] = base_url
        if "apiKey" in patch:
            api_key = str(patch.get("apiKey") or "").strip()
            if api_key:
                provider["apiKey"] = api_key
        if "protocol" in patch:
            provider["protocol"] = self._normalize_protocol(str(patch.get("protocol") or DEFAULT_PROTOCOL))
        if "enabled" in patch:
            provider["enabled"] = bool(patch.get("enabled"))
        self._ensure_default_valid(config)
        self.save(config)
        return self._public_provider(provider)

    def update_models_cache(self, provider_id: str, *, endpoint: str, models: list[str]) -> dict[str, Any]:
        config, provider = self._provider_for_update(provider_id)
        provider["modelsEndpoint"] = endpoint
        provider["lastModelsRefreshAt"] = now_ms()
        provider["discoveredModels"] = [
            {
                "id": model,
                "label": _model_label(model),
            }
            for model in sorted(set(str(model).strip() for model in models if str(model).strip()))
        ]
        self.save(config)
        return self._public_provider(provider)

    def provider_connection(self, provider_id: str) -> dict[str, str]:
        config = self.load()
        provider = self._find_provider(config, provider_id)
        if provider is None:
            raise ModelConfigError("供应商不存在")
        return {
            "baseUrl": str(provider.get("baseUrl") or ""),
            "apiKey": str(provider.get("apiKey") or ""),
            "protocol": str(provider.get("protocol") or DEFAULT_PROTOCOL),
        }

    def add_models(self, provider_id: str, models: list[dict[str, Any]]) -> dict[str, Any]:
        if not models:
            raise ModelConfigError("至少选择一个模型")
        config, provider = self._provider_for_update(provider_id)
        existing_ids = {
            str(model.get("id"))
            for item in config["llmProviders"]
            for model in item.get("models", [])
        }
        existing_names = {str(model.get("model")) for model in provider.get("models", [])}
        for item in models:
            model_name = str(item.get("model") or "").strip()
            if not model_name or model_name in existing_names:
                continue
            model_id = _unique_id("model", f"{provider_id}_{model_name}", existing_ids)
            existing_names.add(model_name)
            provider.setdefault("models", []).append(self._normalize_model({
                "id": model_id,
                "providerId": provider_id,
                "model": model_name,
                "label": str(item.get("label") or _model_label(model_name)),
                "protocol": item.get("protocol") or provider.get("protocol") or DEFAULT_PROTOCOL,
                "enabled": item.get("enabled", True),
                "capabilities": item.get("capabilities") or {},
                "limits": item.get("limits") or {},
                "generation": item.get("generation") or {},
            }, provider))
        self._ensure_default_valid(config)
        self.save(config)
        return self.list_settings()

    def update_model(self, model_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        config, provider, model = self._model_for_update(model_id)
        if "label" in patch:
            label = str(patch.get("label") or "").strip()
            if label:
                model["label"] = label
        if "protocol" in patch:
            model["protocol"] = self._normalize_protocol(str(patch.get("protocol") or provider.get("protocol") or DEFAULT_PROTOCOL))
        if "enabled" in patch:
            model["enabled"] = bool(patch.get("enabled"))
        if isinstance(patch.get("capabilities"), dict):
            model["capabilities"] = {
                **model.get("capabilities", {}),
                **patch["capabilities"],
            }
        if isinstance(patch.get("limits"), dict):
            model["limits"] = self._normalize_limits({
                **model.get("limits", {}),
                **patch["limits"],
            })
        if isinstance(patch.get("generation"), dict):
            model["generation"] = self._normalize_generation({
                **model.get("generation", {}),
                **patch["generation"],
            })
        self._ensure_default_valid(config)
        self.save(config)
        return self._public_model(provider, model)

    def delete_model(self, model_id: str, *, replacement_model_id: str | None = None) -> dict[str, Any]:
        config = self.load()
        removed = False
        for provider in config["llmProviders"]:
            models = provider.get("models", [])
            next_models = [model for model in models if model.get("id") != model_id]
            if len(next_models) != len(models):
                provider["models"] = next_models
                removed = True
                break
        if not removed:
            raise ModelConfigError("模型不存在")

        settings = config["modelSettings"]
        if settings.get("defaultModelId") == model_id:
            settings["defaultModelId"] = replacement_model_id
        if settings.get("lastUsedModelId") == model_id:
            settings["lastUsedModelId"] = replacement_model_id
        self._ensure_default_valid(config)
        self.save(config)
        return self.list_settings()

    def delete_provider(self, provider_id: str, *, replacement_model_id: str | None = None) -> dict[str, Any]:
        config = self.load()
        provider = self._find_provider(config, provider_id)
        if provider is None:
            raise ModelConfigError("供应商不存在")
        removed_model_ids = {str(model.get("id")) for model in provider.get("models", [])}
        config["llmProviders"] = [item for item in config["llmProviders"] if item.get("id") != provider_id]
        settings = config["modelSettings"]
        if settings.get("defaultModelId") in removed_model_ids:
            settings["defaultModelId"] = replacement_model_id
        if settings.get("lastUsedModelId") in removed_model_ids:
            settings["lastUsedModelId"] = replacement_model_id
        self._ensure_default_valid(config)
        self.save(config)
        return self.list_settings()

    def update_default(self, *, default_strategy: str, default_model_id: str | None) -> dict[str, Any]:
        config = self.load()
        strategy = "fixed" if default_strategy == "fixed" else "last_used"
        if strategy == "fixed" and not self.resolve_model(default_model_id, config=config):
            raise ModelConfigError("固定默认模型不存在或未启用")
        settings = config["modelSettings"]
        settings["defaultStrategy"] = strategy
        settings["defaultModelId"] = default_model_id if strategy == "fixed" else None
        self._ensure_default_valid(config)
        self.save(config)
        return self.list_settings()

    def mark_last_used(self, model_id: str | None) -> None:
        if not model_id:
            return
        config = self.load()
        if self.resolve_model(model_id, config=config):
            config["modelSettings"]["lastUsedModelId"] = model_id
            self.save(config)

    def resolve_model(
        self,
        model_id: str | None,
        *,
        config: dict[str, Any] | None = None,
    ) -> ResolvedModel | None:
        config = config or self.load()
        if not model_id:
            return None
        for provider in config["llmProviders"]:
            if not provider.get("enabled", True):
                continue
            for model in provider.get("models", []):
                if model.get("id") == model_id and model.get("enabled", True):
                    return self._resolved_model(provider, model)
        return None

    def effective_default_model(self, *, config: dict[str, Any] | None = None) -> ResolvedModel | None:
        config = config or self.load()
        settings = config["modelSettings"]
        candidates = []
        if settings.get("defaultStrategy") == "fixed":
            candidates.append(settings.get("defaultModelId"))
        else:
            candidates.append(settings.get("lastUsedModelId"))
            candidates.append(settings.get("defaultModelId"))
        for model_id in candidates:
            resolved = self.resolve_model(model_id, config=config)
            if resolved:
                return resolved
        enabled = self._enabled_models(config)
        if not enabled:
            return None
        provider, model = enabled[0]
        return self._resolved_model(provider, model)

    def sync_nanobot_config(self, config: dict[str, Any] | None = None) -> None:
        config = config or self.load()
        nanobot_config = _read_json_object(self._nanobot_path)
        providers_payload: dict[str, Any] = {}
        presets_payload: dict[str, Any] = {}

        for provider in config["llmProviders"]:
            if not provider.get("enabled", True):
                continue
            provider_key = _provider_key(provider)
            provider_payload: dict[str, Any] = {
                "apiKey": str(provider.get("apiKey") or ""),
                "apiBase": str(provider.get("baseUrl") or ""),
            }
            protocol = str(provider.get("protocol") or DEFAULT_PROTOCOL)
            if protocol == "openai_responses" and provider_key == "openai":
                provider_payload["apiType"] = "responses"
            providers_payload[provider_key] = provider_payload

            for model in provider.get("models", []):
                if not model.get("enabled", True):
                    continue
                preset_id = _model_preset_id(str(model.get("id") or "model"))
                limits = model.get("limits") if isinstance(model.get("limits"), dict) else {}
                generation = model.get("generation") if isinstance(model.get("generation"), dict) else {}
                presets_payload[preset_id] = {
                    "label": str(model.get("label") or model.get("model") or preset_id),
                    "provider": provider_key,
                    "model": str(model.get("model") or ""),
                    "maxTokens": _as_int(limits.get("maxOutputTokens"), DEFAULT_MAX_OUTPUT_TOKENS),
                    "contextWindowTokens": _as_int(limits.get("contextWindowTokens"), DEFAULT_CONTEXT_WINDOW_TOKENS),
                    "temperature": _as_float(generation.get("temperature"), DEFAULT_TEMPERATURE),
                    "reasoningEffort": str(generation.get("reasoningEffort") or "none"),
                }

        nanobot_config["providers"] = {
            **{
                key: value
                for key, value in (nanobot_config.get("providers") or {}).items()
                if key not in providers_payload
            },
            **providers_payload,
        }
        nanobot_config["modelPresets"] = presets_payload
        agents = nanobot_config.setdefault("agents", {})
        if not isinstance(agents, dict):
            agents = {}
            nanobot_config["agents"] = agents
        defaults = agents.setdefault("defaults", {})
        if not isinstance(defaults, dict):
            defaults = {}
            agents["defaults"] = defaults
        effective = self.effective_default_model(config=config)
        if effective:
            defaults["modelPreset"] = effective.model_preset_id
        defaults.setdefault("maxToolIterations", 20)
        defaults.setdefault("failOnToolError", True)
        tools = nanobot_config.setdefault("tools", {})
        if isinstance(tools, dict):
            tools.setdefault("restrictToWorkspace", True)
            tools.setdefault("exec", {"enable": True, "timeout": 30})
            tools.setdefault("file", {"enable": True})
            tools.setdefault("web", {"search": {"enable": False}, "fetch": {"enable": False}})
        atomic_write_json(self._nanobot_path, nanobot_config)

    def _migrate_from_nanobot_config(self) -> dict[str, Any]:
        config = _empty_config()
        nanobot = _read_json_object(self._nanobot_path)
        providers = nanobot.get("providers") if isinstance(nanobot.get("providers"), dict) else {}
        presets = nanobot.get("modelPresets") if isinstance(nanobot.get("modelPresets"), dict) else {}
        defaults = ((nanobot.get("agents") or {}).get("defaults") or {}) if isinstance(nanobot.get("agents"), dict) else {}
        default_preset = defaults.get("modelPreset")

        provider_ids: dict[str, str] = {}
        existing_provider_ids: set[str] = set()
        existing_model_ids: set[str] = set()
        for provider_key, provider_value in providers.items():
            if not isinstance(provider_value, dict):
                continue
            provider_id = _unique_id("provider", str(provider_key), existing_provider_ids)
            provider_ids[str(provider_key)] = provider_id
            config["llmProviders"].append({
                "id": provider_id,
                "name": str(provider_key),
                "baseUrl": str(provider_value.get("apiBase") or provider_value.get("api_base") or ""),
                "apiKey": str(provider_value.get("apiKey") or provider_value.get("api_key") or ""),
                "protocol": "openai_responses" if provider_value.get("apiType") == "responses" else DEFAULT_PROTOCOL,
                "enabled": True,
                "modelsEndpoint": "",
                "lastModelsRefreshAt": None,
                "discoveredModels": [],
                "models": [],
                "nanobotProviderKey": str(provider_key),
            })

        for preset_id, preset in presets.items():
            if not isinstance(preset, dict):
                continue
            provider_key = str(preset.get("provider") or "custom")
            provider_id = provider_ids.get(provider_key)
            if provider_id is None:
                provider_id = _unique_id("provider", provider_key, existing_provider_ids)
                provider_ids[provider_key] = provider_id
                config["llmProviders"].append({
                    "id": provider_id,
                    "name": provider_key,
                    "baseUrl": "",
                    "apiKey": "",
                    "protocol": DEFAULT_PROTOCOL,
                    "enabled": True,
                    "modelsEndpoint": "",
                    "lastModelsRefreshAt": None,
                    "discoveredModels": [],
                    "models": [],
                    "nanobotProviderKey": provider_key,
                })
            provider = self._find_provider(config, provider_id)
            if provider is None:
                continue
            model_name = str(preset.get("model") or preset_id)
            model_id = _unique_id("model", f"{provider_id}_{model_name}", existing_model_ids)
            provider.setdefault("models", []).append(self._normalize_model({
                "id": model_id,
                "providerId": provider_id,
                "model": model_name,
                "label": str(preset.get("label") or _model_label(model_name)),
                "protocol": provider.get("protocol") or DEFAULT_PROTOCOL,
                "enabled": True,
                "capabilities": {
                    "text": True,
                    "vision": False,
                    "audio": False,
                    "tools": True,
                    "reasoning": str(preset.get("reasoningEffort") or "none") not in {"", "none"},
                },
                "limits": {
                    "contextWindowTokens": preset.get("contextWindowTokens") or preset.get("context_window_tokens"),
                    "maxOutputTokens": preset.get("maxTokens") or preset.get("max_tokens"),
                },
                "generation": {
                    "temperature": preset.get("temperature"),
                    "reasoningEffort": preset.get("reasoningEffort") or "none",
                },
            }, provider))
            if preset_id == default_preset:
                config["modelSettings"]["defaultModelId"] = model_id
                config["modelSettings"]["lastUsedModelId"] = model_id

        self._ensure_default_valid(config)
        return config

    def _normalize(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = _empty_config()
        settings = config.get("modelSettings") if isinstance(config.get("modelSettings"), dict) else {}
        normalized["schemaVersion"] = SCHEMA_VERSION
        normalized["modelSettings"] = {
            "defaultStrategy": "fixed" if settings.get("defaultStrategy") == "fixed" else "last_used",
            "defaultModelId": settings.get("defaultModelId"),
            "lastUsedModelId": settings.get("lastUsedModelId"),
        }
        providers = config.get("llmProviders") if isinstance(config.get("llmProviders"), list) else []
        provider_ids: set[str] = set()
        model_ids: set[str] = set()
        for item in providers:
            if not isinstance(item, dict):
                continue
            provider_id = str(item.get("id") or "").strip()
            if not provider_id or provider_id in provider_ids:
                provider_id = _unique_id("provider", str(item.get("name") or item.get("baseUrl") or "provider"), provider_ids)
            else:
                provider_ids.add(provider_id)
            provider = {
                "id": provider_id,
                "name": str(item.get("name") or provider_id),
                "baseUrl": str(item.get("baseUrl") or "").strip().rstrip("/"),
                "apiKey": str(item.get("apiKey") or ""),
                "protocol": self._normalize_protocol(str(item.get("protocol") or DEFAULT_PROTOCOL)),
                "enabled": item.get("enabled", True) is not False,
                "modelsEndpoint": str(item.get("modelsEndpoint") or ""),
                "lastModelsRefreshAt": item.get("lastModelsRefreshAt"),
                "discoveredModels": item.get("discoveredModels") if isinstance(item.get("discoveredModels"), list) else [],
                "models": [],
                "nanobotProviderKey": str(item.get("nanobotProviderKey") or self._suggest_provider_key(str(item.get("name") or provider_id), provider_id)),
            }
            for raw_model in item.get("models", []) if isinstance(item.get("models"), list) else []:
                if not isinstance(raw_model, dict):
                    continue
                model_id = str(raw_model.get("id") or "").strip()
                if not model_id or model_id in model_ids:
                    model_id = _unique_id("model", f"{provider_id}_{raw_model.get('model') or 'model'}", model_ids)
                else:
                    model_ids.add(model_id)
                provider["models"].append(self._normalize_model({**raw_model, "id": model_id, "providerId": provider_id}, provider))
            normalized["llmProviders"].append(provider)
        self._dedupe_provider_keys(normalized["llmProviders"])
        self._ensure_default_valid(normalized)
        return normalized

    def _normalize_model(self, model: dict[str, Any], provider: dict[str, Any]) -> dict[str, Any]:
        model_name = str(model.get("model") or "").strip()
        capabilities = model.get("capabilities") if isinstance(model.get("capabilities"), dict) else {}
        return {
            "id": str(model.get("id") or ""),
            "providerId": str(model.get("providerId") or provider.get("id") or ""),
            "model": model_name,
            "label": str(model.get("label") or _model_label(model_name)),
            "protocol": self._normalize_protocol(str(model.get("protocol") or provider.get("protocol") or DEFAULT_PROTOCOL)),
            "enabled": model.get("enabled", True) is not False,
            "capabilities": {
                "text": capabilities.get("text", True) is not False,
                "vision": bool(capabilities.get("vision")),
                "audio": bool(capabilities.get("audio")),
                "tools": capabilities.get("tools", True) is not False,
                "reasoning": bool(capabilities.get("reasoning")),
            },
            "limits": self._normalize_limits(model.get("limits") if isinstance(model.get("limits"), dict) else {}),
            "generation": self._normalize_generation(model.get("generation") if isinstance(model.get("generation"), dict) else {}),
        }

    def _normalize_limits(self, limits: dict[str, Any]) -> dict[str, int]:
        return {
            "contextWindowTokens": _as_int(limits.get("contextWindowTokens"), DEFAULT_CONTEXT_WINDOW_TOKENS),
            "maxOutputTokens": _as_int(limits.get("maxOutputTokens"), DEFAULT_MAX_OUTPUT_TOKENS),
        }

    def _normalize_generation(self, generation: dict[str, Any]) -> dict[str, Any]:
        return {
            "temperature": _as_float(generation.get("temperature"), DEFAULT_TEMPERATURE),
            "reasoningEffort": str(generation.get("reasoningEffort") or "none"),
        }

    def _ensure_default_valid(self, config: dict[str, Any]) -> None:
        settings = config["modelSettings"]
        enabled_ids = {str(model.get("id")) for _provider, model in self._enabled_models(config)}
        if settings.get("defaultModelId") not in enabled_ids:
            settings["defaultModelId"] = None
        if settings.get("lastUsedModelId") not in enabled_ids:
            settings["lastUsedModelId"] = None
        if settings.get("defaultStrategy") == "fixed" and settings.get("defaultModelId") is None:
            settings["defaultStrategy"] = "last_used"

    def _enabled_models(self, config: dict[str, Any], *, include_disabled: bool = False) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        result = []
        for provider in config["llmProviders"]:
            if not include_disabled and not provider.get("enabled", True):
                continue
            for model in provider.get("models", []):
                if include_disabled or model.get("enabled", True):
                    result.append((provider, model))
        return result

    def _provider_for_update(self, provider_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        config = self.load()
        provider = self._find_provider(config, provider_id)
        if provider is None:
            raise ModelConfigError("供应商不存在")
        return config, provider

    def _model_for_update(self, model_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        config = self.load()
        for provider in config["llmProviders"]:
            for model in provider.get("models", []):
                if model.get("id") == model_id:
                    return config, provider, model
        raise ModelConfigError("模型不存在")

    @staticmethod
    def _find_provider(config: dict[str, Any], provider_id: str) -> dict[str, Any] | None:
        for provider in config.get("llmProviders", []):
            if provider.get("id") == provider_id:
                return provider
        return None

    @staticmethod
    def _normalize_protocol(value: str) -> str:
        normalized = value.strip().lower().replace("-", "_")
        if normalized in {"anthropic", "openai_responses"}:
            return normalized
        return DEFAULT_PROTOCOL

    @staticmethod
    def _provider_name_from_url(base_url: str) -> str:
        value = base_url.strip().removeprefix("https://").removeprefix("http://").split("/", 1)[0]
        return value or "自定义供应商"

    @staticmethod
    def _suggest_provider_key(name: str, provider_id: str) -> str:
        known = {
            "anthropic": "anthropic",
            "deepseek": "deepseek",
            "openai": "openai",
            "openrouter": "openrouter",
        }
        slug = _slug(name, fallback=provider_id)
        for marker, key in known.items():
            if marker in slug:
                return key
        return _slug(provider_id, fallback="custom")

    @staticmethod
    def _unique_provider_key(value: str, existing: set[str]) -> str:
        base = _slug(value, fallback="custom")
        candidate = base
        index = 2
        while candidate in existing:
            candidate = f"{base}_{index}"
            index += 1
        existing.add(candidate)
        return candidate

    def _dedupe_provider_keys(self, providers: list[dict[str, Any]]) -> None:
        existing: set[str] = set()
        for provider in providers:
            provider["nanobotProviderKey"] = self._unique_provider_key(
                str(provider.get("nanobotProviderKey") or provider.get("id") or "custom"),
                existing,
            )

    def _resolved_model(self, provider: dict[str, Any], model: dict[str, Any]) -> ResolvedModel:
        limits = model.get("limits") if isinstance(model.get("limits"), dict) else {}
        generation = model.get("generation") if isinstance(model.get("generation"), dict) else {}
        return ResolvedModel(
            model_id=str(model.get("id") or ""),
            model_preset_id=_model_preset_id(str(model.get("id") or "model")),
            provider_id=str(provider.get("id") or ""),
            provider_name=str(provider.get("name") or provider.get("id") or ""),
            model=str(model.get("model") or ""),
            label=str(model.get("label") or model.get("model") or ""),
            protocol=str(model.get("protocol") or provider.get("protocol") or DEFAULT_PROTOCOL),
            context_window_tokens=_as_int(limits.get("contextWindowTokens"), DEFAULT_CONTEXT_WINDOW_TOKENS),
            max_output_tokens=_as_int(limits.get("maxOutputTokens"), DEFAULT_MAX_OUTPUT_TOKENS),
            reasoning_effort=str(generation.get("reasoningEffort") or "none"),
        )

    def _public_provider(self, provider: dict[str, Any]) -> dict[str, Any]:
        api_key = str(provider.get("apiKey") or "")
        return {
            **{
                key: value
                for key, value in provider.items()
                if key not in {"apiKey", "models", "nanobotProviderKey"}
            },
            "models": [self._public_model(provider, model) for model in provider.get("models", [])],
            "hasApiKey": bool(api_key),
            "apiKeyPreview": _preview_secret(api_key),
        }

    def _public_model(self, provider: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
        return {
            **model,
            "providerName": provider.get("name"),
            "providerBaseUrl": provider.get("baseUrl"),
            "modelPresetId": _model_preset_id(str(model.get("id") or "model")),
        }
