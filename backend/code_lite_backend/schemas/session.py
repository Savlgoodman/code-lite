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
class SlashCommand:
    """斜杠命令定义"""
    id: str
    label: str
    description: str
    command: str


@dataclass(frozen=True)
class SessionCapabilities:
    """进入对话时加载的完整能力描述。

    由 ACP session/new 结果构建，驱动前端所有 UI 控件渲染。
    """

    agent: SessionAgentInfo
    modes: list[SessionMode]
    models: list[SessionModel]
    config_options: list[SessionConfigOption]
    commands: list[SlashCommand] = field(default_factory=list)

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
            "commands": [asdict(c) for c in self.commands],
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

_MODE_LABELS: dict[str, str] = {
    "read-only": "只读",
    "agent": "Agent",
    "agent-full-access": "完全访问",
    "workspace": "工作区",
}


def _build_modes(
    raw_config: dict[str, Any],
    session_result: Any,
    default_mode: str,
) -> list[SessionMode]:
    """从多个来源合并 modes 列表。

    优先级：
    1. configOptions.mode.values —— ACP 声明的完整可用 modes
    2. session_result.modes —— ACP 返回的当前 session modes
    3. default_mode fallback
    """
    from code_lite_backend.agents.acp.capabilities import parse_modes_from_session_result

    mode_ids: list[str] = []
    mode_labels: dict[str, str] = {}
    config_current_mode = ""

    # 来源 1: configOptions.mode
    mode_config = raw_config.get("mode")
    if isinstance(mode_config, dict):
        values = mode_config.get("values")
        if isinstance(values, list):
            mode_ids = [str(v) for v in values if str(v).strip()]
        # 从 option_labels 获取展示名
        option_labels = mode_config.get("option_labels")
        if isinstance(option_labels, dict):
            mode_labels = {str(k): str(v) for k, v in option_labels.items()}
        # configOptions.mode.current_value 是 runtime 声明的当前默认模式
        config_current_mode = str(mode_config.get("current_value") or "")

    # 来源 2: session_result.modes（补充来源 1 中可能缺失的）
    if not mode_ids:
        raw_modes = parse_modes_from_session_result(session_result)
        mode_ids = [str(m.get("id") or "") for m in raw_modes if str(m.get("id") or "").strip()]
        for m in raw_modes:
            mid = str(m.get("id") or "")
            mlabel = str(m.get("label") or "")
            if mid and mlabel:
                mode_labels.setdefault(mid, mlabel)

    # 来源 3: fallback
    if not mode_ids:
        mode_ids = [default_mode]

    # 默认模式：优先用 configOptions.mode 声明的 current_value，其次用传入的 default_mode
    if config_current_mode and config_current_mode in mode_ids:
        default_mode = config_current_mode

    # 确保 default_mode 在列表中
    if default_mode and default_mode not in mode_ids:
        mode_ids.insert(0, default_mode)

    return [
        SessionMode(
            id=mode_id,
            label=mode_labels.get(mode_id) or _MODE_LABELS.get(mode_id, mode_id),
            is_default=(mode_id == default_mode),
        )
        for mode_id in mode_ids
    ]


def _build_runtime_models_from_config(
    *,
    runtime: str,
    model_config: dict[str, Any],
) -> list[SessionModel]:
    from code_lite_backend.agents.acp.capabilities import parse_models_from_config_option

    models_data = parse_models_from_config_option(model_config, runtime)
    current_model_id = str(models_data.get("currentModelId") or "")
    return [
        SessionModel(
            id=m["id"],
            label=m.get("label") or m["id"],
            description=m.get("description"),
            is_current=(m["id"] == current_model_id),
        )
        for m in models_data.get("models", [])
    ]


# 命令 ID → 中文展示名映射
_COMMAND_LABELS: dict[str, str] = {
    "compact": "压缩",
    "goal": "目标",
    "init": "初始化",
    "resume": "恢复",
    "review": "审查",
    "context": "上下文",
    "mcp": "MCP",
    "skills": "Skills",
    "status": "状态",
    "logout": "登出",
}

# 命令 ID → 中文描述映射
_COMMAND_DESCRIPTIONS: dict[str, str] = {
    "compact": "压缩此线程的上下文",
    "goal": "设置或清除任务目标",
    "init": "初始化 CLAUDE.md 文件",
    "resume": "恢复会话",
    "review": "审查未暂存的更改",
    "context": "显示上下文使用情况",
    "mcp": "显示 MCP 服务器状态",
    "skills": "列出可用技能",
    "status": "显示会话配置和状态",
    "logout": "退出登录",
}


def _build_commands(raw: dict[str, Any], runtime: str) -> list[SlashCommand]:
    """从 ACP session/new 结果中提取可用命令列表。

    优先从 session_result 中的 availableCommands 提取，
    否则根据 runtime 类型提供静态 fallback 列表。
    """
    raw_commands: list[dict[str, Any]] = []
    if isinstance(raw, dict):
        for item in raw.get("availableCommands", []):
            if isinstance(item, dict):
                raw_commands.append(item)

    # 如果 ACP 返回了可用命令，优先使用
    if raw_commands:
        commands: list[SlashCommand] = []
        for cmd in raw_commands:
            cmd_name = str(cmd.get("name") or "").strip()
            if not cmd_name:
                continue
            commands.append(SlashCommand(
                id=cmd_name,
                label=_COMMAND_LABELS.get(cmd_name, cmd_name),
                description=_COMMAND_DESCRIPTIONS.get(cmd_name, str(cmd.get("description") or "")),
                command=f"/{cmd_name}",
            ))
        return commands

    # Fallback: 根据 runtime 类型提供静态命令列表
    if runtime == "claude_code":
        cmd_ids = ["compact", "goal", "init", "resume", "review", "context"]
    elif runtime == "codex":
        cmd_ids = ["compact", "goal", "mcp", "skills", "status", "review", "logout"]
    elif runtime == "opencode":
        cmd_ids = ["compact"]
    else:
        return []

    return [
        SlashCommand(
            id=cmd_id,
            label=_COMMAND_LABELS.get(cmd_id, cmd_id),
            description=_COMMAND_DESCRIPTIONS.get(cmd_id, ""),
            command=f"/{cmd_id}",
        )
        for cmd_id in cmd_ids
    ]


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
    from code_lite_backend.agents.acp.capabilities import (
        parse_config_options_from_session_result,
        parse_models_from_session_result,
        parse_modes_from_session_result,
    )
    from code_lite_backend.agents.acp.mapper import to_jsonable

    raw = to_jsonable(session_result)

    # 解析 configOptions（先解析，因为 modes 可能从 configOptions.mode.values 提取）
    raw_config = parse_config_options_from_session_result(session_result)

    # 解析 modes —— 优先从 configOptions.mode.values 获取完整列表，
    # 其次从 session_result.modes 获取，最后 fallback 到 default_mode
    modes = _build_modes(raw_config, session_result, default_mode)

    # 解析 models —— 优先从顶层 models.availableModels（Codex），
    # 其次从 configOptions.model（Claude Code 把模型放在 configOptions 里）
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
    # fallback: 从 configOptions.model 提取（Claude Code）
    if not models:
        model_config = raw_config.get("model")
        if isinstance(model_config, dict):
            models = _build_runtime_models_from_config(
                runtime=runtime,
                model_config=model_config,
            )

    # 思考强度别名：Claude Code 用 "effort"，Codex 用 "reasoning_effort"，统一暴露
    THOUGHT_LEVEL_IDS = {"reasoning_effort", "effort"}

    # 解析 config options（排除 mode 和 model，因为它们已通过 modes/models 提供）
    config_options = []
    for config_id, config_def in raw_config.items():
        if config_id in ("mode", "model"):
            continue
        if not isinstance(config_def, dict):
            continue
        config_type = str(config_def.get("type") or "enum")
        config_values = config_def.get("values")
        if isinstance(config_values, list):
            config_values = [str(v) for v in config_values]
        else:
            config_values = None
        # 思考强度统一用 reasoning_effort 作为前端 id（前端只认这个）
        effective_id = "reasoning_effort" if config_id in THOUGHT_LEVEL_IDS else config_id
        # 优先使用 ACP 返回的 option_labels，其次用内置映射
        option_labels = config_def.get("option_labels") or _CONFIG_VALUE_LABELS.get(effective_id)
        # 优先使用 ACP 返回的 name 作为 label
        acp_name = config_def.get("name")
        label = _CONFIG_OPTION_LABELS.get(effective_id, acp_name or effective_id)
        current_value = config_def.get("current_value")
        config_options.append(SessionConfigOption(
            id=effective_id,
            label=label,
            type=config_type,
            values=config_values,
            current_value=current_value,
            value_labels=option_labels,
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
        commands=_build_commands(raw, runtime),
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
        commands=[],
    )
