from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEV_ENV_VALUE = "DEV"
ENV_NAME = "CODE_LITE_ENV"
NANOBOT_CONFIG_NAME = "nanobot_config.json"
APP_CONFIG_NAME = "app_config.json"
IMAGE_CONFIG_NAME = "image_config.json"
AGENT_RUNTIME_CONFIG_NAME = "agent_runtimes.json"
ACP_CONNECTION_MODE_ENV_NAME = "CODE_LITE_ACP_CONNECTION_MODE"
ACP_CONNECTION_MODE_PER_CONVERSATION = "per_conversation"
ACP_CONNECTION_MODE_MULTI_SESSION = "multi_session"
ACP_CONNECTION_MODES = {
    ACP_CONNECTION_MODE_PER_CONVERSATION,
    ACP_CONNECTION_MODE_MULTI_SESSION,
}


MINIMAL_NANOBOT_CONFIG: dict[str, Any] = {
    "providers": {
        "deepseek": {
            "apiKey": "",
            "apiBase": "https://api.deepseek.com",
        }
    },
    "modelPresets": {
        "deepseekFlash": {
            "label": "DeepSeek V4 Flash",
            "provider": "deepseek",
            "model": "deepseek-v4-flash",
            "maxTokens": 4096,
            "contextWindowTokens": 65536,
            "temperature": 0.1,
            "reasoningEffort": "none",
        }
    },
    "agents": {
        "defaults": {
            "modelPreset": "deepseekFlash",
            "maxToolIterations": 20,
            "failOnToolError": True,
        }
    },
    "tools": {
        "restrictToWorkspace": True,
        "exec": {
            "enable": True,
            "timeout": 30,
        },
        "file": {
            "enable": True,
        },
        "web": {
            "search": {
                "enable": False,
            },
            "fetch": {
                "enable": False,
            },
        },
    },
}


@dataclass(frozen=True)
class RuntimeConfig:
    env: str
    data_dir: Path
    config_dir: Path
    record_dir: Path
    attachments_dir: Path
    billing_dir: Path
    logs_dir: Path
    cache_dir: Path
    image_gen_dir: Path
    app_config_path: Path
    image_config_path: Path
    agent_runtime_config_path: Path
    nanobot_config_path: Path
    agent_adapter: str
    acp_connection_mode: str


def resolve_data_dir(*, env: str, workspace: Path, data_dir_override: Path | None = None) -> Path:
    if data_dir_override is not None:
        return data_dir_override.expanduser().resolve()

    if env.upper() == DEV_ENV_VALUE:
        return (workspace / "data").resolve()

    return (Path.home() / ".code-lite").resolve()


def write_json_if_missing(path: Path, value: dict[str, Any]) -> None:
    if path.exists():
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_json_encoding(path: Path) -> None:
    if not path.exists():
        return

    content = path.read_text(encoding="utf-8-sig")
    if content.startswith("\ufeff"):
        content = content.removeprefix("\ufeff")
    path.write_text(content, encoding="utf-8")


def resolve_runtime_config(
    *,
    workspace: Path,
    config_override: Path | None = None,
    data_dir_override: Path | None = None,
    agent_adapter_override: str | None = None,
) -> RuntimeConfig:
    env = os.environ.get(ENV_NAME, "").strip()
    data_dir = resolve_data_dir(env=env, workspace=workspace, data_dir_override=data_dir_override)
    config_dir = data_dir / "config"
    record_dir = data_dir / "record"
    attachments_dir = data_dir / "attachments"
    billing_dir = data_dir / "billing"
    logs_dir = data_dir / "logs"
    cache_dir = data_dir / "cache"
    image_gen_dir = data_dir / "image-gen"

    for directory in (config_dir, record_dir, attachments_dir, billing_dir / "daily", logs_dir, cache_dir, image_gen_dir):
        directory.mkdir(parents=True, exist_ok=True)

    nanobot_config_path = (
        config_override.expanduser().resolve()
        if config_override is not None
        else config_dir / NANOBOT_CONFIG_NAME
    )
    app_config_path = config_dir / APP_CONFIG_NAME
    image_config_path = config_dir / IMAGE_CONFIG_NAME
    agent_runtime_config_path = config_dir / AGENT_RUNTIME_CONFIG_NAME
    write_json_if_missing(nanobot_config_path, MINIMAL_NANOBOT_CONFIG)
    normalize_json_encoding(nanobot_config_path)

    agent_adapter = (
        agent_adapter_override
        or os.environ.get("CODE_LITE_ADAPTER")
        or "router"
    ).strip().lower()
    acp_connection_mode = os.environ.get(
        ACP_CONNECTION_MODE_ENV_NAME,
        ACP_CONNECTION_MODE_MULTI_SESSION,
    ).strip().lower()
    if acp_connection_mode not in ACP_CONNECTION_MODES:
        acp_connection_mode = ACP_CONNECTION_MODE_MULTI_SESSION

    return RuntimeConfig(
        env=env,
        data_dir=data_dir,
        config_dir=config_dir,
        record_dir=record_dir,
        attachments_dir=attachments_dir,
        billing_dir=billing_dir,
        logs_dir=logs_dir,
        cache_dir=cache_dir,
        image_gen_dir=image_gen_dir,
        app_config_path=app_config_path,
        image_config_path=image_config_path,
        agent_runtime_config_path=agent_runtime_config_path,
        nanobot_config_path=nanobot_config_path,
        agent_adapter=agent_adapter,
        acp_connection_mode=acp_connection_mode,
    )
