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
DEFAULT_CODEX_ACP_VERSION = "1.1.0"
DEFAULT_CLAUDE_ACP_VERSION = "0.55.0"
SUPPORTED_ACTIVE_ADAPTERS = {"codex", "claude_code", "nanobot"}
ACP_RUNTIME_IDS = {"codex", "claude_code"}


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

    def acp_package_settings(self, *, check_latest: bool = False) -> dict[str, Any]:
        config = self.load()
        package_root = self.runtime_root()
        packages = [
            self._public_acp_package(config["agentRuntimes"][runtime_id], check_latest=check_latest)
            for runtime_id in ("codex", "claude_code")
        ]
        return {
            "packageRoot": str(package_root),
            "packageRootExists": package_root.exists(),
            "packageRootIsEmpty": self._is_acp_package_root_empty(package_root),
            "nodeDetected": self._detect_node(),
            "npmDetected": self._detect_npm(),
            "packages": packages,
            "runtimeVersions": [
                self._runtime_cli_version("codex", "Codex", self._codex_binary_command()),
                self._runtime_cli_version("claude_code", "Claude Code", ["claude", "--version"]),
            ],
            "checkedAt": _now_ms() if check_latest else None,
        }

    def update_acp_package_root(self, package_root: str) -> dict[str, Any]:
        root = _configured_path(package_root, self._default_runtime_root())
        config = self.load()
        config["acpPackageRoot"] = str(root)
        self.save(config)
        return self.acp_package_settings()

    def install_acp_packages(self, *, update: bool = False) -> dict[str, Any]:
        for runtime_id in ("codex", "claude_code"):
            self.install_runtime(runtime_id, package_version="latest" if update else None)
        return self.acp_package_settings(check_latest=update)

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
            raise AgentRuntimeConfigError("当前只支持切换 Codex、Claude Code 和 nanobot")
        config = self.load()
        config["activeAdapter"] = adapter
        self.save(config)
        return self.list_settings()

    def install_runtime(self, runtime_id: str, package_version: str | None = None) -> dict[str, Any]:
        if runtime_id not in ACP_RUNTIME_IDS:
            raise AgentRuntimeConfigError("当前只支持安装 Codex ACP 和 Claude Code ACP 包")

        npm = _resolve_executable("npm")
        if not Path(npm).exists() and shutil.which(npm) is None:
            raise AgentRuntimeConfigError("未检测到 npm。请先安装 Node.js，后续版本会提供托管 Node 安装。")

        package_dir = self.managed_package_dir(runtime_id)
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
        command = self.managed_codex_command() if runtime_id == "codex" else self.managed_claude_command()
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
        root = package_root or self.runtime_root()
        if runtime_id == "codex":
            return root / "codex-acp"
        if runtime_id == "claude_code":
            return root / "claude-agent-acp"
        return root / runtime_id

    def managed_codex_command(self) -> list[str]:
        return self._managed_command_for_runtime("codex")

    def managed_claude_command(self) -> list[str]:
        return self._managed_command_for_runtime("claude_code")

    def codex_command(self) -> list[str]:
        runtime = self.load()["agentRuntimes"]["codex"]
        return self._resolve_codex_command(runtime)["command"]

    def _npx_codex_command(self) -> list[str]:
        return [_resolve_executable("npx"), "-y", CODEX_ACP_PACKAGE]

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

        npx_command = self._npx_codex_command()
        npm_status = self._detect_npm()
        return {
            "ok": bool(npm_status["ok"]),
            "command": npx_command,
            "missingCommand": [_resolve_executable(command[0]), *command[1:]] if command else None,
            "source": "npx",
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

        codex_path = str(runtime.get("codexPath") or "").strip()
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
                    runtime["managedPackage"] = {
                        **default_package,
                        **existing_package,
                        "path": default_package["path"],
                    }
                    if runtime.get("distribution") == "managed-npm":
                        runtime["command"] = (
                            self._managed_command_for_runtime(runtime_id, acp_package_root)
                            if self._installed_package_version_at(runtime_id, acp_package_root)
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
                "distribution": "dev-npx",
                "managedPackage": self._default_managed_package("codex", package_root),
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
                "managedPackage": self._default_managed_package("claude_code", package_root),
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
        if isinstance(public.get("managedPackage"), dict) and runtime_id in ACP_RUNTIME_IDS:
            managed_package = dict(public["managedPackage"])
            managed_package["installedVersion"] = self._installed_package_version(runtime_id)
            managed_package["path"] = str(self.managed_package_dir(runtime_id))
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

    def _detect_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        if runtime_id == "nanobot":
            return {"ok": True, "detail": "Python backend 已内置 nanobot SDK adapter"}
        if runtime_id == "codex":
            resolved = self._resolve_codex_command(runtime)
            source = str(resolved.get("source") or "")
            if source == "npx":
                detail = "将通过 npx 按需启动 codex-acp" if resolved["ok"] else "未检测到 npm"
            elif source == "managed-npm":
                detail = "已检测到托管 Codex ACP 命令"
            elif source == "custom":
                detail = str(resolved.get("detail") or "自定义 Codex ACP 命令不可用")
            else:
                detail = "已检测到 Codex ACP 命令" if resolved["ok"] else "未检测到 Codex ACP 命令"
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

    def _managed_command_for_runtime(self, runtime_id: str, package_root: Path | None = None) -> list[str]:
        if runtime_id == "codex":
            bin_name = "codex-acp.cmd" if os.name == "nt" else "codex-acp"
        else:
            bin_name = "claude-agent-acp.cmd" if os.name == "nt" else "claude-agent-acp"
        return [str(self.managed_package_dir(runtime_id, package_root) / "node_modules" / ".bin" / bin_name)]

    def _public_acp_package(self, runtime: dict[str, Any], *, check_latest: bool) -> dict[str, Any]:
        runtime_id = str(runtime.get("id") or "")
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_dir = self.managed_package_dir(runtime_id)
        command = self.managed_codex_command() if runtime_id == "codex" else self.managed_claude_command()
        installed_version = self._installed_package_version(runtime_id)
        latest_version = self._latest_package_version(package_name) if check_latest else None
        return {
            "runtimeId": runtime_id,
            "label": str(runtime.get("label") or runtime_id),
            "packageName": package_name,
            "packageDir": str(package_dir),
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
            if self._installed_package_version_at(runtime_id, path):
                return False
        return True

    def _installed_package_version(self, runtime_id: str) -> str | None:
        return self._installed_package_version_at(runtime_id, self.runtime_root())

    def _installed_package_version_at(self, runtime_id: str, package_root: Path) -> str | None:
        package_name = CODEX_ACP_PACKAGE if runtime_id == "codex" else CLAUDE_ACP_PACKAGE
        package_json = self.managed_package_dir(runtime_id, package_root) / "node_modules" / package_name / "package.json"
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
            if runtime["command"]:
                managed = os.path.normcase(os.path.abspath(self.managed_codex_command()[0]))
                current = os.path.normcase(os.path.abspath(runtime["command"][0]))
                runtime["distribution"] = "managed-npm" if current == managed else "custom"
            else:
                runtime["distribution"] = "managed-npm" if self._installed_package_version("codex") else "dev-npx"
