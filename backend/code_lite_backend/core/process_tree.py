from __future__ import annotations

import asyncio
import os
import signal
import sys
from dataclasses import asdict, dataclass
from typing import Any

from code_lite_backend.core.process_utils import hidden_subprocess_kwargs


@dataclass(frozen=True)
class ProcessTreeKillResult:
    """进程树终止结果。"""

    pid: int
    attempted: bool
    method: str
    returncode: int | None = None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def ok(self) -> bool:
        if not self.attempted:
            return True
        if self.returncode == 0:
            return True
        message = f"{self.stdout}\n{self.stderr}\n{self.error or ''}".lower()
        return "not found" in message or "no running instance" in message or "找不到" in message


async def terminate_process_tree(pid: int | None, *, timeout: float = 8.0) -> ProcessTreeKillResult:
    """终止 pid 对应的进程树。

    只能传入 code-lite 自己 spawn 后记录的 root pid；调用方不应按进程名全局清理。
    """

    if not pid or pid <= 0:
        return ProcessTreeKillResult(pid=0, attempted=False, method="none", error="missing pid")
    if os.name == "nt":
        return await _terminate_windows_process_tree(pid, timeout=timeout)
    return await _terminate_posix_process_tree(pid)


async def _terminate_windows_process_tree(pid: int, *, timeout: float) -> ProcessTreeKillResult:
    kwargs = hidden_subprocess_kwargs()
    try:
        process = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout)
        return ProcessTreeKillResult(
            pid=pid,
            attempted=True,
            method="taskkill",
            returncode=process.returncode,
            stdout=stdout_bytes.decode("utf-8", errors="replace").strip(),
            stderr=stderr_bytes.decode("utf-8", errors="replace").strip(),
        )
    except asyncio.TimeoutError:
        return ProcessTreeKillResult(
            pid=pid,
            attempted=True,
            method="taskkill",
            error=f"taskkill timeout after {timeout:.1f}s",
        )
    except OSError as exc:
        return ProcessTreeKillResult(
            pid=pid,
            attempted=True,
            method="taskkill",
            error=str(exc),
        )


async def _terminate_posix_process_tree(pid: int) -> ProcessTreeKillResult:
    method = "process-group" if sys.platform != "win32" else "direct"
    try:
        if sys.platform != "win32":
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                return ProcessTreeKillResult(pid=pid, attempted=True, method=method, returncode=0)
            except PermissionError as exc:
                return ProcessTreeKillResult(pid=pid, attempted=True, method=method, error=str(exc))
            await asyncio.sleep(0.5)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return ProcessTreeKillResult(pid=pid, attempted=True, method=method, returncode=0)
    except OSError as exc:
        return ProcessTreeKillResult(pid=pid, attempted=True, method=method, error=str(exc))
    return ProcessTreeKillResult(pid=pid, attempted=True, method=method, returncode=0)
