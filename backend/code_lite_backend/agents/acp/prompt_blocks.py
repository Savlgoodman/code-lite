from __future__ import annotations

import base64
from typing import Any

import acp

from code_lite_backend.schemas.agent import AgentRunRequest, ImageInputBlock, TextInputBlock
from code_lite_backend.storage.attachments import AttachmentStore


def build_acp_prompt_blocks(
    request: AgentRunRequest,
    attachment_store: AttachmentStore,
) -> list[Any]:
    blocks: list[Any] = []
    source_blocks = request.input_blocks or [TextInputBlock(type="text", text=request.prompt)]
    for block in source_blocks:
        if isinstance(block, TextInputBlock):
            text = block.text.strip()
            if text:
                blocks.append(acp.text_block(text))
            continue
        if isinstance(block, ImageInputBlock):
            stored = attachment_store.load_image(request.conversation_id, block.source.attachment_id)
            if stored is None:
                raise ValueError(f"图片附件不存在：{block.source.attachment_id}")
            mime_type = str(stored.metadata.get("mimeType") or block.mime_type)
            data = base64.b64encode(stored.image_path.read_bytes()).decode("ascii")
            blocks.append(acp.image_block(data, mime_type))
            continue
    if not blocks:
        raise ValueError("输入不能为空。")
    return blocks
