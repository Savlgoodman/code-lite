"""会话工作区内的受控文件读取（供聊天正文文件引用查看）。

安全边界：
1. 路径必须落在会话 workspace 之内（规范化后前缀校验，防目录穿越与符号链接逃逸）。
2. 大小上限：文本 1 MiB、图片 5 MiB，超出返回 truncated 或拒绝。
3. 文本按 UTF-8 读取，图片按 base64 返回；其它二进制拒绝。
只读，不涉及写入或目录遍历。
"""
from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path

MAX_TEXT_BYTES = 1 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_TEXT_TRUNCATE_TAIL = "\n\n... (文件过大，已截断)"


class FileReadError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class FileReadResult:
    path: str
    kind: str  # "text" | "image"
    mime_type: str
    encoding: str  # "utf-8" | "base64"
    content: str
    truncated: bool
    size_bytes: int


def _resolve_within(workspace: Path, raw_path: str) -> Path:
    """把 raw_path 解析为绝对路径并校验落在 workspace 内，否则抛 FileReadError。"""
    try:
        workspace_resolved = workspace.expanduser().resolve()
    except OSError as exc:  # pragma: no cover - workspace 通常存在
        raise FileReadError("invalid_workspace", str(exc)) from exc

    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = workspace_resolved / candidate
    try:
        # strict=False 允许对不存在路径规范化，随后再判存在性。
        resolved = candidate.resolve()
    except OSError as exc:
        raise FileReadError("invalid_path", str(exc)) from exc

    # 前缀校验（符号链接已在 resolve 时展开，可防逃逸）。
    if resolved != workspace_resolved and workspace_resolved not in resolved.parents:
        raise FileReadError("path_outside_workspace", str(resolved))
    return resolved


def read_workspace_file(workspace: Path, raw_path: str) -> FileReadResult:
    if not raw_path or not raw_path.strip():
        raise FileReadError("missing_path")

    resolved = _resolve_within(workspace, raw_path.strip())
    if not resolved.exists():
        raise FileReadError("not_found", str(resolved))
    if not resolved.is_file():
        raise FileReadError("not_a_file", str(resolved))

    size_bytes = resolved.stat().st_size
    ext = resolved.suffix.lower()
    mime_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"

    if ext in _IMAGE_EXTS:
        if size_bytes > MAX_IMAGE_BYTES:
            raise FileReadError("too_large", f"{size_bytes} bytes")
        data = resolved.read_bytes()
        if ext == ".svg":
            # SVG 是文本，按文本返回避免内联执行脚本的风险。
            return FileReadResult(
                path=str(resolved),
                kind="text",
                mime_type="image/svg+xml",
                encoding="utf-8",
                content=data.decode("utf-8", errors="replace"),
                truncated=False,
                size_bytes=size_bytes,
            )
        return FileReadResult(
            path=str(resolved),
            kind="image",
            mime_type=mime_type if mime_type.startswith("image/") else "image/png",
            encoding="base64",
            content=base64.b64encode(data).decode("ascii"),
            truncated=False,
            size_bytes=size_bytes,
        )

    # 文本（含代码 / markdown）：读取上限内的字节，按 UTF-8 解码。
    truncated = size_bytes > MAX_TEXT_BYTES
    with resolved.open("rb") as handle:
        raw = handle.read(MAX_TEXT_BYTES)
    text = raw.decode("utf-8", errors="replace")
    if truncated:
        text += _TEXT_TRUNCATE_TAIL
    return FileReadResult(
        path=str(resolved),
        kind="text",
        mime_type=mime_type,
        encoding="utf-8",
        content=text,
        truncated=truncated,
        size_bytes=size_bytes,
    )
