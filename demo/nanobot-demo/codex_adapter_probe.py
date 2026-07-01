from __future__ import annotations

import argparse
import importlib.metadata
import inspect
import json
import sys
from pathlib import Path
from typing import Any


APPROVAL_REQUEST_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
}

PRODUCT_PERMISSION_MODES = ("readonly", "ask", "auto", "fullaccess")


CODEX_PRODUCT_PERMISSION_MAPPING: dict[str, dict[str, Any]] = {
    "readonly": {
        "productMode": "readonly",
        "codexSandbox": "read-only",
        "codexThreadSandbox": "read-only",
        "codexSandboxPolicy": {"type": "readOnly"},
        "codexApprovalPolicy": "never",
        "codexApprovalsReviewer": None,
        "sdkHighLevelApprovalMode": "deny_all",
        "approvalHandler": "deny command/file approval requests",
        "notes": [
            "Allows code and file inspection, but denies approval requests for commands or file changes.",
            "Best default for evaluating Codex inside PC Repair Agent.",
        ],
    },
    "ask": {
        "productMode": "ask",
        "codexSandbox": "workspace-write",
        "codexThreadSandbox": "workspace-write",
        "codexSandboxPolicy": {"type": "workspaceWrite"},
        "codexApprovalPolicy": "on-request",
        "codexApprovalsReviewer": "user",
        "sdkHighLevelApprovalMode": None,
        "approvalHandler": "bridge command/file approval requests to PC Repair Agent UI",
        "notes": [
            "The public high-level ApprovalMode enum does not expose a user ask value.",
            "Use low-level CodexClient approval_handler and JSON-RPC payloads for this mode.",
            "Smoke runs showed workspace writes inside the approved sandbox can complete without calling approval_handler.",
        ],
    },
    "auto": {
        "productMode": "auto",
        "codexSandbox": "workspace-write",
        "codexThreadSandbox": "workspace-write",
        "codexSandboxPolicy": {"type": "workspaceWrite"},
        "codexApprovalPolicy": "on-request",
        "codexApprovalsReviewer": "auto_review",
        "sdkHighLevelApprovalMode": "auto_review",
        "approvalHandler": "record auto-review events and keep product blocked rules outside Codex",
        "notes": [
            "Codex auto-review changes who reviews boundary-crossing actions; it does not expand the sandbox.",
            "PC Repair Agent should still keep its own blocked policy and Execution Gateway.",
        ],
    },
    "fullaccess": {
        "productMode": "fullaccess",
        "codexSandbox": "full-access",
        "codexThreadSandbox": "danger-full-access",
        "codexSandboxPolicy": {"type": "dangerFullAccess"},
        "codexApprovalPolicy": "on-request",
        "codexApprovalsReviewer": "auto_review",
        "sdkHighLevelApprovalMode": "auto_review",
        "approvalHandler": "record escalation decisions; never bypass product blocked policy",
        "notes": [
            "Use only for expert/debug workflows.",
            "This does not mean PC Repair Agent should skip its Rust Execution Gateway.",
        ],
    },
}


CODEX_NOTIFICATION_EVENT_MAP = {
    "turn/started": "agent.run.started",
    "item/agentMessage/delta": "agent.text.delta",
    "item/reasoningText/delta": "agent.reasoning.delta",
    "item/reasoningSummaryText/delta": "agent.reasoning.delta",
    "item/plan/delta": "agent.plan.delta",
    "turn/plan/updated": "agent.plan.updated",
    "item/commandExecution/outputDelta": "agent.command.output.delta",
    "item/fileChange/outputDelta": "agent.file_change.output.delta",
    "item/fileChange/patchUpdated": "agent.file_change.patch.updated",
    "item/mcpToolCall/progress": "agent.tool.progress",
    "item/autoApprovalReview/started": "approval.auto_review.started",
    "item/autoApprovalReview/completed": "approval.auto_review.completed",
    "thread/tokenUsage/updated": "agent.usage.updated",
    "turn/completed": "agent.run.completed",
}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def enum_values(enum_type: Any) -> list[str]:
    return [item.value for item in enum_type]


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def inspect_sdk() -> dict[str, Any]:
    import openai_codex
    from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox, Thread
    from openai_codex.client import CodexClient
    from openai_codex.generated.v2_all import (
        ApprovalsReviewer,
        AskForApprovalValue,
        ReasoningEffort,
        ReasoningSummaryValue,
    )

    try:
        import codex_cli_bin

        bundled_codex_path = str(codex_cli_bin.bundled_codex_path())
    except Exception as exc:  # noqa: BLE001
        bundled_codex_path = f"unavailable: {type(exc).__name__}: {exc}"

    return {
        "package": {
            "openai_codex": getattr(openai_codex, "__version__", None),
            "openai-codex": package_version("openai-codex"),
            "openai-codex-cli-bin": package_version("openai-codex-cli-bin"),
            "modulePath": str(Path(openai_codex.__file__).resolve()),
            "bundledCodexPath": bundled_codex_path,
        },
        "interfaces": {
            "Codex": str(inspect.signature(Codex)),
            "CodexConfig": str(inspect.signature(CodexConfig)),
            "CodexClient": str(inspect.signature(CodexClient)),
            "Codex.thread_start": str(inspect.signature(Codex.thread_start)),
            "Codex.models": str(inspect.signature(Codex.models)),
            "Thread.turn": str(inspect.signature(Thread.turn)),
            "Thread.run": str(inspect.signature(Thread.run)),
        },
        "capabilities": {
            "streaming": "TurnHandle.stream() yields typed notifications; stream_text() yields text deltas.",
            "cancellation": "TurnHandle.interrupt() / AsyncTurnHandle.interrupt().",
            "permissionModesExposedBySdk": enum_values(ApprovalMode),
            "sandboxLevelsExposedBySdk": enum_values(Sandbox),
            "lowLevelApprovalPolicyValues": enum_values(AskForApprovalValue),
            "lowLevelApprovalReviewers": enum_values(ApprovalsReviewer),
            "reasoningEffortValues": enum_values(ReasoningEffort),
            "reasoningSummaryValues": enum_values(ReasoningSummaryValue),
            "modelOverride": "thread_start(..., model=...) and Thread.turn(..., model=...).",
            "modelProviderOverride": "thread_start(..., model_provider=...), not exposed on per-turn helper.",
            "modelList": "Codex.models() / CodexClient.model_list().",
            "approvalHook": (
                "CodexClient accepts approval_handler(method, params). "
                "The default handler accepts command and file-change approval requests."
            ),
            "customToolRegistration": (
                "No Python function-tool registration API was found in openai-codex 0.1.0b2. "
                "Tool extension appears to be through Codex runtime config/MCP/dynamic tools, "
                "not direct Python callbacks."
            ),
        },
        "pcRepairAssessment": {
            "canStreamText": True,
            "canObserveToolLikeEvents": True,
            "canCancelTurn": True,
            "canSetReadOnlySandbox": True,
            "canSetFullAccessSandbox": True,
            "canFineGrainApproveCommands": (
                "Partially. Raw JSON-RPC approval requests can be intercepted by approval_handler, "
                "but the high-level ApprovalMode enum only exposes deny_all and auto_review. "
                "The ask/user mode needs the low-level CodexClient path."
            ),
            "canRegisterPythonToolsDirectly": False,
            "recommendedUse": (
                "Use Codex adapter for coding/workspace repair tasks that fit Codex's runtime. "
                "Use MCP or product Execution Gateway for first-party PC repair tools."
            ),
        },
    }


def adapter_descriptor() -> dict[str, Any]:
    version = package_version("openai-codex")
    runtime_version = package_version("openai-codex-cli-bin")
    return {
        "id": "codex",
        "label": "OpenAI Codex",
        "vendor": "OpenAI",
        "runtimeKind": "local_jsonrpc_sdk",
        "status": "available" if version else "missing_dependency",
        "version": version,
        "runtimeVersion": runtime_version,
        "defaults": {
            "permissionMode": "readonly",
            "sandbox": "read-only",
            "approvalMode": "deny_all",
            "reasoningEffort": None,
            "reasoningSummary": "auto",
            "model": None,
        },
        "capabilities": {
            "streaming": {
                "textDelta": True,
                "reasoningDelta": True,
                "planDelta": True,
                "commandOutputDelta": True,
                "fileChangeDelta": True,
                "toolEvents": True,
                "tokenUsage": True,
                "finalResult": True,
            },
            "permissions": {
                "supportedProductModes": list(PRODUCT_PERMISSION_MODES),
                "supportsSandbox": True,
                "sandboxLevels": ["read-only", "workspace-write", "full-access"],
                "supportsEscalationApprovalCallback": True,
                "supportsEveryActionApprovalCallback": False,
                "supportsAutoReview": True,
                "supportsPerTurnOverride": True,
                "hardBlockSupportedByProductPolicy": True,
                "observedPermissionBehavior": [
                    "read-only sandbox still allowed a read-only shell command such as pwd.",
                    "read-only sandbox blocked a file creation command before filesystem mutation.",
                    "workspace-write plus on-request/user did not call approval_handler before creating a workspace file.",
                ],
            },
            "models": {
                "supportsModelList": True,
                "supportsThreadModelOverride": True,
                "supportsTurnModelOverride": True,
                "supportsModelProviderOnThread": True,
                "supportsReasoningEffort": True,
                "supportsReasoningSummary": True,
            },
            "tools": {
                "builtinTools": ["shell", "file_edit", "mcp", "dynamic_tool_protocol"],
                "supportsPythonToolRegistration": False,
                "supportsMcp": True,
                "supportsDynamicTools": True,
                "supportsToolApproval": True,
                "toolRegistrationStrategy": "mcp_or_runtime_config",
                "toolCallEventGranularity": "arguments_and_result_when_runtime_emits_them",
            },
            "sessions": {
                "supportsResume": True,
                "supportsFork": True,
                "supportsCompact": True,
                "supportsPersistentThreads": True,
            },
            "events": CODEX_NOTIFICATION_EVENT_MAP,
        },
        "permissionMapping": CODEX_PRODUCT_PERMISSION_MAPPING,
        "notes": [
            "Codex is a runtime adapter, not a Python Tool host like nanobot.",
            "Codex sandbox approvals are not a replacement for per-action product approval.",
            "First-party PC repair actions should still go through product tools and the Rust Execution Gateway.",
        ],
    }


class RecordingApprovalHandler:
    def __init__(self, decision: str) -> None:
        self.decision = decision
        self.requests: list[dict[str, Any]] = []

    def __call__(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        record = {
            "method": method,
            "params": params or {},
            "decision": self.decision,
        }
        self.requests.append(record)
        if method in APPROVAL_REQUEST_METHODS:
            return {"decision": self.decision}
        return {}


def _product_permission_mapping(args: argparse.Namespace) -> dict[str, Any]:
    mapping = dict(CODEX_PRODUCT_PERMISSION_MAPPING[args.permission_mode])
    if args.sandbox is not None:
        mapping["codexSandbox"] = args.sandbox
        mapping["codexThreadSandbox"] = _thread_sandbox_value(args.sandbox)
        mapping["codexSandboxPolicy"] = _sandbox_policy_payload(args.sandbox)
    if args.approval_mode is not None:
        if args.approval_mode == "auto_review":
            mapping["codexApprovalPolicy"] = "on-request"
            mapping["codexApprovalsReviewer"] = "auto_review"
            mapping["sdkHighLevelApprovalMode"] = "auto_review"
        else:
            mapping["codexApprovalPolicy"] = "never"
            mapping["codexApprovalsReviewer"] = None
            mapping["sdkHighLevelApprovalMode"] = "deny_all"
    return mapping


def _approval_payload(mapping: dict[str, Any]) -> dict[str, str | None]:
    return {
        "approvalPolicy": mapping["codexApprovalPolicy"],
        "approvalsReviewer": mapping["codexApprovalsReviewer"],
    }


def _thread_sandbox_value(sandbox: str) -> str:
    if sandbox == "full-access":
        return "danger-full-access"
    return sandbox


def _sandbox_policy_payload(sandbox: str) -> dict[str, Any]:
    if sandbox == "read-only":
        return {"type": "readOnly"}
    if sandbox == "workspace-write":
        return {"type": "workspaceWrite"}
    if sandbox == "full-access":
        return {"type": "dangerFullAccess"}
    raise ValueError(f"unsupported sandbox: {sandbox}")


def run_smoke(args: argparse.Namespace) -> dict[str, Any]:
    from openai_codex import ApprovalMode, Sandbox
    from openai_codex.client import CodexClient, CodexConfig

    approval_handler = RecordingApprovalHandler(args.approval_decision)
    cwd = str(Path(args.cwd).resolve())
    mapping = _product_permission_mapping(args)
    config = CodexConfig(
        cwd=cwd,
        config_overrides=tuple(args.config_override),
    )

    events: list[dict[str, Any]] = []
    with CodexClient(config=config, approval_handler=approval_handler) as client:
        initialized = client.initialize()
        thread_payload = {
            **_approval_payload(mapping),
            "cwd": cwd,
            "ephemeral": True,
            "sandbox": mapping["codexThreadSandbox"],
            "model": args.model,
        }
        thread = client.thread_start(thread_payload)
        turn_payload = {
            **_approval_payload(mapping),
            "sandboxPolicy": mapping["codexSandboxPolicy"],
            "model": args.model,
        }
        if args.reasoning_effort is not None:
            turn_payload["reasoningEffort"] = args.reasoning_effort
        if args.reasoning_summary is not None:
            turn_payload["summary"] = args.reasoning_summary
        turn = client.turn_start(thread.thread.id, args.prompt, turn_payload)
        turn_id = turn.turn.id
        client.register_turn_notifications(turn_id)
        try:
            while True:
                notification = client.next_turn_notification(turn_id)
                payload = notification.payload
                payload_dump = (
                    payload.model_dump(by_alias=True, mode="json")
                    if hasattr(payload, "model_dump")
                    else str(payload)
                )
                events.append(
                    {
                        "method": notification.method,
                        "payload": payload_dump,
                    }
                )
                if notification.method == "turn/completed":
                    break
        finally:
            client.unregister_turn_notifications(turn_id)

    return {
        "initialized": initialized.model_dump(mode="json"),
        "productPermissionMode": args.permission_mode,
        "codexPermissionMapping": mapping,
        "sdkApprovalModeEnum": enum_values(ApprovalMode),
        "sdkSandboxEnum": enum_values(Sandbox),
        "approvalRequests": approval_handler.requests,
        "events": events,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe openai-codex SDK capabilities for PC Repair Agent adapter design.",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Start the local Codex runtime and run one ephemeral turn.",
    )
    parser.add_argument(
        "--cwd",
        default=str(Path.cwd()),
        help="Working directory passed to Codex when --smoke is used.",
    )
    parser.add_argument(
        "--prompt",
        default="请用一句话说明当前项目是什么，不要修改文件，也不要执行命令。",
        help="Prompt for the optional smoke turn.",
    )
    parser.add_argument(
        "--approval-mode",
        choices=["deny_all", "auto_review"],
        default=None,
        help="Optional legacy Codex SDK approval mode override used by the smoke turn.",
    )
    parser.add_argument(
        "--permission-mode",
        choices=PRODUCT_PERMISSION_MODES,
        default="readonly",
        help="PC Repair Agent product permission mode to map into Codex settings.",
    )
    parser.add_argument(
        "--approval-decision",
        choices=["accept", "deny"],
        default="deny",
        help="Decision returned by the low-level approval handler during smoke runs.",
    )
    parser.add_argument(
        "--sandbox",
        choices=["read-only", "workspace-write", "full-access"],
        default=None,
        help="Optional Codex sandbox override used by the smoke turn.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Optional Codex model override for the smoke turn.",
    )
    parser.add_argument(
        "--reasoning-effort",
        choices=["none", "minimal", "low", "medium", "high", "xhigh"],
        default=None,
        help="Optional Codex reasoning effort override for the smoke turn.",
    )
    parser.add_argument(
        "--reasoning-summary",
        choices=["auto", "concise", "detailed", "none"],
        default=None,
        help="Optional Codex reasoning summary override for the smoke turn.",
    )
    parser.add_argument(
        "--config-override",
        action="append",
        default=[],
        help="Codex --config override, for example key=value. Can be repeated.",
    )
    return parser.parse_args()


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = parse_args()

    result = {
        "probe": inspect_sdk(),
        "adapterDescriptor": adapter_descriptor(),
        "smoke": None,
    }
    if args.smoke:
        result["smoke"] = run_smoke(args)

    print_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
