from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ConversationEventStore:
    """事件优先存储。

    为每个 conversation 维护一个 append-only events.ndjson，
    记录产品级事件（不是原始 ACP JSON-RPC）。
    同时保持 messages.json 作为投影兼容输出。
    """

    def __init__(self, record_dir: Path) -> None:
        self._record_dir = record_dir
        self._sequences: dict[str, int] = {}  # conversation_id -> next sequence

    async def append_event(
        self,
        conversation_id: str,
        event: dict[str, Any],
        *,
        runtime: str | None = None,
        native_session_id: str | None = None,
    ) -> dict[str, Any]:
        """追加产品级事件到 events.ndjson。

        自动添加 eventId、sequence、createdAt。
        返回带完整元数据的事件。
        """
        seq = self._sequences.get(conversation_id, 1)
        enriched = {
            "eventId": event.get("eventId") or f"evt_{uuid.uuid4().hex}",
            "sequence": seq,
            "createdAt": event.get("createdAt") or _now_iso(),
            **event,
        }
        if runtime and "runtime" not in enriched:
            enriched["runtime"] = runtime
        if native_session_id and "nativeSessionId" not in enriched:
            enriched["nativeSessionId"] = native_session_id
        # 确保 sequence 和 eventId 在最前面
        enriched["eventId"] = enriched["eventId"]
        enriched["sequence"] = seq
        self._sequences[conversation_id] = seq + 1

        path = self._events_path(conversation_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(enriched, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.warning("Failed to write event to events.ndjson: %s", exc)

        return enriched

    async def load_events(
        self,
        conversation_id: str,
        after: int = 0,
    ) -> list[dict[str, Any]]:
        """加载事件，支持按 sequence 过滤（用于远程同步补偿）。"""
        path = self._events_path(conversation_id)
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        if event.get("sequence", 0) > after:
                            events.append(event)
                    except json.JSONDecodeError:
                        continue
        except Exception as exc:
            logger.warning("Failed to read events.ndjson: %s", exc)
        return events

    async def get_latest_sequence(self, conversation_id: str) -> int:
        """获取最新 sequence 号。"""
        events = await self.load_events(conversation_id)
        if not events:
            return 0
        return max(e.get("sequence", 0) for e in events)

    def _events_path(self, conversation_id: str) -> Path:
        return self._record_dir / conversation_id / "events.ndjson"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
