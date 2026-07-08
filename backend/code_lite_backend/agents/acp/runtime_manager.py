from __future__ import annotations

import asyncio
import asyncio.subprocess as aio_subprocess
import contextlib
import hashlib
import logging
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
from code_lite_backend.services.approvals import ApprovalBroker
from code_lite_backend.services.inputs import InputBroker

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConnectionKey:
    """连接复用键。

    每个 conversation 一个独立连接，彻底隔离事件流。
    同一 conversation 的多轮 turn 复用同一连接。
    """

    runtime_id: str
    acp_server_kind: str
    workspace: str
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
        self._connection_mode = (
            runtime_config.acp_connection_mode
            if runtime_config is not None
            else "per_conversation"
        )

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
                conn.key.runtime_id == binding.runtime_id
                and conn.key.acp_server_kind == binding.acp_server_kind
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

        每个 conversation 一个独立连接，彻底隔离事件流。
        同一 conversation 的多轮 turn 复用同一连接。
        """
        key = self._build_key(descriptor, command, env, workspace, conversation_id)

        # 已有 ready connection 则复用
        existing = self._connections.get(key)
        if existing is not None and existing.is_ready:
            existing.touch()
            logger.debug("Reusing existing ACP connection for %s", descriptor.id)
            return existing

        # 清理旧连接（如果存在但不 ready）
        if existing is not None:
            await self._close_connection(existing)
            self._connections.pop(key, None)

        # spawn ACP process and create persistent connection
        logger.info("Spawning new ACP connection for %s: %s", descriptor.id, command[0])
        connection = await self._spawn_and_initialize(
            descriptor=descriptor,
            command=command,
            env=env,
            workspace=workspace,
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
            if self._binding_matches_connection(existing, connection) and existing.native_session_id in connection.sessions.values():
                existing.updated_at = _now_iso()
                existing.state = "active"
                connection.touch()
                return existing

        # 2. 尝试从磁盘恢复
        saved_binding = self.load_binding_from_disk(conversation_id)
        if saved_binding is not None and saved_binding.native_session_id:
            restored = await self._try_restore_saved_session(
                connection=connection,
                binding=saved_binding,
                workspace=workspace,
            )
            if restored is not None:
                return restored

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

    async def close_connection(self, key: ConnectionKey) -> None:
        """关闭指定连接。"""
        connection = self._connections.pop(key, None)
        if connection is not None:
            await self._close_connection(connection)

    async def close_all(self) -> None:
        """关闭所有连接。"""
        for key in list(self._connections.keys()):
            await self.close_connection(key)
        self._session_bindings.clear()
        self._turn_locks.clear()

    def remove_session_binding(self, conversation_id: str) -> None:
        """移除会话绑定（不清理 native session，只移除产品层映射）。"""
        binding = self._session_bindings.pop(conversation_id, None)
        if binding is not None:
            for conn in self._connections.values():
                conn.sessions.pop(conversation_id, None)

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
            with contextlib.suppress(Exception):
                process.kill()
            with contextlib.suppress(Exception):
                await process.wait()
            stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task
            raise
        except Exception as exc:
            stderr_dump = "\n".join(client_handler.stderr_tail)
            logger.error(
                "[spawn] initialize() FAILED: %s: %s. returncode=%s stderr:\n%s",
                type(exc).__name__, exc, process.returncode, stderr_dump or "(empty)",
                extra={"category": "acp", "runtime": descriptor.id, "stage": "initialize"},
            )
            with contextlib.suppress(Exception):
                process.kill()
            with contextlib.suppress(Exception):
                await process.wait()
            stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task
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

    async def _close_connection(self, connection: AcpRuntimeConnection) -> None:
        connection._ready = False

        # 取消 stderr 任务
        if connection._stderr_task is not None:
            connection._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await connection._stderr_task

        # 关闭 SDK connection
        with contextlib.suppress(Exception):
            await asyncio.wait_for(connection.sdk_connection.close(), timeout=5)

        # 关闭进程
        if connection.process.returncode is None:
            try:
                connection.process.terminate()
            except ProcessLookupError:
                pass
            with contextlib.suppress(Exception):
                await asyncio.wait_for(connection.process.wait(), timeout=5)
            if connection.process.returncode is None:
                with contextlib.suppress(Exception):
                    connection.process.kill()
                    await asyncio.wait_for(connection.process.wait(), timeout=3)

        logger.info("Closed ACP connection for %s", connection.descriptor.id)

    def _build_key(
        self,
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
        conversation_id: str = "",
    ) -> ConnectionKey:
        command_fp = hashlib.sha256(" ".join(command).encode()).hexdigest()[:12]
        # env fingerprint: 只记录 key 名，不记录 value（避免泄露 secret）
        env_keys = sorted(env.keys())
        env_fp = hashlib.sha256(",".join(env_keys).encode()).hexdigest()[:12]
        return ConnectionKey(
            runtime_id=descriptor.id,
            acp_server_kind=descriptor.acp_server_kind,
            workspace=str(workspace),
            config_mode=descriptor.config_mode,
            conversation_id=(
                ""
                if self._connection_mode == ACP_CONNECTION_MODE_MULTI_SESSION
                else conversation_id
            ),
            command_fingerprint=command_fp,
            env_fingerprint=env_fp,
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
