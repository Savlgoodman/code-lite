from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.api.routes.settings import _collect_about_info
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


if __name__ == "__main__":
    unittest.main()
