# nanobot 命令执行权限调研与切换设计

本文调研 `nanobot-ai 0.2.2` 在工具执行权限、审批和自动放行方面的原生能力，并设计 PC Repair Agent 的命令执行权限切换方案。

当前结论基于本仓库锁定依赖、已落地 backend 代码和本地安装包源码。公开资料只作为辅助参考，最终以当前运行时依赖 `backend/uv.lock` 中的 `nanobot-ai 0.2.2` 为准。

## 1. 调研问题

本次重点确认：

1. nanobot 是否内置“用户审批”权限级别。
2. nanobot 是否内置“自动审批”权限级别。
3. nanobot 是否内置“完全允许”权限级别。
4. nanobot 现有 hook、工具配置和安全策略能否支撑 PC Repair Agent 自定义权限切换。
5. PC Repair Agent 应如何在 UI、Python backend 和 Tauri/Rust Execution Gateway 中建模权限模式。

## 2. 结论摘要

nanobot 当前没有产品级的“用户审批 / 自动审批 / 完全允许”权限模式开关。

nanobot 提供的是底层组合能力：

1. `AgentHook.before_execute_tools(...)`：工具执行前 hook，可用于等待 UI 审批。
2. `AgentHook(reraise=True)`：审批拒绝时可通过抛异常中断当前 turn。
3. `Tool.read_only`：标记工具是否只读，主要用于并发安全判断，不等同于审批策略。
4. `tools.<tool>.enable`：按工具开关启用或禁用。
5. `tools.restrict_to_workspace`：限制工具访问工作区。
6. `exec.allow_patterns` / `exec.deny_patterns`：对 shell 命令做 allowlist / denylist 过滤。
7. `exec.sandbox`：非 Windows 平台可包装命令进入 sandbox；Windows 上当前会降级为非 sandbox 执行并记录 warning。
8. SDK 流事件 `tool.started` / `tool.completed` / `tool.failed` 可用于 UI 展示工具状态，但 `tool.started` 本身不是审批。

因此，PC Repair Agent 应在自己的适配层实现权限模式：

1. `ask`：用户审批模式。
2. `auto`：自动审批模式。
3. `full`：完全允许模式。

同时要明确：无论 nanobot 侧采用哪种模式，Tauri/Rust Execution Gateway 仍是最终安全边界。`blocked` 级别操作永远不能因为前端模式切换而自动执行。

## 3. nanobot 原生能力调研

### 3.1 配置中没有审批模式字段

`nanobot.config.schema.Config` 下主要包含：

1. `agents`
2. `channels`
3. `providers`
4. `modelPresets`
5. `tools`
6. `api`
7. `gateway`

`AgentDefaults` 中有模型、上下文、最大工具轮次、并发、禁用 Skill 等字段，但没有类似以下字段：

```text
approvalMode
permissionMode
autoApprove
fullAccess
requireApproval
```

`ToolsConfig` 也没有统一的审批级别字段，只有工具配置和安全边界字段：

```text
tools.restrict_to_workspace
tools.web
tools.exec
tools.file
tools.mcp_servers
tools.ssrf_whitelist
```

这说明 nanobot 没有内置产品级权限模式，需要上层应用自己实现。

### 3.2 工具执行前 hook 可实现用户审批

nanobot runner 的工具执行顺序是：

```text
LLM 返回 tool_calls
  -> 构造 assistant tool call message
  -> 写入 checkpoint
  -> await hook.before_execute_tools(context)
  -> 执行 response.tool_calls
```

`AgentHookContext` 包含：

```text
iteration
messages
response
tool_calls
tool_results
tool_events
session_key
```

PC Repair Agent 当前已经在 `backend/pc_agent_backend/agents/nanobot/hooks.py` 中实现 `UiApprovalHook`：

1. 遍历 `context.tool_calls`。
2. 使用 `risk_level(call.name)` 判断风险。
3. `low` 风险直接跳过审批。
4. `medium` / `high` 生成 `approval.required` 事件。
5. 等待 `ApprovalBroker` 返回用户决策。
6. 用户拒绝时抛出 `ToolApprovalRejected` 中断当前 turn。

该能力可以支撑“用户审批模式”。

### 3.3 拒绝单个工具但继续当前 turn 不是稳定能力

虽然 `before_execute_tools(context)` 能看到 `context.tool_calls`，但 nanobot runner 后续实际执行的是 `response.tool_calls`。

这意味着在 hook 中修改 `context.tool_calls`，不能稳定地删除某一个工具调用并让其他工具继续执行。

当前推荐策略仍然是：

```text
任意一个待审批工具被拒绝
  -> 抛出 ToolApprovalRejected
  -> 中断当前 Agent turn
  -> UI 展示用户拒绝和后续建议
```

后续如需要“只拒绝某个工具，当前 turn 继续”，应考虑在 PC Repair Agent 适配层改造工具注册/执行代理，或向 nanobot 提 PR。

### 3.4 `tool.started` 不是审批事件

nanobot SDK 的 `SDKStreamingHook.before_execute_tools(...)` 会在工具执行前发出 `tool.started`。

但该事件只是观察事件，不会等待用户确认，也不会自动阻止执行。真正的审批必须由自定义 `AgentHook` 完成。

在 UI 中应区分：

| 事件 | 含义 | 是否表示已审批 |
| --- | --- | --- |
| `agent.tool.started` | nanobot 准备执行工具或工具已进入执行阶段展示 | 否 |
| `approval.required` | PC Repair Agent 权限策略要求用户确认 | 是，等待确认 |
| `agent.tool.completed` | 工具执行完成 | 不代表用户审批，只代表结果 |
| `agent.tool.failed` | 工具执行失败 | 不代表用户审批 |

### 3.5 nanobot 的工具安全能力

nanobot `exec` 工具提供了若干安全控制：

1. `exec.enable`：是否注册 `exec` 工具。
2. `exec.timeout`：默认命令超时。
3. `exec.allow_patterns`：配置 allowlist。
4. `exec.deny_patterns`：配置 denylist。
5. 内置 deny patterns：阻止部分删除、格式化、磁盘、关机、重启、fork bomb、破坏 nanobot 内部状态文件等命令。
6. `tools.restrict_to_workspace`：限制工作目录和绝对路径访问。
7. SSRF 防护：阻止内部或私有 URL 访问。

这些能力是底层防线，不能替代 PC Repair Agent 的产品审批：

1. deny pattern 不能完整理解用户意图和维修风险。
2. pattern 过滤无法覆盖驱动安装、注册表、服务、环境变量等结构化操作。
3. 用户需要看到用途、影响、风险和回滚方式。
4. 审批、自动放行和阻止都需要审计日志。
5. 真正的系统修改应走 Tauri/Rust Execution Gateway。

## 4. PC Repair Agent 权限模式设计

### 4.1 模式定义

建议使用三个用户可见模式：

| 模式 | 标识 | 用户语义 | 默认行为 |
| --- | --- | --- | --- |
| 用户审批 | `ask` | 涉及网络、下载或修改本机状态前先问我 | `low` 自动允许，`medium` / `high` 需要审批，`blocked` 拒绝 |
| 自动审批 | `auto` | 自动执行低中风险操作，高风险仍提醒我 | `low` / `medium` 自动允许，`high` 需要审批，`blocked` 拒绝 |
| 完全允许 | `full` | 尽量不中断 Agent，但保留硬性安全边界 | `low` / `medium` / `high` 自动允许，`blocked` 拒绝 |

设计原则：

1. `full` 不是“绕过所有安全机制”。
2. `blocked` 永远不能自动执行。
3. `full` 只跳过 nanobot 工具审批，不跳过 Execution Gateway 的禁止策略。
4. 所有自动允许都必须写入审计日志。
5. 高风险系统修改即使在 `full` 下，也应优先通过结构化 `PendingAction` 进入 Execution Gateway，而不是让 nanobot 原始 `exec` 直接执行。

### 4.2 风险等级

建议沿用并扩展当前 `backend/pc_agent_backend/agents/risk.py`：

| 风险 | 含义 | 示例 |
| --- | --- | --- |
| `low` | 只读、生成计划、读取受控工作区信息 | `hardware_scan`、`read_file`、`list_dir` |
| `medium` | 网络访问、下载、打开外部资源、写入缓存 | `web_search`、`web_fetch`、`download_candidate` |
| `high` | 修改系统、执行命令、安装程序、写文件、改环境变量 | `exec`、`run_installer`、`modify_registry`、`set_environment_variable` |
| `blocked` | 默认破坏性、不可恢复、越权或明显不属于维修场景 | 格式化磁盘、删除系统目录、关闭安全软件、窃取密钥 |

风险判断应从“工具名级别”逐步升级为“工具名 + 参数 + 来源 + 目标路径 + 命令语义”：

```python
class PermissionDecision:
    action: Literal["allow", "ask", "deny"]
    risk: Literal["low", "medium", "high", "blocked"]
    reason: str
    audit_required: bool
```

### 4.3 模式与风险矩阵

| 模式 | low | medium | high | blocked |
| --- | --- | --- | --- | --- |
| `ask` | 自动允许 | 用户审批 | 用户审批 | 自动拒绝 |
| `auto` | 自动允许 | 自动允许 | 用户审批 | 自动拒绝 |
| `full` | 自动允许 | 自动允许 | 自动允许 | 自动拒绝 |

补充规则：

1. `full` 允许的是 Agent 工具层继续执行，不代表 Rust Gateway 必须执行危险操作。
2. `exec` 在正式产品中不建议作为高风险系统修改的主通道；优先使用 `execution_gateway_request` 或 `create_pending_action`。
3. 涉及管理员权限、驱动安装、注册表、系统服务、启动项、环境变量的动作，即使被 `full` 自动允许，也必须在 Execution Gateway 侧记录完整审计。
4. 用户可配置“本次会话记住”或“对同类低中风险操作记住”，但不建议对高风险做长期静默记住。

## 5. 推荐运行时架构

### 5.1 总体链路

```text
UI 设置权限模式
  -> backend 读取 AppSecuritySettings
  -> NanobotAgentAdapter 创建 PermissionPolicy
  -> UiApprovalHook.before_execute_tools
  -> PermissionPolicy.evaluate(tool_call)
  -> allow: 记录自动允许事件，nanobot 继续
  -> ask: 发出 approval.required，等待用户决策
  -> deny: 发出 approval.denied，抛异常中断 turn
  -> 高风险真实执行仍进入 Tauri/Rust Execution Gateway
```

### 5.2 Python backend 组件

建议新增或调整：

```text
backend/pc_agent_backend/
  agents/
    risk.py                    # 风险识别，升级为支持参数级判断
    permissions.py             # 权限模式与决策矩阵
    nanobot/
      hooks.py                 # UiApprovalHook 接入 PermissionPolicy
  services/
    app_settings.py            # 读取/保存 app_config.json
    audit_log.py               # 审计日志
```

核心类型：

```python
PermissionMode = Literal["ask", "auto", "full"]
RiskLevel = Literal["low", "medium", "high", "blocked"]
PermissionAction = Literal["allow", "ask", "deny"]

class ToolPermissionPolicy:
    def evaluate(self, tool_name: str, arguments: dict[str, Any]) -> PermissionDecision:
        ...
```

### 5.3 UI 设置

设置页建议提供一个分段控件：

```text
命令执行权限
[用户审批] [自动审批] [完全允许]
```

对应说明：

1. 用户审批：涉及下载、网络或修改系统前会确认。
2. 自动审批：自动允许低中风险操作，高风险仍确认。
3. 完全允许：减少中断，但禁止操作仍会被拦截并记录。

UI 注意：

1. `full` 需要二次确认才能开启。
2. `full` 设置应有明显状态提示。
3. 审批卡片中显示当前模式、风险等级、自动放行原因或需要确认原因。
4. 用户切换权限模式只影响后续工具调用，不改变正在等待审批的请求。

### 5.4 配置存储

权限模式属于 PC Repair Agent 产品设置，不建议写入 nanobot 原生配置。

建议存储在：

```text
data/config/app_config.json
```

示例：

```json
{
  "security": {
    "commandPermissionMode": "ask",
    "rememberLowRiskApprovals": true,
    "rememberMediumRiskApprovals": false,
    "fullAccessConfirmedAt": null
  }
}
```

`nanobot_config.json` 继续只保存模型、工具启用和 nanobot 自身配置。

### 5.5 事件协议

建议扩展审批事件：

```json
{
  "type": "approval.required",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "approvalId": "approval-001",
  "toolCallId": "call-001",
  "name": "exec",
  "arguments": {
    "command": "pnpm install"
  },
  "permissionMode": "ask",
  "risk": "high",
  "policyAction": "ask",
  "policyReason": "当前为用户审批模式，高风险工具需要确认。",
  "purpose": "Agent 准备执行可能修改本机状态的工具调用。",
  "impact": "该操作可能修改文件、执行命令、安装程序或影响系统配置。",
  "risks": [
    "参数不当可能造成文件或系统状态变化。"
  ],
  "rollback": "拒绝后本轮 Agent 会中断；允许前请确认参数、来源和影响范围。"
}
```

建议新增自动决策事件，便于 UI 和审计展示：

```json
{
  "type": "approval.auto_decided",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "toolCallId": "call-001",
  "name": "web_search",
  "permissionMode": "auto",
  "risk": "medium",
  "decision": "allow",
  "policyReason": "当前为自动审批模式，中风险工具自动允许。"
}
```

自动拒绝事件：

```json
{
  "type": "approval.auto_decided",
  "conversationId": "conv-001",
  "turnId": "turn-001",
  "toolCallId": "call-001",
  "name": "exec",
  "permissionMode": "full",
  "risk": "blocked",
  "decision": "deny",
  "policyReason": "命令命中禁止策略，不能执行。"
}
```

## 6. 与 Execution Gateway 的边界

nanobot 权限模式控制的是“Agent 工具调用是否继续”。

Execution Gateway 控制的是“本机实际状态是否允许改变”。

建议边界：

| 层 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| nanobot `UiApprovalHook` | 是否允许本轮 Agent 继续调用某个工具 | 不直接执行系统修改 |
| Python Tool | 收集信息、下载缓存、生成结构化待执行操作 | 不绕过 Gateway 修改系统 |
| Tauri/Rust Gateway | 风险复核、执行命令、管理员权限、审计日志 | 不决定 Agent 如何推理 |

高风险真实动作推荐链路：

```text
Agent 想安装驱动
  -> 调用 create_pending_action
  -> Python 返回结构化 PendingAction
  -> UI 展示计划
  -> Tauri/Rust Gateway 复核来源、签名、路径、权限
  -> 根据权限模式和风险等级确认或执行
  -> 写审计日志
```

不要让 Agent 长期依赖原始 `exec` 直接执行安装、注册表、服务和驱动相关操作。

## 7. 对当前代码的影响

当前已有能力：

1. `UiApprovalHook` 已支持 `low` 自动放行、非 `low` 用户审批。
2. `ApprovalBroker` 已支持创建、等待和 resolve 审批。
3. `/approvals/{approval_id}/decision` 已支持 UI 返回允许或拒绝。
4. `risk.py` 已有基于工具名的 `low` / `medium` / `high` 识别。

需要补充：

1. `app_config.json` 中增加 `security.commandPermissionMode`。
2. backend 启动时读取权限模式。
3. `UiApprovalHook` 注入 `ToolPermissionPolicy`，不要直接写死 `level == "low"`。
4. `risk.py` 增加 `blocked`。
5. 审批事件增加 `permissionMode`、`policyAction`、`policyReason`。
6. 自动放行和自动拒绝写入事件流和审计日志。
7. UI 设置页增加权限模式切换。
8. UI 工具卡片展示自动放行、等待审批和自动拒绝状态。
9. 后续 Rust Gateway 使用同一套风险等级，但保留独立复核能力。

## 8. nanobot 配置建议

MVP 阶段建议：

```json
{
  "agents": {
    "defaults": {
      "maxToolIterations": 20,
      "failOnToolError": true
    }
  },
  "tools": {
    "restrictToWorkspace": true,
    "exec": {
      "enable": true,
      "timeout": 30,
      "denyPatterns": []
    },
    "file": {
      "enable": true
    },
    "web": {
      "search": {
        "enable": false
      },
      "fetch": {
        "enable": false
      }
    }
  }
}
```

后续正式产品建议：

1. 默认关闭 nanobot 原生 `exec`，改为注册 PC Repair Agent 自己的受控执行工具。
2. 只读扫描、硬件读取、配置读取走低风险工具。
3. 下载走中风险工具，并限制到受控缓存目录。
4. 安装、注册表、服务、环境变量统一走 `execution_gateway_request`。
5. `restrictToWorkspace` 默认开启。
6. 不把产品权限模式混进 `nanobot_config.json`，避免与 SDK 配置边界混淆。

## 9. 分阶段实现计划

### 阶段 1：权限模型落地

1. 新增 `PermissionMode`、`PermissionDecision`、`ToolPermissionPolicy`。
2. 扩展 `risk.py` 支持 `blocked`。
3. `UiApprovalHook` 改为依赖 `ToolPermissionPolicy`。
4. 自动允许和自动拒绝输出 `approval.auto_decided`。

验收：

1. `ask` 下 medium/high 仍会出现审批。
2. `auto` 下 medium 自动允许，high 仍审批。
3. `full` 下 high 自动允许。
4. `blocked` 在所有模式下都拒绝。

### 阶段 2：配置与 UI 切换

1. `app_config.json` 增加 `security.commandPermissionMode`。
2. 设置页增加三段式权限切换。
3. 切换后只影响新 turn 或后续 tool call。
4. `full` 首次开启要求二次确认。

验收：

1. 重启应用后权限模式保留。
2. UI 可以看到当前模式。
3. 审批卡片显示触发审批的策略原因。

### 阶段 3：审计日志

1. 记录用户审批、自动允许、自动拒绝。
2. 记录工具名、参数摘要、风险、模式、决策、时间、conversationId、turnId。
3. 高风险参数做敏感字段脱敏。

验收：

1. 自动审批不会“静默消失”，审计中可追踪。
2. 用户拒绝后能看到对应日志。
3. full 模式下的高风险自动允许有明显审计标记。

### 阶段 4：Execution Gateway 接管高风险执行

1. 减少对 nanobot 原生 `exec` 的依赖。
2. 引入结构化 `PendingAction`。
3. Rust Gateway 复核并执行真实系统修改。
4. Gateway 保留独立 blocked 策略。

验收：

1. 驱动安装、注册表、服务、环境变量不通过原始 `exec` 直接执行。
2. Gateway 对 blocked 操作无条件拒绝。
3. full 模式不能绕过 Gateway blocked 策略。

## 10. 风险与待确认问题

1. `full` 模式是否允许长期保存，还是仅本次会话有效，需要产品决策。
2. 高风险是否允许“本次会话自动允许同类操作”，建议 MVP 不支持。
3. 参数级风险识别需要持续补充规则，不能只靠工具名。
4. 如果 nanobot 同一轮返回多个工具调用，其中一个被拒绝，当前策略会中断整个 turn。
5. Windows 上 nanobot `exec.sandbox` 不提供真实隔离，不能作为安全边界。
6. 后续如果启用 MCP 工具，需要把 `mcp_*` 工具纳入同一套风险识别。

## 11. 推荐默认值

MVP 默认：

```text
commandPermissionMode = "ask"
```

理由：

1. 当前产品目标是 PC 维修，涉及本机状态变更，默认应偏保守。
2. 已有 UI 审批链路能支撑该模式。
3. 自动审批和完全允许可以作为设置页中的高级选项逐步开放。
4. 默认保守不影响后续提供专家模式。

推荐第一版用户可见文案：

```text
用户审批：涉及下载、网络访问或修改系统前会先确认。
自动审批：自动允许低中风险操作，高风险仍会确认。
完全允许：尽量不中断 Agent，但禁止操作仍会被拦截并记录。
```

