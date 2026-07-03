from __future__ import annotations

from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PACKAGE_ROOT.parent
REPO_ROOT = BACKEND_ROOT.parent
DEFAULT_WORKSPACE = REPO_ROOT
