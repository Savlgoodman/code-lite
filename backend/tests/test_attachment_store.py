from __future__ import annotations

import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.agents.acp.prompt_blocks import build_acp_prompt_blocks
from code_lite_backend.schemas.agent import AgentRunRequest, ImageAttachmentSource, ImageInputBlock, TextInputBlock
from code_lite_backend.storage.attachments import AttachmentStore


class AttachmentStoreTest(unittest.TestCase):
    def test_save_image_and_build_acp_prompt_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = AttachmentStore(Path(temp_dir))
            metadata = store.save_image(
                conversation_id="conv-test",
                turn_id="turn-test",
                filename="screen.png",
                mime_type="image/png",
                stream=BytesIO(b"png-bytes"),
                width=12,
                height=8,
                was_compressed=False,
            )

            request = AgentRunRequest(
                conversation_id="conv-test",
                turn_id="turn-test",
                prompt="看这张图",
                workspace=Path(temp_dir),
                input_blocks=[
                    TextInputBlock(type="text", text="看这张图"),
                    ImageInputBlock(
                        type="image",
                        mime_type="image/png",
                        source=ImageAttachmentSource(kind="attachment", attachment_id=str(metadata["id"])),
                    ),
                ],
            )

            with patch("code_lite_backend.agents.acp.prompt_blocks.acp.text_block", side_effect=lambda text: ("text", text)), \
                    patch("code_lite_backend.agents.acp.prompt_blocks.acp.image_block", side_effect=lambda data, mime: ("image", data, mime)):
                blocks = build_acp_prompt_blocks(request, store)

            self.assertEqual(blocks[0], ("text", "看这张图"))
            self.assertEqual(blocks[1], ("image", "cG5nLWJ5dGVz", "image/png"))

    def test_delete_turn_removes_only_matching_attachments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = AttachmentStore(Path(temp_dir))
            first = store.save_image(
                conversation_id="conv-test",
                turn_id="turn-a",
                filename="a.png",
                mime_type="image/png",
                stream=BytesIO(b"a"),
            )
            second = store.save_image(
                conversation_id="conv-test",
                turn_id="turn-b",
                filename="b.png",
                mime_type="image/png",
                stream=BytesIO(b"b"),
            )

            self.assertEqual(store.delete_turn("conv-test", "turn-a"), 1)
            self.assertIsNone(store.load_metadata("conv-test", str(first["id"])))
            self.assertIsNotNone(store.load_metadata("conv-test", str(second["id"])))


if __name__ == "__main__":
    unittest.main()
