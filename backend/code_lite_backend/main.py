from __future__ import annotations

import argparse
import asyncio
import atexit
import logging
import signal
import sys
from pathlib import Path

import uvicorn

from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.core.encoding import configure_stdio_encoding
from code_lite_backend.core.paths import DEFAULT_WORKSPACE

logger = logging.getLogger(__name__)

_LOG_FILE_HANDLE = None
_RUNTIME_MANAGER = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Code Lite backend")
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
        help="Agent adapter to use. Defaults to CODE_LITE_ADAPTER or router.",
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


def _setup_shutdown_hooks(app_instance) -> None:
    """设置关闭钩子，确保 ACP 常驻子进程在 backend 终止前被正确清理。

    Windows 下关闭 cmd 标签页时，uvicorn 可能来不及执行 FastAPI shutdown event，
    导致 ACP 子进程残留。这里通过 atexit 和 Windows 信号处理兜底。
    """
    global _RUNTIME_MANAGER
    _RUNTIME_MANAGER = getattr(app_instance.state, "runtime_manager", None)

    def _cleanup():
        if _RUNTIME_MANAGER is None:
            return
        try:
            loop = None
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
            if loop and loop.is_running():
                # uvicorn 还在运行，让 FastAPI shutdown event 处理
                return
            # uvicorn 已停止，创建新 loop 执行 async cleanup
            cleanup_loop = asyncio.new_event_loop()
            cleanup_loop.run_until_complete(_RUNTIME_MANAGER.close_all())
            cleanup_loop.close()
        except Exception:
            pass

    atexit.register(_cleanup)

    if sys.platform == "win32":
        def _win_signal_handler(signum, frame):
            logger.info("Received signal %s, cleaning up ACP connections...", signum)
            _cleanup()
            sys.exit(0)

        signal.signal(signal.SIGINT, _win_signal_handler)
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, _win_signal_handler)


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
    _setup_shutdown_hooks(app)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
