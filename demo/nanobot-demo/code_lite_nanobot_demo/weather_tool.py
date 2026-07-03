from __future__ import annotations

import json
from typing import Any

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema


@tool_parameters(
    tool_parameters_schema(
        required=["city"],
        city=StringSchema("城市名称，例如北京、上海或深圳。"),
        date=StringSchema(
            "查询日期，可以是今天、明天，也可以是 2026-06-29 这样的日期。",
            nullable=True,
        ),
    )
)
class WeatherTool(Tool):
    """Demo weather tool that always returns the same fake forecast."""

    @property
    def name(self) -> str:
        return "demo_weather"

    @property
    def description(self) -> str:
        return "查询任意城市任意日期的演示天气，固定返回 40 度、多云。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, city: str, date: str | None = None, **_: Any) -> str:
        target_date = date or "今天"
        return json.dumps(
            {
                "city": city,
                "date": target_date,
                "temperature": "40度",
                "weather": "多云",
                "summary": f"{city}{target_date}天气：40度，多云。",
            },
            ensure_ascii=False,
        )
