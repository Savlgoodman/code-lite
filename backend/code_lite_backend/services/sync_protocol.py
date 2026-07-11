"""
双端同步协议 - 后端同步事件辅助模块

与前端 @code-lite/sync 包对应，提供：
1. 同步事件类型常量
2. 同步事件构造函数
3. 同步事件分发辅助函数

前后端使用相同的 syncType 字符串和 payload 结构，
确保协议的一致性。

见 docs/design/0710-UNIFIED-SYNC-PROTOCOL.md
"""

from __future__ import annotations

import time
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from code_lite_backend.services.event_bus import SessionEventBus


# ─── 同步事件类型常量（与前端 SyncEvents 一一对应） ───────────────

class SyncEvents:
    SESSION_RUNNING = "session.running"
    SESSION_STOPPED = "session.stopped"
    SESSION_STATE = "session.state"
    SESSION_CONFIG = "session.config"

    CONFIG_MODEL = "config.model"
    CONFIG_EFFORT = "config.effort"
    CONFIG_ACCESS_MODE = "config.access_mode"
    CONFIG_BATCH = "config.batch"

    CONTROL_CANCEL = "control.cancel"
    CONTROL_LOCK = "control.lock"
    CONTROL_UNLOCK = "control.unlock"

    PRESENCE_JOIN = "presence.join"
    PRESENCE_LEAVE = "presence.leave"
    PRESENCE_HEARTBEAT = "presence.heartbeat"


# ─── 全局频道常量 ───────────────────────────────────────────────

GLOBAL_CHANNEL = "*"


# ─── 同步事件构造函数 ──────────────────────────────────────────

def create_sync_event(sync_type: str, sync_payload: dict[str, Any]) -> dict[str, Any]:
    """构造一个同步事件（包装为 AgentEvent 格式）。

    事件通过 event_bus 广播到会话频道或全局频道。
    前端 SyncManager 收到后通过 syncType 字段识别并分发。
    """
    return {
        "type": "sync",
        "syncType": sync_type,
        "syncPayload": sync_payload,
    }


# ─── 便捷构造器 ────────────────────────────────────────────────

def session_running_event(
    conversation_id: str,
    turn_id: str,
    started_by: str = "host",
) -> dict[str, Any]:
    """构造会话开始运行事件。在 turn.start 成功后广播。"""
    return create_sync_event(SyncEvents.SESSION_RUNNING, {
        "conversationId": conversation_id,
        "turnId": turn_id,
        "startedBy": started_by,
        "startedAt": int(time.time() * 1000),
    })


def session_stopped_event(
    conversation_id: str,
    turn_id: str,
    reason: str = "completed",
    stopped_by: str = "auto",
) -> dict[str, Any]:
    """构造会话停止运行事件。在 turn 结束或取消后广播。"""
    return create_sync_event(SyncEvents.SESSION_STOPPED, {
        "conversationId": conversation_id,
        "turnId": turn_id,
        "stoppedBy": stopped_by,
        "reason": reason,
        "stoppedAt": int(time.time() * 1000),
    })


def config_change_event(
    conversation_id: str,
    changes: dict[str, Any],
    changed_by: str = "host",
) -> dict[str, Any]:
    """构造配置变更事件。在 conversation.config.update 成功后广播。"""
    return create_sync_event(SyncEvents.CONFIG_BATCH, {
        "conversationId": conversation_id,
        "changes": changes,
        "changedBy": changed_by,
    })


def session_state_event(
    conversation_id: str,
    action: str,
    by: str = "host",
) -> dict[str, Any]:
    """构造会话状态变化事件（创建、归档、删除）。"""
    return create_sync_event(SyncEvents.SESSION_STATE, {
        "conversationId": conversation_id,
        "action": action,
        "by": by,
    })


def presence_join_event(
    peer_id: str,
    role: str = "operator",
) -> dict[str, Any]:
    """构造设备加入事件。"""
    return create_sync_event(SyncEvents.PRESENCE_JOIN, {
        "peerId": peer_id,
        "role": role,
        "joinedAt": int(time.time() * 1000),
    })


def presence_leave_event(peer_id: str) -> dict[str, Any]:
    """构造设备离开事件。"""
    return create_sync_event(SyncEvents.PRESENCE_LEAVE, {
        "peerId": peer_id,
        "leftAt": int(time.time() * 1000),
    })


# ─── 分发辅助 ──────────────────────────────────────────────────

def broadcast_sync(
    event_bus: "SessionEventBus",
    channel: str,
    sync_type: str,
    sync_payload: dict[str, Any],
) -> None:
    """向指定频道广播同步事件。

    Args:
        event_bus: 事件总线实例
        channel: 目标频道（会话 ID 或全局频道 "*"）
        sync_type: 同步事件类型
        sync_payload: 同步事件载荷
    """
    event = create_sync_event(sync_type, sync_payload)
    event_bus.publish(channel, event)


def broadcast_to_all(
    event_bus: "SessionEventBus",
    conversation_id: str,
    sync_type: str,
    sync_payload: dict[str, Any],
) -> None:
    """向会话频道和全局频道同时广播同步事件。

    用于需要通知所有订阅者的场景（如运行态变化）：
    - 订阅该会话频道的 -> 获得会话级同步
    - 订阅全局频道的 -> 获得全局列表级同步

    Args:
        event_bus: 事件总线实例
        conversation_id: 会话 ID
        sync_type: 同步事件类型
        sync_payload: 同步事件载荷
    """
    event = create_sync_event(sync_type, sync_payload)
    event_bus.publish(conversation_id, event)
    event_bus.publish(GLOBAL_CHANNEL, event)
