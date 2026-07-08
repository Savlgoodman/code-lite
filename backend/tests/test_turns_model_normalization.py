from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.api.routes.turns import _normalize_codex_runtime_model


class TurnsModelNormalizationTest(unittest.TestCase):
    def test_codex_runtime_model_keeps_single_effort_suffix(self) -> None:
        cases = {
            None: None,
            "": None,
            "gpt-5.5": "gpt-5.5",
            "gpt-5.5[xhigh]": "gpt-5.5[xhigh]",
            "gpt-5.5[xhigh][xhigh]": "gpt-5.5[xhigh]",
            "gpt-5.5[xhigh][xhigh][xhigh][high]": "gpt-5.5[high]",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(_normalize_codex_runtime_model(raw), expected)


if __name__ == "__main__":
    unittest.main()
