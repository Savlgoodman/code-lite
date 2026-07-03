from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class RuntimeDescriptor:
    """Runtime 描述符 —— 各 ACP agent 的唯一标识。

    每个 ACP runtime（Codex、Claude Code、opencode）只需要定义自己的 descriptor，
    由通用的 AcpAgentAdapter 驱动。差异只在 command、env、defaults、caveats。
    """

    id: str
    label: str
    family: str
    adapter_kind: str = "acp"
    default_mode: str = "read-only"
    config_mode: str = "user-native"
    status: str = "available"
    caveats: list[str] = field(default_factory=list)

    managed_npm_package: str | None = None
    managed_npm_version: str | None = None
    default_command: list[str] = field(default_factory=list)
    default_env: dict[str, str] = field(default_factory=dict)

    def client_capabilities(self) -> dict[str, Any]:
        """当前 client 声明的能力（compat mode 默认关闭 fs/terminal）。"""
        return {
            "fs": {"readTextFile": False, "writeTextFile": False},
            "terminal": False,
        }


# ─── Codex ────────────────────────────────────────────────────────────────────

CODEX_DESCRIPTOR = RuntimeDescriptor(
    id="codex",
    label="Codex",
    family="codex",
    adapter_kind="acp",
    default_mode="read-only",
    config_mode="user-native",
    status="experimental",
    caveats=[
        "compat mode 不能保证所有危险动作经由 gateway",
        "usage_update 是 best effort",
        "compaction 没有 ACP 标准字段",
    ],
    managed_npm_package="@agentclientprotocol/codex-acp",
    managed_npm_version="1.1.0",
    default_command=["codex-acp"],
    default_env={"NO_BROWSER": "1"},
)

# Codex 的 mode 映射：产品 access_mode → ACP mode_id
CODEX_MODE_MAP: dict[str, str] = {
    "read-only": "read-only",
    "agent": "agent",
    "agent-full-access": "agent-full-access",
}

# Codex 的环境变量构建
def codex_env(
    runtime_config_dict: dict[str, Any],
    base_env: dict[str, str] | None = None,
    logs_dir: str | None = None,
    isolated_codex_home: str | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    if base_env:
        env.update(base_env)
    env.setdefault("NO_BROWSER", "1")
    env["INITIAL_AGENT_MODE"] = str(runtime_config_dict.get("mode") or "read-only")
    if logs_dir:
        env.setdefault("APP_SERVER_LOGS", logs_dir)
    if runtime_config_dict.get("configMode") == "isolated" and isolated_codex_home:
        env["CODEX_HOME"] = isolated_codex_home
    codex_path = str(runtime_config_dict.get("codexPath") or "").strip()
    if codex_path:
        env["CODEX_PATH"] = codex_path
    return env


def resolve_codex_mode(fallback: str | None = None) -> str:
    mode = str(fallback or "read-only")
    return CODEX_MODE_MAP.get(mode, "read-only")


# ─── Claude Code ──────────────────────────────────────────────────────────────

CLAUDE_DESCRIPTOR = RuntimeDescriptor(
    id="claude_code",
    label="Claude Code",
    family="claude_code",
    adapter_kind="acp",
    default_mode="ask",
    config_mode="user-native",
    status="experimental",
    caveats=[
        "Claude Code ACP 尚未经过完整 smoke test",
        ".claude/skills 和 CLAUDE.md 加载行为待验证",
    ],
    managed_npm_package="@agentclientprotocol/claude-agent-acp",
    managed_npm_version="0.55.0",
    default_command=["claude-agent-acp"],
)


# ─── opencode ─────────────────────────────────────────────────────────────────

OPENCODE_DESCRIPTOR = RuntimeDescriptor(
    id="opencode",
    label="opencode",
    family="opencode",
    adapter_kind="acp",
    default_mode="ask",
    config_mode="isolated",
    status="planned",
    caveats=[
        "opencode ACP 尚未经过完整 smoke test",
        "当前仅支持 system command 分发",
    ],
    default_command=["opencode", "acp"],
)


# ─── Registry ─────────────────────────────────────────────────────────────────

RUNTIME_DESCRIPTORS: dict[str, RuntimeDescriptor] = {
    "codex": CODEX_DESCRIPTOR,
    "claude_code": CLAUDE_DESCRIPTOR,
    "opencode": OPENCODE_DESCRIPTOR,
}


def get_descriptor(runtime_id: str) -> RuntimeDescriptor | None:
    return RUNTIME_DESCRIPTORS.get(runtime_id)
