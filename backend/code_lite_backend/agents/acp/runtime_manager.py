from __future__ import annotations

import asyncio
import asyncio.subprocess as aio_subprocess
import contextlib
import hashlib
import logging
import os
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from acp.core import DEFAULT_STDIO_BUFFER_LIMIT_BYTES
from acp import schema as acp_schema
from acp.meta import PROTOCOL_VERSION as _ACP_PROTOCOL_VERSION
from acp.transports import default_environment

from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.acp.client_capabilities import build_client_capabilities
from code_lite_backend.agents.acp.connection import CodeLiteClientSideConnection
from code_lite_backend.agents.runtimes import RuntimeDescriptor
from code_lite_backend.core.config import ACP_CONNECTION_MODE_MULTI_SESSION, RuntimeConfig
from code_lite_backend.core.process_tree import terminate_process_tree
from code_lite_backend.core.process_utils import hidden_subprocess_kwargs
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.inputs import InputBroker

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConnectionKey:
    """连接复用键。

    multi_session 模式下按 runtime/acpServerKind/config/command/env 复用连接，
    workspace 只作为 native session 的 cwd 和 binding 字段。
    """

    runtime_id: str
    acp_server_kind: str
    workspace: str  # per-conversation fallback 使用；multi_session 为空表示 shared
    config_mode: str
    conversation_id: str  # 每个会话独立隔离
    command_fingerprint: str
    env_fingerprint: str


@dataclass
class AcpSessionBinding:
    """UI conversation 到 native ACP session 的绑定。"""

    conversation_id: str
    agent_id: str
    runtime_id: str
    acp_server_kind: str
    native_session_id: str
    workspace: str
    config_mode: str
    created_at: str
    updated_at: str
    state: str = "active"
    capabilities: dict[str, Any] | None = None


@dataclass
class AcpRuntimeConnection:
    """常驻 ACP 连接。

    持有子进程、SDK connection、stderr ring buffer 和 session 映射。
    """

    key: ConnectionKey
    descriptor: RuntimeDescriptor
    command: list[str]
    env: dict[str, str]
    process: aio_subprocess.Process
    sdk_connection: CodeLiteClientSideConnection
    initialize_result: Any
    stderr_ring_buffer: deque[str] = field(default_factory=lambda: deque(maxlen=20))
    spawned_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    closed_at: str | None = None
    close_reason: str | None = None
    close_result: dict[str, Any] | None = None
    latest_activity_at: float = field(default_factory=time.time)
    sessions: dict[str, str] = field(default_factory=dict)  # conversation_id -> native_session_id
    prompt_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    capabilities_cache: dict[str, Any] | None = None
    _ready: bool = False
    _client_handler: AcpClientHandler | None = None
    _stderr_task: asyncio.Task[None] | None = None
    _receive_task: asyncio.Task[None] | None = None

    @property
    def is_ready(self) -> bool:
        return self._ready and self.process.returncode is None

    def touch(self) -> None:
        self.latest_activity_at = time.time()


@dataclass
class AcpConnectionCloseResult:
    """单个 ACP connection 的关闭结果。"""

    runtime: str
    acp_server_kind: str
    pid: int | None
    command: list[str]
    sessions: list[str]
    reason: str
    closed: bool
    process_tree: dict[str, Any] | None = None
    sdk_close_error: str | None = None
    direct_process_error: str | None = None
    returncode: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "runtime": self.runtime,
            "acpServerKind": self.acp_server_kind,
            "pid": self.pid,
            "command": self.command,
            "sessions": self.sessions,
            "reason": self.reason,
            "closed": self.closed,
            "processTree": self.process_tree,
            "sdkCloseError": self.sdk_close_error,
            "directProcessError": self.direct_process_error,
            "returncode": self.returncode,
        }


class AcpRuntimeManager:
    """ACP Runtime 常驻连接管理器。

    管理 ACP 子进程连接和 session 绑定，实现跨 turn 复用，
    避免每轮 prompt 都重新 spawn 子进程。
    """

    def __init__(self, conversation_store: Any = None, runtime_config: RuntimeConfig | None = None) -> None:
        self._connections: dict[ConnectionKey, AcpRuntimeConnection] = {}
        self._session_bindings: dict[str, AcpSessionBinding] = {}  # conversation_id -> binding
        self._turn_locks: dict[str, asyncio.Lock] = {}  # conversation_id -> lock
        self._handshake_timeout = 30.0
        self._session_timeout = 30.0
        self._conversation_store = conversation_store  # ConversationStore (optional)
        self._process_cwd = runtime_config.data_dir if runtime_config is not None else None
        self._connection_mode = (
            runtime_config.acp_connection_mode
            if runtime_config is not None
            else "per_conversation"
        )
        self._approvals: ApprovalBroker | None = None
        self._inputs: InputBroker | None = None

    def get_turn_lock(self, conversation_id: str) -> asyncio.Lock:
        """获取指定 conversation 的 turn lock（串行化同一会话的 prompt）。"""
        if conversation_id not in self._turn_locks:
            self._turn_locks[conversation_id] = asyncio.Lock()
        return self._turn_locks[conversation_id]

    def get_session_binding(self, conversation_id: str) -> AcpSessionBinding | None:
        """获取指定 conversation 的 session 绑定。"""
        return self._session_bindings.get(conversation_id)

    def get_connection_for_conversation(self, conversation_id: str) -> AcpRuntimeConnection | None:
        """查找指定 conversation 绑定的连接的连接。"""
        binding = self._session_bindings.get(conversation_id)
        if binding is None:
            return None
        for conn in self._connections.values():
            if (
                conn.sessions.get(conversation_id) == binding.native_session_id
                and self._binding_matches_connection(binding, conn)
                and conn.is_ready
            ):
                return conn
        return None

    def get_connection_for_runtime(self, runtime_id: str) -> AcpRuntimeConnection | None:
        """查找指定 runtime 的活跃连接。"""
        for conn in self._connections.values():
            if conn.key.runtime_id == runtime_id and conn.is_ready:
                return conn
        return None

    async def ensure_connection(
        self,
        *,
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
        conversation_id: str,
        approvals: ApprovalBroker,
        inputs: InputBroker,
    ) -> AcpRuntimeConnection:
        """确保存在 ready 的 ACP 连接。

        multi_session 模式下，同一 runtime/acpServerKind/config/command/env
        复用同一个 ACP 连接；workspace 只用于 native session cwd。
        """
        key = self._build_key(descriptor, command, env, workspace, conversation_id)
        self._approvals = approvals
        self._inputs = inputs

        # 已有 ready connection 则复用
        existing = self._connections.get(key)
        if existing is not None and existing.is_ready:
            existing.touch()
            logger.debug("Reusing existing ACP connection for %s", descriptor.id)
            return existing

        # 清理旧连接（如果存在但不 ready）
        if existing is not None:
            result = await self._close_connection(existing, reason="stale_connection_replaced")
            if not result.closed:
                raise RuntimeError(
                    f"旧 ACP Runtime 进程仍未关闭，已阻止重新启动。runtime={descriptor.id} pid={result.pid}"
                )
            self._connections.pop(key, None)

        # spawn ACP process and create persistent connection
        logger.info("Spawning new ACP connection for %s: %s", descriptor.id, command[0])
        connection = await self._spawn_and_initialize(
            descriptor=descriptor,
            command=command,
            env=env,
            workspace=self._connection_process_workspace(workspace),
            approvals=approvals,
            inputs=inputs,
            key=key,
        )
        self._connections[key] = connection
        logger.info("ACP connection ready for %s", descriptor.id)
        return connection

    async def ensure_session(
        self,
        *,
        connection: AcpRuntimeConnection,
        conversation_id: str,
        workspace: Path,
    ) -> AcpSessionBinding:
        """确保存在绑定的 native ACP session。

        恢复策略（按优先级）：
        1. 内存中已有绑定 → 复用
        2. 磁盘上有 native-session.json + runtime 支持 session/resume → 尝试 session/resume
        3. session/resume 不可用或失败，且 runtime 支持 loadSession → 尝试 session/load
        4. 无磁盘记录 → session/new

        按 ACP 官方语义，session/load 会重放历史消息；session/resume 恢复
        上下文但不重放 transcript。这里优先 resume，并在 load fallback
        期间静音 handler 输出，避免历史 replay 被当作当前 turn 流。
        """
        # 1. 内存中已有绑定则复用
        existing = self._session_bindings.get(conversation_id)
        if existing is not None:
            if (
                self._binding_matches_connection(existing, connection)
                and self._binding_matches_workspace(existing, workspace)
                and connection.sessions.get(conversation_id) == existing.native_session_id
            ):
                existing.updated_at = _now_iso()
                existing.state = "active"
                self._detach_conversation_from_other_connections(conversation_id, connection)
                connection.touch()
                return existing

        # 2. 尝试从磁盘恢复
        saved_binding = self.load_binding_from_disk(conversation_id)
        if (
            saved_binding is not None
            and saved_binding.native_session_id
            and self._binding_matches_connection(saved_binding, connection)
            and self._binding_matches_workspace(saved_binding, workspace)
        ):
            restored = await self._try_restore_saved_session(
                connection=connection,
                binding=saved_binding,
                workspace=workspace,
            )
            if restored is not None:
                return restored
        elif saved_binding is not None and saved_binding.native_session_id:
            logger.info(
                "Ignoring native session binding for %s because runtime/workspace no longer matches",
                conversation_id[:12],
            )

        # 3/4. session/new
        logger.info("[session] calling new_session for %s...", conversation_id[:12])
        result = await asyncio.wait_for(
            connection.sdk_connection.new_session(
                cwd=str(workspace),
                mcp_servers=[],
            ),
            timeout=self._session_timeout,
        )
        native_session_id = str(result.session_id)

        # 序列化 session_result 供后续构建 capabilities 使用
        from code_lite_backend.agents.acp.mapper import to_jsonable
        session_data = to_jsonable(result)
        # 记录 session/new 返回了哪些能力字段
        if isinstance(session_data, dict):
            config_opts = session_data.get("configOptions")
            opt_ids = []
            if isinstance(config_opts, list):
                opt_ids = [o.get("id") for o in config_opts if isinstance(o, dict)]
            logger.info(
                "[session] new_session OK — top-level keys=%s configOption ids=%s",
                list(session_data.keys()), opt_ids,
            )
        else:
            logger.warning("[session] new_session returned non-dict: %s", type(session_data).__name__)

        created_at = saved_binding.created_at if saved_binding else _now_iso()
        binding = AcpSessionBinding(
            conversation_id=conversation_id,
            agent_id=connection.descriptor.id,
            runtime_id=connection.descriptor.id,
            acp_server_kind=connection.descriptor.acp_server_kind,
            native_session_id=native_session_id,
            workspace=str(workspace),
            config_mode=connection.key.config_mode,
            created_at=created_at,
            updated_at=_now_iso(),
            state="active",
            capabilities=session_data,
        )
        self._detach_conversation_from_other_connections(conversation_id, connection)
        connection.sessions[conversation_id] = native_session_id
        self._session_bindings[conversation_id] = binding

        # 持久化到 native-session.json
        self._persist_binding(binding)

        connection.touch()
        logger.info(
            "Created new native session %s for conversation %s",
            native_session_id[:12],
            conversation_id[:12],
        )
        return binding

    @staticmethod
    def _supports_load_session(connection: AcpRuntimeConnection) -> bool:
        """检查 runtime 是否支持 session/load。"""
        init_result = connection.initialize_result
        if init_result is None:
            return False
        agent_capabilities = getattr(init_result, "agent_capabilities", None)
        if agent_capabilities is None:
            return False
        return bool(getattr(agent_capabilities, "load_session", False))

    @staticmethod
    def _supports_resume_session(connection: AcpRuntimeConnection) -> bool:
        """检查 runtime 是否支持 session/resume。"""
        init_result = connection.initialize_result
        if init_result is None:
            return False
        agent_capabilities = getattr(init_result, "agent_capabilities", None)
        if agent_capabilities is None:
            return False
        session_capabilities = getattr(agent_capabilities, "session_capabilities", None)
        if session_capabilities is None:
            return False
        return bool(getattr(session_capabilities, "resume", None))

    @staticmethod
    def _supports_close_session(connection: AcpRuntimeConnection) -> bool:
        """检查 runtime 是否支持 session/close。"""
        init_result = connection.initialize_result
        if init_result is None:
            return False
        agent_capabilities = getattr(init_result, "agent_capabilities", None)
        if agent_capabilities is None:
            return False
        session_capabilities = getattr(agent_capabilities, "session_capabilities", None)
        if session_capabilities is None:
            return False
        return bool(getattr(session_capabilities, "close", None))

    async def _try_restore_saved_session(
        self,
        *,
        connection: AcpRuntimeConnection,
        binding: AcpSessionBinding,
        workspace: Path,
    ) -> AcpSessionBinding | None:
        """恢复磁盘上的 native session，优先 resume，load 作为兼容兜底。"""
        cwd = binding.workspace or str(workspace)

        if self._supports_resume_session(connection):
            restored = await self._restore_with_method(
                connection=connection,
                binding=binding,
                method="resume",
                call=lambda: connection.sdk_connection.resume_session(
                    cwd=cwd,
                    session_id=binding.native_session_id,
                    mcp_servers=[],
                ),
                suppress_output=False,
            )
            if restored is not None:
                return restored

        if self._supports_load_session(connection):
            return await self._restore_with_method(
                connection=connection,
                binding=binding,
                method="load",
                call=lambda: connection.sdk_connection.load_session(
                    cwd=cwd,
                    session_id=binding.native_session_id,
                    mcp_servers=[],
                ),
                suppress_output=True,
            )

        return None

    async def _restore_with_method(
        self,
        *,
        connection: AcpRuntimeConnection,
        binding: AcpSessionBinding,
        method: str,
        call: Callable[[], Awaitable[Any]],
        suppress_output: bool,
    ) -> AcpSessionBinding | None:
        logger.info(
            "Attempting session/%s for %s (native: %s)",
            method,
            binding.conversation_id[:12],
            binding.native_session_id[:12],
        )
        client_handler = connection._client_handler
        previous_suppression = getattr(client_handler, "suppress_output", False) if client_handler else False
        if client_handler is not None and suppress_output:
            client_handler.suppress_output = True
        try:
            result = await asyncio.wait_for(call(), timeout=self._session_timeout)
        except Exception as exc:
            logger.warning(
                "session/%s failed for %s: %s - trying next recovery strategy",
                method,
                binding.conversation_id[:12],
                exc,
            )
            return None
        finally:
            if client_handler is not None and suppress_output:
                client_handler.suppress_output = previous_suppression

        from code_lite_backend.agents.acp.mapper import to_jsonable

        session_data = to_jsonable(result)
        if session_data:
            binding.capabilities = session_data
        binding.updated_at = _now_iso()
        self._detach_conversation_from_other_connections(binding.conversation_id, connection)
        connection.sessions[binding.conversation_id] = binding.native_session_id
        self._session_bindings[binding.conversation_id] = binding
        self._persist_binding(binding)
        connection.touch()
        logger.info(
            "Successfully restored native session %s for conversation %s via session/%s",
            binding.native_session_id[:12],
            binding.conversation_id[:12],
            method,
        )
        return binding

    @staticmethod
    def _binding_matches_connection(binding: AcpSessionBinding, connection: AcpRuntimeConnection) -> bool:
        return (
            binding.runtime_id == connection.descriptor.id
            and binding.acp_server_kind == connection.descriptor.acp_server_kind
            and binding.config_mode == connection.key.config_mode
        )

    @staticmethod
    def _binding_matches_workspace(binding: AcpSessionBinding, workspace: Path) -> bool:
        return _workspace_key(binding.workspace) == _workspace_key(str(workspace))

    def _detach_conversation_from_other_connections(
        self,
        conversation_id: str,
        keep_connection: AcpRuntimeConnection | None,
    ) -> None:
        """清理同一 conversation 在其他 connection 上的陈旧映射。"""
        for connection in self._connections.values():
            if keep_connection is not None and connection.key == keep_connection.key:
                continue
            native_session_id = connection.sessions.pop(conversation_id, None)
            if native_session_id and connection._client_handler is not None:
                connection._client_handler.detach_route(native_session_id)
                connection._client_handler.remove_route(native_session_id)

    async def close_session_for_conversation(
        self,
        conversation_id: str,
        *,
        delete_binding: bool = False,
        close_empty_connection: bool = False,
    ) -> bool:
        """释放指定 conversation 的 active ACP session。

        delete_binding=True 用于删除会话；归档或空闲释放时保留磁盘绑定，
        后续可通过 session/resume 或 session/load 恢复。
        """
        binding = self._session_bindings.get(conversation_id)
        if binding is None:
            binding = self.load_binding_from_disk(conversation_id)
        if binding is None or not binding.native_session_id:
            return False

        connection = self.get_connection_for_conversation(conversation_id)
        closed = False
        if connection is not None and connection.is_ready:
            handler = connection._client_handler
            if handler is not None:
                handler.detach_route(binding.native_session_id)
                if delete_binding:
                    handler.remove_route(binding.native_session_id)
            if self._supports_close_session(connection):
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        connection.sdk_connection.close_session(binding.native_session_id),
                        timeout=5,
                    )
                    closed = True
            connection.sessions.pop(conversation_id, None)
            connection.touch()

        self._session_bindings.pop(conversation_id, None)
        if delete_binding:
            if self._conversation_store is not None:
                with contextlib.suppress(Exception):
                    self._conversation_store.delete_native_session(conversation_id)
        else:
            binding.state = "idle_closed" if closed else "detached"
            binding.updated_at = _now_iso()
            self._persist_binding(binding)

        if close_empty_connection and connection is not None and not connection.sessions:
            await self.close_connection(connection.key, reason="empty_session_connection")

        return True

    async def close_connection(
        self,
        key: ConnectionKey,
        *,
        reason: str = "close_connection",
    ) -> dict[str, Any] | None:
        """关闭指定连接。"""
        connection = self._connections.get(key)
        if connection is None:
            return None
        result = await self._close_connection(connection, reason=reason)
        result_dict = result.to_dict()
        if result.closed:
            self._connections.pop(key, None)
        return result_dict

    async def disconnect_runtime(
        self,
        runtime_id: str,
        *,
        reason: str,
        clear_bindings: bool = True,
    ) -> dict[str, Any]:
        """彻底断开指定 runtime 的所有 ACP connection 和进程树。"""
        matching_keys = [
            key for key, connection in self._connections.items()
            if connection.key.runtime_id == runtime_id
        ]
        results: list[dict[str, Any]] = []
        for key in matching_keys:
            result = await self.close_connection(key, reason=reason)
            if result is not None:
                results.append(result)
        summary = self._disconnect_summary(results)
        if clear_bindings and summary["failedConnections"] == 0:
            self._clear_bindings_for_runtime(runtime_id)
        return {
            "closed": summary["failedConnections"] == 0,
            "reason": reason,
            "runtime": runtime_id,
            "summary": summary,
            "connections": results,
            "failed": [item for item in results if not item.get("closed")],
        }

    async def disconnect_all(self, *, reason: str) -> dict[str, Any]:
        """彻底断开所有 ACP connection 和进程树。"""
        results: list[dict[str, Any]] = []
        for key in list(self._connections.keys()):
            result = await self.close_connection(key, reason=reason)
            if result is not None:
                results.append(result)
        summary = self._disconnect_summary(results)
        if summary["failedConnections"] == 0:
            self._session_bindings.clear()
            self._turn_locks.clear()
        return {
            "closed": summary["failedConnections"] == 0,
            "reason": reason,
            "summary": summary,
            "connections": results,
            "failed": [item for item in results if not item.get("closed")],
        }

    async def close_all(self) -> dict[str, Any]:
        """关闭所有连接。保留旧调用名，内部使用强断开。"""
        return await self.disconnect_all(reason="backend_shutdown")

    def remove_session_binding(self, conversation_id: str) -> None:
        """移除会话绑定（不清理 native session，只移除产品层映射）。"""
        binding = self._session_bindings.pop(conversation_id, None)
        if binding is not None:
            for conn in self._connections.values():
                conn.sessions.pop(conversation_id, None)

    def status_snapshot(self) -> dict[str, Any]:
        """返回当前 ACP connection/session 状态，供设置页和诊断使用。"""
        connections: list[dict[str, Any]] = []
        for connection in self._connections.values():
            sessions: list[dict[str, Any]] = []
            for conversation_id, native_session_id in connection.sessions.items():
                binding = self._session_bindings.get(conversation_id)
                route = (
                    connection._client_handler.get_route(native_session_id)
                    if connection._client_handler is not None
                    else None
                )
                sessions.append({
                    "conversationId": conversation_id,
                    "nativeSessionId": native_session_id,
                    "state": binding.state if binding is not None else "active",
                    "activePrompt": bool(getattr(route, "active_prompt", False)),
                    "workspace": binding.workspace if binding is not None else "",
                    "runtime": binding.runtime_id if binding is not None else connection.descriptor.id,
                    "acpServerKind": (
                        binding.acp_server_kind
                        if binding is not None
                        else connection.descriptor.acp_server_kind
                    ),
                })
            connections.append({
                "runtime": connection.descriptor.id,
                "acpServerKind": connection.descriptor.acp_server_kind,
                "workspace": connection.key.workspace,
                "configMode": connection.key.config_mode,
                "conversationKey": connection.key.conversation_id,
                "pid": connection.process.pid,
                "rootPid": connection.process.pid,
                "spawnedAt": connection.spawned_at,
                "ready": connection.is_ready,
                "activeSessions": len(connection.sessions),
                "latestActivityAt": connection.latest_activity_at,
                "sessions": sessions,
            })
        return {
            "connectionMode": self._connection_mode,
            "connections": connections,
        }

    def load_binding_from_disk(self, conversation_id: str) -> AcpSessionBinding | None:
        """从 native-session.json 加载绑定（不创建新 session）。"""
        if self._conversation_store is None:
            return None
        data = self._conversation_store.load_native_session(conversation_id)
        if data is None:
            return None
        return AcpSessionBinding(
            conversation_id=data.get("conversationId", conversation_id),
            agent_id=data.get("agentId", data.get("runtimeId", "")),
            runtime_id=data.get("runtimeId", ""),
            acp_server_kind=data.get("acpServerKind", data.get("runtimeId", "")),
            native_session_id=data.get("nativeSessionId", ""),
            workspace=data.get("workspace", ""),
            config_mode=data.get("configMode", ""),
            created_at=data.get("createdAt", ""),
            updated_at=data.get("updatedAt", ""),
            state=data.get("state", "active"),
            capabilities=data.get("capabilities"),
        )

    def load_text_baselines(self, conversation_id: str) -> dict[str, str]:
        """读取已持久化的 assistant 文本，用于过滤 ACP session 历史重放。"""
        if self._conversation_store is None:
            return {"content": "", "reasoning": ""}
        try:
            messages = self._conversation_store.load_messages(conversation_id)
        except Exception as exc:
            logger.warning("Failed to load ACP text baselines for %s: %s", conversation_id[:12], exc)
            return {"content": "", "reasoning": ""}

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            content = message.get("content")
            if isinstance(content, str) and content:
                content_parts.append(content)
            reasoning = message.get("reasoning")
            if isinstance(reasoning, str) and reasoning:
                reasoning_parts.append(reasoning)
        return {
            "content": "".join(content_parts),
            "reasoning": "".join(reasoning_parts),
        }

    def _persist_binding(self, binding: AcpSessionBinding) -> None:
        """持久化绑定到 native-session.json。"""
        if self._conversation_store is None:
            return
        try:
            data = {
                "conversationId": binding.conversation_id,
                "agentId": binding.agent_id,
                "runtimeId": binding.runtime_id,
                "acpServerKind": binding.acp_server_kind,
                "nativeSessionId": binding.native_session_id,
                "workspace": binding.workspace,
                "configMode": binding.config_mode,
                "createdAt": binding.created_at,
                "updatedAt": binding.updated_at,
                "state": binding.state,
            }
            # 缓存 capabilities（首次 session/new 后写入，后续从磁盘读取）
            if binding.capabilities is not None:
                data["capabilities"] = binding.capabilities
            self._conversation_store.save_native_session(binding.conversation_id, data)
        except Exception as exc:
            logger.warning("Failed to persist native session binding: %s", exc)

    # ─── Private helpers ──────────────────────────────────────────────────

    async def _spawn_and_initialize(
        self,
        *,
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
        approvals: ApprovalBroker,
        inputs: InputBroker,
        key: ConnectionKey,
    ) -> AcpRuntimeConnection:
        """手动 spawn 子进程并建立持久连接（不使用 context manager）。"""
        # 合并环境变量
        merged_env = dict(default_environment())
        merged_env.update(env)

        logger.info("[spawn] runtime=%s command=%s cwd=%s", descriptor.id, command, workspace)

        # spawn 子进程
        subprocess_kwargs = hidden_subprocess_kwargs()
        if os.name != "nt":
            subprocess_kwargs["start_new_session"] = True
        try:
            process = await asyncio.create_subprocess_exec(
                command[0],
                *command[1:],
                stdin=aio_subprocess.PIPE,
                stdout=aio_subprocess.PIPE,
                stderr=aio_subprocess.PIPE,
                env=merged_env,
                cwd=str(workspace),
                limit=DEFAULT_STDIO_BUFFER_LIMIT_BYTES,
                **subprocess_kwargs,
            )
        except FileNotFoundError:
            logger.error(
                "[spawn] executable not found: %s",
                command[0],
                extra={"category": "acp", "runtime": descriptor.id, "stage": "spawn"},
            )
            raise
        except Exception:
            logger.exception(
                "[spawn] failed to create subprocess: %s",
                command,
                extra={"category": "acp", "runtime": descriptor.id, "stage": "spawn"},
            )
            raise

        logger.info(
            "[spawn] subprocess started, pid=%s",
            process.pid,
            extra={"category": "acp", "runtime": descriptor.id, "stage": "spawn", "fields": {"pid": process.pid}},
        )

        if process.stdout is None or process.stdin is None:
            await terminate_process_tree(process.pid)
            with contextlib.suppress(Exception):
                process.kill()
                await process.wait()
            raise RuntimeError("ACP process requires stdout/stdin pipes")

        # 创建 client handler（用于回调）
        client_handler = AcpClientHandler(
            runtime=descriptor.id,
            conversation_id="connection-init",
            turn_id="connection-init",
            output_queue=asyncio.Queue(),
            approvals=approvals,
            inputs=inputs,
        )

        # 创建 ClientSideConnection（直接使用 StreamWriter/StreamReader）
        # 注意：ClientSideConnection 的 input_stream 是 StreamWriter（写入到子进程 stdin），
        # output_stream 是 StreamReader（从子进程 stdout 读取）
        sdk_connection = CodeLiteClientSideConnection(
            client_handler,
            input_stream=process.stdin,   # StreamWriter -> 写入子进程 stdin
            output_stream=process.stdout,  # StreamReader -> 读取子进程 stdout
            use_unstable_protocol=True,
            observers=[client_handler.observe_stream],
        )

        # 启动 stderr 读取
        stderr_task = asyncio.create_task(
            self._drain_stderr(process, client_handler)
        )

        # initialize
        logger.info("[spawn] calling initialize()...")
        try:
            initialize_result = await asyncio.wait_for(
                sdk_connection.initialize(
                    protocol_version=_ACP_PROTOCOL_VERSION,
                    client_capabilities=build_client_capabilities(descriptor.id),
                    client_info=acp_schema.Implementation(
                        name="code-lite",
                        title="code-lite",
                        version="0.1.4",
                    ),
                ),
                timeout=30,
            )
            logger.info(
                "[spawn] initialize() OK — agent_info=%s load_session=%s",
                getattr(initialize_result, "agent_info", None),
                getattr(getattr(initialize_result, "agent_capabilities", None), "load_session", None),
                extra={"category": "acp", "runtime": descriptor.id, "stage": "initialize"},
            )
        except asyncio.TimeoutError:
            stderr_dump = "\n".join(client_handler.stderr_tail)
            logger.error(
                "[spawn] initialize() TIMEOUT after 30s. returncode=%s stderr:\n%s",
                process.returncode, stderr_dump or "(empty)",
                extra={"category": "acp", "runtime": descriptor.id, "stage": "initialize"},
            )
            await self._cleanup_failed_spawn(process, stderr_task)
            raise
        except Exception as exc:
            stderr_dump = "\n".join(client_handler.stderr_tail)
            logger.error(
                "[spawn] initialize() FAILED: %s: %s. returncode=%s stderr:\n%s",
                type(exc).__name__, exc, process.returncode, stderr_dump or "(empty)",
                extra={"category": "acp", "runtime": descriptor.id, "stage": "initialize"},
            )
            await self._cleanup_failed_spawn(process, stderr_task)
            raise

        connection = AcpRuntimeConnection(
            key=key,
            descriptor=descriptor,
            command=command,
            env=env,
            process=process,
            sdk_connection=sdk_connection,
            initialize_result=initialize_result,
            stderr_ring_buffer=client_handler.stderr_tail,
            latest_activity_at=time.time(),
            sessions={},
            capabilities_cache=None,
            _ready=True,
            _client_handler=client_handler,
            _stderr_task=stderr_task,
        )
        return connection

    async def _drain_stderr(self, process: aio_subprocess.Process, client: AcpClientHandler) -> None:
        """读取子进程 stderr 到 ring buffer。"""
        stderr = process.stderr
        if stderr is None:
            return
        try:
            while True:
                line = await stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    client.stderr_tail.append(text)
                    logger.warning(
                        text,
                        extra={
                            "category": "runtime.stderr",
                            "runtime": client.runtime,
                            "conversationId": client.conversation_id,
                            "turnId": client.turn_id,
                            "nativeSessionId": client.native_session_id,
                        },
                    )
        except (asyncio.CancelledError, Exception):
            pass

    async def _cleanup_failed_spawn(
        self,
        process: aio_subprocess.Process,
        stderr_task: asyncio.Task[None],
    ) -> None:
        await terminate_process_tree(process.pid)
        if getattr(process, "returncode", None) is None:
            with contextlib.suppress(Exception):
                process.kill()
                await asyncio.wait_for(process.wait(), timeout=3)
        stderr_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stderr_task

    async def _close_connection(
        self,
        connection: AcpRuntimeConnection,
        *,
        reason: str,
    ) -> AcpConnectionCloseResult:
        pid = int(connection.process.pid) if getattr(connection.process, "pid", None) else None
        sessions = list(connection.sessions.keys())
        connection._ready = False
        connection.close_reason = reason

        if sessions and self._approvals is not None:
            with contextlib.suppress(Exception):
                await self._approvals.reject_for_conversations(set(sessions))
        if sessions and self._inputs is not None:
            with contextlib.suppress(Exception):
                await self._inputs.cancel_for_conversations(set(sessions))

        handler = connection._client_handler
        if handler is not None:
            for native_session_id in list(connection.sessions.values()):
                handler.detach_route(native_session_id)
                handler.remove_route(native_session_id)

        process_tree_result = await terminate_process_tree(pid, timeout=8)

        if connection._stderr_task is not None:
            connection._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await connection._stderr_task

        sdk_close_error: str | None = None
        try:
            await asyncio.wait_for(connection.sdk_connection.close(), timeout=2)
        except Exception as exc:
            sdk_close_error = f"{type(exc).__name__}: {exc}"

        direct_process_error = await self._finalize_direct_process(connection)
        closed = self._connection_closed(connection, process_tree_result)
        result = AcpConnectionCloseResult(
            runtime=connection.descriptor.id,
            acp_server_kind=connection.descriptor.acp_server_kind,
            pid=pid,
            command=list(connection.command),
            sessions=sessions,
            reason=reason,
            closed=closed,
            process_tree=process_tree_result.to_dict(),
            sdk_close_error=sdk_close_error,
            direct_process_error=direct_process_error,
            returncode=getattr(connection.process, "returncode", None),
        )
        result_dict = result.to_dict()
        if closed:
            connection.sessions.clear()
        connection.closed_at = _now_iso()
        connection.close_result = result_dict
        logger.info(
            "Closed ACP connection for %s pid=%s closed=%s reason=%s",
            connection.descriptor.id,
            pid,
            closed,
            reason,
            extra={
                "category": "acp",
                "runtime": connection.descriptor.id,
                "stage": "disconnect.connection",
                "fields": {
                    "pid": pid,
                    "reason": reason,
                    "closed": closed,
                    "processTree": result_dict.get("processTree"),
                    "sdkCloseError": sdk_close_error,
                    "directProcessError": direct_process_error,
                    "sessions": sessions,
                },
            },
        )
        return result

    async def _finalize_direct_process(self, connection: AcpRuntimeConnection) -> str | None:
        process = connection.process
        if getattr(process, "returncode", None) is None:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=1)
        if getattr(process, "returncode", None) is not None:
            return None

        try:
            process.kill()
        except ProcessLookupError:
            return None
        except Exception as exc:
            return f"{type(exc).__name__}: {exc}"

        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except asyncio.TimeoutError:
            return "timeout waiting for direct process after kill"
        except Exception as exc:
            return f"{type(exc).__name__}: {exc}"
        return None

    @staticmethod
    def _connection_closed(connection: AcpRuntimeConnection, process_tree_result: Any) -> bool:
        if getattr(connection.process, "returncode", None) is not None:
            return True
        return bool(getattr(process_tree_result, "ok", False))

    def _clear_bindings_for_runtime(self, runtime_id: str) -> None:
        for conversation_id, binding in list(self._session_bindings.items()):
            if binding.runtime_id != runtime_id:
                continue
            binding.state = "runtime_disconnected"
            binding.updated_at = _now_iso()
            self._persist_binding(binding)
            self._session_bindings.pop(conversation_id, None)
            self._turn_locks.pop(conversation_id, None)

    @staticmethod
    def _disconnect_summary(results: list[dict[str, Any]]) -> dict[str, int]:
        closed = sum(1 for item in results if item.get("closed"))
        failed = len(results) - closed
        return {
            "closedConnections": closed,
            "failedConnections": failed,
            "attemptedConnections": len(results),
        }

    def _build_key(
        self,
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
        conversation_id: str = "",
    ) -> ConnectionKey:
        command_fp = hashlib.sha256(" ".join(command).encode()).hexdigest()[:12]
        # env value 参与哈希，避免同名变量但值不同的 runtime 误复用旧连接。
        env_items = [f"{key}={env[key]}" for key in sorted(env.keys())]
        env_fp = hashlib.sha256("\n".join(env_items).encode()).hexdigest()[:12]
        return ConnectionKey(
            runtime_id=descriptor.id,
            acp_server_kind=descriptor.acp_server_kind,
            workspace=(
                ""
                if self._connection_mode == ACP_CONNECTION_MODE_MULTI_SESSION
                else str(workspace)
            ),
            config_mode=descriptor.config_mode,
            conversation_id=(
                ""
                if self._connection_mode == ACP_CONNECTION_MODE_MULTI_SESSION
                else conversation_id
            ),
            command_fingerprint=command_fp,
            env_fingerprint=env_fp,
        )

    def _connection_process_workspace(self, session_workspace: Path) -> Path:
        if self._connection_mode == ACP_CONNECTION_MODE_MULTI_SESSION and self._process_cwd is not None:
            self._process_cwd.mkdir(parents=True, exist_ok=True)
            return self._process_cwd
        return session_workspace


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _workspace_key(value: str) -> str:
    if not value:
        return ""
    normalized = os.path.normpath(value).replace("\\", "/")
    return normalized.rstrip("/").casefold()
