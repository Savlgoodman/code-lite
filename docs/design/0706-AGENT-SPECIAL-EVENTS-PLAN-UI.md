# Agent 特殊交互事件与计划面板展示说明

创建日期：2026-07-06

本文记录本轮对 ACP 特殊交互事件、runtime 原始事件记录、Codex / Claude Code 计划事件映射，以及前端计划面板展示的实现约定。它是 `docs/research/0706-AGENT-INTERACTION-TOOLS-RESEARCH.md` 的实现收口文档。

## 1. 背景

Claude Code 和 Codex 通过 ACP 接入后，普通文本、工具调用、审批和 token usage 已经能进入 code-lite 统一事件流。但 plan 模式、当前模式切换、可用命令、动态配置、用户选择和未知 JSON-RPC 消息不完全等价于普通工具调用。

上一轮现象是：

1. Claude Code 的 plan 模式可以看到 `Ready to code?`、`Exited Plan Mode` 等工具和审批，但前端没有专门计划视图。
2. Claude Code 切换 plan 模式会有 `current_mode_update`，但 mapper 没处理时前端不会知道模式已变化。
3. Codex 的 `update_plan` host tool 不一定通过 ACP 作为 tool call 暴露；`codex-acp@1.1.0` 内部 plan item 当前会转成 `Plan:\n...` 文本。
4. 未适配的 ACP update 或 JSON-RPC method 如果被静默忽略，后续就无法从 record 里复盘。

因此本轮目标不是“只适配已知两个 plan case”，而是让特殊事件进入统一事件流、落盘记录，并给计划类事件一个轻量展示面板。

## 2. 事件分层

code-lite 当前按三层理解 agent 交互事件：

| 层级 | 示例 | 处理策略 |
| --- | --- | --- |
| ACP 标准事件 | `plan`、`current_mode_update`、`available_commands_update`、`config_option_update`、`tool_call` | 映射为统一 `agent.*` 事件 |
| runtime-specific 语义 | Claude `ExitPlanMode.rawInput.plan`、Codex `Plan:\n...` 文本 | best effort 提取为统一 plan snapshot，并标记 source |
| 未适配原始事件 | 新增 session update kind、非 session/update JSON-RPC request / notification | 不拦截、不丢弃，脱敏后转为 raw event 并记录 |

这里的关键原则是：前端只消费统一事件，但 recorder 和 runtimeEvents 也保存原始线索。这样未来适配 Claude form elicitation、Codex review event 或 opencode 私有事件时，不需要重新复现当时会话。

## 3. 新增统一事件

### 3.1 `agent.plan.updated`

用途：更新当前 assistant 消息上的计划快照。

来源：

1. ACP 标准 `session/update.plan`。
2. Claude Code `approval.required` 或 tool payload 中的 `rawInput.plan`。
3. Claude Code 已批准计划结果中的 `## Approved Plan`。
4. Codex `agent_message_chunk` 中以 `Plan:\n` 开头的计划文本。

计划结构：

```json
{
  "type": "agent.plan.updated",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "plan": {
    "entries": [
      {"id": "plan-entry-0", "content": "创建测试计划", "status": "completed", "priority": "medium"},
      {"id": "plan-entry-1", "content": "观察客户端展示", "status": "in_progress", "priority": "medium"}
    ],
    "markdown": "...",
    "source": "acp.plan | acp.permission.switch_mode | codex-acp.agent_message_chunk"
  }
}
```

`entries` 是前端计划面板的主数据。只有 markdown 时，前端会解析 checkbox、编号列表和步骤标题作为 fallback。

### 3.2 `agent.mode.updated`

用途：同步 runtime 当前模式，尤其是 Claude Code 进入或退出 plan mode 后更新 composer 权限模式。

来源：ACP 标准 `current_mode_update`。

前端行为：

1. 更新当前会话的 `accessMode`。
2. 将事件写入 assistant message 的 `runtimeEvents`。
3. 不插入普通文本，避免模式变化打断对话正文。

### 3.3 `agent.command.available.updated`

用途：同步 runtime 当前可用 slash commands 或命令能力。

来源：ACP 标准 `available_commands_update`。

前端行为：更新当前会话 capabilities 中的 `commands`，让 composer 左侧快捷指令菜单能显示 runtime 提供的命令。

### 3.4 `agent.config.updated`

用途：保存 runtime 动态配置更新，例如模型、effort、fast mode 等配置项变化。

来源：ACP 标准 `config_option_update`。

当前前端只记录，不主动重绘所有配置控件。后续可把它接入 session capabilities 的增量更新。

### 3.5 `agent.raw.update`

用途：保存未知 `session/update`。

来源：mapper 收到不在映射表内的 ACP update kind。

策略：

1. 生成统一事件并推给前端。
2. 写入 assistant message 的 `runtimeEvents`。
3. 写结构化 ACP 日志，字段包含 `updateKind`。
4. raw payload 通过 `sanitize_log_value` 脱敏。

### 3.6 `agent.raw.rpc`

用途：保存 ACP SDK 未建模或 code-lite 未适配的原始 JSON-RPC request / notification。

来源：ACP raw observer 观察到非 `session/update` 的 incoming method，或未知 session update。

策略：

1. 不阻止 SDK 原本路由。
2. 不因为前端暂不认识该 method 就丢弃。
3. 写入 `runtimeEvents` 和结构化 ACP 日志。
4. payload 脱敏并限制在 recorder 最近 200 条 runtime event 内。

这个事件是后续排查 “AskUserQuestion exists but is not enabled in this context” 这类问题的关键证据。即便当前不启用 elicitation，也要能知道 runtime 是否尝试发起过对应 JSON-RPC。

## 4. Backend 映射和记录

### 4.1 Mapper

`backend/code_lite_backend/agents/acp/mapper.py` 负责：

1. 将 ACP `plan` 映射为 `agent.plan.updated`。
2. 将 `current_mode_update` 映射为 `agent.mode.updated`。
3. 将 `available_commands_update` 映射为 `agent.command.available.updated`。
4. 将 `config_option_update` 映射为 `agent.config.updated`。
5. 将未知 update 映射为 `agent.raw.update`。
6. 从 Claude switch mode 工具 payload 和 Codex `Plan:\n` 文本中提取 plan snapshot。

### 4.2 ACP client

`backend/code_lite_backend/agents/acp/client.py` 负责：

1. raw observer 记录 incoming JSON-RPC。
2. 对未知 session update 生成 `agent.raw.rpc`。
3. 对非 `session/update` 的 request / notification 生成 `agent.raw.rpc`。
4. 对 usage update 继续生成 `agent.context.updated`。

这满足“不拦截任何工具调用，包括未适配展示项函数，统统接受并丢过来记录”的要求。这里的“不拦截”指 code-lite 不因为 UI 未适配而丢弃或阻断可观察事件；runtime 是否真正执行仍由 ACP SDK、runtime 自身权限和 code-lite gateway 能力决定。

### 4.3 Recorder

`backend/code_lite_backend/services/conversation_recorder.py` 负责：

1. 将 plan 保存到 assistant message 的 `plan` 字段。
2. 将 mode / config / commands / raw events 保存到 `runtimeEvents`。
3. runtimeEvents 保留最近 200 条，避免长会话无限膨胀。

record 目录中未来应能同时看到：

1. 用户可读的 assistant 文本。
2. 可展示的 plan snapshot。
3. 可追溯的 runtimeEvents。

## 5. 前端展示

### 5.1 计划面板位置

计划面板由 `ui/src/features/chat/PlanProgressPanel.tsx` 渲染，挂在 composer stack 中，位于输入框上方、一键到底按钮下方的视觉区域。滚动区通过 `:has(.plan-progress-panel)` 增加底部 padding，避免最后一条消息被 composer 和计划面板遮挡。

### 5.2 折叠态

折叠态设计目标是轻量、不遮挡正文：

1. 面板宽度约为输入框的三分之一。
2. 半透明背景和 blur，降低视觉遮挡。
3. 不展示独立展开按钮，点击面板任意区域即可展开。
4. 仅展示 `in_progress` 的计划项；没有进行中项时展示最靠前的未完成项；都完成后展示第一项。
5. 文本单行省略，避免长计划撑开布局。

### 5.3 展开态

展开态展示所有计划项：

1. 宽度扩展到输入框宽度。
2. 列表可滚动。
3. 点击面板再次收起。
4. header 保留 `进度` 和 `completed/total` 计数。

### 5.4 状态图形

计划项状态约定：

| status | 展示 |
| --- | --- |
| `completed` | 实心圆加 check |
| `in_progress` | 转动圆环加呼吸外圈 |
| `pending` | 空心圆 |

这里不依赖 runtime 名称，只依赖 `PlanEntry.status`。

## 6. 兼容与风险

1. `:has(...)` 需要现代 Chromium / WebView2 支持。当前 Tauri 2 Windows 桌面壳基于现代 WebView2，风险可接受；如后续要支持旧 WebView，可改为在 `chat-workspace` 上显式挂 class。
2. Codex plan 文本识别是 best effort。它不能证明 Codex host `update_plan` 已经完整透传，只能把 wrapper 暴露出的 `Plan:\n` 文本转成计划面板。
3. Claude `AskUserQuestion` 仍未启用。打开 elicitation 前必须先实现 `agent.input.required` UI 和回传路径。
4. raw event 记录会增加 record 体积，但当前只保留 message runtimeEvents 最近 200 条，并且结构化日志会脱敏。
5. ACP permission 不是强安全边界。强拦截仍依赖后续 gateway mode。

## 7. 验收

本轮完成后应满足：

1. Claude Code plan approval 的计划内容可以显示在计划面板。
2. ACP 标准 `plan` 可以显示在计划面板。
3. Codex `Plan:\n...` 文本可以 best effort 显示在计划面板。
4. `current_mode_update` 能更新当前会话 mode。
5. 未知 update 和未适配 JSON-RPC 能进入 record 和日志，不再一无所知。
6. 计划面板折叠态为输入框约三分之一宽，单行省略；展开态显示全部计划。

