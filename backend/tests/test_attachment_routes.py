from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000100ffff03000006000557bfab7d00000000"
    "49454e44ae426082"
)


class AttachmentRoutesTest(unittest.TestCase):
    def test_upload_and_read_turn_attachment(self) -> None:
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
                json={"agentId": "codex", "title": "upload probe"},
            ).json()["session"]
            upload = client.post(
                f"/api/conversations/{conversation['id']}/turns/turn-probe/attachments",
                files=[("files", ("tiny.png", PNG_1X1, "image/png"))],
                data={"widths": "1", "heights": "1", "wasCompressed": "false"},
            )

            self.assertEqual(upload.status_code, 200)
            attachments = upload.json()["attachments"]
            self.assertEqual(len(attachments), 1)
            self.assertEqual(attachments[0]["mimeType"], "image/png")
            self.assertEqual(attachments[0]["turnId"], "turn-probe")

            image = client.get(
                f"/api/conversations/{conversation['id']}/attachments/{attachments[0]['id']}/image",
            )
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.headers.get("content-type"), "image/png")
            self.assertEqual(image.content, PNG_1X1)


if __name__ == "__main__":
    unittest.main()
