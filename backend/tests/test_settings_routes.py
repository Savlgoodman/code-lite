from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.api.routes.settings import (
    _collect_about_info,
    _disconnect_acp_runtime_before_settings_change,
    _disconnect_acp_runtimes_before_settings_change,
)
from code_lite_backend.core.config import resolve_runtime_config


class SettingsRoutesTest(unittest.TestCase):
    def test_about_info_lists_all_data_subdirectories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            config = resolve_runtime_config(
                workspace=root,
                data_dir_override=data_dir,
                agent_adapter_override="router",
            )
            extra_dir = data_dir / "runtime-state"
            extra_dir.mkdir(parents=True)
            (extra_dir / "state.bin").write_bytes(b"runtime")
            services = SimpleNamespace(
                runtime_config=config,
                workspace=root,
            )

            about = _collect_about_info(services)

            labels = {item["label"] for item in about["dataUsage"]}
            self.assertIn("配置", labels)
            self.assertIn("附件", labels)
            self.assertIn("runtime-state", labels)

    def test_about_info_uses_injected_build_versions(self) -> None:
        display_version = "0.2.1 build-2026-07-13-23-49"
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "CODE_LITE_APP_VERSION": display_version,
                "CODE_LITE_BACKEND_VERSION": display_version,
            },
        ):
            root = Path(temp_dir)
            services = SimpleNamespace(
                runtime_config=resolve_runtime_config(
                    workspace=root,
                    data_dir_override=root / "data",
                    agent_adapter_override="router",
                ),
                workspace=root,
            )

            about = _collect_about_info(services)

            self.assertEqual(about["appVersion"], display_version)
            self.assertEqual(about["backendVersion"], display_version)


class FakeRuntimeManager:
    def __init__(self, closed: bool) -> None:
        self.closed = closed
        self.calls: list[tuple[str, str]] = []

    async def disconnect_runtime(self, runtime_id: str, *, reason: str) -> dict[str, Any]:
        self.calls.append((runtime_id, reason))
        return {
            "closed": self.closed,
            "runtime": runtime_id,
            "reason": reason,
            "summary": {
                "attemptedConnections": 1,
                "closedConnections": 1 if self.closed else 0,
                "failedConnections": 0 if self.closed else 1,
            },
            "connections": [],
            "failed": [] if self.closed else [{"runtime": runtime_id, "closed": False, "pid": 1234}],
        }


class SettingsRuntimeDisconnectTest(unittest.IsolatedAsyncioTestCase):
    async def test_settings_disconnect_helper_allows_successful_disconnect(self) -> None:
        runtime_manager = FakeRuntimeManager(closed=True)
        services = SimpleNamespace(runtime_manager=runtime_manager)

        response = await _disconnect_acp_runtime_before_settings_change(
            services,
            "claude_code",
            reason="runtime_config_update",
        )

        self.assertIsNone(response)
        self.assertEqual(runtime_manager.calls, [("claude_code", "runtime_config_update")])

    async def test_settings_disconnect_helper_blocks_failed_disconnect(self) -> None:
        runtime_manager = FakeRuntimeManager(closed=False)
        services = SimpleNamespace(runtime_manager=runtime_manager)

        response = await _disconnect_acp_runtime_before_settings_change(
            services,
            "claude_code",
            reason="runtime_config_update",
        )

        self.assertIsNotNone(response)
        self.assertEqual(response.status_code, 409)

    async def test_settings_disconnect_many_stops_on_failed_runtime(self) -> None:
        runtime_manager = FakeRuntimeManager(closed=False)
        services = SimpleNamespace(runtime_manager=runtime_manager)

        response = await _disconnect_acp_runtimes_before_settings_change(
            services,
            ["codex", "claude_code"],
            reason="acp_package_install",
        )

        self.assertIsNotNone(response)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            runtime_manager.calls,
            [("codex", "acp_package_install"), ("claude_code", "acp_package_install")],
        )


if __name__ == "__main__":
    unittest.main()
