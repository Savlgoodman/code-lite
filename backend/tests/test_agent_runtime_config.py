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

    def test_acp_package_root_can_be_overridden(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self.make_store(root)
            package_root = root / "custom-acp"

            settings = store.update_acp_package_root(str(package_root))

            self.assertEqual(settings["packageRoot"], str(package_root.resolve()))
            self.assertEqual(store.runtime_root(), package_root.resolve())
            self.assertTrue(store.managed_package_dir("codex").is_relative_to(package_root.resolve()))

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


if __name__ == "__main__":
    unittest.main()
