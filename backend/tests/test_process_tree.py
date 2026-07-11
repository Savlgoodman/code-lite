from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.core.process_tree import terminate_process_tree


class FakeAsyncProcess:
    def __init__(self) -> None:
        self.returncode = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"ok", b""


class ProcessTreeTest(unittest.IsolatedAsyncioTestCase):
    async def test_missing_pid_is_not_attempted(self) -> None:
        result = await terminate_process_tree(None)

        self.assertFalse(result.attempted)
        self.assertEqual(result.method, "none")

    async def test_windows_uses_taskkill_process_tree(self) -> None:
        calls: list[tuple[object, ...]] = []

        async def fake_create_subprocess_exec(*args: object, **_: object) -> FakeAsyncProcess:
            calls.append(args)
            return FakeAsyncProcess()

        with patch("code_lite_backend.core.process_tree.os.name", "nt"), patch(
            "code_lite_backend.core.process_tree.asyncio.create_subprocess_exec",
            side_effect=fake_create_subprocess_exec,
        ):
            result = await terminate_process_tree(1234)

        self.assertTrue(result.ok)
        self.assertEqual(calls[0][:5], ("taskkill", "/PID", "1234", "/T", "/F"))


if __name__ == "__main__":
    unittest.main()
