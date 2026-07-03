from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from pc_agent_backend.app import create_app
from pc_agent_backend.core.config import resolve_runtime_config
from pc_agent_backend.core.encoding import configure_stdio_encoding
from pc_agent_backend.core.paths import DEFAULT_WORKSPACE


_LOG_FILE_HANDLE = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PC Repair Agent backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--config", default=None)
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--log-file", default=None)
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument(
        "--agent-adapter",
        default=None,
        choices=["router", "nanobot", "codex", "claude_code"],
        help="Agent adapter to use. Defaults to REPAIR_AGENT_ADAPTER or router.",
    )
    return parser.parse_args()


def configure_log_file(log_file: str | None) -> None:
    if not log_file:
        return

    path = Path(log_file).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    global _LOG_FILE_HANDLE
    _LOG_FILE_HANDLE = path.open("a", encoding="utf-8", buffering=1)
    sys.stdout = _LOG_FILE_HANDLE
    sys.stderr = _LOG_FILE_HANDLE


def main() -> None:
    configure_stdio_encoding()
    args = parse_args()
    configure_log_file(args.log_file)
    workspace = Path(args.workspace).resolve()
    runtime_config = resolve_runtime_config(
        workspace=workspace,
        config_override=Path(args.config) if args.config else None,
        data_dir_override=Path(args.data_dir) if args.data_dir else None,
        agent_adapter_override=args.agent_adapter,
    )
    app = create_app(runtime_config=runtime_config, workspace=workspace)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
