from __future__ import annotations

import argparse
import dataclasses
import importlib
import importlib.metadata
import inspect
import json
import os
import pkgutil
import stat
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, get_args


PACKAGE_SPECS = {
    "codex": {
        "distributions": ["openai-codex", "openai-codex-cli-bin"],
        "modules": ["openai_codex", "codex_cli_bin"],
        "home_env": "CODEX_HOME",
        "home_default": ".codex",
        "project_dir": ".codex",
    },
    "claude": {
        "distributions": ["claude-agent-sdk"],
        "modules": ["claude_agent_sdk"],
        "home_env": "CLAUDE_CONFIG_DIR",
        "home_default": ".claude",
        "project_dir": ".claude",
    },
    "nanobot": {
        "distributions": ["nanobot-ai"],
        "modules": ["nanobot"],
        "home_env": "NANOBOT_HOME",
        "home_default": ".nanobot",
        "project_dir": "skills",
    },
}

BINARY_SUFFIXES = {
    ".bat",
    ".bin",
    ".cmd",
    ".com",
    ".dll",
    ".dylib",
    ".exe",
    ".msi",
    ".node",
    ".pyd",
    ".sh",
    ".so",
}

BINARY_DIR_HINTS = (
    "/bin/",
    "\\bin\\",
    "/_bundled/",
    "\\_bundled\\",
)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(
        description="Reflect Python SDK packages without starting agent runtimes.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON. This is the default-friendly format for docs and tests.",
    )
    parser.add_argument(
        "--include-site-files",
        action="store_true",
        help="Include a short sample of installed distribution files.",
    )
    parser.add_argument(
        "--runtime",
        choices=sorted(PACKAGE_SPECS),
        action="append",
        help="Limit output to one runtime. Can be repeated.",
    )
    args = parser.parse_args()

    selected_specs = {
        runtime_id: spec
        for runtime_id, spec in PACKAGE_SPECS.items()
        if args.runtime is None or runtime_id in args.runtime
    }
    result = {
        "probe": "code-lite-agent-sdk-research",
        "python": {
            "version": sys.version,
            "executable": redact_path(Path(sys.executable)),
        },
        "cwd": redact_path(Path.cwd()),
        "packages": {
            runtime_id: inspect_runtime(runtime_id, spec, args)
            for runtime_id, spec in selected_specs.items()
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def inspect_runtime(runtime_id: str, spec: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    return {
        "distributions": {
            name: inspect_distribution(name, include_site_files=args.include_site_files)
            for name in spec["distributions"]
        },
        "modules": {name: inspect_module(name) for name in spec["modules"]},
        "runtime_binaries": inspect_runtime_binaries(runtime_id),
        "state_locations": inspect_state_locations(spec),
        "api": inspect_api(runtime_id),
        "entry_points": inspect_entry_points(spec["distributions"]),
    }


def inspect_distribution(name: str, *, include_site_files: bool) -> dict[str, Any]:
    try:
        dist = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        return {"installed": False}

    files = list(dist.files or [])
    binary_candidates = []
    sample_files = []
    for file in files:
        file_text = str(file)
        if include_site_files and len(sample_files) < 40:
            sample_files.append(file_text)
        if looks_like_binary_candidate(file_text):
            located = Path(dist.locate_file(file))
            binary_candidates.append(file_summary(located, label=file_text))

    metadata = dist.metadata
    return {
        "installed": True,
        "name": metadata.get("Name", name),
        "version": dist.version,
        "summary": metadata.get("Summary"),
        "file_count": len(files),
        "binary_candidates": binary_candidates[:80],
        "sample_files": sample_files,
    }


def inspect_module(name: str) -> dict[str, Any]:
    try:
        module = importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001
        return {
            "imported": False,
            "error": f"{type(exc).__name__}: {exc}",
        }

    path = Path(getattr(module, "__file__", "") or "")
    package_paths = [
        redact_path(Path(item))
        for item in getattr(module, "__path__", [])
    ]
    submodules = []
    if hasattr(module, "__path__"):
        for item in pkgutil.iter_modules(module.__path__):
            if len(submodules) >= 60:
                break
            submodules.append(item.name)
    return {
        "imported": True,
        "version": getattr(module, "__version__", None),
        "file": redact_path(path) if path else None,
        "package_paths": package_paths,
        "submodules": submodules,
    }


def inspect_runtime_binaries(runtime_id: str) -> dict[str, Any]:
    if runtime_id == "codex":
        try:
            codex_cli_bin = importlib.import_module("codex_cli_bin")
            binary_path = codex_cli_bin.bundled_codex_path()
            return {
                "bundled_codex_path": file_summary(Path(binary_path)),
            }
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}

    if runtime_id == "claude":
        found = []
        try:
            module = importlib.import_module("claude_agent_sdk")
            roots = [Path(item) for item in getattr(module, "__path__", [])]
            for root in roots:
                if not root.exists():
                    continue
                for path in root.rglob("*"):
                    if len(found) >= 80:
                        break
                    if path.is_file() and looks_like_binary_candidate(str(path.relative_to(root))):
                        found.append(file_summary(path, label=str(path.relative_to(root))))
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}
        return {"package_binary_candidates": found}

    return {"package_binary_candidates": []}


def inspect_state_locations(spec: dict[str, Any]) -> dict[str, Any]:
    home = Path(os.environ.get(spec["home_env"], "")).expanduser() if os.environ.get(spec["home_env"]) else Path.home() / spec["home_default"]
    project_dir = Path.cwd() / spec["project_dir"]
    return {
        "home_env": spec["home_env"],
        "home_env_set": spec["home_env"] in os.environ,
        "home_dir": directory_summary(home),
        "project_dir": directory_summary(project_dir),
    }


def inspect_api(runtime_id: str) -> dict[str, Any]:
    if runtime_id == "codex":
        return inspect_codex_api()
    if runtime_id == "claude":
        return inspect_claude_api()
    if runtime_id == "nanobot":
        return inspect_nanobot_api()
    return {}


def inspect_codex_api() -> dict[str, Any]:
    data: dict[str, Any] = {}
    try:
        openai_codex = importlib.import_module("openai_codex")
        client_mod = importlib.import_module("openai_codex.client")
        generated = importlib.import_module("openai_codex.generated.v2_all")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}

    names = {
        "Codex": getattr(openai_codex, "Codex", None),
        "AsyncCodex": getattr(openai_codex, "AsyncCodex", None),
        "CodexConfig": getattr(openai_codex, "CodexConfig", None),
        "CodexClient": getattr(client_mod, "CodexClient", None),
        "AsyncCodexClient": getattr(client_mod, "AsyncCodexClient", None),
        "Thread": getattr(openai_codex, "Thread", None),
    }
    data["signatures"] = {key: signature(value) for key, value in names.items()}
    data["methods"] = {
        "Codex.thread_start": signature(getattr(names["Codex"], "thread_start", None)),
        "Codex.models": signature(getattr(names["Codex"], "models", None)),
        "Thread.run": signature(getattr(names["Thread"], "run", None)),
        "Thread.turn": signature(getattr(names["Thread"], "turn", None)),
    }
    data["enums"] = {
        "ApprovalMode": enum_values(getattr(openai_codex, "ApprovalMode", None)),
        "Sandbox": enum_values(getattr(openai_codex, "Sandbox", None)),
        "AskForApprovalValue": enum_values(getattr(generated, "AskForApprovalValue", None)),
        "ApprovalsReviewer": enum_values(getattr(generated, "ApprovalsReviewer", None)),
        "ReasoningEffort": enum_values(getattr(generated, "ReasoningEffort", None)),
        "ReasoningSummaryValue": enum_values(getattr(generated, "ReasoningSummaryValue", None)),
    }
    data["generated_type_hints"] = [
        name
        for name in dir(generated)
        if any(marker in name.lower() for marker in ("approval", "context", "token", "usage", "interrupt"))
    ][:120]
    data["observed_capability_fields"] = {
        "cwd": "CodexConfig has cwd in current SDK when signature includes it.",
        "streaming": "Thread.turn returns a handle in current SDK; existing probe checks TurnHandle.stream().",
        "interrupt": "Current SDK exposes interrupt on turn handles when present.",
        "per_turn_model": "Thread.turn signature can include model.",
        "reasoning": "ReasoningEffort and ReasoningSummaryValue are generated protocol enums.",
    }
    return data


def inspect_claude_api() -> dict[str, Any]:
    data: dict[str, Any] = {}
    try:
        sdk = importlib.import_module("claude_agent_sdk")
        types_mod = importlib.import_module("claude_agent_sdk.types")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}

    options = getattr(sdk, "ClaudeAgentOptions", None)
    client = getattr(sdk, "ClaudeSDKClient", None)
    data["signatures"] = {
        "query": signature(getattr(sdk, "query", None)),
        "ClaudeSDKClient": signature(client),
        "ClaudeAgentOptions": signature(options),
        "create_sdk_mcp_server": signature(getattr(sdk, "create_sdk_mcp_server", None)),
        "tool": signature(getattr(sdk, "tool", None)),
    }
    data["client_methods"] = {
        name: signature(getattr(client, name, None))
        for name in ("connect", "disconnect", "query", "receive_response", "interrupt")
    }
    data["option_fields"] = dataclass_fields(options)
    data["literal_values"] = {
        "PermissionMode": literal_values(getattr(types_mod, "PermissionMode", None)),
        "EffortLevel": literal_values(getattr(types_mod, "EffortLevel", None)),
        "SettingSource": literal_values(getattr(types_mod, "SettingSource", None)),
        "HookEvent": literal_values(getattr(types_mod, "HookEvent", None)),
    }
    data["message_fields"] = {
        name: dataclass_fields(getattr(types_mod, name, None))
        for name in ("AssistantMessage", "ResultMessage", "StreamEvent", "RateLimitEvent")
    }
    data["observed_capability_fields"] = {
        "cwd": "ClaudeAgentOptions.cwd",
        "settings": "ClaudeAgentOptions.setting_sources/settings/settings path",
        "streaming": "query() and ClaudeSDKClient.receive_response() are async iterators; partial stream events require include_partial_messages.",
        "interrupt": "ClaudeSDKClient.interrupt",
        "approval": "can_use_tool, permission_prompt_tool_name, hooks, permissions rules",
        "per_turn_model": "Options are client/query scoped; per-turn change can be modeled by new query/client options or separate session.",
        "context": "ResultMessage.model_usage can include contextWindow and maxOutputTokens.",
    }
    return data


def inspect_nanobot_api() -> dict[str, Any]:
    data: dict[str, Any] = {}
    try:
        nanobot = importlib.import_module("nanobot")
        agent_mod = importlib.import_module("nanobot.agent")
        streaming_mod = importlib.import_module("nanobot.sdk.streaming")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}

    bot = getattr(nanobot, "Nanobot", None)
    hook = getattr(agent_mod, "AgentHook", None)
    stream = getattr(streaming_mod, "RunStream", None)
    data["signatures"] = {
        "Nanobot": signature(bot),
        "Nanobot.from_config": signature(getattr(bot, "from_config", None)),
        "Nanobot.run": signature(getattr(bot, "run", None)),
        "Nanobot.run_streamed": signature(getattr(bot, "run_streamed", None)),
        "AgentHook": signature(hook),
        "RunStream": signature(stream),
    }
    data["methods"] = {
        "RunStream.stream_events": signature(getattr(stream, "stream_events", None)),
        "RunStream.cancel": signature(getattr(stream, "cancel", None)),
        "AgentHook.before_execute_tools": signature(getattr(hook, "before_execute_tools", None)),
        "AgentHook.after_execute_tools": signature(getattr(hook, "after_execute_tools", None)),
    }
    data["observed_capability_fields"] = {
        "config": "Nanobot.from_config accepts explicit config/workspace inputs in current SDK.",
        "streaming": "Nanobot.run_streamed returns RunStream.",
        "cancel": "RunStream.cancel",
        "approval": "AgentHook.before_execute_tools can gate tool execution.",
        "skills": "nanobot loads workspace skills from workspace/skills in the researched version.",
    }
    return data


def inspect_entry_points(distribution_names: Iterable[str]) -> dict[str, list[str]]:
    wanted = set(distribution_names)
    result: dict[str, list[str]] = {}
    for entry_point in importlib.metadata.entry_points():
        try:
            dist_name = entry_point.dist.metadata["Name"]
        except Exception:  # noqa: BLE001
            continue
        if dist_name not in wanted:
            continue
        result.setdefault(entry_point.group, []).append(f"{entry_point.name} = {entry_point.value}")
    return {key: sorted(value) for key, value in sorted(result.items())}


def looks_like_binary_candidate(path_text: str) -> bool:
    normalized = path_text.replace("\\", "/").lower()
    suffix = Path(path_text).suffix.lower()
    if suffix in BINARY_SUFFIXES:
        return True
    return any(hint in path_text for hint in BINARY_DIR_HINTS)


def file_summary(path: Path, *, label: str | None = None) -> dict[str, Any]:
    try:
        exists = path.exists()
        mode = path.stat().st_mode if exists else 0
        return {
            "label": label,
            "path": redact_path(path),
            "exists": exists,
            "is_file": path.is_file() if exists else False,
            "size": path.stat().st_size if exists and path.is_file() else None,
            "suffix": path.suffix,
            "executable_bit": bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)),
        }
    except OSError as exc:
        return {
            "label": label,
            "path": redact_path(path),
            "error": f"{type(exc).__name__}: {exc}",
        }


def directory_summary(path: Path) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "path": redact_path(path),
        "exists": path.exists(),
        "is_dir": path.is_dir(),
        "entries": [],
    }
    if not path.is_dir():
        return summary
    entries = []
    try:
        for child in sorted(path.iterdir(), key=lambda item: item.name.lower())[:60]:
            item = {
                "name": child.name,
                "kind": "dir" if child.is_dir() else "file",
            }
            try:
                stat_result = child.stat()
                item["size"] = stat_result.st_size if child.is_file() else None
                item["mtime"] = int(stat_result.st_mtime)
            except OSError:
                pass
            entries.append(item)
    except OSError as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
    summary["entries"] = entries
    return summary


def signature(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(inspect.signature(value))
    except (TypeError, ValueError):
        return None


def enum_values(value: Any) -> list[str]:
    if value is None:
        return []
    try:
        return [item.value for item in value]
    except TypeError:
        return []


def literal_values(value: Any) -> list[str]:
    if value is None:
        return []
    return [str(item) for item in get_args(value)]


def dataclass_fields(value: Any) -> list[dict[str, str]]:
    if value is None or not dataclasses.is_dataclass(value):
        return []
    fields = []
    for field in dataclasses.fields(value):
        fields.append(
            {
                "name": field.name,
                "type": str(field.type),
                "default": repr(field.default)
                if field.default is not dataclasses.MISSING
                else "<factory>" if field.default_factory is not dataclasses.MISSING else "<required>",
            }
        )
    return fields


def redact_path(path: Path) -> str:
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        resolved = path.expanduser().absolute()
    home = Path.home().resolve()
    try:
        relative = resolved.relative_to(home)
        return str(Path("~") / relative)
    except ValueError:
        return str(resolved)


if __name__ == "__main__":
    raise SystemExit(main())
