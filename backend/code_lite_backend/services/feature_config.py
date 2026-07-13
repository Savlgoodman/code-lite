from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.storage.conversations import atomic_write_json


SCHEMA_VERSION = 1

# 生图提示词优化默认模板：把用户描述扩写成利于文生图模型的高质量提示词。
DEFAULT_IMAGE_PROMPT = (
    "你是图像生成提示词优化助手。请把用户给出的图片描述扩写成更精细、结构清晰、"
    "利于文生图模型理解的提示词，补充画面主体、风格、光照、构图、细节等要素，"
    "保持与用户输入相同的语言，只返回优化后的提示词本身，不要解释、不要加引号。"
)

# code agent 提示词优化默认模板：把粗略需求整理成结构清晰、便于 agent 执行的指令。
# {AGENTS.md} 会被替换为项目根目录 AGENTS.md 的内容；若信息不足，模板要求优化后的提示词
# 说明去阅读各子目录里的 CLAUDE.md 与 AGENTS.md 以更了解项目。
DEFAULT_CODE_PROMPT = (
    "你是编码任务提示词优化助手。请把用户给出的粗略需求整理成结构清晰、目标明确、"
    "便于编码 agent 执行的高质量提示词：明确要做的事、涉及的模块或文件、约束与验收标准，"
    "保持与用户输入相同的语言，只返回优化后的提示词本身，不要解释、不要加引号。\n\n"
    "下面是当前项目根目录的 AGENTS.md，用于了解项目结构与协作规范：\n"
    "{AGENTS.md}\n\n"
    "如果根目录信息不足以覆盖用户需求所涉及的模块，请在优化后的提示词中明确要求 agent "
    "先阅读相关目录下的 CLAUDE.md 和 AGENTS.md 再动手，以更充分地了解项目情况。"
)


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _default_config() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "promptOptimize": {
            "imageEnabled": True,
            "codeEnabled": False,
            "modelId": "",
            "imagePrompt": DEFAULT_IMAGE_PROMPT,
            "codePrompt": DEFAULT_CODE_PROMPT,
        },
    }


class FeatureConfigStore:
    """功能设置：提示词优化开关、模型与 prompt 模板。

    独立落 feature_config.json，避免与 app_config.json / image_config.json 互相覆盖。
    """

    def __init__(self, runtime_config: RuntimeConfig) -> None:
        self._path = runtime_config.feature_config_path

    def load(self) -> dict[str, Any]:
        return self._normalize(_read_json_object(self._path))

    def save(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize(config)
        atomic_write_json(self._path, normalized)
        return normalized

    def get_prompt_optimize(self) -> dict[str, Any]:
        return self.load()["promptOptimize"]

    def update_prompt_optimize(self, patch: dict[str, Any]) -> dict[str, Any]:
        config = self.load()
        settings = config["promptOptimize"]
        if "imageEnabled" in patch:
            settings["imageEnabled"] = bool(patch.get("imageEnabled"))
        if "codeEnabled" in patch:
            settings["codeEnabled"] = bool(patch.get("codeEnabled"))
        if "modelId" in patch:
            settings["modelId"] = str(patch.get("modelId") or "").strip()
        if "imagePrompt" in patch:
            value = str(patch.get("imagePrompt") or "").strip()
            settings["imagePrompt"] = value or DEFAULT_IMAGE_PROMPT
        if "codePrompt" in patch:
            value = str(patch.get("codePrompt") or "").strip()
            settings["codePrompt"] = value or DEFAULT_CODE_PROMPT
        self.save(config)
        return config["promptOptimize"]

    def _normalize(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = _default_config()
        raw = config.get("promptOptimize") if isinstance(config.get("promptOptimize"), dict) else {}
        settings = normalized["promptOptimize"]
        settings["imageEnabled"] = raw.get("imageEnabled", True) is not False
        settings["codeEnabled"] = bool(raw.get("codeEnabled", False))
        settings["modelId"] = str(raw.get("modelId") or "").strip()
        image_prompt = str(raw.get("imagePrompt") or "").strip()
        settings["imagePrompt"] = image_prompt or DEFAULT_IMAGE_PROMPT
        code_prompt = str(raw.get("codePrompt") or "").strip()
        settings["codePrompt"] = code_prompt or DEFAULT_CODE_PROMPT
        return normalized
