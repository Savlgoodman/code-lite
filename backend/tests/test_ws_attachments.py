from __future__ import annotations

import asyncio
import base64
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.api.routes.ws import (
    _handle_attachment_get,
    _handle_attachment_upload,
)
from code_lite_backend.app import create_app
from code_lite_backend.core.config import resolve_runtime_config


PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000100ffff03000006000557bfab7d00000000"
    "49454e44ae426082"
)


class _FakeWs:
    """收集 _send 写出的信封，供断言。"""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


class WsAttachmentHandlersTest(unittest.TestCase):
    def test_upload_then_get_roundtrip(self) -> None:
        async def run() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                workspace = Path(temp_dir)
                config = resolve_runtime_config(
                    workspace=workspace,
                    data_dir_override=workspace,
                    agent_adapter_override="router",
                )
                app = create_app(runtime_config=config, workspace=workspace)
                services = app.state.services

                # 需要真实会话，upload 才不会 conversation_not_found
                from code_lite_backend.api.routes.conversations import create_conversation_record

                created = create_conversation_record(services, {"agentId": "codex", "title": "ws probe"})
                conversation_id = created["session"]["id"]

                # ── upload ──
                ws = _FakeWs()
                await _handle_attachment_upload(ws, services, "req-1", {
                    "conversationId": conversation_id,
                    "turnId": "turn-ws-probe",
                    "fileName": "tiny.png",
                    "mimeType": "image/png",
                    "data": base64.b64encode(PNG_1X1).decode("ascii"),
                    "width": 1,
                    "height": 1,
                    "wasCompressed": False,
                })
                self.assertEqual(len(ws.sent), 1)
                envelope = ws.sent[0]
                self.assertEqual(envelope["kind"], "result", envelope)
                attachment = envelope["payload"]["attachment"]
                self.assertEqual(attachment["mimeType"], "image/png")
                self.assertEqual(attachment["turnId"], "turn-ws-probe")
                attachment_id = attachment["id"]

                # ── get ──
                ws2 = _FakeWs()
                await _handle_attachment_get(ws2, services, "req-2", {
                    "conversationId": conversation_id,
                    "attachmentId": attachment_id,
                })
                self.assertEqual(len(ws2.sent), 1)
                envelope2 = ws2.sent[0]
                self.assertEqual(envelope2["kind"], "result", envelope2)
                payload = envelope2["payload"]
                self.assertEqual(payload["mimeType"], "image/png")
                self.assertEqual(base64.b64decode(payload["data"]), PNG_1X1)

        asyncio.run(run())

    def test_upload_rejects_unknown_conversation(self) -> None:
        async def run() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                workspace = Path(temp_dir)
                config = resolve_runtime_config(
                    workspace=workspace,
                    data_dir_override=workspace,
                    agent_adapter_override="router",
                )
                app = create_app(runtime_config=config, workspace=workspace)
                services = app.state.services

                ws = _FakeWs()
                await _handle_attachment_upload(ws, services, "req-x", {
                    "conversationId": "does-not-exist",
                    "turnId": "turn-x",
                    "fileName": "tiny.png",
                    "mimeType": "image/png",
                    "data": base64.b64encode(PNG_1X1).decode("ascii"),
                })
                self.assertEqual(ws.sent[0]["kind"], "error")
                self.assertEqual(ws.sent[0]["payload"]["code"], "conversation_not_found")

        asyncio.run(run())

    def test_get_missing_attachment_errors(self) -> None:
        async def run() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                workspace = Path(temp_dir)
                config = resolve_runtime_config(
                    workspace=workspace,
                    data_dir_override=workspace,
                    agent_adapter_override="router",
                )
                app = create_app(runtime_config=config, workspace=workspace)
                services = app.state.services

                ws = _FakeWs()
                await _handle_attachment_get(ws, services, "req-y", {
                    "conversationId": "conv",
                    "attachmentId": "att_missing",
                })
                self.assertEqual(ws.sent[0]["kind"], "error")
                self.assertEqual(ws.sent[0]["payload"]["code"], "not_found")

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
