from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from nanobot import (
    STREAM_EVENT_REASONING_COMPLETED,
    STREAM_EVENT_REASONING_DELTA,
    STREAM_EVENT_RUN_COMPLETED,
    STREAM_EVENT_RUN_FAILED,
    STREAM_EVENT_RUN_STARTED,
    STREAM_EVENT_TEXT_COMPLETED,
    STREAM_EVENT_TEXT_DELTA,
    STREAM_EVENT_TOOL_COMPLETED,
    STREAM_EVENT_TOOL_FAILED,
    STREAM_EVENT_TOOL_STARTED,
    Nanobot,
)
from nanobot.agent import AgentHook, AgentHookContext


def configure_console_encoding() -> None:
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            with contextlib.suppress(Exception):
                reconfigure(encoding="utf-8")


HIGH_RISK_TOOL_NAMES = {
    "exec",
    "write_file",
    "edit_file",
    "apply_patch",
    "write_stdin",
}


class ToolApprovalRejected(RuntimeError):
    pass


def format_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except TypeError:
        return repr(value)


def risk_level(tool_name: str, arguments: dict[str, Any] | None) -> str:
    if tool_name in HIGH_RISK_TOOL_NAMES:
        return "高风险"
    if tool_name.startswith("web_"):
        return "中风险"
    return "低风险"


def describe_risk(tool_name: str, arguments: dict[str, Any] | None) -> str:
    level = risk_level(tool_name, arguments)
    if level == "高风险":
        return "该工具可能修改文件、执行命令或影响本机状态，需要明确确认。"
    if level == "中风险":
        return "该工具可能访问网络或获取外部内容，需要注意来源可信度。"
    return "该工具通常偏只读，但仍建议在 demo 中观察其参数。"


async def ask_user_approval(tool_name: str, arguments: dict[str, Any] | None) -> bool:
    print("\n\n[审批] Agent 准备调用工具")
    print(f"工具：{tool_name}")
    print(f"风险：{risk_level(tool_name, arguments)}")
    print(f"说明：{describe_risk(tool_name, arguments)}")
    print("参数：")
    print(format_json(arguments or {}))
    print()

    while True:
        answer = await asyncio.to_thread(input, "是否允许执行？输入 y 允许，n 拒绝：")
        normalized = answer.strip().lower()
        if normalized in {"y", "yes"}:
            return True
        if normalized in {"n", "no"}:
            return False
        print("请输入 y 或 n。")


class ApprovalHook(AgentHook):
    def __init__(self) -> None:
        # reraise=True 很关键：否则 CompositeHook 会吞掉异常，工具仍可能继续执行。
        super().__init__(reraise=True)

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for call in context.tool_calls:
            allowed = await ask_user_approval(call.name, call.arguments)
            if not allowed:
                raise ToolApprovalRejected(
                    f"用户拒绝执行工具：{call.name}，本轮 Agent 已中断。"
                )


async def stream_one_turn(
    bot: Nanobot,
    prompt: str,
    *,
    session_key: str,
    cancel_after: float | None = None,
) -> None:
    run = await bot.run_streamed(
        prompt,
        session_key=session_key,
        hooks=[ApprovalHook()],
    )

    cancel_task = None
    if cancel_after is not None:
        cancel_task = asyncio.create_task(cancel_after_delay(run, cancel_after))
    final_seen = False
    try:
        async for event in run.stream_events():
            if event.type == STREAM_EVENT_RUN_STARTED:
                model = event.metadata.get("model")
                print(f"\n[开始] model={model}")
            elif event.type == STREAM_EVENT_TEXT_DELTA:
                print(event.delta, end="", flush=True)
            elif event.type == STREAM_EVENT_TEXT_COMPLETED:
                if event.resuming:
                    print("\n[文本段结束，Agent 准备继续工具调用]")
            elif event.type == STREAM_EVENT_REASONING_DELTA:
                print(f"\n[推理] {event.delta}", end="", flush=True)
            elif event.type == STREAM_EVENT_REASONING_COMPLETED:
                print("\n[推理结束]")
            elif event.type == STREAM_EVENT_TOOL_STARTED:
                print("\n\n[工具开始]")
                print(f"工具：{event.name}")
                print(f"参数：{format_json(event.arguments or {})}")
            elif event.type == STREAM_EVENT_TOOL_COMPLETED:
                print("\n[工具完成]")
                print(f"工具：{event.name}")
                if event.metadata:
                    print(f"摘要：{event.metadata.get('detail', '')}")
            elif event.type == STREAM_EVENT_TOOL_FAILED:
                print("\n[工具失败]")
                print(f"工具：{event.name}")
                print(f"错误：{event.error or event.metadata.get('detail', '')}")
            elif event.type == STREAM_EVENT_RUN_COMPLETED:
                final_seen = True
                print("\n\n[完成]")
                if event.result is not None:
                    print(f"停止原因：{event.result.stop_reason}")
                    print(f"使用工具：{event.result.tools_used}")
                    print(f"用量：{event.result.usage}")
            elif event.type == STREAM_EVENT_RUN_FAILED:
                print("\n\n[失败]")
                print(event.error or "未知错误")

        if not final_seen:
            await run.wait()
    except ToolApprovalRejected as exc:
        print(f"\n[已拒绝] {exc}")
    except asyncio.CancelledError:
        print("\n[已取消]")
        raise
    except KeyboardInterrupt:
        await run.cancel()
        print("\n[已通过 Ctrl+C 取消当前 turn]")
    except Exception as exc:
        print(f"\n[异常] {type(exc).__name__}: {exc}")
    finally:
        if cancel_task is not None:
            cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_task
        if not run.done:
            await run.aclose()


async def cancel_after_delay(run: Any, seconds: float) -> None:
    await asyncio.sleep(seconds)
    if not run.done:
        await run.cancel()
        print(f"\n[已按计划在 {seconds:.1f} 秒后取消当前 turn]")


def parse_cancel_after_command(text: str) -> tuple[float, str] | None:
    prefix = "/cancel-after "
    if not text.lower().startswith(prefix):
        return None
    rest = text[len(prefix):].strip()
    if not rest:
        return None
    parts = rest.split(maxsplit=1)
    if len(parts) != 2:
        return None
    try:
        seconds = float(parts[0])
    except ValueError:
        return None
    if seconds <= 0:
        return None
    return seconds, parts[1].strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="nanobot SDK CLI 审批 demo")
    parser.add_argument(
        "--config",
        default=str(Path(__file__).with_name("nanobot_config.local.json")),
        help="nanobot 配置文件路径",
    )
    parser.add_argument(
        "--workspace",
        default=str(Path(__file__).resolve().parents[1]),
        help="覆盖 nanobot workspace，默认使用项目根目录",
    )
    parser.add_argument(
        "--session",
        default="pc-agent-demo",
        help="会话 key",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    config_path = Path(args.config).resolve()
    workspace = Path(args.workspace).resolve()

    if not config_path.exists():
        raise FileNotFoundError(
            f"配置文件不存在：{config_path}\n"
            "请先复制 demo/nanobot_config.example.json 为 demo/nanobot_config.local.json"
        )

    if not os.environ.get("DEEPSEEK_API_KEY"):
        print("[提醒] 当前进程没有设置 DEEPSEEK_API_KEY。")
        print("PowerShell 示例：$env:DEEPSEEK_API_KEY = \"你的 key\"")

    async with Nanobot.from_config(config_path=config_path, workspace=workspace) as bot:
        print("nanobot SDK CLI 审批 demo")
        print(f"模型：{bot.runtime.model}")
        print(f"workspace：{bot.runtime.workspace}")
        print("输入 /exit 退出。运行中可按 Ctrl+C 取消当前 turn。")
        print("也可以输入：/cancel-after 2 请写一段较长说明")

        while True:
            prompt = await asyncio.to_thread(input, "\n你> ")
            prompt = prompt.strip()
            if not prompt:
                continue
            if prompt.lower() in {"/exit", "exit", "quit"}:
                break
            cancel_spec = parse_cancel_after_command(prompt)
            if cancel_spec is not None:
                seconds, real_prompt = cancel_spec
                await stream_one_turn(
                    bot,
                    real_prompt,
                    session_key=args.session,
                    cancel_after=seconds,
                )
                continue
            if prompt.lower().startswith("/cancel-after"):
                print("格式：/cancel-after 秒数 提示词")
                continue
            await stream_one_turn(bot, prompt, session_key=args.session)


if __name__ == "__main__":
    configure_console_encoding()
    asyncio.run(main())
