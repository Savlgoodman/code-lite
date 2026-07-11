from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.core.process_utils import run_hidden
from code_lite_backend.storage.conversations import atomic_write_json


SCHEMA_VERSION = 1
CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp"
CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp"
CODEX_RUNTIME_PACKAGE = "@openai/codex"
CLAUDE_RUNTIME_PACKAGE = "@anthropic-ai/claude-agent-sdk"
DEFAULT_CODEX_ACP_VERSION = "1.1.0"
DEFAULT_CLAUDE_ACP_VERSION = "0.55.0"
SUPPORTED_ACTIVE_ADAPTERS = {"codex", "claude_code", "nanobot"}
ACP_RUNTIME_IDS = {"codex", "claude_code"}
RUNTIME_EXECUTABLE_SOURCES = {"sdk", "system"}


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


def _command_reference_exists(command: str) -> bool:
    resolved = _resolve_executable(command)
    return Path(resolved).exists() or shutil.which(command) is not None


def _existing_path(value: Any) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    path = Path(text).expanduser()
    try:
        return path.resolve() if path.exists() else None
    except OSError:
        return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        text = str(item or "").strip()
        if text:
            result.append(text)
    return result


def _configured_path(value: Any, fallback: Path) -> Path:
    text = str(value or "").strip()
    if not text:
        return fallback
    return Path(text).expanduser().resolve()


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
            "acpPackageRoot": config["acpPackageRoot"],
            "configPath": str(self._path),
            "runtimeRoot": str(self.runtime_root()),
            "nodeDetected": self._detect_node(),
            "npmDetected": self._detect_npm(),
            "runtimes": [self._public_runtime(runtimes[runtime_id]) for runtime_id in self._ordered_runtime_ids()],
        }

    def acp_package_settings(
        self,
        *,
        check_latest: bool = False,
        runtime_id: str | None = None,
        include_runtime_versions: bool = False,
        include_runtime_executables: bool = False,
        discover_runtime_executables: bool = False,
    ) -> dict[str, Any]:
        config = self.load()
        package_root = self.runtime_root()
        runtime_ids = self._acp_runtime_ids(runtime_id)
        packages = [
            self._public_acp_package(config["agentRuntimes"][runtime_id], check_latest=check_latest)
            for runtime_id in runtime_ids
        ]
        runtime_versions = [
            self._selected_runtime_executable_version(runtime_id, config["agentRuntimes"][runtime_id])
            for runtime_id in runtime_ids
        ] if include_runtime_versions else []
        runtime_executables = [
            self._public_runtime_executable(
                config["agentRuntimes"][runtime_id],
                check_latest=check_latest,
                discover_system=discover_runtime_executables,
            )
            for runtime_id in runtime_ids
        ] if include_runtime_executables else []
        return {
            "packageRoot": str(package_root),
            "packageRootExists": package_root.exists(),
            "packageRootIsEmpty": self._is_acp_package_root_empty(package_root),
            "nodeDetected": self._detect_node(),
            "npmDetected": self._detect_npm(),
            "packages": packages,
            "runtimeVersions": runtime_versions,
            "runtimeExecutables": runtime_executables,
            "checkedAt": _now_ms() if check_latest else None,
        }

    def runtime_executable_settings(self, runtime_id: str, *, check_latest: bool = False) -> dict[str, Any]:
        if runtime_id not in ACP_RUNTIME_IDS:
            raise AgentRuntimeConfigError("Agent runtime 不支持 Runtime 可执行文件配置")
        config = self.load()
        return self._public_runtime_executable(
            config["agentRuntimes"][runtime_id],
            check_latest=check_latest,
            discover_system=True,
        )

    def update_acp_package_root(self, package_root: str) -> dict[str, Any]:
        root = _configured_path(package_root, self._default_runtime_root())
        config = self.load()
        config["acpPackageRoot"] = str(root)
        self.save(config)
        return self.acp_package_settings()

    def update_acp_package_dir(self, runtime_id: str, package_dir: str) -> dict[str, Any]:
        if runtime_id not in ACP_RUNTIME_IDS:
            raise AgentRuntimeConfigError("Agent runtime 不支持 ACP 包目录配置")
        package_path = _configured_path(package_dir, self.managed_package_dir(runtime_id))
        config = self.load()
        runtime = config["agentRuntimes"][runtime_id]
        managed_package = dict(runtime.get("managedPackage") or {})
        managed_package["path"] = str(package_path)
        managed_package["installedVersion"] = self._installed_package_version_in_dir(runtime_id, package_path)
        runtime["managedPackage"] = managed_package
        command = self._managed_command_for_runtime(runtime_id, package_dir=package_path)
        runtime["command"] = command if self._command_available(command) else []
        self.save(config)
        return self.acp_package_settings()

    def install_acp_packages(self, *, update: bool = False, runtime_id: str | None = None) -> dict[str, Any]:
        runtime_ids = [runtime_id] if runtime_id else ["codex", "claude_code"]
        for current_runtime_id in runtime_ids:
            if current_runtime_id not in ACP_RUNTIME_IDS:
                raise AgentRuntimeConfigError("当前只支持安装 Codex ACP 和 Claude Code ACP 包")
        for current_runtime_id in runtime_ids:
            self.install_runtime(
                current_runtime_id,
                package_version="latest" if update else None,
                replace=update,
            )
        return self.acp_package_settings(check_latest=update)

    def update_runtime(self, runtime_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        config = self.load()
        runtime = config["agentRuntimes"].get(runtime_id)
        if runtime is None:
            raise AgentRuntimeConfigError("Agent runtime 不存在")

        if runtime_id in ACP_RUNTIME_IDS and "runtimeExecutable" in patch:
            self._update_runtime_executable(runtime_id, runtime, patch.get("runtimeExecutable"))
        elif runtime_id == "codex" and "codexPath" in patch:
            self._update_legacy_codex_path(runtime, patch.get("codexPath"))

        if runtime_id == "codex":
            self._update_codex_runtime(runtime, patch)
        elif runtime_id == "claude_code":
            allowed = {"enabled", "configMode", "command", "mode"}
            for key in allowed:
                if key in patch:
                    runtime[key] = patch[key]
        else:
            allowed = {"enabled", "configMode", "command"}
            for key in allowed:
                if key in patch:
                    runtime[key] = patch[key]

        self.save(config)
        return self._public_runtime(config["agentRuntimes"][runtime_id])

    def _acp_runtime_ids(self, runtime_id: str | None = None) -> list[str]:
        if runtime_id is None:
            return ["codex", "claude_code"]
        normalized = str(runtime_id or "").strip()
        if normalized not in ACP_RUNTIME_IDS:
            raise AgentRuntimeConfigError("Agent runtime 不支持 ACP 包配置")
        return [normalized]

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
            raise AgentRuntimeConfigError("当前只支持切换 Codex、Claude Code 和 nanobot")
        config = self.load()
        config["activeAdapter"] = adapter
        self.save(config)
        return self.list_settings()

    def install_runtime(
        self,
        runtime_id: str,
        package_version: str | None = None,
        *,
        replace: bool = False,
    ) -> dict[str, Any]:
        if runtime_id not in ACP_RUNTIME_IDS:
            raise AgentRuntimeConfigError("当前只支持安装 Codex ACP 和 Claude Code ACP 包")

        npm = _resolve_executable("npm")
        if not Path(npm).exists() and shutil.which(npm) is None:
            raise AgentRuntimeConfigError("未检测到 npm。请先安装 Node.js，后续版本会提供托管 Node 安装。")

        package_dir = self.managed_package_dir(runtime_id)
        self._prepare_package_dir_for_install(package_dir, replace=replace)
        package_dir.mkdir(parents=True, exist_ok=True)
        package_manifest = package_dir / "package.json"
        if not package_manifest.exists():
            package_manifest.write_text(
                json.dumps(
                    {
                        "private": True,
                        "name": f"code-lite-{runtime_id}-runtime",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        requested_version = (
            package_version
            or (DEFAULT_CODEX_ACP_VERSION if runtime_id == "codex" else DEFAULT_CLAUDE_ACP_VERSION)
        )
        package_spec = f"{package_name}@{requested_version}"
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
        command = self._managed_command_for_runtime(runtime_id, package_dir=package_dir)
        installed_version = self._installed_package_version(runtime_id)
        if not installed_version or not self._command_available(command):
            runtime["lastInstall"] = {
                "status": "failed",
                "at": _now_ms(),
                "detail": "npm install completed but ACP package files were not found",
            }
            self.save(config)
            raise AgentRuntimeConfigError(f"安装失败：未在 {package_dir} 检测到 ACP 包或启动命令")

        runtime["command"] = command
        runtime["distribution"] = "managed-npm"
        runtime["managedPackage"] = {
            "name": package_name,
            "requestedVersion": installed_version or requested_version,
            "installedVersion": installed_version,
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
        config = _read_json_object(self._path)
        return _configured_path(config.get("acpPackageRoot"), self._default_runtime_root())

    def _default_runtime_root(self) -> Path:
        return self._runtime_config.data_dir / "runtimes" / "acp"

    def managed_package_dir(self, runtime_id: str, package_root: Path | None = None) -> Path:
        if package_root is not None:
            return package_root / self._package_dir_name(runtime_id)
        raw_config = _read_json_object(self._path)
        raw_runtimes = raw_config.get("agentRuntimes") if isinstance(raw_config.get("agentRuntimes"), dict) else {}
        raw_runtime = raw_runtimes.get(runtime_id) if isinstance(raw_runtimes.get(runtime_id), dict) else {}
        raw_package = raw_runtime.get("managedPackage") if isinstance(raw_runtime.get("managedPackage"), dict) else {}
        default_path = self.runtime_root() / self._package_dir_name(runtime_id)
        return _configured_path(raw_package.get("path"), default_path)

    def managed_codex_command(self) -> list[str]:
        return self._managed_command_for_runtime("codex")

    def managed_claude_command(self) -> list[str]:
        return self._managed_command_for_runtime("claude_code")

    def codex_command(self) -> list[str]:
        runtime = self.load()["agentRuntimes"]["codex"]
        return self._resolve_codex_command(runtime)["command"]

    def _command_available(self, command: list[str]) -> bool:
        return bool(command) and _command_reference_exists(command[0])

    def _resolve_codex_command(self, runtime: dict[str, Any]) -> dict[str, Any]:
        command = _string_list(runtime.get("command"))
        if command:
            resolved = [_resolve_executable(command[0]), *command[1:]]
            if self._command_available(resolved):
                return {
                    "ok": True,
                    "command": resolved,
                    "source": str(runtime.get("distribution") or "configured"),
                }
            if runtime.get("distribution") == "custom":
                return {
                    "ok": False,
                    "command": resolved,
                    "detail": "自定义 Codex ACP 命令不存在",
                    "source": "custom",
                }

        managed = self.managed_codex_command()
        if self._command_available(managed):
            return {
                "ok": True,
                "command": managed,
                "missingCommand": [_resolve_executable(command[0]), *command[1:]] if command else None,
                "source": "managed-npm",
            }

        return {
            "ok": False,
            "command": managed,
            "detail": "未检测到托管 Codex ACP 包，请先在 Agent Runtime 设置中安装 ACP",
            "missingCommand": [_resolve_executable(command[0]), *command[1:]] if command else None,
            "source": "managed-npm",
        }

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

        runtime_executable = self._normalize_runtime_executable("codex", runtime)
        codex_path = str(runtime_executable.get("selectedPath") or runtime.get("codexPath") or "").strip()
        if codex_path:
            env["CODEX_PATH"] = codex_path

        return env

    def codex_mode(self, fallback: str | None = None) -> str:
        mode = str(fallback or self.load()["agentRuntimes"]["codex"].get("mode") or "read-only")
        return mode if mode in {"read-only", "agent", "agent-full-access"} else "read-only"

    def _normalize(self, config: dict[str, Any]) -> dict[str, Any]:
        raw_runtimes = config.get("agentRuntimes") if isinstance(config.get("agentRuntimes"), dict) else {}
        acp_package_root = _configured_path(config.get("acpPackageRoot"), self._default_runtime_root())
        runtimes = self._default_runtimes(acp_package_root)
        for runtime_id, runtime in runtimes.items():
            existing = raw_runtimes.get(runtime_id)
            if isinstance(existing, dict):
                runtime.update(existing)
                if runtime_id in ACP_RUNTIME_IDS:
                    default_package = self._default_managed_package(runtime_id, acp_package_root)
                    existing_package = existing.get("managedPackage") if isinstance(existing.get("managedPackage"), dict) else {}
                    package_dir = _configured_path(existing_package.get("path"), Path(default_package["path"]))
                    runtime["managedPackage"] = {
                        **default_package,
                        **existing_package,
                        "path": str(package_dir),
                    }
                    runtime["runtimeExecutable"] = self._normalize_runtime_executable(runtime_id, runtime)
                    if runtime_id == "codex" and runtime.get("distribution") == "dev-npx":
                        runtime["distribution"] = "managed-npm"
                    if runtime.get("distribution") == "managed-npm":
                        runtime["command"] = (
                            self._managed_command_for_runtime(runtime_id, package_dir=package_dir)
                            if self._installed_package_version_in_dir(runtime_id, package_dir)
                            else []
                        )
            runtime["id"] = runtime_id
        active_adapter = str(config.get("activeAdapter") or self._runtime_config.agent_adapter or "nanobot").strip().lower()
        if active_adapter not in SUPPORTED_ACTIVE_ADAPTERS:
            active_adapter = "nanobot"
        return {
            "schemaVersion": SCHEMA_VERSION,
            "acpPackageRoot": str(acp_package_root),
            "activeAdapter": active_adapter,
            "agentRuntimes": runtimes,
        }

    def _default_managed_package(self, runtime_id: str, package_root: Path) -> dict[str, Any]:
        if runtime_id == "codex":
            return {
                "name": CODEX_ACP_PACKAGE,
                "requestedVersion": DEFAULT_CODEX_ACP_VERSION,
                "installedVersion": None,
                "installedAt": None,
                "path": str(self.managed_package_dir("codex", package_root)),
            }
        return {
            "name": CLAUDE_ACP_PACKAGE,
            "requestedVersion": DEFAULT_CLAUDE_ACP_VERSION,
            "installedVersion": None,
            "installedAt": None,
            "path": str(self.managed_package_dir("claude_code", package_root)),
        }

    def _default_runtimes(self, package_root: Path) -> dict[str, dict[str, Any]]:
        return {
            "codex": {
                "id": "codex",
                "label": "Codex",
                "adapter": "codex",
                "enabled": True,
                "status": "experimental",
                "distribution": "managed-npm",
                "managedPackage": self._default_managed_package("codex", package_root),
                "command": [],
                "mode": "read-only",
                "configMode": "user-native",
                "codexPath": "",
                "runtimeExecutable": {"source": "sdk", "selectedPath": ""},
            },
            "claude_code": {
                "id": "claude_code",
                "label": "Claude Code",
                "adapter": "claude_code",
                "enabled": False,
                "status": "planned",
                "distribution": "managed-npm",
                "managedPackage": self._default_managed_package("claude_code", package_root),
                "command": [],
                "mode": "ask",
                "configMode": "user-native",
                "runtimeExecutable": {"source": "sdk", "selectedPath": ""},
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
        if isinstance(public.get("managedPackage"), dict) and runtime_id in ACP_RUNTIME_IDS:
            managed_package = dict(public["managedPackage"])
            package_dir = self.managed_package_dir(runtime_id)
            managed_package["installedVersion"] = self._installed_package_version_in_dir(runtime_id, package_dir)
            managed_package["path"] = str(package_dir)
            public["managedPackage"] = managed_package
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

    def _normalize_runtime_executable(self, runtime_id: str, runtime: dict[str, Any]) -> dict[str, Any]:
        raw = runtime.get("runtimeExecutable")
        source = ""
        selected_path = ""
        if isinstance(raw, dict):
            source = str(raw.get("source") or "").strip().lower()
            selected_path = str(raw.get("selectedPath") or raw.get("path") or "").strip()
        if runtime_id == "codex":
            legacy_codex_path = str(runtime.get("codexPath") or "").strip()
            if legacy_codex_path and not selected_path:
                source = "system"
                selected_path = legacy_codex_path
        if runtime_id == "claude_code":
            legacy_path = str(runtime.get("claudeCodeExecutable") or "").strip()
            if legacy_path and not selected_path:
                source = "system"
                selected_path = legacy_path
        if source not in RUNTIME_EXECUTABLE_SOURCES:
            source = "sdk"
        if source == "sdk":
            selected_path = ""
        return {"source": source, "selectedPath": selected_path}

    def _runtime_executable_command(self, runtime_id: str, runtime: dict[str, Any]) -> list[str]:
        executable = self._normalize_runtime_executable(runtime_id, runtime)
        selected_path = str(executable.get("selectedPath") or "").strip()
        if executable.get("source") == "system" and selected_path:
            return [selected_path]
        sdk_path = self._sdk_runtime_executable_path(runtime_id)
        return [str(sdk_path)] if sdk_path else []

    def _runtime_executable_version_command(self, runtime_id: str, runtime: dict[str, Any]) -> list[str]:
        command = self._runtime_executable_command(runtime_id, runtime)
        return [*command, "--version"] if command else []

    def _selected_runtime_executable_version(self, runtime_id: str, runtime: dict[str, Any]) -> dict[str, Any]:
        label = "Codex" if runtime_id == "codex" else "Claude Code"
        command = self._runtime_executable_version_command(runtime_id, runtime)
        return self._runtime_cli_version(runtime_id, label, command) if command else {
            "runtimeId": runtime_id,
            "label": label,
            "command": [],
            "detected": False,
            "version": None,
        }

    def _sdk_runtime_executable_path(self, runtime_id: str) -> Path | None:
        package_dir = self.managed_package_dir(runtime_id)
        if runtime_id == "codex":
            platform_package = self._codex_platform_package_name()
            if not platform_package:
                return None
            binary = "codex.exe" if os.name == "nt" else "codex"
            target_triple = self._codex_target_triple()
            if not target_triple:
                return None
            path = package_dir / "node_modules" / platform_package / "vendor" / target_triple / "bin" / binary
            return path if path.exists() else None

        platform_package = self._claude_platform_package_name()
        if not platform_package:
            return None
        binary = "claude.exe" if os.name == "nt" else "claude"
        path = package_dir / "node_modules" / platform_package / binary
        return path if path.exists() else None

    def _sdk_runtime_version(self, runtime_id: str) -> str | None:
        package_dir = self.managed_package_dir(runtime_id)
        if runtime_id == "codex":
            payload = _read_json_object(package_dir / "node_modules" / CODEX_RUNTIME_PACKAGE / "package.json")
            version = str(payload.get("version") or "").strip()
            return version or None
        payload = _read_json_object(package_dir / "node_modules" / CLAUDE_RUNTIME_PACKAGE / "package.json")
        version = str(payload.get("claudeCodeVersion") or payload.get("version") or "").strip()
        return version or None

    def _runtime_npm_package_name(self, runtime_id: str) -> str:
        return CODEX_RUNTIME_PACKAGE if runtime_id == "codex" else CLAUDE_RUNTIME_PACKAGE

    def _runtime_binary_name(self, runtime_id: str) -> str:
        if runtime_id == "codex":
            return "codex.exe" if os.name == "nt" else "codex"
        return "claude.exe" if os.name == "nt" else "claude"

    def _runtime_command_name(self, runtime_id: str) -> str:
        return "codex" if runtime_id == "codex" else "claude"

    def _codex_target_triple(self) -> str | None:
        if sys.platform == "win32":
            return "aarch64-pc-windows-msvc" if os.environ.get("PROCESSOR_ARCHITECTURE", "").lower() == "arm64" else "x86_64-pc-windows-msvc"
        if sys.platform == "darwin":
            return "aarch64-apple-darwin" if os.uname().machine == "arm64" else "x86_64-apple-darwin"
        if sys.platform.startswith("linux"):
            return "aarch64-unknown-linux-musl" if os.uname().machine in {"aarch64", "arm64"} else "x86_64-unknown-linux-musl"
        return None

    def _codex_platform_package_name(self) -> str | None:
        if sys.platform == "win32":
            return "@openai/codex-win32-arm64" if os.environ.get("PROCESSOR_ARCHITECTURE", "").lower() == "arm64" else "@openai/codex-win32-x64"
        if sys.platform == "darwin":
            return "@openai/codex-darwin-arm64" if os.uname().machine == "arm64" else "@openai/codex-darwin-x64"
        if sys.platform.startswith("linux"):
            return "@openai/codex-linux-arm64" if os.uname().machine in {"aarch64", "arm64"} else "@openai/codex-linux-x64"
        return None

    def _claude_platform_package_name(self) -> str | None:
        if sys.platform == "win32":
            return "@anthropic-ai/claude-agent-sdk-win32-arm64" if os.environ.get("PROCESSOR_ARCHITECTURE", "").lower() == "arm64" else "@anthropic-ai/claude-agent-sdk-win32-x64"
        if sys.platform == "darwin":
            return "@anthropic-ai/claude-agent-sdk-darwin-arm64" if os.uname().machine == "arm64" else "@anthropic-ai/claude-agent-sdk-darwin-x64"
        if sys.platform.startswith("linux"):
            arch = "arm64" if os.uname().machine in {"aarch64", "arm64"} else "x64"
            return f"@anthropic-ai/claude-agent-sdk-linux-{arch}"
        return None

    def _discover_system_runtime_executables(self, runtime_id: str) -> list[dict[str, Any]]:
        candidates: dict[str, dict[str, Any]] = {}
        command_name = self._runtime_command_name(runtime_id)
        path_candidate = _existing_path(shutil.which(command_name))
        if path_candidate:
            candidates[str(path_candidate)] = self._runtime_executable_candidate(runtime_id, path_candidate, "PATH")

        for candidate in self._global_npm_runtime_candidates(runtime_id):
            candidates[str(candidate)] = self._runtime_executable_candidate(runtime_id, candidate, "npm global")
        return sorted(candidates.values(), key=lambda item: (item["source"], item["path"].lower()))

    def _global_npm_runtime_candidates(self, runtime_id: str) -> list[Path]:
        binary_name = self._runtime_binary_name(runtime_id)
        command_name = self._runtime_command_name(runtime_id)
        roots: list[Path] = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            roots.append(Path(appdata) / "npm")
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            roots.append(Path(local_appdata) / "pnpm")
        profile = os.environ.get("USERPROFILE") or os.environ.get("HOME")
        if profile:
            roots.extend([
                Path(profile) / ".bun" / "bin",
                Path(profile) / ".npm-global" / "bin",
            ])
        results: list[Path] = []
        for root in roots:
            if not root.exists():
                continue
            direct_names = [binary_name, f"{command_name}.cmd", f"{command_name}.exe", command_name]
            for name in direct_names:
                path = root / name
                if path.exists() and path.is_file():
                    results.append(path.resolve())
            for pattern in (binary_name, f"{command_name}.cmd", f"{command_name}.exe"):
                try:
                    for path in root.glob(f"**/{pattern}"):
                        if path.is_file():
                            results.append(path.resolve())
                except OSError:
                    continue
        return list(dict.fromkeys(results))

    def _runtime_executable_candidate(self, runtime_id: str, path: Path, source: str) -> dict[str, Any]:
        version_result = self._detect_command([str(path), "--version"])
        return {
            "id": self._runtime_executable_option_id("system", str(path)),
            "source": source,
            "kind": "system",
            "label": f"本机 {path.name}",
            "path": str(path),
            "detected": bool(version_result["ok"]),
            "version": version_result.get("version"),
        }

    def _update_runtime_executable(self, runtime_id: str, runtime: dict[str, Any], value: Any) -> None:
        if not isinstance(value, dict):
            raise AgentRuntimeConfigError("Runtime 可执行文件配置不合法")
        source = str(value.get("source") or "").strip().lower()
        selected_path = str(value.get("selectedPath") or value.get("path") or "").strip()
        if source not in RUNTIME_EXECUTABLE_SOURCES:
            raise AgentRuntimeConfigError("Runtime 可执行文件来源不合法")
        if source == "sdk":
            selected_path = ""
        elif not selected_path:
            raise AgentRuntimeConfigError("请选择本机可执行文件路径")
        elif _existing_path(selected_path) is None:
            raise AgentRuntimeConfigError("本机可执行文件不存在")
        runtime["runtimeExecutable"] = {"source": source, "selectedPath": selected_path}
        if runtime_id == "codex":
            runtime["codexPath"] = selected_path if source == "system" else ""
        elif runtime_id == "claude_code":
            runtime["claudeCodeExecutable"] = selected_path if source == "system" else ""

    def _update_legacy_codex_path(self, runtime: dict[str, Any], codex_path: Any) -> None:
        selected_path = str(codex_path or "").strip()
        runtime["codexPath"] = selected_path
        runtime["runtimeExecutable"] = {
            "source": "system" if selected_path else "sdk",
            "selectedPath": selected_path,
        }

    def _runtime_executable_option_id(self, source: str, path: str = "") -> str:
        if source == "sdk":
            return "sdk"
        return f"system:{path}"

    def _public_runtime_executable(
        self,
        runtime: dict[str, Any],
        *,
        check_latest: bool,
        discover_system: bool,
    ) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        executable = self._normalize_runtime_executable(runtime_id, runtime)
        sdk_path = self._sdk_runtime_executable_path(runtime_id)
        sdk_version = self._sdk_runtime_version(runtime_id)
        sdk_option = {
            "id": "sdk",
            "source": "SDK 内置",
            "kind": "sdk",
            "label": "SDK 内置",
            "path": str(sdk_path) if sdk_path else "",
            "detected": bool(sdk_path),
            "version": sdk_version,
        }
        system_options = self._discover_system_runtime_executables(runtime_id) if discover_system else []
        selected_path = str(executable.get("selectedPath") or "").strip()
        selected_id = self._runtime_executable_option_id(
            "system" if executable.get("source") == "system" and selected_path else "sdk",
            selected_path,
        )
        if selected_id != "sdk" and not any(item["id"] == selected_id for item in system_options):
            selected_existing = _existing_path(selected_path)
            system_options.append({
                "id": selected_id,
                "source": "手动路径",
                "kind": "system",
                "label": "手动路径",
                "path": selected_path,
                "detected": bool(selected_existing),
                "version": self._detect_command([selected_path, "--version"]).get("version") if selected_existing else None,
            })
        options = [sdk_option, *system_options]
        selected = next((item for item in options if item["id"] == selected_id), sdk_option)
        latest_runtime_version = self._latest_package_version(self._runtime_npm_package_name(runtime_id)) if check_latest else None
        return {
            "runtimeId": runtime_id,
            "label": str(runtime.get("label") or runtime_id),
            "selectedId": selected.get("id"),
            "selectedSource": executable.get("source"),
            "selectedPath": selected.get("path") or "",
            "selectedVersion": selected.get("version"),
            "sdkPath": str(sdk_path) if sdk_path else "",
            "sdkVersion": sdk_version,
            "latestVersion": latest_runtime_version,
            "options": options,
        }

    def _detect_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        if runtime_id == "nanobot":
            return {"ok": True, "detail": "Python backend 已内置 nanobot SDK adapter"}
        if runtime_id == "codex":
            resolved = self._resolve_codex_command(runtime)
            source = str(resolved.get("source") or "")
            if source == "managed-npm":
                detail = "已检测到托管 Codex ACP 命令"
            elif source == "custom":
                detail = str(resolved.get("detail") or "自定义 Codex ACP 命令不可用")
            else:
                detail = "已检测到 Codex ACP 命令" if resolved["ok"] else "未检测到 Codex ACP 命令"
            if not resolved["ok"]:
                detail = str(resolved.get("detail") or detail)
            return {
                "ok": bool(resolved["ok"]),
                "detail": detail,
                "command": resolved["command"],
                "missingCommand": resolved.get("missingCommand"),
                "source": source,
            }
        if runtime_id == "opencode":
            ok = _command_exists("opencode")
            return {"ok": ok, "detail": "已检测到 opencode" if ok else "未检测到 opencode"}
        if runtime_id == "claude_code":
            command = _string_list(runtime.get("command"))
            if not command:
                command = self.managed_claude_command()
            resolved_cmd = [_resolve_executable(command[0]), *command[1:]] if command else []
            ok = bool(resolved_cmd and (Path(resolved_cmd[0]).exists() or shutil.which(resolved_cmd[0])))
            detail = "Claude Code ACP 已接入" if ok else "未检测到 Claude Code ACP 命令"
            return {
                "ok": ok,
                "detail": detail,
                "command": resolved_cmd,
                "source": str(runtime.get("distribution") or "configured"),
            }
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

    def _package_dir_name(self, runtime_id: str) -> str:
        if runtime_id == "codex":
            return "codex-acp"
        if runtime_id == "claude_code":
            return "claude-agent-acp"
        return runtime_id

    def _managed_command_for_runtime(
        self,
        runtime_id: str,
        package_root: Path | None = None,
        package_dir: Path | None = None,
    ) -> list[str]:
        if runtime_id == "codex":
            bin_name = "codex-acp.cmd" if os.name == "nt" else "codex-acp"
        else:
            bin_name = "claude-agent-acp.cmd" if os.name == "nt" else "claude-agent-acp"
        resolved_package_dir = package_dir or self.managed_package_dir(runtime_id, package_root)
        return [str(resolved_package_dir / "node_modules" / ".bin" / bin_name)]

    def _public_acp_package(self, runtime: dict[str, Any], *, check_latest: bool) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_dir = self.managed_package_dir(runtime_id)
        command = self._managed_command_for_runtime(runtime_id, package_dir=package_dir)
        installed_version = self._installed_package_version_in_dir(runtime_id, package_dir)
        latest_version = self._latest_package_version(package_name) if check_latest else None
        return {
            "runtimeId": runtime_id,
            "label": str(runtime.get("label") or runtime_id),
            "packageName": package_name,
            "packageDir": str(package_dir),
            "packageDirExists": package_dir.exists(),
            "packageDirIsEmpty": self._is_directory_empty(package_dir),
            "command": command,
            "installed": bool(installed_version and self._command_available(command)),
            "installedVersion": installed_version,
            "requestedVersion": str((runtime.get("managedPackage") or {}).get("requestedVersion") or ""),
            "latestVersion": latest_version,
            "needsUpdate": bool(installed_version and latest_version and installed_version != latest_version),
        }

    def _latest_package_version(self, package_name: str) -> str | None:
        npm = _resolve_executable("npm")
        if not Path(npm).exists() and shutil.which(npm) is None:
            return None
        try:
            result = run_hidden(
                [npm, "view", package_name, "version"],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        version = (result.stdout or "").strip().splitlines()
        return version[-1].strip() if version else None

    def _codex_binary_command(self) -> list[str]:
        runtime = self.load()["agentRuntimes"]["codex"]
        codex_path = str(runtime.get("codexPath") or "").strip()
        return [codex_path or "codex", "--version"]

    def _runtime_cli_version(self, runtime_id: str, label: str, command: list[str]) -> dict[str, Any]:
        detected = self._detect_command(command)
        return {
            "runtimeId": runtime_id,
            "label": label,
            "command": [_resolve_executable(command[0]), *command[1:]] if command else [],
            "detected": bool(detected["ok"]),
            "version": detected.get("version"),
        }

    @staticmethod
    def _is_directory_empty(path: Path) -> bool:
        if not path.exists():
            return True
        try:
            next(path.iterdir())
        except StopIteration:
            return True
        except OSError:
            return False
        return False

    def _is_acp_package_root_empty(self, path: Path) -> bool:
        if self._is_directory_empty(path):
            return True
        for runtime_id in ("codex", "claude_code"):
            if self._installed_package_version_in_dir(runtime_id, self.managed_package_dir(runtime_id, path)):
                return False
        return True

    def _installed_package_version(self, runtime_id: str) -> str | None:
        return self._installed_package_version_in_dir(runtime_id, self.managed_package_dir(runtime_id))

    def _installed_package_version_in_dir(self, runtime_id: str, package_dir: Path) -> str | None:
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_json = package_dir / "node_modules" / package_name / "package.json"
        payload = _read_json_object(package_json)
        version = str(payload.get("version") or "").strip()
        return version or None

    def _prepare_package_dir_for_install(self, package_dir: Path, *, replace: bool) -> None:
        if not replace or not package_dir.exists():
            return

        resolved_package_dir = package_dir.resolve()
        runtime_root = self.runtime_root().resolve()
        try:
            resolved_package_dir.relative_to(runtime_root)
        except ValueError:
            return

        if resolved_package_dir == runtime_root:
            raise AgentRuntimeConfigError("拒绝清理 ACP 根目录")
        shutil.rmtree(resolved_package_dir)

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
        if "codexPath" in patch and "runtimeExecutable" not in patch:
            runtime["codexPath"] = str(patch.get("codexPath") or "").strip()
        if "command" in patch:
            command = patch.get("command")
            if isinstance(command, str):
                runtime["command"] = _split_command(command)
            else:
                runtime["command"] = _string_list(command)
            if runtime["command"]:
                managed = os.path.normcase(os.path.abspath(self.managed_codex_command()[0]))
                current = os.path.normcase(os.path.abspath(runtime["command"][0]))
                runtime["distribution"] = "managed-npm" if current == managed else "custom"
            else:
                runtime["distribution"] = "managed-npm"
