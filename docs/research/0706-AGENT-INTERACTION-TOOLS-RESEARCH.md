# Agent 交互工具、Plan 模式与前端展示调研

调研日期：2026-07-06

## 1. 背景

本次调研来自两组真实会话记录：

| Runtime | 会话目录 | 观察 |
| --- | --- | --- |
| Claude Code | `data/record/20260706-213307-31f28aa3f1a24aef` | 看到 `EnterPlanMode`、`Ready to code?`、`Exited Plan Mode`、`Write`、`Read File` 等工具事件和审批事件 |
| Codex | `data/record/20260706-213455-e83dd03ac19241d7` | 只看到文本完成、context usage 和 run completed，看不到计划或工具调用卡片 |

用户实测 Claude Code 让用户做选择时出现：

```text
Error: No such tool available: AskUserQuestion.
AskUserQuestion exists but is not enabled in this context.
```

该错误说明 `AskUserQuestion` 是 Claude Code / Claude Agent SDK 知道的内置交互工具，但在当前 ACP client capability 或 session context 中没有启用。

本次只做调研和文档记录，不修改主代码。

## 2. 调研来源

### 2.1 本地资料

1. `data/record/20260706-213307-31f28aa3f1a24aef/events.ndjson`
2. `data/record/20260706-213307-31f28aa3f1a24aef/native-session.json`
3. `data/record/20260706-213455-e83dd03ac19241d7/events.ndjson`
4. `data/record/20260706-213455-e83dd03ac19241d7/native-session.json`
5. `backend/code_lite_backend/agents/acp/mapper.py`
6. `backend/code_lite_backend/agents/acp/client.py`
7. `backend/code_lite_backend/agents/runtimes/descriptors.py`
8. `@agentclientprotocol/codex-acp@1.1.0` npm 包源码，临时解包到 `%TEMP%\code-lite-acp-research`
9. `@agentclientprotocol/claude-agent-acp@0.55.0` npm 包源码，临时解包到 `%TEMP%\code-lite-acp-research`
10. `@agentclientprotocol/claude-agent-acp@0.56.0` npm 包源码，临时解包到 `%TEMP%\code-lite-acp-research`，用于和 npm 最新版对照

### 2.2 外部资料

1. ACP Agent Plan：`https://agentclientprotocol.com/protocol/v1/agent-plan`
2. ACP Session Modes：`https://agentclientprotocol.com/protocol/v1/session-modes`
3. ACP Tool Calls：`https://agentclientprotocol.com/protocol/v1/tool-calls`
4. Claude Code Tools Reference：`https://code.claude.com/docs/en/tools-reference`
5. Claude Code IAM / tool-specific permission rules：`https://code.claude.com/docs/en/iam`
6. Codex ACP npm README：`https://www.npmjs.com/package/@agentclientprotocol/codex-acp`
7. Claude Agent ACP npm README：`https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp`

说明：OpenAI Codex manual helper 在本机访问 `https://developers.openai.com/codex/codex-manual.md` 时遇到 403，因此 Codex 相关结论优先来自 `codex-acp@1.1.0` README、源码和当前 code-lite 会话暴露的工具能力。

版本说明：本地 Claude record 实际运行 `@agentclientprotocol/claude-agent-acp@0.55.0`；调研时 npm 最新为 `0.56.0`。本文涉及 `EnterPlanMode`、`ExitPlanMode`、`AskUserQuestion`、`current_mode_update`、elicitation gating 的关键逻辑在这两个版本中均存在。

## 3. ACP 标准层能力

ACP 标准里和本次问题直接相关的事件 / 方法有：

| ACP 能力 | 方向 | 含义 | 当前 code-lite 状态 |
| --- | --- | --- | --- |
| `session/update.tool_call` | Agent -> Client | 工具调用开始 | 已映射为 `agent.tool.started` |
| `session/update.tool_call_update` | Agent -> Client | 工具进度或结果 | 已映射为 `agent.tool.delta` / `agent.tool.completed` / `agent.tool.failed` |
| `session/request_permission` | Agent -> Client -> Agent | 工具执行前请求用户审批 | 已映射为 `approval.required` |
| `session/update.usage_update` | Agent -> Client | context / token 使用量更新 | 已映射为 `agent.context.updated` |
| `session/update.plan` | Agent -> Client | 结构化计划 / TODO 状态 | 当前 mapper 未处理 |
| `session/update.current_mode_update` | Agent -> Client | runtime 主动切换或确认当前模式 | 当前 mapper 未处理 |
| ACP elicitation | Agent -> Client -> Agent | 表单、选择、URL 等用户输入请求 | 当前 code-lite 未声明和未处理 |

关键点：

1. Plan 不是只能作为工具调用出现。ACP 标准有独立 `plan` session update。
2. 模式切换不是只能靠 tool result 文本。ACP 标准有 `current_mode_update`。
3. 用户选择 / 表单类交互不应强行复用 `approval.required`，更合适的协议语义是 elicitation 或新的 `agent.input.required` 事件。

## 4. 当前 code-lite mapper 状态

`backend/code_lite_backend/agents/acp/mapper.py` 当前声明式映射表只处理：

```text
agent_message_chunk
agent_thought_chunk
session_info_update
tool_call
tool_call_update
```

`backend/code_lite_backend/agents/acp/client.py` 额外处理：

```text
usage_update -> agent.context.updated
session/request_permission -> approval.required
```

因此以下 ACP update 即使 runtime 发出来，也会被忽略或只能以普通文本形式显示：

```text
plan
current_mode_update
available_commands_update
config_option_update
elicitation / unstable_createElicitation
```

这就是后续前端看不到 Plan 状态、模式变化或用户选择表单的直接实现原因之一。

## 5. Claude Code 调研

### 5.1 Claude Code session capabilities

本地 Claude Code `native-session.json` 返回的 mode / config option 包含：

| mode id | 展示名 | 含义 |
| --- | --- | --- |
| `auto` | Auto | 用模型分类器自动批准或拒绝权限请求 |
| `default` | Default | 标准行为，危险操作询问用户 |
| `acceptEdits` | Accept Edits | 自动接受文件编辑操作 |
| `plan` | Plan Mode | 计划模式，不执行真实工具 |
| `dontAsk` | Don't Ask | 不询问，未预批准则拒绝 |
| `bypassPermissions` | Bypass Permissions | 跳过所有权限检查 |

还返回了：

1. `model` config option。
2. `effort` config option。
3. mode 作为 `configOptions[].id === "mode"` 暴露。

### 5.2 Claude wrapper 确认的工具类型

`@agentclientprotocol/claude-agent-acp@0.55.0/dist/tools.js` 中对下列工具做了显式映射；`0.56.0` 中关键映射仍然存在：

| 工具名 | ACP kind | 展示含义 |
| --- | --- | --- |
| `Agent` / `Task` | `think` | 子任务 / 子 agent |
| `Bash` | `execute` | 终端命令 |
| `Read` | `read` | 读取文件 |
| `Write` | `edit` | 写文件 |
| `Edit` | `edit` | 编辑文件 |
| `Glob` | `search` | 文件模式搜索 |
| `Grep` | `search` | 文本搜索 |
| `WebFetch` | `fetch` | 读取网页 |
| `WebSearch` | `fetch` | 网络搜索 |
| `TodoWrite` | `think`，但 wrapper 转成 `plan` update | 更新 TODO / 计划 |
| `ReportFindings` | `think` | code review findings |
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` | `think`，部分会被压制并转成 `plan` | SDK 任务列表 |
| `ExitPlanMode` | `switch_mode` | 提交计划给用户确认，准备退出计划模式 |
| `AskUserQuestion` | `other`，并可转成 ACP form elicitation | 向用户提出选择题或自由输入题 |
| `Other` | `other` | 未识别工具兜底 |

注意：Claude Code 官方工具能力会随版本变化，上表是 `claude-agent-acp@0.55.0` wrapper 当前显式支持和映射的工具集合，不应写死为永久完整列表。

### 5.3 Claude Plan 模式事件链

本地 record 中，Claude plan 相关事件链为：

```text
agent.tool.started: EnterPlanMode
agent.tool.completed: Entered plan mode...
agent.tool.started: Write
agent.tool.completed: 写入 C:\Users\kevin\.claude\plans\...
agent.tool.started: Ready to code?
approval.required: Ready to code? options=[auto, acceptEdits, default, plan, bypassPermissions]
agent.tool.completed: Exited Plan Mode
```

其中 `ExitPlanMode` 被 wrapper 映射为：

1. tool started 标题：`Ready to code?`
2. kind：`switch_mode`
3. approval options：
   - `bypassPermissions`
   - `auto`
   - `acceptEdits`
   - `default`
   - `plan`
4. tool completed 标题：`Exited Plan Mode`

Claude wrapper 还会在以下场景发送 `current_mode_update`：

1. 用户通过 session mode / config option 切换模式。
2. `ExitPlanMode` 审批选择某个模式。
3. `EnterPlanMode` 的 PostToolUse hook 成功后，将 current mode 更新为 `plan`。

所以用户问“切换到 plan 模式，这个 update 事件有吗？”答案是：有，Claude ACP wrapper 会发送 ACP `session/update.current_mode_update`，但 code-lite 当前 mapper 没处理。

### 5.4 AskUserQuestion 为什么不可用

Claude wrapper 源码显示：

1. `AskUserQuestion` 会作为 Claude Code 内置工具出现。
2. wrapper 只有在 ACP client 声明 `clientCapabilities.elicitation.form` 时，才不禁用它。
3. 如果 client 不支持 form elicitation，wrapper 会把 `AskUserQuestion` 加入 `disallowedTools`。
4. 当可用时，wrapper 会把 `AskUserQuestion` 转为 ACP form elicitation：`unstable_createElicitation(...)`，再把用户回答写回工具 input。

当前 code-lite 的 `_build_client_capabilities()` 只声明：

```python
fs.read_text_file = False
fs.write_text_file = False
terminal = False
```

没有声明 elicitation 能力，也没有 handler。因此 Claude Code 侧会禁用 `AskUserQuestion`。用户实测错误“exists but is not enabled in this context”与 wrapper 源码一致。

## 6. Codex 调研

### 6.1 Codex session capabilities

本地 Codex `native-session.json` 返回：

| mode id | 展示名 | 含义 |
| --- | --- | --- |
| `read-only` | Read-only | 编辑文件和运行命令需要审批 |
| `agent` | Agent | 读写文件并运行命令 |
| `agent-full-access` | Agent full access | 可访问 workspace 外路径并使用网络 |

config option 包含：

1. `mode`
2. `model`
3. `reasoning_effort`
4. `fast-mode`

### 6.2 Codex ACP wrapper 声称支持的事件类型

`@agentclientprotocol/codex-acp@1.1.0` README 明确列出支持：

1. shell command
2. file change
3. permission request
4. MCP tool call
5. terminal output
6. reasoning
7. plan
8. web search
9. image generation
10. image view
11. token usage
12. review events

它还支持 slash commands：

```text
/status
/mcp
/skills
/review
/review-branch
/review-commit
/compact
/goal
/logout
```

### 6.3 Codex wrapper 对 Plan 的映射方式

`codex-acp@1.1.0/dist/index.js` 中 `CodexEventHandler` 对 Codex thread item 的映射包括：

```text
fileChange -> tool_call
commandExecution -> tool_call / tool_call_update
mcpToolCall -> tool_call
dynamicToolCall -> tool_call
collabAgentToolCall -> tool_call
webSearch -> tool_call
imageView -> tool_call
imageGeneration -> tool_call
contextCompaction -> agent_message_chunk("Context compacted.")
plan -> agent_message_chunk("Plan:\n...")
```

关键差异：Codex wrapper 把 `plan` thread item 转成普通 `agent_message_chunk`，而不是 ACP `plan` update，也不是 `tool_call`。

这解释了本地 Codex record 中“看不到工具调用”的一部分原因：用户要求“起一个计划并展示确认”，Codex 可能只是用文本回答，或 wrapper 即使遇到 Codex 内部 plan item，也会把它变成普通 assistant 文本。

### 6.4 Codex 内置工具视角

从 `codex-acp@1.1.0` 的 function-call fallback 和当前 Codex 会话暴露的工具看，Codex 工具可分为几类：

| 类别 | 例子 | ACP 展示 |
| --- | --- | --- |
| shell / command | `exec_command` 或当前 Codex 环境中的 shell tool | `tool_call` kind=`execute`，或 terminal 相关 update |
| patch / edit | `apply_patch` | `tool_call` kind=`edit` |
| image / view | `view_image`、image view | `tool_call` kind=`read` 或 image update |
| parallel tools | `multi_tool_use.parallel` | `tool_call` kind=`execute` |
| web / search | web search | `tool_call` kind=`search` |
| MCP / dynamic tools | MCP tools、dynamic tool calls | `tool_call` |
| review / goal / compact | slash command 或 app-server event | 文本、tool、context update，取决于 wrapper |
| plan | Codex app-server plan item | 当前 wrapper 转普通文本 |

Codex 当前会话里的 `update_plan`、`request_user_input`、`create_goal`、`update_goal` 等工具属于 Codex host / client context 中提供给模型的工具，不等同于 ACP 标准 tool surface，也不保证会被 `codex-acp` 作为 `tool_call` 透传。

## 7. 为什么拿不到 Codex 的 tool 调用情况

本次结论分成四层：

### 7.1 该 turn 可能根本没有触发 Codex 工具

本地 Codex record 的三轮 turn 都没有 `agent.tool.*`。如果模型只是用文本回答“我可以给你计划”，或内部计划没有以外显工具形式执行，ACP client 自然拿不到 tool call。

### 7.2 Codex Plan 被 wrapper 降级为普通文本

`codex-acp@1.1.0` 对内部 `plan` item 的处理是：

```text
createPlanUpdate(item) -> sessionUpdate: "agent_message_chunk", text: "Plan:\n..."
```

所以即便 Codex 内部有 plan item，code-lite 当前也只能当 assistant 正文显示，不能识别为结构化 plan。

### 7.3 Codex host 工具不等于 ACP tool_call

Codex 模型可用的 host 工具，例如 `update_plan`、`request_user_input`、`apply_patch`、`shell_command` 等，是当前 Codex 运行环境提供给模型的工具集合。ACP wrapper 只能映射 Codex App Server 向外暴露的 thread items、notifications 和 function-call fallback。

因此：

```text
模型内部调用 host tool
  不一定等于
codex-acp 发出 ACP session/update.tool_call
```

当前 code-lite 是 ACP client，不是 Codex host UI 本体，不能假设所有 Codex 原生工具都会作为 ACP tool_call 出现。

### 7.4 当前 mapper 也漏掉了部分 ACP 标准事件

即使 Codex 或 Claude 发了 `plan` / `current_mode_update`，当前 `AcpEventMapper` 也不会输出前端事件。这不是 Codex 独有问题，而是统一 ACP mapper 还没覆盖完整交互事件族。

## 8. 前端是否需要特殊处理

建议分两层处理：先做协议级通用事件，再做少量 runtime-specific enrich。

### 8.1 应新增的通用前端事件

| 新事件 | 来源 | 用途 |
| --- | --- | --- |
| `agent.plan.updated` | ACP `plan`，以及 runtime-specific plan 文本探测 | 展示计划 / TODO 列表，不混在普通工具卡或正文里 |
| `agent.mode.updated` | ACP `current_mode_update` | 更新 composer 的 mode chip / session config |
| `agent.input.required` | ACP elicitation form / url | 展示用户选择、问题、自由输入表单 |
| `agent.command.available.updated` | ACP `available_commands_update` | 更新 slash commands / skill commands 列表 |
| `agent.config.updated` | ACP `config_option_update` | 同步模型、effort、fast mode 等动态配置变化 |

### 8.2 Claude Code 特殊处理建议

Claude 的特殊点不是要在前端写大量 `if claude_code`，而是要识别 wrapper 已经暴露的语义：

1. `tool.kind === "switch_mode"` 或 `tool.name === "Ready to code?"` 应渲染为“计划确认卡”，而不是普通工具卡。
2. `approval.required.metadata.options` 对 Claude plan approval 是真实模式选择，按钮应展示 option name，而不是只有 allow / deny。
3. `AskUserQuestion` 应走 `agent.input.required` 或 ACP elicitation，不应走普通 approval。
4. `current_mode_update` 应更新前端当前 mode，避免用户看到仍处于旧模式。
5. `TodoWrite` / `TaskCreate` / `TaskUpdate` 产生的 ACP `plan` update 应显示为任务计划列表。

### 8.3 Codex 特殊处理建议

Codex 侧建议更克制：

1. 优先支持真实 ACP `tool_call`、`tool_call_update`、`permission`、`usage_update`。
2. 对 `agent_message_chunk` 中以 `Plan:\n` 开头的文本，可以 best effort 识别为 `agent.plan.updated`，但要标记 `source=codex-acp.agent_message_chunk`。
3. 不要假设 Codex 的 `update_plan` 一定能通过 ACP 看到。前端不能依赖它来展示进度。
4. 如果用户需要 Codex 计划确认体验，可以在 code-lite 产品层提供独立“计划确认”协议，而不是等待 Codex host tool 透传。
5. `/goal`、`/review`、`/compact` 等 Codex slash command 可作为 command capabilities 展示，但执行结果仍按 wrapper 实际事件处理。

## 9. 后续实现建议

### 9.1 Backend mapper

建议在 `AcpEventMapper` 增加：

```text
plan -> agent.plan.updated
current_mode_update -> agent.mode.updated
available_commands_update -> agent.command.available.updated
config_option_update -> agent.config.updated
```

并在 raw observer / diagnostics 中保留未知 `session_update` 的 kind 和简要 payload，避免将来 wrapper 新增事件时静默丢失。

### 9.2 Client capabilities

当前 `_build_client_capabilities()` 应评估增加：

```text
elicitation.form = true
elicitation.url = false 或按 UI 能力决定
session.configOptions.boolean = true 或按 UI 控件能力决定
_meta.terminal_output = true 或待 terminal UI 准备好后启用
```

在没有 `agent.input.required` UI 前，不建议贸然打开 elicitation.form，否则 `AskUserQuestion` 会开始进入客户端但无法正确展示和回传。

### 9.3 Approval UI

当前 allow / deny 二元审批不够表达 Claude plan approval。

建议：

1. `approval.required.options` 原样进入前端。
2. UI 支持 option buttons，例如 “Yes, and use auto mode”、“No, keep planning”。
3. fallback 仍保留 allow / deny：
   - allow -> 优先 `allow_once`
   - deny -> 优先 `reject_once`
4. 对 `kind=switch_mode` 的审批卡显示 plan Markdown 内容。

### 9.4 Plan UI

建议统一支持两类 plan：

1. 结构化 entries：来自 ACP `plan`，适合 TODO list。
2. Markdown plan：来自 Claude `ExitPlanMode.rawInput.plan` 或 Codex `Plan:\n...` 文本。

前端可以复用同一计划面板，但在 metadata 中标记：

```json
{
  "source": "acp.plan | claude.exit_plan_mode | codex.plan_text",
  "runtime": "claude_code | codex"
}
```

### 9.5 Session state

`agent.mode.updated` 和 `agent.config.updated` 应写入 session record，避免 reload 后 UI mode 与 runtime mode 不一致。

## 10. 风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| Runtime tool 集合随版本变化 | Claude / Codex wrapper 都会升级工具映射 | 不在前端硬编码完整工具列表，只按 kind / metadata 渲染 |
| `AskUserQuestion` 打开后需要完整 UI | 只声明 capability 不实现表单会导致交互中断 | 先实现 `agent.input.required` 再启用 |
| Codex plan 目前不是结构化 ACP plan | wrapper 把 plan 变成文本 | best effort 识别，不能作为强协议 |
| 权限不是强安全边界 | ACP permission 是 Agent 主动请求 | gateway mode 才能做硬拦截 |
| Mode update 被忽略会造成 UI 状态错乱 | Claude plan 进入/退出会发 mode update | mapper 和 recorder 必须支持 |

## 11. 结论

1. Claude Code 的 plan 模式、退出计划确认和用户选择，本质上已经通过 ACP tool call、permission request、current mode update、elicitation 这些机制暴露出来。
2. `AskUserQuestion` 当前不可用，是因为 code-lite 没声明和实现 ACP form elicitation；Claude wrapper 在这种情况下会禁用该工具。
3. Codex 与 Claude 的差异很大：Codex wrapper 支持工具事件，但 plan item 当前会转成普通文本；Codex host tool 调用也不保证透传为 ACP tool_call。
4. code-lite 前端不应为每个 runtime 硬编码完整工具清单，应先补齐 ACP 标准事件族：plan、mode、config、commands、elicitation。
5. 需要对 Claude `switch_mode` / `ExitPlanMode` 做轻量特殊展示，对 Codex `Plan:\n` 文本做 best effort 识别，但这些都应建立在统一事件模型之上。
