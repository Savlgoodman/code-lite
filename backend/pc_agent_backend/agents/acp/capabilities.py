from __future__ import annotations

from typing import Any

from pc_agent_backend.agents.acp.mapper import to_jsonable


def parse_models_from_session_result(session_result: Any, runtime: str) -> dict[str, Any]:
    """从 ACP session/new 结果中提取可用模型列表。"""
    raw = to_jsonable(session_result)
    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, dict):
        return {
            "currentModelId": None,
            "models": [],
        }
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
    return {
        "currentModelId": models.get("currentModelId"),
        "models": parsed,
    }


def extract_available_model_ids(session_result: Any) -> set[str]:
    """从 ACP session/new 结果中提取可用模型 ID 集合。"""
    raw = to_jsonable(session_result)
    models = raw.get("models") if isinstance(raw, dict) else None
    available = models.get("availableModels") if isinstance(models, dict) else []
    result: set[str] = set()
    for item in available if isinstance(available, list) else []:
        if isinstance(item, dict):
            model_id = str(item.get("modelId") or item.get("id") or "").strip()
            if model_id:
                result.add(model_id)
    return result


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
            if isinstance(options, list):
                values = []
                option_labels = {}
                for opt in options:
                    if isinstance(opt, dict):
                        val = str(opt.get("value") or "").strip()
                        if val:
                            values.append(val)
                            name = str(opt.get("name") or val)
                            option_labels[val] = name
            parsed: dict[str, Any] = {
                "type": str(item.get("type") or "enum"),
                "current_value": item.get("currentValue"),
                "name": item.get("name"),
                "description": item.get("description"),
                "category": item.get("category"),
            }
            if values is not None:
                parsed["values"] = values
            if option_labels:
                parsed["option_labels"] = option_labels
            result[config_id] = parsed
        return result

    if isinstance(config_options, dict):
        return config_options

    return {}
