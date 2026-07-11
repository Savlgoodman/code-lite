from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.core.config import (
    ACP_CONNECTION_MODE_ENV_NAME,
    ACP_CONNECTION_MODE_MULTI_SESSION,
    ACP_CONNECTION_MODE_PER_CONVERSATION,
    resolve_runtime_config,
)


class RuntimeConfigTest(unittest.TestCase):
    def test_acp_connection_mode_defaults_to_multi_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict("os.environ", {}, clear=True):
            workspace = Path(temp_dir)

            config = resolve_runtime_config(
                workspace=workspace,
                data_dir_override=workspace,
                agent_adapter_override="router",
            )

            self.assertEqual(config.acp_connection_mode, ACP_CONNECTION_MODE_MULTI_SESSION)

    def test_acp_connection_mode_allows_per_conversation_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            "os.environ",
            {ACP_CONNECTION_MODE_ENV_NAME: ACP_CONNECTION_MODE_PER_CONVERSATION},
            clear=True,
        ):
            workspace = Path(temp_dir)

            config = resolve_runtime_config(
                workspace=workspace,
                data_dir_override=workspace,
                agent_adapter_override="router",
            )

            self.assertEqual(config.acp_connection_mode, ACP_CONNECTION_MODE_PER_CONVERSATION)

    def test_invalid_acp_connection_mode_falls_back_to_multi_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            "os.environ",
            {ACP_CONNECTION_MODE_ENV_NAME: "unexpected"},
            clear=True,
        ):
            workspace = Path(temp_dir)

            config = resolve_runtime_config(
                workspace=workspace,
                data_dir_override=workspace,
                agent_adapter_override="router",
            )

            self.assertEqual(config.acp_connection_mode, ACP_CONNECTION_MODE_MULTI_SESSION)


if __name__ == "__main__":
    unittest.main()
