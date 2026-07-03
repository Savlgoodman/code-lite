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
from typing import Any

from acp import schema as acp_schema
from acp.client.connection import ClientSideConnection
from acp.meta import PROTOCOL_VERSION as _ACP_PROTOCOL_VERSION
from acp.transports import default_environment

from code_lite_backend.agents.acp.client import AcpClientHandler
from code_lite_backend.agents.runtimes import RuntimeDescriptor
from code_lite_backend.services.approvals import ApprovalBroker

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConnectionKey:
    """连接复用键。

    相同 key 的 connection 可以共享，避免重复 spawn 子进程。
    """

    runtime_id: str
    workspace: str
    config_mode: str
    command_fingerprint: str
    env_fingerprint: str


@dataclass
class AcpSessionBinding:
    """UI conversation 到 native ACP session 的绑定。"""

    conversation_id: str
    runtime_id: str
    native_session_id: str
    workspace: str
    config_mode: str
    created_at: str
    updated_at: str
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
    sdk_connection: ClientSideConnection
    initialize_result: Any
    stderr_ring_buffer: deque[str] = field(default_factory=lambda: deque(maxlen=20))
    latest_activity_at: float = field(default_factory=time.time)
    sessions: dict[str, str] = field(default_factory=dict)  # conversation_id -> native_session_id
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

    def __init__(self) -> None:
        self._connections: dict[ConnectionKey, AcpRuntimeConnection] = {}
        self._session_bindings: dict[str, AcpSessionBinding] = {}  # conversation_id -> binding
        self._turn_locks: dict[str, asyncio.Lock] = {}  # conversation_id -> lock
        self._handshake_timeout = 30.0
        self._session_timeout = 30.0

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
            if conn.key.runtime_id == binding.runtime_id and conn.is_ready:
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
        approvals: ApprovalBroker,
    ) -> AcpRuntimeConnection:
        """确保存在 ready 的 ACP 连接。

        如果已有匹配的连接则复用，否则 spawn 新进程并 initialize。
        """
        key = self._build_key(descriptor, command, env, workspace)

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

        如果已有绑定则复用，否则创建新 session。
        """
        # 已绑定 nativeSessionId 则复用
        existing = self._session_bindings.get(conversation_id)
        if existing is not None:
            if existing.native_session_id in connection.sessions.values():
                existing.updated_at = _now_iso()
                connection.touch()
                return existing

        # session/new
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

        binding = AcpSessionBinding(
            conversation_id=conversation_id,
            runtime_id=connection.descriptor.id,
            native_session_id=native_session_id,
            workspace=str(workspace),
            config_mode=connection.key.config_mode,
            created_at=_now_iso(),
            updated_at=_now_iso(),
            capabilities=session_data,
        )
        connection.sessions[conversation_id] = native_session_id
        self._session_bindings[conversation_id] = binding
        connection.touch()
        logger.info(
            "Created new native session %s for conversation %s",
            native_session_id[:12],
            conversation_id[:12],
        )
        return binding

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

    # ─── Private helpers ──────────────────────────────────────────────────

    async def _spawn_and_initialize(
        self,
        *,
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
        approvals: ApprovalBroker,
        key: ConnectionKey,
    ) -> AcpRuntimeConnection:
        """手动 spawn 子进程并建立持久连接（不使用 context manager）。"""
        # 合并环境变量
        merged_env = dict(default_environment())
        merged_env.update(env)

        # spawn 子进程
        process = await asyncio.create_subprocess_exec(
            command[0],
            *command[1:],
            stdin=aio_subprocess.PIPE,
            stdout=aio_subprocess.PIPE,
            stderr=aio_subprocess.PIPE,
            env=merged_env,
            cwd=str(workspace),
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
        )

        # 创建 ClientSideConnection（直接使用 StreamWriter/StreamReader）
        # 注意：ClientSideConnection 的 input_stream 是 StreamWriter（写入到子进程 stdin），
        # output_stream 是 StreamReader（从子进程 stdout 读取）
        sdk_connection = ClientSideConnection(
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
        try:
            initialize_result = await asyncio.wait_for(
                sdk_connection.initialize(
                    protocol_version=_ACP_PROTOCOL_VERSION,
                    client_capabilities=acp_schema.ClientCapabilities(
                        fs=acp_schema.FileSystemCapabilities(
                            read_text_file=False,
                            write_text_file=False,
                        ),
                        terminal=False,
                    ),
                    client_info=acp_schema.Implementation(
                        name="code-lite",
                        title="code-lite",
                        version="0.1.4",
                    ),
                ),
                timeout=30,
            )
        except Exception:
            # 清理失败连接
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

    @staticmethod
    def _build_key(
        descriptor: RuntimeDescriptor,
        command: list[str],
        env: dict[str, str],
        workspace: Path,
    ) -> ConnectionKey:
        command_fp = hashlib.sha256(" ".join(command).encode()).hexdigest()[:12]
        # env fingerprint: 只记录 key 名，不记录 value（避免泄露 secret）
        env_keys = sorted(env.keys())
        env_fp = hashlib.sha256(",".join(env_keys).encode()).hexdigest()[:12]
        return ConnectionKey(
            runtime_id=descriptor.id,
            workspace=str(workspace),
            config_mode=descriptor.config_mode,
            command_fingerprint=command_fp,
            env_fingerprint=env_fp,
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
