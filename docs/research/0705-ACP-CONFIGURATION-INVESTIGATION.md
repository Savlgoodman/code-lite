# ACP 配置与 Claude Code 模型名称调研

> 调研日期：2026-07-05
> 调研范围：code-lite 当前 ACP runtime 启动、配置来源、Claude Code 模型展示名称

## 1. 当前结论

code-lite 当前不是直接调用 Codex 或 Claude Code CLI，而是作为 ACP client 启动对应的 ACP server wrapper，并通过 stdio 上的 JSON-RPC 与它通信。

在 Windows 上，Codex 的托管入口通常是：

```text
H:\code-lite\data\runtimes\acp\codex-acp\1.1.0\node_modules\.bin\codex-acp.cmd
```

这个 `.cmd` 不是业务逻辑本身，而是 npm 在 Windows 下生成的 launcher shim。它负责找到包内真正的 Node 入口，例如 `@agentclientprotocol/codex-acp/dist/index.js`，再把 stdio 暴露给 code-lite 的 ACP client。

Claude Code 同理，通过 `claude-agent-acp.cmd` 启动 `@agentclientprotocol/claude-agent-acp`。

## 2. Runtime launcher 与 ACP 命令

Runtime launcher 是“可执行入口”，解决三个问题：

1. 隐藏 Node 包真实入口路径，避免后端硬编码 `node_modules/@agentclientprotocol/.../dist/index.js`。
2. 保持 npm 包的跨平台 bin 机制，Windows 用 `.cmd`，Unix-like 系统用无扩展名 shim。
3. 让 code-lite 只需要保存一个 command list，例如 `["...\codex-acp.cmd"]`，后续由 ACP SDK 作为子进程启动。

ACP 命令指的不是普通聊天命令，而是 code-lite 用来启动 ACP server 的进程命令。进程启动后，真实交互走 ACP JSON-RPC：

```text
initialize
session/new 或 session/load
session/setMode
session/setConfigOption
session/prompt
session/update
```

也就是说，`.cmd` 只负责把 ACP server 拉起来；模型、权限模式、推理强度等运行时配置主要通过 ACP session capabilities 和后续 JSON-RPC 方法传递。

## 3. 用户配置来源

code-lite 自身的运行时配置来自 data dir：

```text
data/config/agent_runtimes.json
data/runtimes/acp/<runtime>/<version>/
data/record/<conversation_id>/native-session.json
```

Codex 的用户配置是否使用 `~/.codex` 取决于 `configMode`：

| configMode | 行为 |
| --- | --- |
| `user-native` | 不设置 `CODEX_HOME`，由 Codex 使用用户原生 `~/.codex` |
| `isolated` | 设置 `CODEX_HOME=<data_dir>/runtime-state/codex-home` |

Claude Code 当前走用户原生环境，通常会使用用户的 `~/.claude` 配置和运行记录。code-lite 不应主动解析 `~/.claude/projects/*.jsonl` 作为产品功能的主数据源。

## 4. Claude Code 模型名称

Claude Code ACP 的模型列表不一定出现在顶层 `models.availableModels`，而是会出现在 `session/new` 返回的 `configOptions` 中：

```json
{
  "id": "model",
  "type": "select",
  "currentValue": "default",
  "options": [
    { "name": "Default (recommended)", "value": "default" },
    { "name": "claude-opus-4-8", "value": "opus" },
    { "name": "claude-sonnet-5", "value": "sonnet" }
  ]
}
```

这些 `name` 来自 Claude Code 运行时环境，例如：

```text
ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
```

因此，Claude Code 的前端展示名称应使用 `options[].name`，发送给 runtime 的值仍使用 `options[].value`。

当前约定：

1. 不在前端展示 `value=default` 的模型选项。
2. 当 Claude Code 返回 `currentValue=default` 时，code-lite 默认选中 `sonnet`。
3. `messages.json` 中 Claude Code 的 `model.model` 和 `model.label` 记录真实展示名，例如 `claude-sonnet-5`。
4. `messages.json` 中保留 `model.runtimeModel` 作为发送给 ACP 的短值，例如 `sonnet`。

## 5. 关于 Claude JSONL

Claude Code 的 `~/.claude/projects/*.jsonl` 中确实能看到真实模型名和 native message id。调研中也确认过 ACP 事件里的部分 message id 与 Claude JSONL 里的 `message.id` 有对应关系。

但当前实现不采用 JSONL 解析作为主路径，原因是：

1. JSONL 是 Claude Code 的本地转录记录，不是 ACP 协议承诺的能力。
2. 路径、写入时机和清理策略由 Claude Code 控制，code-lite 依赖它会比较脆。
3. `session/new` 的 `configOptions.model.options[].name` 已经能提供展示所需的真实模型名称。

JSONL 可以作为调试证据，但产品路径应优先使用 ACP native session capabilities。
