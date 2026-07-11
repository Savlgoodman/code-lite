from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Protocol

from code_lite_backend.agents.runtimes.descriptors import (
    CLAUDE_DESCRIPTOR,
    CODEX_DESCRIPTOR,
    OPENCODE_DESCRIPTOR,
    RuntimeDescriptor,
    claude_env,
    codex_env,
    resolve_codex_mode,
)
from code_lite_backend.core.config import RuntimeConfig
from code_lite_backend.schemas.agent import AgentRunRequest
from code_lite_backend.services.agent_runtime_config import AgentRuntimeConfigStore, _string_list

logger = logging.getLogger(__name__)


def _config_option_id(option: Any) -> str:
    if isinstance(option, dict):
        return str(option.get("id") or "").strip()
    return str(getattr(option, "id", "") or "").strip()


def _config_option_present(options: list[Any] | None, config_id: str) -> bool | None:
    if not config_id or options is None:
        return None
    return any(_config_option_id(option) == config_id for option in options)


class RuntimeProfile(Protocol):
    descriptor: RuntimeDescriptor

    def resolve_command(self, store: AgentRuntimeConfigStore) -> list[str]:
        ...

    def build_env(self, store: AgentRuntimeConfigStore, runtime_config: RuntimeConfig) -> dict[str, str]:
        ...

    def default_mode(self, store: AgentRuntimeConfigStore) -> str:
        ...

    async def apply_turn_config(
        self,
        *,
        conn: Any,
        session_id: str,
        request: AgentRunRequest,
    ) -> dict[str, Any]:
        ...


@dataclass(frozen=True)
class BaseRuntimeProfile:
    descriptor: RuntimeDescriptor

    def _runtime_settings(self, store: AgentRuntimeConfigStore) -> dict[str, Any]:
        runtimes = store.load()["agentRuntimes"]
        value = runtimes.get(self.descriptor.id, {})
        return value if isinstance(value, dict) else {}

    def resolve_command(self, store: AgentRuntimeConfigStore) -> list[str]:
        runtime = self._runtime_settings(store)
        command = _string_list(runtime.get("command"))
        return command or list(self.descriptor.default_command)

    def build_env(self, store: AgentRuntimeConfigStore, runtime_config: RuntimeConfig) -> dict[str, str]:
        return dict(os.environ)

    def default_mode(self, store: AgentRuntimeConfigStore) -> str:
        runtime = self._runtime_settings(store)
        return str(runtime.get("mode") or self.descriptor.default_mode)

    def resolve_mode(self, requested_mode: str | None) -> str | None:
        mode = str(requested_mode or "").strip()
        return mode or None

    def resolve_model(self, request: AgentRunRequest) -> str:
        return str(request.runtime_model or request.model_metadata.get("model") or "").strip()

    def resolve_reasoning_effort(self, request: AgentRunRequest) -> str:
        return str(request.reasoning_effort or request.model_metadata.get("reasoningEffort") or "").strip()

    def effort_config_id(self) -> str:
        return "reasoning_effort"

    def fast_mode_config_id(self) -> str | None:
        return None

    async def apply_turn_config(
        self,
        *,
        conn: Any,
        session_id: str,
        request: AgentRunRequest,
    ) -> dict[str, Any]:
        await self._apply_mode(conn=conn, session_id=session_id, request=request)
        await self._apply_model(conn=conn, session_id=session_id, request=request)
        await self._apply_reasoning_effort(conn=conn, session_id=session_id, request=request)
        return await self._apply_fast_mode(conn=conn, session_id=session_id, request=request)

    async def _apply_mode(self, *, conn: Any, session_id: str, request: AgentRunRequest) -> None:
        mode = self.resolve_mode(request.access_mode)
        logger.info(
            "[configure] turn=%s conversation=%s session=%s access_mode=%s -> resolved_mode=%s runtime=%s",
            request.turn_id,
            request.conversation_id[:12],
            session_id[:12],
            request.access_mode,
            mode,
            self.descriptor.id,
            extra={
                "category": "acp",
                "runtime": self.descriptor.id,
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "nativeSessionId": session_id,
                "stage": "configure.mode",
            },
        )
        if not mode:
            return
        try:
            await asyncio.wait_for(conn.set_session_mode(session_id=session_id, mode_id=mode), timeout=10)
            logger.info(
                "[configure] set_session_mode(%s) OK",
                mode,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.mode",
                },
            )
        except Exception as exc:
            logger.warning(
                "[configure] set_session_mode(%s) failed: %s",
                mode,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.mode",
                    "fields": {"errorType": type(exc).__name__},
                },
            )

    async def _apply_model(self, *, conn: Any, session_id: str, request: AgentRunRequest) -> None:
        model = self.resolve_model(request)
        logger.info(
            "[configure] turn=%s conversation=%s runtime_model=%s model_metadata.model=%s -> final_model=%s",
            request.turn_id,
            request.conversation_id[:12],
            request.runtime_model,
            request.model_metadata.get("model"),
            model,
            extra={
                "category": "acp",
                "runtime": self.descriptor.id,
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "nativeSessionId": session_id,
                "stage": "configure.model",
            },
        )
        if not model:
            return
        try:
            await self._set_model(conn=conn, session_id=session_id, model=model)
            logger.info(
                "[configure] model=%s OK",
                model,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.model",
                },
            )
        except Exception as exc:
            logger.warning(
                "[configure] model=%s failed: %s",
                model,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.model",
                    "fields": {"errorType": type(exc).__name__},
                },
            )

    async def _set_model(self, *, conn: Any, session_id: str, model: str) -> None:
        await asyncio.wait_for(conn.set_session_model(session_id=session_id, model_id=model), timeout=10)

    async def _apply_reasoning_effort(self, *, conn: Any, session_id: str, request: AgentRunRequest) -> None:
        reasoning_effort = self.resolve_reasoning_effort(request)
        config_id = self.effort_config_id()
        logger.info(
            "[configure] turn=%s conversation=%s reasoning_effort=%s config_id=%s runtime=%s",
            request.turn_id,
            request.conversation_id[:12],
            reasoning_effort,
            config_id,
            self.descriptor.id,
            extra={
                "category": "acp",
                "runtime": self.descriptor.id,
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "nativeSessionId": session_id,
                "stage": "configure.option",
                "fields": {"configId": config_id},
            },
        )
        if not reasoning_effort or reasoning_effort == "none":
            return
        try:
            await asyncio.wait_for(
                conn.set_config_option(session_id=session_id, config_id=config_id, value=reasoning_effort),
                timeout=10,
            )
            logger.info(
                "[configure] set_config_option(%s=%s) OK",
                config_id,
                reasoning_effort,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.option",
                    "fields": {"configId": config_id},
                },
            )
        except Exception as exc:
            logger.warning(
                "[configure] set_config_option(%s=%s) failed: %s",
                config_id,
                reasoning_effort,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.option",
                    "fields": {"configId": config_id, "errorType": type(exc).__name__},
                },
            )

    async def _apply_fast_mode(self, *, conn: Any, session_id: str, request: AgentRunRequest) -> dict[str, Any]:
        fast_mode = str(request.fast_mode or "").strip().lower()
        if fast_mode not in {"on", "off"}:
            return {}
        config_id = self.fast_mode_config_id()
        if not config_id:
            return {}
        logger.info(
            "[configure] turn=%s conversation=%s fast_mode=%s config_id=%s runtime=%s",
            request.turn_id,
            request.conversation_id[:12],
            fast_mode,
            config_id,
            self.descriptor.id,
            extra={
                "category": "acp",
                "runtime": self.descriptor.id,
                "conversationId": request.conversation_id,
                "turnId": request.turn_id,
                "nativeSessionId": session_id,
                "stage": "configure.fast_mode",
                "fields": {"configId": config_id, "fastMode": fast_mode},
            },
        )
        try:
            response = await asyncio.wait_for(
                conn.set_config_option(session_id=session_id, config_id=config_id, value=fast_mode),
                timeout=10,
            )
            self._mark_fast_mode_applied(
                request,
                applied=True,
                config_options=self._response_config_options(response),
                error=None,
            )
            logger.info(
                "[configure] set_config_option(%s=%s) OK",
                config_id,
                fast_mode,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.fast_mode",
                    "fields": {"configId": config_id, "fastMode": fast_mode},
                },
            )
            return {"configOptions": self._response_config_options(response)}
        except Exception as exc:
            self._mark_fast_mode_applied(
                request,
                applied=False,
                config_options=None,
                error=f"{type(exc).__name__}: {exc}",
            )
            logger.warning(
                "[configure] set_config_option(%s=%s) failed: %s",
                config_id,
                fast_mode,
                exc,
                extra={
                    "category": "acp",
                    "runtime": self.descriptor.id,
                    "conversationId": request.conversation_id,
                    "turnId": request.turn_id,
                    "nativeSessionId": session_id,
                    "stage": "configure.fast_mode",
                    "fields": {"configId": config_id, "fastMode": fast_mode, "errorType": type(exc).__name__},
                },
            )
            return {}

    def _mark_fast_mode_applied(
        self,
        request: AgentRunRequest,
        *,
        applied: bool,
        config_options: list[Any] | None,
        error: str | None,
    ) -> None:
        fast_mode = request.model_metadata.get("fastMode")
        if not isinstance(fast_mode, dict):
            return
        enabled = fast_mode.get("enabled") is True
        config_id = str(fast_mode.get("runtimeConfigId") or "").strip()
        option_present = _config_option_present(config_options, config_id) if config_options is not None else None
        effective = bool(applied and enabled and option_present is True)
        fast_mode["configApplied"] = applied
        fast_mode["applied"] = effective
        fast_mode["effective"] = effective
        fast_mode["effectiveSource"] = (
            "runtime_config_options" if option_present is not None else "runtime_config_rpc"
        )
        if option_present is not None:
            fast_mode["runtimeOptionPresent"] = option_present
        elif enabled and applied:
            fast_mode["effectiveUnknown"] = True
            fast_mode["effectiveReason"] = "runtime did not return configOptions after setting fast mode"
        if enabled and option_present is False:
            fast_mode["effectiveReason"] = f"runtime option {config_id} is unavailable for the selected model"
        elif not enabled:
            fast_mode.pop("effectiveReason", None)
        fast_mode["billingMultiplier"] = 2 if effective else 1
        if error:
            fast_mode["error"] = error
        else:
            fast_mode.pop("error", None)

    @staticmethod
    def _response_config_options(response: Any) -> list[Any] | None:
        if response is None:
            return None
        options = getattr(response, "config_options", None)
        if options is not None:
            return list(options) if isinstance(options, list | tuple) else options
        if isinstance(response, dict):
            options = response.get("configOptions") or response.get("config_options")
            if isinstance(options, list):
                return options
        return None


@dataclass(frozen=True)
class CodexRuntimeProfile(BaseRuntimeProfile):
    descriptor: RuntimeDescriptor = CODEX_DESCRIPTOR

    def resolve_command(self, store: AgentRuntimeConfigStore) -> list[str]:
        return store.codex_command()

    def build_env(self, store: AgentRuntimeConfigStore, runtime_config: RuntimeConfig) -> dict[str, str]:
        runtime = self._runtime_settings(store)
        logs_dir = str(runtime_config.logs_dir / "codex-acp")
        isolated_home = None
        if runtime.get("configMode") == "isolated":
            codex_home = runtime_config.data_dir / "runtime-state" / "codex-home"
            codex_home.mkdir(parents=True, exist_ok=True)
            isolated_home = str(codex_home)
        return codex_env(runtime, logs_dir=logs_dir, isolated_codex_home=isolated_home)

    def default_mode(self, store: AgentRuntimeConfigStore) -> str:
        return store.codex_mode()

    def resolve_mode(self, requested_mode: str | None) -> str | None:
        return resolve_codex_mode(requested_mode)

    def fast_mode_config_id(self) -> str | None:
        return "fast-mode"


@dataclass(frozen=True)
class ClaudeCodeRuntimeProfile(BaseRuntimeProfile):
    descriptor: RuntimeDescriptor = CLAUDE_DESCRIPTOR

    def resolve_command(self, store: AgentRuntimeConfigStore) -> list[str]:
        runtime = self._runtime_settings(store)
        command = _string_list(runtime.get("command"))
        return command or store.managed_claude_command()

    def build_env(self, store: AgentRuntimeConfigStore, runtime_config: RuntimeConfig) -> dict[str, str]:
        runtime = self._runtime_settings(store)
        logs_dir = str(runtime_config.logs_dir / "claude-agent-acp")
        return claude_env(runtime, logs_dir=logs_dir)

    def resolve_mode(self, requested_mode: str | None) -> str | None:
        mode = str(requested_mode or "").strip()
        return mode or None

    def effort_config_id(self) -> str:
        return "effort"

    def fast_mode_config_id(self) -> str | None:
        return "fast"

    async def _set_model(self, *, conn: Any, session_id: str, model: str) -> None:
        await asyncio.wait_for(
            conn.set_config_option(session_id=session_id, config_id="model", value=model),
            timeout=10,
        )


@dataclass(frozen=True)
class OpencodeRuntimeProfile(BaseRuntimeProfile):
    descriptor: RuntimeDescriptor = OPENCODE_DESCRIPTOR


RUNTIME_PROFILES: dict[str, RuntimeProfile] = {
    "codex": CodexRuntimeProfile(),
    "claude_code": ClaudeCodeRuntimeProfile(),
    "opencode": OpencodeRuntimeProfile(),
}


def get_runtime_profile(runtime_id: str) -> RuntimeProfile | None:
    return RUNTIME_PROFILES.get(runtime_id)
