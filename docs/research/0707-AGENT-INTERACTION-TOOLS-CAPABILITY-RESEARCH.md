# Claude Code 交互工具在 ACP 模式下不可用问题调研

调研日期：2026-07-07

## 1. 背景

用户在 code-lite 中继续测试 Claude Code 的 plan 模式和“让用户做选择”的交互能力，触发 `AskUserQuestion` 时得到错误：

```text
Error: No such tool available: AskUserQuestion.
AskUserQuestion exists but is not enabled in this context.
```

该现象说明两件事：

1. `AskUserQuestion` 是 Claude Code / Claude Agent SDK 知道的内置工具。
2. 当前 code-lite 通过 ACP 启动 Claude Code 时，相关上下文没有启用该工具。

本文在 `docs/research/0706-AGENT-INTERACTION-TOOLS-RESEARCH.md` 的基础上，针对这次实测错误补充根因、当前实现状态和后续实现建议。

## 2. 结论摘要

1. `AskUserQuestion` 当前不可用的直接原因是：code-lite 初始化 ACP client 时没有声明 `clientCapabilities.elicitation.form`，Claude ACP wrapper 因此把 `AskUserQuestion` 加入 `disallowedTools`。
2. 这不是普通工具卡展示缺失，也不是 `session/request_permission` 审批卡缺失；`AskUserQuestion` 在 ACP 语义上应走 `elicitation/create` 表单交互。
3. 当前 code-lite 后端没有实现 `elicitation_create` / `elicitation_complete` handler，也没有前端 `agent.input.required` 表单 UI 和回传 API，因此不应只靠打开 capability 解决。
4. Claude Code 的 plan 模式确认链路与 `AskUserQuestion` 不完全相同：`ExitPlanMode` 走 `session/request_permission`，`EnterPlanMode` / 退出后模式变化走 `current_mode_update`；当前 dev 分支已经对 plan、mode、commands、config、raw RPC 做了映射和记录。
5. 更准确地说，“ACP 模式下有些工具没开启”主要不是 ACP 协议禁止，而是 wrapper 根据 client capabilities 做能力协商；client 没声明或没实现的交互面，runtime 会降级、禁用或改走错误路径。

## 3. 当前 code-lite 代码证据

### 3.1 Client capabilities 未声明 elicitation

`backend/code_lite_backend/agents/acp/adapter.py` 的 `_build_client_capabilities()` 只声明：

```python
return acp_schema.ClientCapabilities(
    fs=acp_schema.FileSystemCapabilities(
        read_text_file=False,
        write_text_file=False,
    ),
    terminal=False,
)
```

`backend/code_lite_backend/agents/acp/runtime_manager.py` 中常驻连接初始化也直接构造了同等能力：

```python
client_capabilities=acp_schema.ClientCapabilities(
    fs=acp_schema.FileSystemCapabilities(
        read_text_file=False,
        write_text_file=False,
    ),
    terminal=False,
)
```

因此当前 code-lite 明确处在 compat mode：不提供 filesystem gateway、不提供 terminal gateway，也不提供 elicitation gateway。

### 3.2 当前 handler 没有 elicitation 方法

`backend/code_lite_backend/agents/acp/client.py` 当前实现了：

1. `session_update`
2. `request_permission`
3. `read_text_file`
4. `write_text_file`
5. terminal 相关方法
6. raw JSON-RPC observer

但没有实现：

```text
elicitation_create
elicitation_complete
```

本地 Python ACP SDK 的 `CLIENT_METHODS` 中已经包含：

```text
elicitation_create
elicitation_complete
```

并且 `ClientCapabilities` schema 已包含：

```text
elicitation: ElicitationCapabilities | None
```

也就是说协议和 SDK 能承载这类交互，但 code-lite 的 client handler 和 UI 尚未接上。

### 3.3 Plan / mode 相关实现已经推进

昨天的研究报告中提到 mapper 尚未处理 `plan` 和 `current_mode_update`。当前 dev 分支已经有新实现：

1. `plan -> agent.plan.updated`
2. `current_mode_update -> agent.mode.updated`
3. `available_commands_update -> agent.command.available.updated`
4. `config_option_update -> agent.config.updated`
5. 未知 update / JSON-RPC -> `agent.raw.update` / `agent.raw.rpc`

前端 `ui/src/types.ts` 和 `ui/src/pages/ChatPage.tsx` 也已支持这些事件，并将 plan 展示到 `PlanProgressPanel`。

所以本次 `AskUserQuestion` 问题的缺口更集中在 elicitation，而不是 plan/mode 普通 update 映射。

## 4. 上游 Claude ACP wrapper 证据

调研版本：

| 包 | 当前版本 |
| --- | --- |
| `@agentclientprotocol/claude-agent-acp` | `0.56.0` |
| `@agentclientprotocol/codex-acp` | `1.1.0` |
| `@agentclientprotocol/sdk` | `1.2.0` |

### 4.1 `AskUserQuestion` 被 form elicitation gate 控制

`@agentclientprotocol/claude-agent-acp@0.56.0` 的 `dist/acp-agent.js` 中，wrapper 会读取 client 声明：

```javascript
const elicitationSupport = {
  form: !!this.clientCapabilities?.elicitation?.form,
  url: !!this.clientCapabilities?.elicitation?.url,
};
const disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"];
```

这说明只要 client 没声明 `elicitation.form`，Claude wrapper 就会主动禁用 `AskUserQuestion`。

### 4.2 `AskUserQuestion` 可用时会转成 ACP form elicitation

同一 wrapper 在 `canUseTool` 中有特殊处理：

```javascript
if (toolName === "AskUserQuestion" && this.clientCapabilities?.elicitation?.form) {
  await this.ensureToolCallEmitted(sessionId, toolName, toolUseID, toolInput);
  return this.handleAskUserQuestion(sessionId, toolInput, toolUseID, signal);
}
```

`handleAskUserQuestion` 会：

1. 从工具输入中提取 questions。
2. 生成 `mode: "form"` 的 `CreateElicitationRequest`。
3. 调用 `this.client.unstable_createElicitation(...)`。
4. 把用户回答写回工具的 `updatedInput`。

这条链路证明 `AskUserQuestion` 不应被映射成普通 allow/deny 审批。它需要一个“展示问题、选项、其他输入、接受/跳过/取消”的表单交互面。

### 4.3 `ExitPlanMode` 仍然走 permission request

Claude wrapper 对 `ExitPlanMode` 的路径不同：它会构造 `session/request_permission` 的 options，例如：

```text
auto
acceptEdits
default
plan
bypassPermissions
```

用户选择某个可执行模式后，wrapper 再发送：

```text
session/update.current_mode_update
```

因此 plan 模式确认属于“权限/模式切换审批”，而 `AskUserQuestion` 属于“用户输入 elicitation”。两者在 UI 上都像“问用户”，但协议语义和回传方式不同。

## 5. ACP 协议层语义

当前 Python ACP SDK 暴露的 client 方法包括：

```text
session_update
session_request_permission
fs_read_text_file
fs_write_text_file
terminal_create/output/wait_for_exit/kill/release
elicitation_create
elicitation_complete
```

可见 ACP 把几类“客户端参与”分开：

| 能力 | ACP 方法 | code-lite 现状 | 语义 |
| --- | --- | --- | --- |
| 流式事件 | `session/update` | 已实现 | agent 向 client 推送文本、工具、计划、模式等事件 |
| 工具审批 | `session/request_permission` | 已实现基础 allow/deny | agent 执行工具前请求授权 |
| 文件网关 | `fs/read_text_file` / `fs/write_text_file` | capability 关闭，handler 拒绝 | client 托管文件读写 |
| 终端网关 | `terminal/*` | capability 关闭，handler 拒绝 | client 托管命令执行 |
| 用户输入 | `elicitation/create` / `elicitation/complete` | 未声明、未实现 | agent 请求用户填写表单或完成 URL 交互 |

`AskUserQuestion` 正好落在最后一类。

## 6. 为什么会出现 “exists but is not enabled”

完整链路如下：

```text
code-lite initialize
  -> clientCapabilities 只声明 fs=false、terminal=false
  -> 没有 clientCapabilities.elicitation.form

claude-agent-acp initialize/session
  -> 读取 clientCapabilities
  -> 判断 form elicitation 不可用
  -> disallowedTools += ["AskUserQuestion"]

Claude Code 模型尝试使用 AskUserQuestion
  -> Claude runtime 知道该工具存在
  -> 但当前 session 上该工具被禁用
  -> 返回 “exists but is not enabled in this context”
```

所以这不是 code-lite 前端漏显示某个 `agent.raw.rpc`。在这个失败路径里，wrapper 很可能根本不会向 client 发起 `elicitation/create`，因为它已经在工具暴露层把 `AskUserQuestion` 禁掉了。

## 7. 对其他工具的启示

本次问题说明 runtime 内置工具可以分成三类：

| 类型 | 示例 | 能否在当前 code-lite 用 |
| --- | --- | --- |
| runtime 原生工具，wrapper 可直接映射 | `Read`、`Write`、`Bash`、`TodoWrite`、`ExitPlanMode` | 大多可用，取决于 runtime 权限和 wrapper 映射 |
| client gateway 工具 | ACP `fs/*`、`terminal/*` | 当前声明关闭，runtime 不应依赖 code-lite 执行 |
| client interaction 工具 | `AskUserQuestion`、MCP elicitation、fallback dialog | 当前声明关闭，因此 wrapper 会禁用或自动 decline |

因此不能只问“Claude Code 有没有这个工具”。还要问：

1. ACP wrapper 是否把它暴露到该 session。
2. 它是否依赖 client capability。
3. code-lite 是否声明了对应 capability。
4. code-lite 是否真正实现了回调 handler、UI 和回传 API。

## 8. Codex 对照更新

重新核对 `@agentclientprotocol/codex-acp@1.1.0` 后，需要对昨天报告中的 Codex plan 结论做一个收窄：

1. `codex-acp@1.1.0` README 明确声明支持 plan events。
2. 源码中 `turn/plan/updated` 会映射为：

```text
sessionUpdate: "plan"
entries: [...]
```

3. Codex thread item 中的 `plan` 也有 `createPlanUpdate(item)` 路径。

因此更准确的结论是：

1. Codex host tool 与 ACP tool call 仍不能简单等同。
2. 但 Codex ACP 确实有标准 `session/update.plan` 输出路径。
3. code-lite 当前 mapper 已支持 `plan`，也保留了 `Plan:\n...` 文本的 best effort 解析作为 fallback。

## 9. 实现建议

### 9.1 不要立即只打开 `elicitation.form`

只把 capability 改成：

```python
elicitation=acp_schema.ElicitationCapabilities(
    form=acp_schema.ElicitationFormCapabilities(),
)
```

会让 Claude wrapper 开始向 code-lite 发 `elicitation/create`，但如果 handler 和 UI 没实现，turn 会卡住、报错或自动拒绝。正确顺序应是先补完整链路，再启用 capability。

### 9.2 新增统一事件 `agent.input.required`

建议后端将 ACP `CreateFormElicitationRequest` 映射为：

```json
{
  "type": "agent.input.required",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "inputRequestId": "elicitation-...",
  "mode": "form",
  "message": "请选择实现方案",
  "schema": {},
  "toolCallId": "toolu_...",
  "metadata": {
    "runtime": "claude_code",
    "source": "acp.elicitation.create"
  }
}
```

前端展示表单后，用户选择应回传：

```json
{
  "action": "accept",
  "content": {
    "question_0": "方案 A",
    "question_0_custom": ""
  }
}
```

同时支持：

```text
decline：用户跳过问题，Claude wrapper 会给 AskUserQuestion 写入空 answers
cancel：用户取消，tool use aborted
```

### 9.3 新增 InputBroker

可以仿照 `ApprovalBroker` 增加 `InputBroker`：

```text
create(input_request_id, conversation_id, turn_id)
resolve(input_request_id, action, content)
reject_all()
```

区别是 `ApprovalBroker` 返回 bool，而 `InputBroker` 返回 ACP elicitation response。

### 9.4 后端 handler

在 `AcpClientHandler` 增加：

```python
async def elicitation_create(self, params..., session_id: str, **kwargs) -> Any:
    ...

async def elicitation_complete(self, params..., session_id: str, **kwargs) -> None:
    ...
```

具体签名需以 `agent-client-protocol` Python SDK handler 调用方式为准。建议先用 mock agent 或最小 Node ACP server 验证方法名与参数。

### 9.5 前端 UI

前端不建议复用 `ApprovalCard`。应新增独立的 input card：

| 控件 | 对应 schema |
| --- | --- |
| 单选 | `type=string` + `oneOf` |
| 多选 | `type=array` + `items.anyOf` |
| 自由输入 | `type=string` |
| 布尔 | `type=boolean` |
| 数字 | `type=number` / `integer` |

Claude `AskUserQuestion` 生成的 schema 通常会有：

```text
question_0
question_0_custom
```

其中 custom 字段代表 “Other” 自由输入。

### 9.6 Capability 启用策略

建议分 runtime、分能力启用：

```text
claude_code:
  elicitation.form = true  # InputBroker + UI 完成后启用
  elicitation.url = false  # 没有 URL 完成 UI 前先关闭

codex:
  elicitation.form = false # 除非确认 codex-acp 会使用该能力
  elicitation.url = false

opencode:
  待 smoke test
```

同时将实际声明的 `clientCapabilities` 写入 diagnostic / native session record，方便排查“工具存在但未启用”的问题。

## 10. 风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| elicitation 仍是 unstable | SDK schema 标注 unstable，上游可能改字段 | 固定版本、保留 raw RPC、集中封装 |
| 表单 schema 覆盖不全 | 初期可能只支持 string / oneOf / array | unsupported 字段降级为 raw JSON 展示或拒绝 |
| UI 与审批混淆 | “问用户”不都等于 allow/deny | `approval.required` 和 `agent.input.required` 分开 |
| 长期挂起 | 用户不回答会阻塞 turn | 提供取消、停止任务时 reject_all / cancel_all |
| 远程协作权限 | 远端 viewer 是否可回答问题需要权限控制 | input response 进入审计事件 |

## 11. 建议验收用例

1. Claude Code plan mode：
   - 进入 plan。
   - 退出计划时出现 `Ready to code?` 审批。
   - 选择 “keep planning” 后 mode 保持 `plan`。
   - 选择 “manual approve edits” 后收到 `agent.mode.updated`。

2. Claude Code `AskUserQuestion`：
   - client 声明 `elicitation.form=false` 时，复现当前错误。
   - client 声明 `elicitation.form=true` 但 handler 返回 decline 时，Claude 不报 “tool not enabled”，并把用户跳过传回模型。
   - 完整 UI 选择一个 option 后，Claude 能继续使用该选择。
   - 选择 custom answer 时，wrapper 写回自定义答案。
   - 取消当前 turn 时，pending elicitation 被 cancel。

3. Raw diagnostics：
   - 未适配的 JSON-RPC method 能落到 `agent.raw.rpc`。
   - capability snapshot 能看到是否声明了 `elicitation.form`。

## 12. 最终判断

`AskUserQuestion exists but is not enabled in this context` 是预期的 capability gating 结果，不是 Claude Code 本身缺少工具，也不是 code-lite 已收到但没渲染。当前 code-lite 还没有向 ACP 声明 form elicitation，也没有实现对应 handler 和 UI，所以 Claude wrapper 正确地禁用了该工具。

后续要支持 Claude Code 的“让用户做选择”，应按 ACP elicitation 建一条独立交互链路：`clientCapabilities.elicitation.form` -> `elicitation/create` handler -> `agent.input.required` 事件 -> 前端表单 -> response API -> ACP elicitation response。完成这条链路后再启用 capability，才能让 `AskUserQuestion` 在 code-lite 中稳定工作。
