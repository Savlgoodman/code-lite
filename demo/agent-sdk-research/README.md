# Agent SDK 调研验证

本目录用于验证 code-lite 计划接入的 Python SDK 能力：Codex、Claude Agent SDK 和 nanobot。

默认探针只做本地反射和安全清点：

```powershell
uv run --no-project --with openai-codex --with claude-agent-sdk --with nanobot-ai python .\sdk_capability_probe.py --json
```

默认行为：

1. 不启动 Codex、Claude Code 或 nanobot runtime。
2. 不调用模型。
3. 不读取 `~/.codex`、`~/.claude`、`~/.nanobot` 中的文件内容。
4. 只输出目录是否存在、顶层文件名、大小和修改时间。
5. 对用户目录路径做 `~` 替换，避免把绝对主目录写进结果。

如后续需要做真实 turn smoke test，应另加显式参数，并确保不会自动执行写入、联网或长期运行操作。

