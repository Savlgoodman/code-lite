from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.services.agent_runtime_config import CODEX_ACP_PACKAGE, AgentRuntimeConfigStore


class AgentRuntimeConfigStoreTest(unittest.TestCase):
    def make_store(self, root: Path) -> AgentRuntimeConfigStore:
        config = resolve_runtime_config(
            workspace=root,
            data_dir_override=root / "data",
            agent_adapter_override="router",
        )
        return AgentRuntimeConfigStore(config)

    def test_acp_package_dir_can_be_overridden_per_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self.make_store(root)
            package_dir = root / "custom-codex-acp"

            settings = store.update_acp_package_dir("codex", str(package_dir))

            codex_package = next(item for item in settings["packages"] if item["runtimeId"] == "codex")
            claude_package = next(item for item in settings["packages"] if item["runtimeId"] == "claude_code")
            self.assertEqual(codex_package["packageDir"], str(package_dir.resolve()))
            self.assertNotEqual(claude_package["packageDir"], str(package_dir.resolve()))
            self.assertEqual(store.managed_package_dir("codex"), package_dir.resolve())

    def test_acp_package_settings_reports_empty_root_and_versions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            AgentRuntimeConfigStore,
            "_detect_command",
            return_value={"ok": False, "version": None},
        ):
            store = self.make_store(Path(temp_dir))

            settings = store.acp_package_settings()

            self.assertTrue(settings["packageRootIsEmpty"])
            self.assertEqual([item["runtimeId"] for item in settings["packages"]], ["codex", "claude_code"])
            self.assertEqual([item["runtimeId"] for item in settings["runtimeVersions"]], ["codex", "claude_code"])

    def test_managed_command_is_rewritten_for_current_package_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self.make_store(root)
            package_json = store.managed_package_dir("codex") / "node_modules" / CODEX_ACP_PACKAGE / "package.json"
            package_json.parent.mkdir(parents=True)
            package_json.write_text('{"version":"1.1.0"}', encoding="utf-8")
            config = store.load()
            config["agentRuntimes"]["codex"]["distribution"] = "managed-npm"
            config["agentRuntimes"]["codex"]["command"] = [
                str(store.runtime_root() / "codex-acp" / "1.1.0" / "node_modules" / ".bin" / "codex-acp.cmd")
            ]
            store.save(config)

            normalized = store.load()

            self.assertEqual(normalized["agentRuntimes"]["codex"]["command"], store.managed_codex_command())

    def test_codex_does_not_fallback_to_npx_when_managed_package_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = self.make_store(Path(temp_dir))

            settings = store.list_settings()
            codex = next(item for item in settings["runtimes"] if item["id"] == "codex")

            self.assertFalse(codex["detected"]["ok"])
            self.assertEqual(codex["detected"]["source"], "managed-npm")
            self.assertNotIn("npx", " ".join(codex["detected"]["command"]).lower())
            self.assertIn("托管 Codex ACP 包", codex["detected"]["detail"])

    def test_update_install_requests_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            AgentRuntimeConfigStore,
            "_detect_command",
            return_value={"ok": False, "version": None},
        ), patch.object(
            AgentRuntimeConfigStore,
            "_latest_package_version",
            return_value="1.2.3",
        ):
            store = self.make_store(Path(temp_dir))
            with patch.object(store, "install_runtime") as install_runtime:
                store.install_acp_packages(update=True, runtime_id="codex")

            install_runtime.assert_called_once_with("codex", package_version="latest", replace=True)

    def test_replace_install_cleans_managed_package_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = self.make_store(Path(temp_dir))
            package_dir = store.managed_package_dir("codex")
            stale_file = package_dir / "stale.txt"
            stale_file.parent.mkdir(parents=True)
            stale_file.write_text("old", encoding="utf-8")

            store._prepare_package_dir_for_install(package_dir, replace=True)

            self.assertFalse(package_dir.exists())


if __name__ == "__main__":
    unittest.main()
