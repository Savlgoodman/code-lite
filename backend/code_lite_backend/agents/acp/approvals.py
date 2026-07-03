from __future__ import annotations

from typing import Any

from acp import schema as acp_schema


def _permission_option_id(option: Any) -> str:
    return str(getattr(option, "option_id", None) or getattr(option, "optionId", None) or "")


def _permission_option_kind(option: Any) -> str:
    return str(getattr(option, "kind", "") or "")


def choose_permission_option(options: list[Any], *, allowed: bool) -> Any | None:
    """从 ACP permission options 中选择一个 allow 或 reject 选项。

    优先选择 _once 变体，避免默认授予持久权限。
    """
    if not options:
        return None

    desired_kinds = (
        ["allow_once", "allow_always"]
        if allowed
        else ["reject_once", "reject_always"]
    )
    prefix = "allow" if allowed else "reject"

    for kind in desired_kinds:
        for option in options:
            if _permission_option_kind(option) == kind:
                return option
    for option in options:
        if _permission_option_kind(option).startswith(prefix):
            return option
    return options[0] if allowed else None


def build_allowed_response(option: Any) -> acp_schema.RequestPermissionResponse:
    return acp_schema.RequestPermissionResponse(
        outcome=acp_schema.AllowedOutcome(
            outcome="selected",
            optionId=_permission_option_id(option),
        ),
    )


def build_denied_response() -> acp_schema.RequestPermissionResponse:
    return acp_schema.RequestPermissionResponse(
        outcome=acp_schema.DeniedOutcome(outcome="cancelled"),
    )
