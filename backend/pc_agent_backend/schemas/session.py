from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class SessionAgentInfo:
    id: str
    label: str
    adapter_kind: str
    status: str


@dataclass(frozen=True)
class SessionMode:
    id: str
    label: str
    is_default: bool


@dataclass(frozen=True)
class SessionModel:
    id: str
    label: str
    description: str | None = None
    is_current: bool = False


@dataclass(frozen=True)
class SessionConfigOption:
    id: str
    label: str
    type: str  # "enum" | "boolean" | "number"
    values: list[str] | None = None
    current_value: str | int | bool | None = None
    value_labels: dict[str, str] | None = None


@dataclass(frozen=True)
class SessionCapabilities:
    """进入对话时加载的完整能力描述。

    由 ACP session/new 结果构建，驱动前端所有 UI 控件渲染。
    """

    agent: SessionAgentInfo
    modes: list[SessionMode]
    models: list[SessionModel]
    config_options: list[SessionConfigOption]

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent": asdict(self.agent),
            "modes": [asdict(m) for m in self.modes],
            "models": [asdict(m) for m in self.models],
            "configOptions": [
                {
                    "id": opt.id,
                    "label": opt.label,
                    "type": opt.type,
                    "values": opt.values,
                    "currentValue": opt.current_value,
                    "valueLabels": opt.value_labels,
                }
                for opt in self.config_options
            ],
        }


# 已知的 config option 展示标签映射
_CONFIG_OPTION_LABELS: dict[str, str] = {
    "reasoning_effort": "思考强度",
    "fast-mode": "快速模式",
    "mode": "运行模式",
    "model": "模型",
}

_CONFIG_VALUE_LABELS: dict[str, dict[str, str]] = {
    "reasoning_effort": {
        "none": "无思考",
        "low": "低思考",
        "medium": "中思考",
        "high": "高思考",
        "xhigh": "超高思考",
    },
}


def build_session_capabilities(
    *,
    agent_id: str,
    agent_label: str,
    adapter_kind: str,
    status: str,
    session_result: Any,
    default_mode: str,
    runtime: str,
) -> SessionCapabilities:
    """从 ACP session/new 结果构建 SessionCapabilities。"""
    from pc_agent_backend.agents.acp.capabilities import (
        parse_config_options_from_session_result,
        parse_models_from_session_result,
        parse_modes_from_session_result,
    )
    from pc_agent_backend.agents.acp.mapper import to_jsonable

    raw = to_jsonable(session_result)

    # 解析 modes
    raw_modes = parse_modes_from_session_result(session_result)
    modes = [
        SessionMode(
            id=m["id"],
            label=m.get("label") or m["id"],
            is_default=(m["id"] == default_mode),
        )
        for m in raw_modes
    ]
    if not modes:
        modes = [SessionMode(id=default_mode, label=default_mode, is_default=True)]

    # 解析 models
    models_data = parse_models_from_session_result(session_result, runtime)
    current_model_id = str(models_data.get("currentModelId") or "")
    models = [
        SessionModel(
            id=m["id"],
            label=m.get("label") or m["id"],
            description=m.get("description"),
            is_current=(m["id"] == current_model_id),
        )
        for m in models_data.get("models", [])
    ]

    # 解析 config options
    raw_config = parse_config_options_from_session_result(session_result)
    config_options = []
    for config_id, config_def in raw_config.items():
        if config_id in ("mode", "model"):
            continue  # mode 和 model 已通过 modes/models 提供
        if not isinstance(config_def, dict):
            continue
        config_type = str(config_def.get("type") or "enum")
        config_values = config_def.get("values")
        if isinstance(config_values, list):
            config_values = [str(v) for v in config_values]
        else:
            config_values = None
        config_options.append(SessionConfigOption(
            id=config_id,
            label=_CONFIG_OPTION_LABELS.get(config_id, config_id),
            type=config_type,
            values=config_values,
            value_labels=_CONFIG_VALUE_LABELS.get(config_id),
        ))

    return SessionCapabilities(
        agent=SessionAgentInfo(
            id=agent_id,
            label=agent_label,
            adapter_kind=adapter_kind,
            status=status,
        ),
        modes=modes,
        models=models,
        config_options=config_options,
    )


def build_nanobot_session_capabilities(
    *,
    model_config_store: Any,
) -> SessionCapabilities:
    """为 nanobot 构建 SessionCapabilities（从产品模型配置提取）。"""
    try:
        settings = model_config_store.list_settings()
    except Exception:
        settings = {"models": []}

    models = []
    default_model_id = str(settings.get("effectiveDefaultModelId") or "")
    for m in settings.get("models", []):
        if not isinstance(m, dict):
            continue
        model_id = str(m.get("id") or "")
        if not model_id:
            continue
        enabled = m.get("enabled", True)
        if not enabled:
            continue
        models.append(SessionModel(
            id=model_id,
            label=str(m.get("label") or model_id),
            is_current=(model_id == default_model_id),
        ))

    return SessionCapabilities(
        agent=SessionAgentInfo(
            id="nanobot",
            label="nanobot",
            adapter_kind="nanobot",
            status="available",
        ),
        modes=[SessionMode(id="workspace", label="工作区模式", is_default=True)],
        models=models,
        config_options=[],
    )
