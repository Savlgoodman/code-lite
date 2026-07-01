# Agent SDK 能力调研：Codex / Claude Code / nanobot

验证日期：2026-07-02

本文调研 code-lite 计划接入的三个 Python SDK：

1. OpenAI Codex Python SDK：`openai-codex 0.1.0b2`，运行时包 `openai-codex-cli-bin 0.132.0`。
2. Claude Agent SDK Python：`claude-agent-sdk 0.2.110`，包内 Claude Code CLI 版本 `2.1.191`。
3. nanobot Python SDK：`nanobot-ai 0.2.2`。

opencode 暂不纳入本文，因为当前未发现可直接验证的 Python SDK。

## 1. 验证方式

新增本地验证目录：

```text
demo/agent-sdk-research/
  pyproject.toml
  README.md
  sdk_capability_probe.py
```

默认探针只做安全反射，不启动 agent runtime、不调用模型、不读取配置文件内容：

```powershell
cd .\demo\agent-sdk-research
uv sync
uv run python .\sdk_capability_probe.py --json --runtime codex
uv run python .\sdk_capability_probe.py --json --runtime claude
uv run python .\sdk_capability_probe.py --json --runtime nanobot
```

主要依据：

1. 本地安装包版本、wheel 文件清单和公开 API 签名。
2. 本地安装包源码中的注释、类型和默认路径。
3. 现有 `docs/NANOBOT_SDK_RESEARCH.md` 和 `docs/AGENT_ADAPTER_REDESIGN.md` 的前序 smoke 结论。
4. 官方文档入口：
   - [OpenAI Codex SDK](https://developers.openai.com/codex/sdk)
   - [Claude Agent SDK Python](https://code.claude.com/docs/en/agent-sdk/python)
   - [Claude Agent SDK Session Storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
   - [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
   - [Claude Code Settings](https://code.claude.com/docs/en/settings)
   - [Claude Code Manage Costs](https://code.claude.com/docs/en/costs)
   - [PyInstaller Spec Files](https://pyinstaller.org/en/stable/spec-files.html)
   - [PyInstaller Hooks](https://pyinstaller.org/en/stable/hooks.html)

## 2. 总体结论

| 问题 | Codex Python SDK | Claude Agent SDK Python | nanobot SDK | code-lite 建议 |
|------|------------------|--------------------------|-------------|----------------|
| 包内是否有二进制 | 有。`openai-codex-cli-bin` 包含 `codex.exe`、`codex-command-runner.exe`、`codex-windows-sandbox-setup.exe`。`openai-codex` 本体是 Python 包。 | 有。`claude-agent-sdk` wheel 包含 `claude_agent_sdk/_bundled/claude.exe`。 | 没有同类独立 agent runtime。只有 Python console script shim `nanobot.exe` 和少量 skill shell 脚本。 | 安装体积、升级策略、病毒误报和签名校验要分别处理。 |
| 配置是否可自定义 | 可。`CodexConfig(codex_bin, config_overrides, cwd, env)`，默认 home 为 `~/.codex`。 | 可。`ClaudeAgentOptions(settings, setting_sources, env, cli_path, cwd, add_dirs, sandbox)`，默认使用 `~/.claude` 与项目 `.claude`。 | 可。`Nanobot.from_config(config_path, workspace, model, model_preset)`，默认 `~/.nanobot/config.json`。 | code-lite 保留自己的产品配置，再把必要字段映射给各 runtime。 |
| 对话记录存储 | native thread/session 由 Codex runtime 管理。本机可见 `~/.codex/sessions`、`session_index.jsonl`、SQLite 状态文件。SDK 支持 `thread_list/read/resume/fork/archive`。 | native transcript 默认在 `~/.claude/projects` 等目录。SDK 提供 `SessionStore`，可镜像 transcript 到外部存储，并支持 resume materialize。 | 当前 session 主要在 `workspace/sessions/*.jsonl`，也兼容 legacy `~/.nanobot/sessions`；memory 也落在 workspace 相关目录。 | code-lite 应拥有统一会话/event store，native 存储只当 runtime 状态和恢复来源。 |
| 流式输出 | 支持。`Thread.turn()` 返回 handle，低层 JSON-RPC notification 有文本、reasoning、命令输出、文件变更、usage 等事件。 | 支持。`query()` 和 `ClaudeSDKClient.receive_response()` 是 async iterator；`include_partial_messages=True` 可获得 partial stream event。 | 支持。`run_streamed()` 返回 `RunStream`，`stream_events()` 输出 text/reasoning/tool/run 事件。 | UI 和远程同步只消费统一 `AgentEvent`。 |
| 审批请求 | 支持但不是完整产品闸门。高层 `ApprovalMode` 只有 `deny_all`、`auto_review`；低层有 `AskForApprovalValue` 与 `approval_handler`。前序 smoke 显示 workspace 内写入不一定都会触发 handler。 | 支持。`can_use_tool` 可接管本来会 prompt 的工具调用；`hooks` 有 `PermissionRequest`、`PreToolUse` 等。文档和源码明确：`can_use_tool` 不会拦截已被 allow/permission_mode 放行的工具。 | 支持。`AgentHook.before_execute_tools(context)` 可拦截工具执行；要中断运行需配合 `reraise=True`。 | 所有 adapter 的原生审批都只能作为 runtime 层信号，产品级强权限仍要由 code-lite policy/gateway 控制。 |
| 临时中断 | 支持。`TurnHandle.interrupt()` / 低层 `turn_interrupt`。 | 支持。`ClaudeSDKClient.interrupt()`。 | 支持。`RunStream.cancel()`。 | 统一为 `AgentTurnHandle.cancel(reason)`，语义是尽力停止当前 turn。 |
| 权限管理 | `Sandbox`: `read-only`、`workspace-write`、`full-access`；`ApprovalMode`: `deny_all`、`auto_review`；低层 reviewer 有 `user`。 | `PermissionMode`: `default`、`acceptEdits`、`plan`、`bypassPermissions`、`dontAsk`、`auto`；还有 `allowed_tools`、`disallowed_tools`、settings 权限规则、sandbox settings。 | 没有统一 full sandbox 枚举；依赖工具自身、workspace policy 和 hook 审批。 | 产品权限模式不要和 runtime 原生命名一一等同，必须保留 capability caveat。 |
| 可否指定 cwd/workspace | 支持。`CodexConfig.cwd`、`thread_start(cwd=...)`、`Thread.turn(cwd=...)`。 | 支持。`ClaudeAgentOptions.cwd`，并有 `add_dirs`。 | 支持。`Nanobot.from_config(workspace=...)`。 | 所有 adapter 都要接收 code-lite 的 `workspace_cwd`。项目 skill 读取用统一 SkillBridge 处理。 |
| turn 内模型/思考强度 | 支持。`Thread.turn(model=..., effort=..., summary=...)`；`model_provider` 主要在线程启动时设置。 | 支持配置 `model`、`fallback_model`、`thinking`、`effort`、`max_thinking_tokens`。持久 client 的单次 `query()` 不接收 options，per-turn 切换可通过新 options/client 或新 session 实现。 | 支持 `run/run_streamed(model=..., model_preset=...)`；没有通用 thinking strength 字段。 | 统一请求保留 `model`, `model_preset_id`, `reasoning_effort`, `thinking`，由 adapter 选择可用字段。 |
| 上下文窗口信息 | 支持通过 Python SDK 的 turn stream 获取 `thread/tokenUsage/updated` 通知。`ThreadTokenUsage` 包含 `total`、`last`、`modelContextWindow`，Python 字段为 `model_context_window`。 | `ResultMessage.model_usage` 可带 `contextWindow`、`maxOutputTokens` 等；`ClaudeSDKClient.get_context_usage()` 可读取 `/context` 同类信息。 | 内部有 prompt token 估算和 `/status` 类逻辑，但 SDK 暂未暴露统一 context window 对象。 | UI 展示做 best-effort：`context.used_tokens`、`context.max_tokens`、`context.source` 可为空。 |
| 上下文自动/手动压缩 | 支持手动压缩。`Thread.compact()` / `AsyncThread.compact()` 发送 `thread/compact/start`；`thread/compacted` 通知表示压缩发生。配置类型里有 `model_auto_compact_token_limit`、`compact_prompt`，但当前通知不区分手动/自动。 | 支持自动压缩和 `/compact`。SDK 有 `PreCompact` hook，字段 `trigger` 为 `manual` 或 `auto`；官方文档还有 `PostCompact`，但当前 Python SDK 类型只建模到 `PreCompact`。`get_context_usage()` 可读 `isAutoCompactEnabled` 和 `autoCompactThreshold`。 | 暂未验证到统一压缩 API 或压缩通知。 | 统一事件建议用 `agent.context.compaction.started`、`agent.context.compacted`；触发来源字段 best-effort，不能所有 runtime 都保证。 |
| 后续消息队列/运行中引导 | 未发现稳定的统一 SDK 队列 API。低层协议有 thread append 等能力，但不应先作为产品依赖。 | `query(prompt=AsyncIterable[dict])` 可接收异步输入，SDK control protocol 有 interrupt；但产品级排队仍应自己实现。 | 未发现内置队列 API。 | QueueManager 放在 code-lite。默认“当前 turn 结束后继续”，高级场景再做 interrupt-and-resume 或 runtime 特化。 |

## 3. 分项细节

### 3.1 包内二进制

Codex：

```text
openai-codex-cli-bin 0.132.0
  codex_cli_bin/bin/codex.exe
  codex_cli_bin/bin/codex-command-runner.exe
  codex_cli_bin/bin/codex-windows-sandbox-setup.exe
```

`codex_cli_bin.bundled_codex_path()` 返回包内 `codex.exe`。`openai_codex.client` 也允许用 `CodexConfig.codex_bin` 指向自定义 binary。

Claude Code：

```text
claude-agent-sdk 0.2.110
  claude_agent_sdk/_bundled/claude.exe
  claude_agent_sdk/_cli_version.py: __cli_version__ = "2.1.191"
```

`ClaudeAgentOptions.cli_path` 可以指定自定义 Claude Code CLI，否则使用 bundled executable。

nanobot：

```text
nanobot-ai 0.2.2
  console_scripts: nanobot = nanobot.cli.commands:app
  nanobot/skills/tmux/scripts/*.sh
```

Windows 下看到的 `nanobot.exe` 是 Python console script 入口 shim，不是类似 `codex.exe` / `claude.exe` 的独立 agent runtime。

### 3.1.1 二进制发现与按需安装策略

可以不把 Codex / Claude Code runtime 二进制直接打进 code-lite 主应用包，而是在运行时按需绑定：

1. 优先使用用户显式配置的绝对路径。
2. 其次扫描可信系统位置和 `PATH` 中的 `codex` / `codex.exe`、`claude` / `claude.exe`。
3. 发现候选后执行短超时版本检查，例如 `<bin> --version`，记录 resolved path、version、sha256。
4. 用户确认后写入 code-lite runtime manifest。
5. 用户本机没有可用 binary 时，再下载到 code-lite 的 per-user runtime 目录，例如 `%APPDATA%/code-lite/runtimes/<runtime>/<version>/`。

绑定方式已由 SDK 验证：

```python
CodexConfig(codex_bin=str(codex_bin), cwd=str(workspace))
ClaudeAgentOptions(cli_path=str(claude_bin), cwd=str(workspace))
```

但要注意 Python SDK 依赖体积：

1. `openai-codex 0.1.0b2` 的普通依赖包含 `openai-codex-cli-bin`。如果用正常 `uv/pip` 安装 SDK，会拉取包含 Codex runtime 的 wheel。若想完全避免下载 bundled Codex runtime，需要验证 `openai-codex --no-deps` 加显式 `CodexConfig.codex_bin` 的方案；从源码看可行，但这属于偏离包声明依赖的优化路径，需要 smoke test。
2. `claude-agent-sdk 0.2.110` 当前 wheel 自身包含 `_bundled/claude.exe`。即使传入 `ClaudeAgentOptions.cli_path` 使用用户本机 CLI，正常安装该 Python 包仍会下载 bundled binary。若要完全避免这部分体积，需要后续验证是否有 no-binary 分发；否则只能把 Claude adapter 做成可选延迟安装，或直接实现基于 Claude CLI JSON stream 的轻量 subprocess adapter。
3. nanobot 没有同类独立 runtime，按需安装收益主要来自整个 Python 依赖集，而不是 runtime binary。

推荐产品策略：

1. 主应用不内置 Codex / Claude Code 二进制，也不把这两个 adapter 的完整依赖打进默认安装包。
2. Adapter 首次启用时进入 setup wizard：检测本机 binary、展示版本与路径、让用户选择“使用本机安装”或“由 code-lite 下载托管版本”。
3. code-lite 托管下载必须使用固定版本、校验 sha256，并采用原子替换，避免半下载状态被执行。
4. 版本兼容性需要维护 manifest，例如 `codex sdk 0.1.0b2 -> codex runtime 0.132.x`、`claude-agent-sdk 0.2.110 -> claude cli 2.1.191`。用户本机版本过旧或过新时，提示风险并允许切换到 code-lite 托管版本。
5. 不从工作区相对路径或项目 `node_modules/.bin` 自动绑定 runtime，除非用户显式选择。PATH 发现出的路径也应在 UI 中确认，防止被恶意工作区或 shell 配置劫持。

### 3.1.2 PyInstaller 打包时能否不包含 bundled runtime

可以控制，但不是一个单独的 `--no-bundled` 开关。需要区分三层：

1. Python 依赖安装层：`pip/uv` 是否把带二进制的 wheel 下载进构建环境。
2. PyInstaller 收集层：PyInstaller 是否把已安装包中的 `_bundled` / `bin` 文件收进 `dist`。
3. 运行时绑定层：adapter 是否始终显式传入外部 `codex_bin` / `cli_path`。

PyInstaller 官方机制：

1. `.spec` 是可执行 Python 文件，`Analysis` 结果里有 `binaries` 和 `datas` 两个列表；可以在 `.spec` 中修改这些列表。
2. 非 Python 数据文件默认不一定会自动收集；通常由 `--add-data`、`--add-binary`、`--collect-all` 或 package hook 收集。
3. `--exclude-module` / `Analysis(excludes=[...])` 可排除模块或包，但它是按 Python module 名排除，不是按单个文件排除。
4. hooks 中的 `collect_data_files(..., excludes=...)` 支持按 glob 排除数据文件；`collect_all(..., exclude_datas=...)` 也能过滤 data。
5. 对已经进入 `a.datas` / `a.binaries` 的条目，最直接可靠的方式是在 `.spec` 里按目标路径过滤。

建议的 PyInstaller spec 过滤示例：

```python
def keep_runtime_entry(entry):
    text = " ".join(str(part).replace("\\", "/") for part in entry).lower()
    blocked = (
        "claude_agent_sdk/_bundled/",
        "codex_cli_bin/bin/",
        "openai_codex_cli_bin",
    )
    return not any(marker in text for marker in blocked)

a = Analysis(
    ["pc_agent_backend/main.py"],
    excludes=[
        # 如果 Codex adapter 永远显式传 CodexConfig.codex_bin，
        # 可以进一步验证排除 codex_cli_bin。
        # "codex_cli_bin",
    ],
    datas=[],
    binaries=[],
)

a.datas = [entry for entry in a.datas if keep_runtime_entry(entry)]
a.binaries = [entry for entry in a.binaries if keep_runtime_entry(entry)]
```

Codex 判断：

1. `openai-codex` 依赖声明包含 `openai-codex-cli-bin`，正常 `uv/pip` 安装会下载 runtime wheel。
2. 但 `openai_codex` 源码支持 `CodexConfig(codex_bin=...)`。只要 adapter 始终传入外部 binary，就不需要调用默认 `codex_cli_bin.bundled_codex_path()`。
3. 因此 Codex 可选轻量方案是：构建环境用 `openai-codex --no-deps` 加必要纯 Python 依赖，或在 PyInstaller spec 中排除 `codex_cli_bin/bin`。该方案需要单独 smoke test，因为它偏离 `openai-codex` 的声明依赖。

Claude Code 判断：

1. `claude-agent-sdk` 当前 wheel 自身包含 `claude_agent_sdk/_bundled/claude.exe`，不是单独依赖包。
2. `ClaudeAgentOptions(cli_path=...)` 支持绑定外部 Claude Code CLI。只要 adapter 始终传入外部路径，就不依赖 `_bundled/claude.exe`。
3. 但如果构建环境正常安装 `claude-agent-sdk`，下载阶段仍会下载含 bundled binary 的 wheel。PyInstaller 可以在最终 dist 里过滤 `_bundled/claude.exe`，但不能减少构建时下载体积。
4. 若要连构建时下载体积也避免，需要验证是否存在不带 bundled binary 的 SDK 分发；若没有，推荐把 Claude adapter 做成按需安装的插件/sidecar worker，或实现直接调用用户本机 `claude` CLI JSON stream 的轻量 adapter。

推荐发布方案：

1. 主应用 PyInstaller 包不内置 Codex / Claude Code runtime。
2. 主包也尽量不直接 import 重型 SDK；使用可选 adapter worker 或懒加载模块，避免 PyInstaller 静态分析把依赖整包带入。
3. 首次启用 Codex / Claude Code 时运行 setup wizard：先发现本机 binary，再按需下载 code-lite 托管 runtime。
4. 如果必须把 SDK 打入主包，则在 `.spec` 里过滤 `claude_agent_sdk/_bundled` 与 `codex_cli_bin/bin`，并在启动时检测缺失外部 binary 时给出安装引导。
5. CI 必须加产物体积检查和内容检查，例如确保最终 dist 中不存在 `claude_agent_sdk/_bundled/claude.exe`、`codex_cli_bin/bin/codex.exe`。

### 3.2 配置目录与自定义

Codex：

1. `default_codex_home()` 返回 `Path.home() / ".codex"`。
2. 本机目录摘要可见 `~/.codex/config.toml`、`auth.json`、`sessions`、`session_index.jsonl`、`skills`、`plugins`、若干 SQLite 状态文件。
3. SDK 可通过 `CodexConfig.config_overrides` 和 thread/turn 参数覆盖 runtime 配置。

Claude Code：

1. `ClaudeAgentOptions.setting_sources` 明确支持 `user`、`project`、`local`：
   - `user`：`~/.claude/settings.json`
   - `project`：`.claude/settings.json`
   - `local`：`.claude/settings.local.json`
2. `setting_sources=[]` 可进入 SDK isolation mode，禁用 filesystem settings。
3. `settings` 可传额外 settings JSON 文件或 JSON 字符串，优先级高。
4. `env` 可传入 `CLAUDE_CONFIG_DIR`，用于隔离或重定向配置目录。

nanobot：

1. `Nanobot.from_config()` 文档字符串说明默认 `~/.nanobot/config.json`。
2. `config_path` 可显式传入 code-lite 生成的配置。
3. `workspace` 可覆盖配置中的 workspace。
4. 当前 backend 已经通过产品模型配置同步出 nanobot config，因此 nanobot 不应反过来成为多 runtime 的总配置中心。

### 3.3 会话与对话记录

Codex：

1. SDK 支持 `thread_start`、`thread_list`、`thread_read(include_turns=True)`、`thread_resume`、`thread_fork`、`thread_archive`。
2. 本地类型 `Thread.path` 注释为 `[UNSTABLE] Path to the thread on disk`。
3. `thread_resume` 返回的 turns 是 lossy 历史，不保证包含所有 agent interaction，例如命令执行。

Claude Code：

1. native transcript 默认写在 `~/.claude/projects` 等目录。
2. `ClaudeAgentOptions.session_store` 可以把每条本地 transcript line 镜像给外部 store。
3. `session_store_flush` 支持 `batched` 和 `eager`。
4. 使用 `resume` / `continue_conversation` 时，SDK 能从 `SessionStore` materialize 到临时 `CLAUDE_CONFIG_DIR`。

nanobot：

1. `SessionManager` 注释明确：sessions are stored as JSONL files。
2. 当前路径是 `workspace/sessions/<safe_key>.jsonl`。
3. 兼容 legacy `~/.nanobot/sessions/<safe_key>.jsonl`。
4. `Nanobot.run/run_streamed(..., ephemeral=True)` 可以不持久化本轮。

结论：code-lite 不应直接把三家 runtime 的 native transcript 当成产品会话库。产品会话库需要存统一的 prompt、event、approval、artifact、remote-sync cursor。native session id/path 只作为 `RuntimeSessionRef`。

### 3.4 流式事件与审批

Codex 可观察事件包括：

```text
turn/started
item/agentMessage/delta
item/reasoningText/delta
item/reasoningSummaryText/delta
item/commandExecution/outputDelta
item/fileChange/outputDelta
item/mcpToolCall/progress
item/autoApprovalReview/started
item/autoApprovalReview/completed
thread/tokenUsage/updated
thread/compacted
turn/completed
```

结合 `H:\codex-plugin-remote` 逆向出的 app-server schema，以及 `openai_codex.generated.v2_all` 的本地反射，可以确认 Codex app-server 的上下文窗口信息来自 `thread/tokenUsage/updated`：

```ts
type ThreadTokenUsage = {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
```

Python SDK 字段名为：

```python
notification.payload.token_usage.model_context_window
notification.payload.token_usage.total.total_tokens
notification.payload.token_usage.last.total_tokens
```

本地 `openai-codex 0.1.0b2` 反射进一步确认，Python SDK 已把这个通知注册到 generated notification registry：

1. `openai_codex.generated.notification_registry.NOTIFICATION_MODELS["thread/tokenUsage/updated"]` 指向 `ThreadTokenUsageUpdatedNotification`。
2. `ThreadTokenUsageUpdatedNotification` 字段包含 `thread_id`、`turn_id`、`token_usage`。
3. `ThreadTokenUsage` 字段包含 `total`、`last`、`model_context_window`，其中 `model_context_window` 对应 app-server JSON 字段 `modelContextWindow`。
4. `TokenUsageBreakdown` 字段包含 `total_tokens`、`input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_output_tokens`。

adapter 可在 `TurnHandle.stream()` 或 `AsyncTurnHandle.stream()` 中直接处理该 notification：

```python
from openai_codex.generated.v2_all import ThreadTokenUsageUpdatedNotification

turn = thread.turn("...")
for event in turn.stream():
    if (
        event.method == "thread/tokenUsage/updated"
        and isinstance(event.payload, ThreadTokenUsageUpdatedNotification)
    ):
        usage = event.payload.token_usage

        context_max_tokens = usage.model_context_window
        context_used_tokens = usage.total.total_tokens
        last_turn_tokens = usage.last.total_tokens
```

当前逆向 schema 和 Python SDK 中，`thread/read` / `thread/resume` 返回的 `Thread` 不包含 token usage 字段，因此 adapter 应在运行中的 notification stream 里维护最近一次 usage snapshot。恢复历史会话后，如果还没有收到新的 `thread/tokenUsage/updated`，UI 应显示“未知”或使用 code-lite 自己 event store 中保存的上一份快照。

Codex 上下文压缩能力：

1. 手动压缩 API 已确认：`Thread.compact()` / `AsyncThread.compact()` 调用低层 `thread/compact/start`，参数只有 `threadId`，响应是空对象。
2. 压缩通知已确认：`openai_codex.generated.notification_registry.NOTIFICATION_MODELS["thread/compacted"]` 指向 `ContextCompactedNotification`，字段为 `thread_id`、`turn_id`。
3. `ContextCompactedNotification` 在逆向 schema 中标注为 deprecated，建议优先理解为“压缩已发生”的兼容信号；rollout / response item 中还存在 `compaction`、`compaction_trigger`、`context_compaction` item 类型，其中 `context_compaction` 是更接近新模型的历史记录形态。
4. 配置类型里有 `model_auto_compact_token_limit`、`model_context_window`、`compact_prompt`，说明 Codex app-server 协议保留了自动压缩阈值与压缩 prompt 配置；但当前 `thread/compacted` payload 不包含 `trigger=manual|auto`，adapter 不能仅凭该通知稳定区分自动压缩和手动压缩。
5. code-lite 如果由 UI 主动调用 `thread.compact()`，可以把本地 intent 标记为 `trigger="manual"`；runtime 自行发出的 `thread/compacted` 应记录为 `trigger="runtime"` 或 `unknown`，除非后续 SDK 暴露更明确字段。

adapter 示例：

```python
compact_result = thread.compact()

for event in turn.stream():
    if event.method == "thread/compacted":
        yield AgentEvent(
            type="agent.context.compacted",
            data={
                "thread_id": event.payload.thread_id,
                "turn_id": event.payload.turn_id,
                "trigger": "runtime",
                "source": "codex.thread.compacted",
            },
        )
```

Claude Code 可输出：

```text
UserMessage
AssistantMessage
SystemMessage
ResultMessage
StreamEvent
RateLimitEvent
```

在 `include_partial_messages=True` 时，可获得 partial assistant stream。`include_hook_events=True` 时可把 hook lifecycle 纳入消息流。

Claude Code 上下文压缩能力：

1. 自动压缩是 Claude Code 原生能力。官方文档说明 `autoCompactEnabled` 默认开启，会在上下文接近限制时自动压缩；也可通过环境变量 `DISABLE_AUTO_COMPACT` 禁用。
2. 手动压缩通过 Claude Code 的 `/compact` 命令触发；官方文档支持 `/compact Focus on code samples and API usage` 这种自定义压缩说明。
3. Python SDK 当前没有 `ClaudeSDKClient.compact()` 这类显式方法；手动触发是否能通过向会话发送 slash command 稳定实现，需要单独 smoke test。第一版 adapter 不应把它声明成稳定 SDK API。
4. Python SDK 已建模 `PreCompact` hook：`PreCompactHookInput.trigger` 为 `manual` 或 `auto`，`custom_instructions` 在手动 `/compact` 时包含用户传入的说明，自动压缩时为空。
5. 官方 hook 文档还定义 `PostCompact`，字段包含 `trigger` 和 `compact_summary`，可用于压缩完成后的外部同步；但本地 `claude-agent-sdk 0.2.110` 的 `HookEvent` / `HookInput` 类型没有建模 `PostCompact`，因此 code-lite 当前只能把 `PreCompact` 作为已验证 SDK 入口，把 `PostCompact` 标记为 CLI 文档能力、待 Python SDK 验证。
6. `ClaudeAgentOptions.include_hook_events=True` 时，hook lifecycle 会以 `HookEventMessage` 进入消息流，便于 UI 和远程端展示压缩开始/完成相关状态。
7. `ClaudeSDKClient.get_context_usage()` 可读取与 `/context` 类似的信息，包括 `totalTokens`、`maxTokens`、`rawMaxTokens`、`percentage`、`isAutoCompactEnabled`、`autoCompactThreshold`。它适合用来展示压缩前后的上下文占用状态，不是压缩通知本身。

hook 示例：

```python
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

async def on_pre_compact(input_data, tool_use_id, context):
    trigger = input_data["trigger"]  # "manual" or "auto"
    custom_instructions = input_data.get("custom_instructions")
    return {"continue_": True}

options = ClaudeAgentOptions(
    hooks={"PreCompact": [HookMatcher(hooks=[on_pre_compact])]},
    include_hook_events=True,
)
```

code-lite 对 Claude Code 的建议映射：

1. `PreCompact(trigger="manual")` -> `agent.context.compaction.started`，`trigger="manual"`。
2. `PreCompact(trigger="auto")` -> `agent.context.compaction.started`，`trigger="auto"`。
3. 如果未来 Python SDK 暴露 `PostCompact` 或消息流能稳定收到 `PostCompact` hook event，则映射为 `agent.context.compacted`，并保存 `compact_summary`。
4. 在没有 `PostCompact` 的当前 SDK 版本中，可在下一条 `ResultMessage` 或 `get_context_usage()` 刷新后发出 best-effort 的 `agent.context.updated`，不要伪造完整的 `agent.context.compacted` summary。

nanobot 事件包括：

```text
run.started
text.delta
reasoning.delta
tool.started
tool.completed
tool.failed
run.completed
run.failed
```

审批差异：

1. Codex `approval_handler` 是 runtime 判定需要审批时的回调，不是每个文件写入和命令执行的强制前置闸门。
2. Claude `can_use_tool` 只处理原本会 prompt 的工具调用；已由 permission mode、allow rules、allowed tools 放行的调用不会触发它。若要观察每个工具调用，应使用 `PreToolUse` hook。
3. nanobot 的 `before_execute_tools` 更接近工具执行前 hook，但它是否能“拒绝单个工具后继续本轮”仍受 nanobot runner 实现约束，前序调研建议拒绝时直接中断本轮。

## 4. 统一 Adapter 方案

### 4.1 分层原则

code-lite 应把三类职责拆开：

1. Runtime Adapter：只负责和 Codex、Claude Code、nanobot SDK 通信。
2. Product Control Plane：负责权限、审批、队列、模型选择、会话记录、远程同步。
3. SkillBridge：负责把 code-lite 的项目 skill 映射为各 runtime 能理解的上下文、原生 skill 或 MCP 工具。

不要把 adapter 设计成“所有 runtime 都像 nanobot 一样注册 Python Tool”。Codex 和 Claude Code 本质上是本地 coding agent runtime；nanobot 更像 Python agent framework。

### 4.2 核心协议对象

建议扩展 backend 的 `AgentAdapterCapabilities`，增加可序列化 descriptor：

```python
@dataclass
class AgentAdapterDescriptor:
    id: str
    label: str
    vendor: str
    sdk_package: str
    runtime_kind: Literal["bundled_binary", "python_framework"]
    version: str | None
    runtime_version: str | None
    capabilities: AgentAdapterCapabilities
    defaults: AgentAdapterDefaults
    caveats: list[str]

@dataclass
class AgentRunRequest:
    conversation_id: str
    turn_id: str
    prompt: str
    workspace_cwd: Path
    permission_mode: Literal["readonly", "ask", "workspace_write", "full_access"]
    runtime_model: str | None = None
    model_preset_id: str | None = None
    reasoning_effort: str | None = None
    thinking: dict[str, Any] | None = None
    native_session_ref: RuntimeSessionRef | None = None
    skills: list[str] | Literal["all"] | None = None
    queue_policy: Literal["enqueue", "interrupt", "reject"] = "enqueue"
```

运行时引用：

```python
@dataclass
class RuntimeSessionRef:
    adapter_id: str
    native_session_id: str | None
    native_thread_id: str | None
    native_path: str | None
    cwd: str
    metadata: dict[str, Any]
```

turn handle：

```python
class AgentTurnHandle(Protocol):
    adapter_id: str
    conversation_id: str
    turn_id: str
    native_turn_id: str | None

    async def events(self) -> AsyncIterator[AgentEvent]: ...
    async def cancel(self, reason: str | None = None) -> None: ...
    async def decide_approval(self, approval_id: str, decision: ApprovalDecision) -> None: ...
```

### 4.3 统一事件模型

建议保留这些事件类型：

```text
agent.run.started
agent.text.delta
agent.text.completed
agent.reasoning.delta
agent.reasoning.completed
agent.plan.updated
agent.tool.started
agent.tool.delta
agent.tool.completed
agent.tool.failed
agent.command.started
agent.command.output.delta
agent.command.completed
agent.file_change.started
agent.file_change.delta
agent.file_change.completed
approval.required
approval.decided
approval.auto_review.started
approval.auto_review.completed
agent.usage.updated
agent.context.updated
agent.context.compaction.started
agent.context.compacted
agent.session.updated
agent.run.completed
agent.run.failed
agent.run.cancelled
```

所有事件都应写入 code-lite 自己的 event store。远程同步观看只读这个统一 event log，不直接读取 runtime native transcript。

### 4.4 权限模式映射

产品层建议只展示四个模式：

| 产品模式 | Codex 映射 | Claude Code 映射 | nanobot 映射 | UI caveat |
|----------|------------|------------------|--------------|-----------|
| `readonly` | `Sandbox.read_only` + `ApprovalMode.deny_all` | 优先 `permission_mode="plan"` 或严格 disallow 写入工具；配合 settings 权限规则 | 禁用写类工具，hook 拒绝工具调用 | 只读是产品承诺，不能只靠 runtime 自报。 |
| `ask` | `workspace-write` + 低层 `on-request/user` + `approval_handler` | `permission_mode="default"` + `can_use_tool` + `PreToolUse` hook | `before_execute_tools` 转 UI 审批 | 原生 ask 不保证拦截每个写入，需展示为“需要时询问”。 |
| `workspace_write` | `workspace-write` + `auto_review` 或受控 allow | `acceptEdits` 或 allow rules 限定工作区 | 允许低风险工具，限制路径到 workspace | 仍禁止仓库外高风险动作。 |
| `full_access` | `full-access` | `bypassPermissions` | 允许高风险工具集合 | 必须显式二次确认，默认关闭。 |

说明：

1. Codex 的 `workspace-write ask` 不能承诺“每次工作区写入前都询问用户”。
2. Claude 的 `can_use_tool` 也不能承诺“每个工具调用都会询问用户”。
3. nanobot hook 接近产品审批，但 tool 实现仍可能绕过细粒度路径策略。
4. code-lite 如果要做强权限边界，应把危险动作迁移到自己控制的 MCP/工具/执行网关，而不是完全放给 runtime 内置 shell。

### 4.5 配置与会话策略

产品配置：

```json
{
  "agents": {
    "defaultAdapter": "codex",
    "adapters": {
      "codex": {
        "enabled": true,
        "configOverrides": []
      },
      "claude_code": {
        "enabled": true,
        "settingSources": ["user", "project", "local"]
      },
      "nanobot": {
        "enabled": true,
        "configPath": "data/config/nanobot_config.json"
      }
    }
  }
}
```

不要把 Codex/Claude Code 的私有配置塞进 nanobot config。每个 runtime 保留自己的配置入口，code-lite 只保存选择、默认值、权限策略和映射参数。

会话存储：

1. code-lite `ConversationStore` 保存产品视角的消息、事件、审批、artifact。
2. Codex adapter 保存 `thread_id`，必要时用 `thread_read` 做恢复和补齐。
3. Claude adapter 优先实现 `SessionStore`，把 transcript mirror 到 code-lite 后端。
4. nanobot adapter 使用 `session_key`，并把 stream event 同步到 code-lite；native `workspace/sessions/*.jsonl` 只作恢复参考。

### 4.6 cwd 与 SkillBridge

三家都能指定工作目录或 workspace，但“是否自动读取 code-lite 项目 skill”不一致：

1. nanobot：原生读取 `workspace/skills/<skill>/SKILL.md`。
2. Claude Code：SDK 有 `skills` 字段，可启用全部或指定 skill；`setting_sources` 包含 `project` 时才加载项目设置和 `CLAUDE.md`。
3. Codex：支持 `cwd`，并能加载 runtime 自己的 repo 指令和配置；code-lite 的 `skills/` 目录不应假设自动等同于 Codex skill。

建议新增 SkillBridge：

```text
code-lite SkillRegistry
  -> nanobot: workspace/skills
  -> Claude Code: ClaudeAgentOptions.skills + project settings
  -> Codex: developer_instructions 注入、MCP bridge 或 Codex 原生配置
```

Skill 文件不得存放密钥。即使某个 runtime 的 skill filter 隐藏了 skill，文件仍可能被 Read/Bash 读取。

### 4.7 队列与运行中引导

队列建议放在 code-lite：

```text
ConversationTurnManager
  active_turn: AgentTurnHandle | None
  queue: list[QueuedUserMessage]
  policy: enqueue | interrupt | reject
```

默认行为：

1. 当前 turn 正在运行时，后续用户消息进入队列。
2. runtime 完成后，TurnManager 自动取下一条消息开始新 turn。
3. 用户点停止时，调用 adapter `cancel()`，再决定是否继续队列。
4. “引导当前运行”作为高级能力，只有 adapter 明确支持时才开放；否则用“追加到下一轮”实现。

Claude `query(prompt=AsyncIterable[dict])` 可以作为后续探索方向，但不应成为第一版统一协议的强依赖。

## 5. Adapter 落地顺序

建议按风险从低到高推进：

1. 扩展 descriptor/capability schema，让 UI 能展示 runtime 能力和 caveat。
2. 保持 nanobot adapter 为当前稳定基线，补齐 event store 和 session_key 映射。
3. 实现 Claude Code adapter 原型：`ClaudeAgentOptions.cwd`、`setting_sources`、`can_use_tool`、`include_partial_messages`、`SessionStore`。
4. 实现 Codex adapter 原型：优先低层 `CodexClient`，接入 `approval_handler`、`turn_interrupt`、`thread_read`、usage 事件。
5. 实现统一 QueueManager 和 RemoteSyncHub，让 UI 与远程观看只依赖 code-lite event store。
6. 最后再开放 `full_access`，并要求 UI 二次确认和审计记录。

## 6. 当前风险与待验证项

1. Codex 官方文档和 Python SDK 仍在快速变化，当前结论绑定 `openai-codex 0.1.0b2` 与 runtime `0.132.0`。
2. Claude Agent SDK 当前能力非常丰富，但 `permission_mode` 与 settings rules 的组合需要真实 smoke 验证，尤其是“只读模式”的产品语义。
3. nanobot 的 tool approval 能力适合原型，但如果要“拒绝单个工具后继续执行剩余工具”，仍需进一步验证或改造。
4. 三家 native transcript 都可能含敏感路径、命令输出和用户数据，不应直接同步给远程观看端。
5. context window 信息只能 best-effort 展示，不能假设三家都有统一字段。
