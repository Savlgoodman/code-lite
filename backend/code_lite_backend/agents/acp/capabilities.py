from __future__ import annotations

from typing import Any

from code_lite_backend.agents.acp.mapper import to_jsonable


_CLAUDE_DEFAULT_MODEL = "sonnet"


def parse_models_from_config_option(model_config: dict[str, Any], runtime: str) -> dict[str, Any]:
    model_values = model_config.get("values")
    if not isinstance(model_values, list):
        return {
            "currentModelId": None,
            "models": [],
        }

    values = [str(value) for value in model_values if str(value).strip()]
    labels = model_config.get("option_labels") or {}
    descriptions = model_config.get("option_descriptions") or {}
    current = str(model_config.get("current_value") or "")

    if runtime == "claude_code":
        values = [value for value in values if value != "default"]
        available = set(values)
        if current == "default" or current not in available:
            current = _CLAUDE_DEFAULT_MODEL if _CLAUDE_DEFAULT_MODEL in available else ""

    return {
        "currentModelId": current or None,
        "models": [
            {
                "id": value,
                "label": str(labels.get(value) or value),
                "description": descriptions.get(value),
                "source": runtime,
            }
            for value in values
        ],
    }


def parse_models_from_session_result(session_result: Any, runtime: str) -> dict[str, Any]:
    """从 ACP session/new 结果中提取可用模型列表。"""
    raw = to_jsonable(session_result)
    models = raw.get("models") if isinstance(raw, dict) else None
    if isinstance(models, dict):
        available = models.get("availableModels") if isinstance(models.get("availableModels"), list) else []
        parsed = []
        for item in available:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("modelId") or item.get("id") or "").strip()
            if not model_id:
                continue
            parsed.append({
                "id": model_id,
                "label": str(item.get("name") or model_id),
                "description": item.get("description"),
                "source": runtime,
            })
        if parsed:
            return {
                "currentModelId": models.get("currentModelId"),
                "models": parsed,
            }

    raw_config = parse_config_options_from_session_result(session_result)
    model_config = raw_config.get("model")
    if isinstance(model_config, dict):
        return parse_models_from_config_option(model_config, runtime)

    return {
        "currentModelId": None,
        "models": [],
    }

def parse_modes_from_session_result(session_result: Any) -> list[dict[str, Any]]:
    """从 ACP session/new 结果中提取可用权限模式。"""
    raw = to_jsonable(session_result)
    modes = raw.get("modes") if isinstance(raw, dict) else None
    if not isinstance(modes, list):
        return []
    parsed = []
    for item in modes:
        if not isinstance(item, dict):
            continue
        mode_id = str(item.get("id") or item.get("modeId") or "").strip()
        if not mode_id:
            continue
        parsed.append({
            "id": mode_id,
            "label": str(item.get("label") or mode_id),
        })
    return parsed


def parse_config_options_from_session_result(session_result: Any) -> dict[str, Any]:
    """从 ACP session/new 结果中提取可用配置选项。

    ACP configOptions 可能是 list 或 dict 格式：
    - list: [{id, type, currentValue, options: [{value, name}], ...}]
    - dict: {id: {type, values, ...}}

    统一转为 dict 格式: {id: {type, values, current_value, name, options, ...}}
    """
    raw = to_jsonable(session_result)
    config_options = raw.get("configOptions") if isinstance(raw, dict) else None

    if isinstance(config_options, list):
        # list 格式: [{id, type, currentValue, options: [{value, name}], ...}]
        result: dict[str, Any] = {}
        for item in config_options:
            if not isinstance(item, dict):
                continue
            config_id = str(item.get("id") or "").strip()
            if not config_id:
                continue
            # 从 options 列表提取 values
            options = item.get("options")
            values = None
            option_labels = None
            option_descriptions = None
            if isinstance(options, list):
                values = []
                option_labels = {}
                option_descriptions = {}
                for opt in options:
                    if isinstance(opt, dict):
                        val = str(opt.get("value") or "").strip()
                        if val:
                            values.append(val)
                            name = str(opt.get("name") or val)
                            option_labels[val] = name
                            desc = opt.get("description")
                            if desc:
                                option_descriptions[val] = str(desc)
            # ACP type "select" -> 前端 "enum"；"boolean" 保持
            raw_type = str(item.get("type") or "enum")
            normalized_type = "enum" if raw_type == "select" else raw_type
            parsed: dict[str, Any] = {
                "type": normalized_type,
                "current_value": item.get("currentValue"),
                "name": item.get("name"),
                "description": item.get("description"),
                "category": item.get("category"),
            }
            if values is not None:
                parsed["values"] = values
            if option_labels:
                parsed["option_labels"] = option_labels
            if option_descriptions:
                parsed["option_descriptions"] = option_descriptions
            result[config_id] = parsed
        return result

    if isinstance(config_options, dict):
        return config_options

    return {}
