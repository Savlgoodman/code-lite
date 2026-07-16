from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.api.routes.image_gen import _call_image_provider
from code_lite_backend.core.config import resolve_runtime_config
from code_lite_backend.services.image_config import (
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ImageConfigError,
    ImageProviderConfigStore,
)


class FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._body = json.dumps(payload).encode("utf-8")
        self.headers: dict[str, str] = {}

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class ImageProviderConfigStoreTest(unittest.TestCase):
    def create_store(self, root: Path) -> tuple[ImageProviderConfigStore, Path]:
        runtime_config = resolve_runtime_config(
            workspace=root,
            data_dir_override=root / "data",
            agent_adapter_override="router",
        )
        return ImageProviderConfigStore(runtime_config), runtime_config.image_config_path

    def test_legacy_provider_gets_default_request_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, config_path = self.create_store(Path(temp_dir))
            config_path.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "imageProviders": [{
                        "id": "legacy",
                        "name": "Legacy",
                        "baseUrl": "https://example.com/v1",
                        "apiKey": "secret",
                        "defaultModel": "image-model",
                    }],
                }),
                encoding="utf-8",
            )

            provider = store.list_providers()[0]
            connection = store.provider_connection("legacy")

            self.assertEqual(
                provider["requestTimeoutSeconds"],
                DEFAULT_REQUEST_TIMEOUT_SECONDS,
            )
            self.assertEqual(
                connection["requestTimeoutSeconds"],
                DEFAULT_REQUEST_TIMEOUT_SECONDS,
            )

    def test_create_update_and_validate_request_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, _ = self.create_store(Path(temp_dir))
            provider = store.create_provider(
                name="Provider",
                base_url="https://example.com/v1",
                api_key="secret",
                request_timeout_seconds=45,
            )

            self.assertEqual(provider["requestTimeoutSeconds"], 45)
            updated = store.update_provider(
                str(provider["id"]),
                {"requestTimeoutSeconds": 600},
            )
            self.assertEqual(updated["requestTimeoutSeconds"], 600)

            for invalid in (9, 3601, 10.5, "invalid", True):
                with self.subTest(invalid=invalid), self.assertRaises(ImageConfigError):
                    store.update_provider(
                        str(provider["id"]),
                        {"requestTimeoutSeconds": invalid},
                    )

    def test_provider_request_uses_configured_timeout(self) -> None:
        response = FakeResponse({"data": [{"b64_json": "aW1hZ2U="}]})
        with patch(
            "code_lite_backend.api.routes.image_gen.urlopen",
            return_value=response,
        ) as mocked_urlopen:
            images = _call_image_provider(
                base_url="https://example.com/v1",
                api_key="secret",
                model="image-model",
                prompt="test",
                n=1,
                size="auto",
                quality="auto",
                reference_files=[],
                request_timeout_seconds=42,
            )

        self.assertEqual(images[0]["data"], b"image")
        self.assertEqual(mocked_urlopen.call_args.kwargs["timeout"], 42)

    def test_provider_request_reports_configured_timeout(self) -> None:
        with patch(
            "code_lite_backend.api.routes.image_gen.urlopen",
            side_effect=URLError(TimeoutError("timed out")),
        ):
            with self.assertRaisesRegex(RuntimeError, "42 秒"):
                _call_image_provider(
                    base_url="https://example.com/v1",
                    api_key="secret",
                    model="image-model",
                    prompt="test",
                    n=1,
                    size="auto",
                    quality="auto",
                    reference_files=[],
                    request_timeout_seconds=42,
                )


if __name__ == "__main__":
    unittest.main()
