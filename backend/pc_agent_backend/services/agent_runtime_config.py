from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from pc_agent_backend.core.config import RuntimeConfig
from pc_agent_backend.core.process_utils import run_hidden
from pc_agent_backend.storage.conversations import atomic_write_json


SCHEMA_VERSION = 1
CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp"
CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp"
DEFAULT_CODEX_ACP_VERSION = "1.1.0"
DEFAULT_CLAUDE_ACP_VERSION = "0.55.0"
SUPPORTED_ACTIVE_ADAPTERS = {"codex", "nanobot"}


class AgentRuntimeConfigError(ValueError):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _split_command(value: str) -> list[str]:
    if os.name == "nt":
        import shlex

        return shlex.split(value, posix=False)

    import shlex

    return shlex.split(value)


def _resolve_executable(command: str) -> str:
    path = Path(command)
    if path.is_absolute() or len(path.parts) > 1:
        return str(path)

    candidates = [command]
    if os.name == "nt" and not path.suffix:
        candidates = [f"{command}.cmd", f"{command}.exe", f"{command}.bat", command]

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return command


def _command_exists(command: str) -> bool:
    return shutil.which(command) is not None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        text = str(item or "").strip()
        if text:
            result.append(text)
    return result


class AgentRuntimeConfigStore:
    def __init__(self, runtime_config: RuntimeConfig) -> None:
        self._runtime_config = runtime_config
        self._path = runtime_config.agent_runtime_config_path

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> dict[str, Any]:
        config = self._normalize(_read_json_object(self._path))
        self.save(config)
        return config

    def save(self, config: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize(config)
        atomic_write_json(self._path, normalized)
        return normalized

    def list_settings(self) -> dict[str, Any]:
        config = self.load()
        runtimes = config["agentRuntimes"]
        return {
            "activeAdapter": config["activeAdapter"],
            "configPath": str(self._path),
            "runtimeRoot": str(self.runtime_root()),
            "nodeDetected": self._detect_node(),
            "npmDetected": self._detect_npm(),
            "runtimes": [self._public_runtime(runtimes[runtime_id]) for runtime_id in self._ordered_runtime_ids()],
        }

    def update_runtime(self, runtime_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        config = self.load()
        runtime = config["agentRuntimes"].get(runtime_id)
        if runtime is None:
            raise AgentRuntimeConfigError("Agent runtime 不存在")

        if runtime_id == "codex":
            self._update_codex_runtime(runtime, patch)
        else:
            allowed = {"enabled", "configMode", "command"}
            for key in allowed:
                if key in patch:
                    runtime[key] = patch[key]

        self.save(config)
        return self._public_runtime(config["agentRuntimes"][runtime_id])

    def active_adapter(self) -> str:
        return str(self.load().get("activeAdapter") or self._runtime_config.agent_adapter or "nanobot")

    def resolve_adapter(self, adapter: str | None) -> str:
        candidate = str(adapter or "").strip().lower()
        if candidate in SUPPORTED_ACTIVE_ADAPTERS:
            return candidate
        return self.active_adapter()

    def agent_summary(self, adapter: str | None = None) -> dict[str, Any]:
        config = self.load()
        selected = self.resolve_adapter(adapter)
        for runtime in config["agentRuntimes"].values():
            if str(runtime.get("adapter") or runtime.get("id")) == selected:
                return {
                    "id": selected,
                    "label": str(runtime.get("label") or selected),
                    "mode": str(runtime.get("mode") or ""),
                    "configMode": str(runtime.get("configMode") or ""),
                    "runtimeId": str(runtime.get("id") or selected),
                }
        return {
            "id": selected,
            "label": selected,
            "mode": "",
            "configMode": "",
            "runtimeId": selected,
        }

    def update_active_adapter(self, adapter: str) -> dict[str, Any]:
        adapter = adapter.strip().lower()
        if adapter not in SUPPORTED_ACTIVE_ADAPTERS:
            raise AgentRuntimeConfigError("当前只支持切换 Codex 和 nanobot")
        config = self.load()
        config["activeAdapter"] = adapter
        self.save(config)
        return self.list_settings()

    def install_runtime(self, runtime_id: str) -> dict[str, Any]:
        if runtime_id not in {"codex", "claude_code"}:
            raise AgentRuntimeConfigError("当前只支持安装 Codex ACP 和 Claude Code ACP 包")

        npm = _resolve_executable("npm")
        if not Path(npm).exists() and shutil.which(npm) is None:
            raise AgentRuntimeConfigError("未检测到 npm。请先安装 Node.js，后续版本会提供托管 Node 安装。")

        package_dir = self.managed_package_dir(runtime_id)
        package_dir.mkdir(parents=True, exist_ok=True)
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_version = DEFAULT_CODEX_ACP_VERSION if runtime_id == "codex" else DEFAULT_CLAUDE_ACP_VERSION
        package_spec = f"{package_name}@{package_version}"
        try:
            result = run_hidden(
                [npm, "install", "--no-save", package_spec],
                cwd=package_dir,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=180,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise AgentRuntimeConfigError(f"安装失败：{exc}") from exc

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "npm install failed").strip()
            raise AgentRuntimeConfigError(f"安装失败：{detail[-1000:]}")

        config = self.load()
        runtime = config["agentRuntimes"][runtime_id]
        command = self.managed_codex_command() if runtime_id == "codex" else self.managed_claude_command()
        runtime["command"] = command
        runtime["distribution"] = "managed-npm"
        runtime["managedPackage"] = {
            "name": package_name,
            "requestedVersion": package_version,
            "installedVersion": self._installed_package_version(runtime_id),
            "installedAt": _now_ms(),
            "path": str(package_dir),
        }
        runtime["lastInstall"] = {
            "status": "ok",
            "at": _now_ms(),
        }
        self.save(config)
        return self._public_runtime(runtime)

    def runtime_root(self) -> Path:
        return self._runtime_config.data_dir / "runtimes" / "acp"

    def managed_package_dir(self, runtime_id: str) -> Path:
        if runtime_id == "codex":
            return self.runtime_root() / "codex-acp" / DEFAULT_CODEX_ACP_VERSION
        if runtime_id == "claude_code":
            return self.runtime_root() / "claude-agent-acp" / DEFAULT_CLAUDE_ACP_VERSION
        return self.runtime_root() / runtime_id

    def managed_codex_command(self) -> list[str]:
        bin_name = "codex-acp.cmd" if os.name == "nt" else "codex-acp"
        return [str(self.managed_package_dir("codex") / "node_modules" / ".bin" / bin_name)]

    def managed_claude_command(self) -> list[str]:
        bin_name = "claude-agent-acp.cmd" if os.name == "nt" else "claude-agent-acp"
        return [str(self.managed_package_dir("claude_code") / "node_modules" / ".bin" / bin_name)]

    def codex_command(self) -> list[str]:
        runtime = self.load()["agentRuntimes"]["codex"]
        command = _string_list(runtime.get("command"))
        if command:
            return [_resolve_executable(command[0]), *command[1:]]

        managed = self.managed_codex_command()
        if Path(managed[0]).exists():
            return managed

        return [_resolve_executable("npx"), "-y", CODEX_ACP_PACKAGE]

    def codex_env(self) -> dict[str, str]:
        runtime = self.load()["agentRuntimes"]["codex"]
        env = dict(os.environ)
        env.setdefault("NO_BROWSER", "1")
        env["INITIAL_AGENT_MODE"] = str(runtime.get("mode") or "read-only")
        env.setdefault("APP_SERVER_LOGS", str(self._runtime_config.logs_dir / "codex-acp"))

        if runtime.get("configMode") == "isolated":
            codex_home = self._runtime_config.data_dir / "runtime-state" / "codex-home"
            codex_home.mkdir(parents=True, exist_ok=True)
            env["CODEX_HOME"] = str(codex_home)

        codex_path = str(runtime.get("codexPath") or "").strip()
        if codex_path:
            env["CODEX_PATH"] = codex_path

        return env

    def codex_mode(self, fallback: str | None = None) -> str:
        mode = str(fallback or self.load()["agentRuntimes"]["codex"].get("mode") or "read-only")
        return mode if mode in {"read-only", "agent", "agent-full-access"} else "read-only"

    def _normalize(self, config: dict[str, Any]) -> dict[str, Any]:
        raw_runtimes = config.get("agentRuntimes") if isinstance(config.get("agentRuntimes"), dict) else {}
        runtimes = self._default_runtimes()
        for runtime_id, runtime in runtimes.items():
            existing = raw_runtimes.get(runtime_id)
            if isinstance(existing, dict):
                runtime.update(existing)
            runtime["id"] = runtime_id
        active_adapter = str(config.get("activeAdapter") or self._runtime_config.agent_adapter or "nanobot").strip().lower()
        if active_adapter not in SUPPORTED_ACTIVE_ADAPTERS:
            active_adapter = "nanobot"
        return {
            "schemaVersion": SCHEMA_VERSION,
            "activeAdapter": active_adapter,
            "agentRuntimes": runtimes,
        }

    def _default_runtimes(self) -> dict[str, dict[str, Any]]:
        return {
            "codex": {
                "id": "codex",
                "label": "Codex",
                "adapter": "codex",
                "enabled": True,
                "status": "experimental",
                "distribution": "dev-npx",
                "managedPackage": {
                    "name": CODEX_ACP_PACKAGE,
                    "requestedVersion": DEFAULT_CODEX_ACP_VERSION,
                    "installedVersion": None,
                    "installedAt": None,
                    "path": str(self.managed_package_dir("codex")),
                },
                "command": [],
                "mode": "read-only",
                "configMode": "user-native",
                "codexPath": "",
            },
            "claude_code": {
                "id": "claude_code",
                "label": "Claude Code",
                "adapter": "claude_code",
                "enabled": False,
                "status": "planned",
                "distribution": "managed-npm",
                "managedPackage": {
                    "name": CLAUDE_ACP_PACKAGE,
                    "requestedVersion": DEFAULT_CLAUDE_ACP_VERSION,
                    "installedVersion": None,
                    "installedAt": None,
                    "path": str(self.managed_package_dir("claude_code")),
                },
                "command": [],
                "mode": "ask",
                "configMode": "user-native",
            },
            "opencode": {
                "id": "opencode",
                "label": "opencode",
                "adapter": "opencode",
                "enabled": False,
                "status": "planned",
                "distribution": "system",
                "command": ["opencode", "acp"],
                "mode": "ask",
                "configMode": "isolated",
            },
            "nanobot": {
                "id": "nanobot",
                "label": "nanobot",
                "adapter": "nanobot",
                "enabled": True,
                "status": "available",
                "distribution": "python-sdk",
                "command": [],
                "mode": "workspace",
                "configMode": "code-lite",
            },
        }

    def _ordered_runtime_ids(self) -> list[str]:
        return ["codex", "claude_code", "opencode", "nanobot"]

    def _public_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        public = dict(runtime)
        public["command"] = _string_list(public.get("command"))
        public["detected"] = self._detect_runtime(runtime)
        public["canActivate"] = runtime_id in SUPPORTED_ACTIVE_ADAPTERS
        public["canInstall"] = runtime_id in {"codex", "claude_code"}
        public["canConfigure"] = runtime_id == "codex"
        public["isActive"] = self.active_adapter() == str(runtime.get("adapter") or runtime_id)
        return public

    def _detect_node(self) -> dict[str, Any]:
        return self._detect_command(["node", "--version"])

    def _detect_npm(self) -> dict[str, Any]:
        return self._detect_command(["npm", "--version"])

    def _detect_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        if runtime_id == "nanobot":
            return {"ok": True, "detail": "Python backend 已内置 nanobot SDK adapter"}
        if runtime_id == "codex":
            command = self.codex_command()
            if command and command[1:3] == ["-y", CODEX_ACP_PACKAGE]:
                npm_status = self._detect_npm()
                return {
                    "ok": bool(npm_status["ok"]),
                    "detail": "将通过 npx 启动 codex-acp" if npm_status["ok"] else "未检测到 npm",
                    "command": command,
                }
            command_path = Path(command[0]) if command else None
            if command_path and (command_path.exists() or shutil.which(command[0])):
                return {"ok": True, "detail": "已检测到 Codex ACP 命令", "command": command}
            return {"ok": False, "detail": "未检测到 Codex ACP 命令", "command": command}
        if runtime_id == "opencode":
            ok = _command_exists("opencode")
            return {"ok": ok, "detail": "已检测到 opencode" if ok else "未检测到 opencode"}
        if runtime_id == "claude_code":
            command = _string_list(runtime.get("command"))
            if not command:
                command = self.managed_claude_command()
            ok = bool(command and (Path(command[0]).exists() or shutil.which(command[0])))
            return {"ok": ok, "detail": "待接入 Claude Code ACP" if not ok else "已检测到 Claude Code ACP 命令"}
        return {"ok": False, "detail": "未知 runtime"}

    def _detect_command(self, command: list[str]) -> dict[str, Any]:
        executable = _resolve_executable(command[0])
        if not Path(executable).exists() and shutil.which(command[0]) is None:
            return {"ok": False, "version": None}
        try:
            result = run_hidden(
                [executable, *command[1:]],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return {"ok": False, "version": None}
        output = (result.stdout or result.stderr or "").strip().splitlines()
        return {
            "ok": result.returncode == 0,
            "version": output[0] if output else None,
        }

    def _installed_package_version(self, runtime_id: str) -> str | None:
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_json = self.managed_package_dir(runtime_id) / "node_modules" / package_name / "package.json"
        payload = _read_json_object(package_json)
        version = str(payload.get("version") or "").strip()
        return version or None

    def _update_codex_runtime(self, runtime: dict[str, Any], patch: dict[str, Any]) -> None:
        if "enabled" in patch:
            runtime["enabled"] = bool(patch.get("enabled"))
        if "mode" in patch:
            mode = str(patch.get("mode") or "read-only").strip()
            if mode not in {"read-only", "agent", "agent-full-access"}:
                raise AgentRuntimeConfigError("Codex 运行模式不合法")
            runtime["mode"] = mode
        if "configMode" in patch:
            config_mode = str(patch.get("configMode") or "user-native").strip()
            if config_mode not in {"user-native", "isolated"}:
                raise AgentRuntimeConfigError("Codex 配置模式不合法")
            runtime["configMode"] = config_mode
        if "codexPath" in patch:
            runtime["codexPath"] = str(patch.get("codexPath") or "").strip()
        if "command" in patch:
            command = patch.get("command")
            if isinstance(command, str):
                runtime["command"] = _split_command(command)
            else:
                runtime["command"] = _string_list(command)
