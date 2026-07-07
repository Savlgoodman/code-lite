from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from code_lite_backend.agents.acp.runtime_manager import (
    AcpRuntimeConnection,
    AcpRuntimeManager,
    AcpSessionBinding,
    ConnectionKey,
)


class FakeStore:
    def __init__(self, binding: dict[str, Any] | None) -> None:
        self.binding = binding
        self.saved: dict[str, Any] | None = None

    def load_native_session(self, conversation_id: str) -> dict[str, Any] | None:
        return self.binding

    def save_native_session(self, conversation_id: str, binding: dict[str, Any]) -> dict[str, Any]:
        self.saved = binding
        return binding


class FakeSdk:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def resume_session(self, **_: Any) -> Any:
        self.calls.append("resume")
        return SimpleNamespace(
            config_options=[],
            models=None,
            modes=None,
        )

    async def load_session(self, **_: Any) -> Any:
        self.calls.append("load")
        return SimpleNamespace(
            config_options=[],
            models=None,
            modes=None,
        )


class FailingResumeSdk(FakeSdk):
    async def resume_session(self, **_: Any) -> Any:
        self.calls.append("resume")
        raise RuntimeError("resume failed")


class FakeHandler:
    def __init__(self) -> None:
        self.suppress_output = False
        self.suppression_states: list[bool] = []

    async def record_suppression_state(self) -> None:
        self.suppression_states.append(self.suppress_output)


class LoadObservingSdk(FailingResumeSdk):
    def __init__(self, handler: FakeHandler) -> None:
        super().__init__()
        self.handler = handler

    async def load_session(self, **_: Any) -> Any:
        self.calls.append("load")
        await self.handler.record_suppression_state()
        return SimpleNamespace(
            config_options=[],
            models=None,
            modes=None,
        )


def make_binding() -> dict[str, Any]:
    return {
        "conversationId": "conv-1",
        "runtimeId": "codex",
        "nativeSessionId": "native-1",
        "workspace": "H:/codex-lite",
        "configMode": "managed",
        "createdAt": "2026-07-07T00:00:00Z",
        "updatedAt": "2026-07-07T00:00:00Z",
        "capabilities": {"configOptions": []},
    }


def make_connection(*, sdk: Any, handler: Any, resume: bool, load: bool) -> AcpRuntimeConnection:
    session_caps = SimpleNamespace(resume=SimpleNamespace() if resume else None)
    agent_caps = SimpleNamespace(
        load_session=load,
        session_capabilities=session_caps,
    )
    return AcpRuntimeConnection(
        key=ConnectionKey(
            runtime_id="codex",
            workspace="H:/codex-lite",
            config_mode="managed",
            conversation_id="conv-1",
            command_fingerprint="cmd",
            env_fingerprint="env",
        ),
        descriptor=SimpleNamespace(id="codex"),
        command=["codex-acp"],
        env={},
        process=SimpleNamespace(returncode=None),
        sdk_connection=sdk,
        initialize_result=SimpleNamespace(agent_capabilities=agent_caps),
        _ready=True,
        _client_handler=handler,
    )


class AcpRuntimeManagerRestoreTest(unittest.IsolatedAsyncioTestCase):
    async def test_restore_prefers_resume_when_supported(self) -> None:
        sdk = FakeSdk()
        manager = AcpRuntimeManager(conversation_store=FakeStore(make_binding()))
        connection = make_connection(
            sdk=sdk,
            handler=FakeHandler(),
            resume=True,
            load=True,
        )

        binding = await manager.ensure_session(
            connection=connection,
            conversation_id="conv-1",
            workspace=Path("H:/codex-lite"),
        )

        self.assertEqual(binding.native_session_id, "native-1")
        self.assertEqual(sdk.calls, ["resume"])

    async def test_load_fallback_suppresses_replay_output(self) -> None:
        handler = FakeHandler()
        sdk = LoadObservingSdk(handler)
        manager = AcpRuntimeManager(conversation_store=FakeStore(make_binding()))
        connection = make_connection(
            sdk=sdk,
            handler=handler,
            resume=True,
            load=True,
        )

        binding = await manager.ensure_session(
            connection=connection,
            conversation_id="conv-1",
            workspace=Path("H:/codex-lite"),
        )

        self.assertEqual(binding.native_session_id, "native-1")
        self.assertEqual(sdk.calls, ["resume", "load"])
        self.assertEqual(handler.suppression_states, [True])
        self.assertFalse(handler.suppress_output)


if __name__ == "__main__":
    unittest.main()
