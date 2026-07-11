from __future__ import annotations

import asyncio
import contextlib
import sys
from importlib.metadata import entry_points
from pathlib import Path

from nanobot.agent.tools.context import ToolContext
from nanobot.agent.tools.loader import ToolLoader
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.config.schema import ToolsConfig


def configure_console_encoding() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            with contextlib.suppress(Exception):
                reconfigure(encoding="utf-8")


async def main() -> None:
    plugin_names = {ep.name for ep in entry_points(group="nanobot.tools")}
    print(f"entry_point_demo_weather={ 'demo_weather' in plugin_names }")

    ctx = ToolContext(config=ToolsConfig(), workspace=str(Path.cwd()))
    registry = ToolRegistry()
    registered = ToolLoader().load(ctx, registry)
    print(f"registered_demo_weather={ 'demo_weather' in registered }")
    print(f"registry_has_demo_weather={ registry.has('demo_weather') }")

    tool = registry.get("demo_weather")
    if tool is None:
        raise RuntimeError("demo_weather tool was not registered")

    print(f"tool_name={tool.name}")
    print(f"tool_read_only={tool.read_only}")
    print(await tool.execute(city="北京", date="明天"))


if __name__ == "__main__":
    configure_console_encoding()
    asyncio.run(main())
