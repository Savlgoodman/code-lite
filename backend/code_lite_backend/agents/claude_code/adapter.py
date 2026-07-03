from __future__ import annotations

from code_lite_backend.agents.placeholders import PlaceholderAgentAdapter


class ClaudeCodeAgentAdapter(PlaceholderAgentAdapter):
    def __init__(self) -> None:
        super().__init__("claude_code")
