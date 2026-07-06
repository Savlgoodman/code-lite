from __future__ import annotations

import json
import logging
import os
import sys
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOG_CATEGORIES = {
    "api",
    "acp",
    "python",
    "runtime.stderr",
    "tauri",
    "ui",
    "audit",
    "diagnostic",
}

_TEXT_LOG_HANDLE: Any | None = None
_ANSI_RESET = "\033[0m"
_CATEGORY_COLORS = {
    "acp": "\033[31m",
    "runtime.stderr": "\033[91m",
    "diagnostic": "\033[91m",
    "python": "\033[34m",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json_default(value: Any) -> str:
    return str(value)


def _safe_text(value: Any, limit: int = 4000) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "...[truncated]"


def sanitize_log_value(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            lowered = key_text.lower()
            if any(token in lowered for token in ("key", "token", "password", "secret", "authorization")):
                result[key_text] = "[redacted]"
            else:
                result[key_text] = sanitize_log_value(item)
        return result
    if isinstance(value, list | tuple):
        return [sanitize_log_value(item) for item in value]
    if isinstance(value, str):
        return _safe_text(value)
    return value


class JsonlLogWriter:
    def __init__(self, logs_dir: Path) -> None:
        self.logs_dir = logs_dir
        self.current_dir = logs_dir / "current"
        self.current_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._files: dict[str, Any] = {}

    def close(self) -> None:
        with self._lock:
            for handle in self._files.values():
                try:
                    handle.close()
                except OSError:
                    pass
            self._files.clear()

    def write(self, payload: dict[str, Any]) -> None:
        category = str(payload.get("category") or "python")
        filename = _category_filename(category)
        line = json.dumps(payload, ensure_ascii=False, default=_json_default)
        with self._lock:
            handle = self._files.get(filename)
            if handle is None:
                path = self.current_dir / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                handle = path.open("a", encoding="utf-8", buffering=1)
                self._files[filename] = handle
            handle.write(line + "\n")


def _category_filename(category: str) -> str:
    if category == "runtime.stderr":
        return "runtime-stderr.jsonl"
    if category == "diagnostic":
        return "diagnostics.jsonl"
    if category in {"api", "acp", "python"}:
        return f"{category}.jsonl"
    return "python.jsonl"


class StructuredLogHandler(logging.Handler):
    def __init__(self, writer: JsonlLogWriter) -> None:
        super().__init__()
        self.writer = writer

    def close(self) -> None:
        try:
            self.writer.close()
        finally:
            super().close()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            category = str(getattr(record, "category", "") or _category_from_logger(record.name))
            payload: dict[str, Any] = {
                "id": f"log_{uuid.uuid4().hex}",
                "timestamp": _utc_now(),
                "level": record.levelname.lower(),
                "category": category if category in LOG_CATEGORIES else "python",
                "source": record.name,
                "message": self.format(record),
            }
            for attr, key in (
                ("runtime", "runtime"),
                ("conversationId", "conversationId"),
                ("turnId", "turnId"),
                ("nativeSessionId", "nativeSessionId"),
                ("stage", "stage"),
            ):
                value = getattr(record, attr, None)
                if value:
                    payload[key] = str(value)
            fields = getattr(record, "fields", None)
            if isinstance(fields, dict):
                payload["fields"] = sanitize_log_value(fields)
            if record.exc_info:
                payload.setdefault("fields", {})
                formatter = self.formatter or logging.Formatter()
                payload["fields"]["exception"] = formatter.formatException(record.exc_info)
            self.writer.write(payload)
        except Exception:
            self.handleError(record)


class CategoryColorFormatter(logging.Formatter):
    def __init__(self, *args: Any, use_color: bool = False, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        if not self.use_color:
            return message
        category = str(getattr(record, "category", "") or _category_from_logger(record.name))
        color = _CATEGORY_COLORS.get(category)
        if not color:
            return message
        return f"{color}{message}{_ANSI_RESET}"


def _category_from_logger(name: str) -> str:
    if ".api." in name:
        return "api"
    if ".agents.acp" in name or ".agents.runtimes" in name:
        return "acp"
    return "python"


def _console_color_enabled(stream: Any, *, log_file: str | None) -> bool:
    if log_file:
        return False
    color_mode = os.environ.get("CODE_LITE_LOG_COLOR", "").lower()
    if color_mode in {"1", "true", "yes", "always"}:
        return True
    if color_mode in {"0", "false", "no", "never"}:
        return False
    if os.environ.get("NO_COLOR"):
        return False
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def configure_logging(*, log_file: str | None = None, logs_dir: Path | None = None) -> None:
    global _TEXT_LOG_HANDLE
    if log_file:
        path = Path(log_file).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        _TEXT_LOG_HANDLE = path.open("a", encoding="utf-8", buffering=1)
        sys.stdout = _TEXT_LOG_HANDLE
        sys.stderr = _TEXT_LOG_HANDLE

    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()
    root.setLevel(logging.INFO)

    formatter = CategoryColorFormatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        use_color=_console_color_enabled(sys.stdout, log_file=log_file),
    )

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    if logs_dir is not None:
        writer = JsonlLogWriter(logs_dir)
        json_handler = StructuredLogHandler(writer)
        json_handler.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(json_handler)

    logging.getLogger("code_lite_backend").setLevel(logging.INFO)


def write_runtime_stderr(
    logs_dir: Path,
    *,
    runtime: str,
    message: str,
    conversation_id: str | None = None,
    turn_id: str | None = None,
    native_session_id: str | None = None,
) -> None:
    writer = JsonlLogWriter(logs_dir)
    try:
        payload: dict[str, Any] = {
            "id": f"log_{uuid.uuid4().hex}",
            "timestamp": _utc_now(),
            "level": "warning",
            "category": "runtime.stderr",
            "source": runtime,
            "runtime": runtime,
            "message": _safe_text(message),
        }
        if conversation_id:
            payload["conversationId"] = conversation_id
        if turn_id:
            payload["turnId"] = turn_id
        if native_session_id:
            payload["nativeSessionId"] = native_session_id
        writer.write(payload)
    finally:
        writer.close()


@dataclass
class DiagnosticError:
    code: str
    message: str
    category: str
    stage: str
    runtime: str | None = None
    conversation_id: str | None = None
    turn_id: str | None = None
    native_session_id: str | None = None
    retryable: bool = False
    user_action: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "category": self.category,
            "stage": self.stage,
            "retryable": self.retryable,
        }
        if self.runtime:
            result["runtime"] = self.runtime
        if self.conversation_id:
            result["conversationId"] = self.conversation_id
        if self.turn_id:
            result["turnId"] = self.turn_id
        if self.native_session_id:
            result["nativeSessionId"] = self.native_session_id
        if self.user_action:
            result["userAction"] = self.user_action
        if self.details:
            result["details"] = sanitize_log_value(self.details)
        return result


def log_diagnostic(logs_dir: Path, diagnostic: DiagnosticError) -> None:
    writer = JsonlLogWriter(logs_dir)
    try:
        payload = {
            "id": f"log_{uuid.uuid4().hex}",
            "timestamp": _utc_now(),
            "level": "error",
            "category": "diagnostic",
            "source": "code_lite_backend.diagnostic",
            "runtime": diagnostic.runtime,
            "conversationId": diagnostic.conversation_id,
            "turnId": diagnostic.turn_id,
            "nativeSessionId": diagnostic.native_session_id,
            "stage": diagnostic.stage,
            "message": diagnostic.message,
            "fields": diagnostic.to_dict(),
        }
        writer.write({key: value for key, value in payload.items() if value is not None})
    finally:
        writer.close()
