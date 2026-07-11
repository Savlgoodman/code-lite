from __future__ import annotations

import base64
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.services.file_reader import (
    FileReadError,
    MAX_TEXT_BYTES,
    read_workspace_file,
)


class FileReaderTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_reads_text_file(self) -> None:
        # 写字节以精确控制换行（避免 Windows 文本模式改写 \n）。
        (self.workspace / "note.txt").write_bytes(b"hello\nworld")
        result = read_workspace_file(self.workspace, "note.txt")
        self.assertEqual(result.kind, "text")
        self.assertEqual(result.encoding, "utf-8")
        self.assertEqual(result.content, "hello\nworld")
        self.assertFalse(result.truncated)

    def test_reads_absolute_path_within_workspace(self) -> None:
        target = self.workspace / "sub" / "code.py"
        target.parent.mkdir(parents=True)
        target.write_text("print('hi')\n", encoding="utf-8")
        result = read_workspace_file(self.workspace, str(target))
        self.assertEqual(result.kind, "text")
        self.assertIn("print", result.content)

    def test_reads_image_as_base64(self) -> None:
        png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 16
        (self.workspace / "pic.png").write_bytes(png)
        result = read_workspace_file(self.workspace, "pic.png")
        self.assertEqual(result.kind, "image")
        self.assertEqual(result.encoding, "base64")
        self.assertEqual(base64.b64decode(result.content), png)
        self.assertTrue(result.mime_type.startswith("image/"))

    def test_svg_returned_as_text(self) -> None:
        (self.workspace / "icon.svg").write_text("<svg></svg>", encoding="utf-8")
        result = read_workspace_file(self.workspace, "icon.svg")
        self.assertEqual(result.kind, "text")
        self.assertEqual(result.mime_type, "image/svg+xml")

    def test_rejects_path_outside_workspace(self) -> None:
        outside = Path(self._tmp.name).parent / "outside.txt"
        with self.assertRaises(FileReadError) as ctx:
            read_workspace_file(self.workspace, str(outside))
        self.assertEqual(ctx.exception.code, "path_outside_workspace")

    def test_rejects_traversal(self) -> None:
        with self.assertRaises(FileReadError) as ctx:
            read_workspace_file(self.workspace, "../../etc/passwd")
        self.assertEqual(ctx.exception.code, "path_outside_workspace")

    def test_missing_file(self) -> None:
        with self.assertRaises(FileReadError) as ctx:
            read_workspace_file(self.workspace, "nope.txt")
        self.assertEqual(ctx.exception.code, "not_found")

    def test_missing_path(self) -> None:
        with self.assertRaises(FileReadError) as ctx:
            read_workspace_file(self.workspace, "  ")
        self.assertEqual(ctx.exception.code, "missing_path")

    def test_large_text_truncated(self) -> None:
        big = "a" * (MAX_TEXT_BYTES + 1000)
        (self.workspace / "big.txt").write_text(big, encoding="utf-8")
        result = read_workspace_file(self.workspace, "big.txt")
        self.assertTrue(result.truncated)
        self.assertLess(len(result.content), len(big) + 100)


if __name__ == "__main__":
    unittest.main()
