from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.storage.diff_artifacts import DiffArtifactStore


class DiffArtifactStoreTest(unittest.TestCase):
    def test_save_and_load_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = DiffArtifactStore(Path(directory))
            saved = store.save_diff(
                "conv-1",
                {
                    "diffId": "call-edit-1-0",
                    "path": "README.md",
                    "changeType": "modify",
                    "added": 1,
                    "removed": 0,
                    "oldText": "# Demo\n",
                    "newText": "# Demo\nChanged.\n",
                },
            )

            loaded = store.load_diff("conv-1", "call-edit-1-0")

            self.assertEqual(saved["schemaVersion"], 1)
            self.assertEqual(loaded, saved)
            self.assertEqual(loaded["newText"], "# Demo\nChanged.\n")

    def test_rejects_unsafe_ids(self) -> None:
        store = DiffArtifactStore(Path("unused"))

        with self.assertRaises(ValueError):
            store.load_diff("../conv", "diff-1")
        with self.assertRaises(ValueError):
            store.load_diff("conv-1", "../diff")


class DiffArtifactRoutesTest(unittest.TestCase):
    def test_load_diff_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            config = resolve_runtime_config(
                workspace=workspace,
                data_dir_override=workspace,
                agent_adapter_override="router",
            )
            app = create_app(runtime_config=config, workspace=workspace)
            client = TestClient(app)
            conversation = client.post(
                "/api/conversations",
                json={"agentId": "codex", "title": "diff probe"},
            ).json()["session"]
            app.state.services.diff_artifact_store.save_diff(
                conversation["id"],
                {
                    "diffId": "call-edit-1-0",
                    "path": "README.md",
                    "changeType": "create",
                    "added": 1,
                    "removed": 0,
                    "oldText": None,
                    "newText": "# Demo\n",
                },
            )

            response = client.get(
                f"/api/conversations/{conversation['id']}/diffs/call-edit-1-0",
            )
            missing = client.get(
                f"/api/conversations/{conversation['id']}/diffs/missing",
            )
            invalid = client.get(
                f"/api/conversations/{conversation['id']}/diffs/bad:diff",
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["diff"]["newText"], "# Demo\n")
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(invalid.status_code, 400)


if __name__ == "__main__":
    unittest.main()
