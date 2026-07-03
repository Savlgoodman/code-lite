from __future__ import annotations

import os
import subprocess
from typing import Any


CREATE_NO_WINDOW = 0x08000000


def hidden_subprocess_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {}
    return {"creationflags": CREATE_NO_WINDOW}


def run_hidden(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    kwargs.update(hidden_subprocess_kwargs())
    return subprocess.run(*args, **kwargs)
