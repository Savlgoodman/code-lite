# Codex 与 Claude Code Fast Mode 适配调研

调研日期：2026-07-09

## 1. 背景

code-lite 需要在模型选择框中增加统一“速率”配置：

1. 默认 `1x` 普通速率。
2. 可选 `1.5x` 高速。
3. 开启后在输入框上下文圆环左侧展示闪电 icon，hover 文案为 `fast mode on`。
4. 会话消息记录需要保存本轮 fast mode 配置。
5. 每日 token 消耗账本需要记录 fast mode，并按产品口径将 fast mode 的费用估算乘以 `2`。

当前 Codex 已在 `data/record/20260708-234606-2f7bfbd4f0bd4a7f/native-session.json` 中观察到 ACP `configOptions`：

```json
{
  "id": "fast-mode",
  "name": "Fast mode",
  "category": "model_config",
  "type": "select",
  "currentValue": "off",
  "options": [
    { "name": "Off", "value": "off" },
    { "name": "On", "value": "on" }
  ]
}
```

Claude Code 的传参方式需要确认。

## 2. 验证环境与资料来源

本地环境：

1. 分支：`dev`。
2. OS：Windows，PowerShell。
3. `@agentclientprotocol/codex-acp`：本地 `1.1.0`，`npm view` 当前版本 `1.1.0`。
4. `@agentclientprotocol/claude-agent-acp`：本地 `0.57.0`，`npm view` 当前版本 `0.57.0`。
5. `@anthropic-ai/claude-agent-sdk`：本地 `0.3.202`，来自 `claude-agent-acp` 依赖。

本地源码与记录：

1. `data/record/20260708-234606-2f7bfbd4f0bd4a7f/native-session.json`
2. `data/runtimes/acp/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
3. `data/runtimes/acp/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`
4. `backend/code_lite_backend/agents/runtimes/profiles.py`
5. `backend/code_lite_backend/api/routes/turns.py`
6. `backend/code_lite_backend/services/billing_usage.py`
7. `ui/src/features/chat/ChatComposer.tsx`

外部资料：

1. Anthropic Fast mode 文档：`https://platform.claude.com/docs/en/build-with-claude/fast-mode`
2. Claude Code model configuration：`https://docs.anthropic.com/en/docs/claude-code/model-config`
3. Claude Code settings：`https://docs.anthropic.com/en/docs/claude-code/settings`
4. Claude Code interactive mode：`https://docs.anthropic.com/en/docs/claude-code/interactive-mode`
5. Claude API release notes：`https://docs.anthropic.com/en/release-notes/api`
6. Agent Client Protocol session config options：`https://agentclientprotocol.com/protocol/v1/session-config-options`

## 3. 结论摘要

1. Codex ACP 的 fast mode config id 是 `fast-mode`。
2. Claude Code ACP 的 fast mode config id 是 `fast`。
3. 两个 ACP wrapper 都通过 `session/set_config_option` 传参，不需要 code-lite 直接拼底层 API 参数。
4. 两个 wrapper 当前都接受 `on` / `off` 字符串；当 client 声明 boolean config option 能力时，也可以接受布尔值。
5. code-lite 当前没有声明 ACP boolean config option 能力，因此 runtime 会以 `select` 形式暴露 fast mode；MVP 直接传 `on` / `off` 最稳。
6. fast mode option 只在当前模型支持 fast mode 时出现。模型不支持时，不应强行传参；如传参失败，应作为 warning 记录，不阻断 turn。
7. `session/set_config_option` 成功不等于本轮已经按 fast 档位计费。它只证明 ACP wrapper 接受了配置请求；真实生效还要看当前模型支持、组织策略、cooldown 或 wrapper 返回的最新 config options。
8. 后端应使用 code-lite 统一字段表达速率，例如 `selectedConfig.fastMode` 或 `selectedConfig.speedMode`，由 runtime profile 映射为原生 config id，避免前端绑定 `fast-mode` / `fast` 差异。
9. 每日账本应保留真实 token 数，并额外记录 `billingMultiplier`；只有 `fastMode.effective === true` 时费用估算才乘以 `2`，不要把原始 token usage 改写成两倍。

## 4. Codex ACP Fast Mode

### 4.1 暴露的 config option

Codex ACP `1.1.0` 中 fast mode 常量：

```text
FAST_MODE_CONFIG_ID = "fast-mode"
FAST_MODE_CATEGORY = "model_config"
FAST_MODE_ON = "on"
FAST_MODE_OFF = "off"
FAST_MODE_DESCRIPTION = "1.5x speed, increased usage"
```

当 client 不支持 boolean config option 时，Codex 暴露：

```json
{
  "id": "fast-mode",
  "name": "Fast mode",
  "description": "1.5x speed, increased usage",
  "category": "model_config",
  "type": "select",
  "currentValue": "on | off",
  "options": [
    { "value": "off", "name": "Off" },
    { "value": "on", "name": "On" }
  ]
}
```

如果 client 声明 boolean config option 能力，则 Codex 可暴露：

```json
{
  "id": "fast-mode",
  "type": "boolean",
  "currentValue": true
}
```

code-lite 当前 `build_client_capabilities()` 没有声明 `session.configOptions.boolean`，所以当前本地记录中看到的是 `select`。

### 4.2 如何传参

调用 ACP：

```text
session/set_config_option
```

参数：

```json
{
  "sessionId": "<nativeSessionId>",
  "configId": "fast-mode",
  "value": "on"
}
```

关闭：

```json
{
  "sessionId": "<nativeSessionId>",
  "configId": "fast-mode",
  "value": "off"
}
```

Codex wrapper 逻辑：

1. `setSessionConfigOption()` 收到 `configId === "fast-mode"` 后更新 `sessionState.fastModeEnabled`。
2. prompt 前用 `resolveFastServiceTier(fastModeEnabled, currentModelSupportsFast)`。
3. 当前模型支持 fast mode 且开关为 on 时，向底层 Codex app server 传 `serviceTier = "fast"`。
4. 当前模型不支持时，`serviceTier = null`。

重要限制：

1. `set_config_option(fast-mode=on) OK` 只表示 `sessionState.fastModeEnabled=true` 已写入 wrapper 状态。
2. Codex wrapper 的模型支持判断来自当前模型元数据 `additionalSpeedTiers.includes("fast")`。
3. 例如 `gpt-5.4-mini` 不支持 fast 时，`set_config_option` 仍可能 OK，但 prompt 阶段会传 `serviceTier=null`，远端后台会显示 standard。
4. code-lite 不能用 `set_config_option` 成功作为 2x 计费依据；应检查设置返回的最新 `configOptions` 是否仍包含 `fast-mode`，或等待未来 runtime 暴露本轮 service tier。

## 5. Claude Code ACP Fast Mode

### 5.1 暴露的 config option

`@agentclientprotocol/claude-agent-acp@0.57.0` 中 fast mode 常量：

```text
FAST_MODE_CONFIG_ID = "fast"
FAST_MODE_ON = "on"
FAST_MODE_OFF = "off"
FAST_MODE_DESCRIPTION = "Faster responses on supported models"
```

当 client 不支持 boolean config option 时，Claude Code ACP 暴露：

```json
{
  "id": "fast",
  "name": "Fast mode",
  "description": "Faster responses on supported models",
  "category": "model_config",
  "type": "select",
  "currentValue": "on | off",
  "options": [
    { "value": "on", "name": "On" },
    { "value": "off", "name": "Off" }
  ]
}
```

如果 client 声明 boolean config option 能力，则 Claude Code ACP 可暴露：

```json
{
  "id": "fast",
  "type": "boolean",
  "currentValue": true
}
```

重要差异：

1. Claude 的 config id 是 `fast`，不是 `fast-mode`。
2. option 只在当前模型 `supportsFastMode` 时出现。
3. Claude SDK 会返回 `fast_mode_state`，可能是 `on`、`off` 或 `cooldown`。
4. `cooldown` 表示 fast mode 因 rate limit 暂停；wrapper 会保留用户开关意图，不把 UI 状态抖成 off。

### 5.2 如何传参

调用 ACP：

```text
session/set_config_option
```

参数：

```json
{
  "sessionId": "<nativeSessionId>",
  "configId": "fast",
  "value": "on"
}
```

关闭：

```json
{
  "sessionId": "<nativeSessionId>",
  "configId": "fast",
  "value": "off"
}
```

Claude wrapper 逻辑：

1. `setSessionConfigOption()` 收到 `configId === "fast"` 后调用 `applyFastMode(session, enabled)`。
2. `applyFastMode()` 内部调用 Claude Agent SDK：

```ts
session.query.applyFlagSettings({ fastMode: enabled })
```

3. wrapper 更新 `session.fastModeEnabled` 并刷新 `session.configOptions`。
4. 初始化和 prompt result 中的 `fast_mode_state` 会反向同步回 config option。

失败与回传：

1. 当前模型不支持 fast 时，Claude Code ACP 不会暴露 `fast` config option；强行传 `configId="fast"` 会出现 `Unknown config option` 或 SDK 侧错误。
2. `applyFlagSettings({ fastMode: true })` 会先调用 SDK；如果 Haiku 等模型不支持 fast，或组织管理策略关闭 fast，会抛错。code-lite 日志中可见 `set_config_option(fast=on) failed: Internal error`。
3. Claude Code CLI 中 `/fast` 提示无法开启时，ACP 路线通常也会在 `set_config_option(fast=on)` 阶段失败，或者在后续 `fast_mode_state=off` 的 config update 中回落。
4. `fast_mode_state="cooldown"` 表示 fast 临时暂停，wrapper 保留用户开关意图，不把 UI 直接切成 off。

### 5.3 底层 Claude API 语义

Anthropic 官方 Fast mode 文档说明，Claude API 层 fast mode 使用：

```json
{
  "speed": "fast"
}
```

并需要 beta header：

```text
anthropic-beta: fast-mode-2026-02-01
```

当前官方说明：

1. Fast mode 是 research preview。
2. 面向支持的 Claude Opus 模型，当前文档强调 Claude Opus 4.8 与 Opus 4.7。
3. Fast mode 提升输出 tokens per second，不改变模型权重、行为和能力。
4. Claude Opus 4.7 的 fast mode 已标记为 2026-07-24 移除；后续应优先迁移到 Opus 4.8。
5. Claude Code 层由 `/fast`、settings 或 ACP wrapper 的 `fast` config option 管理，不建议 code-lite 绕过 ACP 直接写底层 API 参数。

对 code-lite 的含义：

1. ACP 路线下不要直接传 `speed: "fast"` 或 beta header。
2. 只需要对 Claude Code ACP 发送 `session/set_config_option(configId="fast", value="on")`。
3. 具体是否支持、是否因 rate limit cooldown 暂停，由 Claude Code / Claude Agent SDK 决定。
4. Claude API usage 层有 `speed` 这类实际速度信号，但当前 Claude Code ACP 没有把它映射到 code-lite 的 `usage`。在 ACP 事件流没有本轮实际 speed/service tier 前，code-lite 只能按 runtime config option 与 `fast_mode_state` 做保守估算。

## 6. code-lite 现状影响

### 6.1 后端请求链路

当前前端已经发送：

```json
{
  "selectedConfig": {}
}
```

`/api/turns/stream` 只从 `selectedConfig.reasoning_effort` 取值，尚未读取 fast mode。

`AgentRunRequest` 当前没有 fast mode 字段，只包含：

```python
reasoning_effort: str | None
model_metadata: dict[str, Any]
```

`RuntimeProfile.apply_turn_config()` 当前顺序：

```text
set mode
set model
set reasoning effort
```

需要新增：

```text
set fast mode
```

建议顺序：

```text
set mode
set model
set reasoning effort
set fast mode
```

原因是 fast mode 支持性依赖当前模型，模型变更后 runtime 才能判断是否暴露 fast option。

### 6.2 SessionCapabilities

当前 `build_session_capabilities()` 会把 ACP config option 原样转成前端 `configOptions`，并把 `effort` 归一为 `reasoning_effort`。

建议增加 fast mode 归一：

```text
Codex native id: fast-mode
Claude native id: fast
code-lite effective id: fast_mode 或 speed_mode
```

MVP 有两种做法：

1. 前端仍读取原始 configOptions，但识别 `fast-mode` 和 `fast` 两个 id。
2. 后端归一为 `fast_mode`，runtime profile 根据自身 descriptor 映射回原生 id。

推荐第二种。理由：

1. UI 不需要知道 Codex 与 Claude 的 id 差异。
2. 后续 opencode 或其他 runtime 也可以映射到统一速率控制。
3. 消息记录和 billing 也能保存稳定字段。

### 6.3 前端 UI

当前 `ChatComposer` 只实现了：

1. 权限模式选择。
2. 模型族选择。
3. 推理强度选择。
4. 上下文圆环。

需要增加：

1. 从 `configOptions` 中识别 fast mode option。
2. 在模型选择展开层中增加“速率”展开框。
3. 展开后显示：
   - `1x 普通速率`
   - `1.5x 高速`
4. 默认选择 `1x 普通速率`。
5. 选择高速后写入 `selectedConfig.fast_mode = "on"`，关闭写入 `"off"`。
6. 开启后在 `ContextRing` 左侧展示 lucide `Zap` icon，`title` 和 `aria-label` 使用 `fast mode on`。

如果当前模型不支持 fast mode，建议不展示“速率”展开框，或只展示禁用的 `1x 普通速率`。MVP 推荐隐藏，避免用户选择后 runtime 拒绝。

## 7. 推荐实现方案

### 7.1 请求协议

新增稳定字段：

```json
{
  "selectedConfig": {
    "fast_mode": "on"
  }
}
```

允许兼容输入：

```text
fast_mode: "on" | "off" | true | false | "fast" | "normal" | "1.5x" | "1x"
fastMode:  同上
speedMode: "fast" | "normal"
fast-mode: "on" | "off"   # Codex 原生兼容
fast: "on" | "off"        # Claude 原生兼容
```

后端统一归一为：

```python
fast_mode_enabled: bool | None
fast_mode_value: "on" | "off" | None
```

推荐在 `AgentRunRequest` 增加：

```python
fast_mode: str | None = None
```

或更清晰：

```python
speed_mode: str | None = None  # "normal" | "fast"
```

MVP 为少改动，可以先放入 `model_metadata`：

```json
{
  "fastMode": {
    "enabled": true,
    "speedMode": "fast",
    "label": "1.5x 高速",
    "billingMultiplier": 2
  }
}
```

但长期应给 `AgentRunRequest` 一个显式字段。

### 7.2 RuntimeProfile 映射

在 `BaseRuntimeProfile` 增加：

```python
def fast_mode_config_id(self) -> str | None:
    return None
```

各 runtime：

```python
class CodexRuntimeProfile:
    def fast_mode_config_id(self) -> str | None:
        return "fast-mode"

class ClaudeCodeRuntimeProfile:
    def fast_mode_config_id(self) -> str | None:
        return "fast"
```

新增通用 apply：

```python
async def _apply_fast_mode(self, *, conn, session_id, request):
    value = normalize_fast_mode(request)
    if value is None:
        return
    config_id = self.fast_mode_config_id()
    if not config_id:
        return
    await conn.set_config_option(
        session_id=session_id,
        config_id=config_id,
        value="on" if value else "off",
    )
```

失败处理：

1. 记录 `stage="configure.fast_mode"` warning。
2. 不阻断 prompt。
3. 在 `agent.run.started.metadata.fastMode.applied=false` 或诊断日志中标记失败，避免 UI 误以为一定生效。

### 7.3 Native session 与消息记录

`native-session.json`：

1. 保留原始 `capabilities.configOptions`，便于确认 runtime 原生 option id。
2. 可新增会话级最近选择：

```json
{
  "selectedConfig": {
    "fast_mode": "on"
  }
}
```

`messages.json`：

建议在 user message 与 assistant message 的 `model` metadata 中保存：

```json
{
  "fastMode": {
    "requested": true,
    "enabled": true,
    "configApplied": true,
    "applied": true,
    "effective": true,
    "effectiveSource": "runtime_config_options",
    "speedMode": "fast",
    "displayRate": "1.5x",
    "runtimeConfigId": "fast-mode",
    "runtimeValue": "on",
    "billingMultiplier": 2
  }
}
```

注意：

1. 不要把 fast mode 写进 assistant `usage.totalTokens`。
2. usage 是 runtime 实测 token，应该保持原样。
3. fast mode 是计费倍率和展示配置，不是 token 分项。
4. `configApplied=true` 表示 ACP 配置调用成功；`effective=true` 才表示 code-lite 认为本轮可以按 fast 估算。

### 7.4 Daily billing

当前 daily entry 结构已有：

```json
{
  "usage": {},
  "cost": {}
}
```

建议新增：

```json
{
  "fastMode": {
    "requested": true,
    "enabled": true,
    "configApplied": true,
    "effective": true,
    "speedMode": "fast",
    "displayRate": "1.5x",
    "billingMultiplier": 2,
    "runtimeConfigId": "fast-mode"
  }
}
```

费用计算：

```text
rawCost = inputCost + outputCost + cachedReadCost + cachedWriteCost + thoughtCost
estimatedCostUsd = rawCost * billingMultiplier
```

倍率口径：

1. `effective === true`：按 `billingMultiplier=2` 估算。
2. `configApplied === false`：按 `billingMultiplier=1`，并记录错误。
3. `configApplied === true` 但 `effective === false`：按 `billingMultiplier=1`。典型场景是 Codex `gpt-5.4-mini` 接受了 fast 开关请求，但当前模型不暴露 `fast-mode`，底层仍走 standard。
4. `effectiveUnknown === true`：按 `billingMultiplier=1`，并在调试信息中说明 runtime 没有返回可确认信号。

同时可保留：

```json
{
  "cost": {
    "estimatedCostUsd": 0.02,
    "baseEstimatedCostUsd": 0.01,
    "billingMultiplier": 2
  }
}
```

聚合：

1. `totals.estimatedCostUsd` 使用乘以倍率后的值。
2. `models.*.estimatedCostUsd` 使用乘以倍率后的值。
3. `hours.*.estimatedCostUsd` 使用乘以倍率后的值。
4. token totals 仍使用真实 token，不乘以 `2`。

如后续需要“按倍率后的 billable token”展示，可新增 `billableTotalTokens`，不要复用 `totalTokens`。

## 8. UI 交互建议

模型菜单层级建议：

```text
模型按钮
  -> 推理
       低 / 中 / 高 / 超高
  -> 速率
       1x 普通速率
       1.5x 高速
  -> 模型
       GPT-5.5 / GPT-5.4 / ...
```

状态展示：

1. 状态 chip 继续显示模型族与推理强度，例如 `GPT-5.5 超高`。
2. fast mode 开启后，在上下文圆环左侧显示 `Zap` icon。
3. icon 使用 `title="fast mode on"`。
4. icon 不建议用按钮样式，除非点击可直接切换；MVP 作为状态指示即可。

默认值：

1. 前端初始化时如果 capabilities 中 fast option 当前值为 on/true，则选中高速。
2. 否则默认普通速率。
3. 用户切换模型族后，如果新模型不再支持 fast mode，应自动回落普通速率，并从 `selectedConfig` 移除或写 `"off"`。

## 9. 风险与注意点

1. Claude 官方 fast mode 实际描述为最高 `2.5x` 输出速度，Codex 当前描述为 `1.5x`。产品 UI 统一展示 `1.5x 高速` 时，建议 tooltip 或文档说明这是 code-lite 的统一速率档位名，runtime 实际提速由供应商决定。
2. Claude fast mode 是 research preview，支持模型和价格可能变动；应以 ACP session capabilities 是否暴露 `fast` option 为准。
3. Claude Opus 4.7 fast mode 官方已标记 2026-07-24 移除，不能在 code-lite 写死模型支持表。
4. fast mode 可能进入 `cooldown`。Claude wrapper 会保留用户意图，code-lite 不应把 cooldown 当成用户关闭。
5. daily billing 乘以 `2` 是产品统计口径，不等同于供应商真实账单。UI 应继续使用“估算费用”文案。
6. 当前 code-lite 没有声明 ACP boolean config option 能力。MVP 传 `on` / `off` 即可；未来若声明 boolean，后端也应兼容布尔值。
7. 不要写死 Codex/Claude 模型 fast 支持表。Codex 以 wrapper 返回的 `additionalSpeedTiers`/`configOptions` 为准；Claude 以 `supportsFastMode`/`fast_mode_state` 为准。

## 10. 验收建议

后端：

1. Codex 选高速时，日志出现 `set_config_option(fast-mode=on) OK`。
2. Claude Code 选高速时，日志出现 `set_config_option(fast=on) OK`。
3. 不支持 fast mode 的模型不会阻断 turn。
4. `messages.json` assistant message 的 `model.fastMode.requested` 与本轮选择一致。
5. 支持并确认生效时，`model.fastMode.effective=true` 且 `billingMultiplier=2`。
6. 不支持或组织策略拒绝时，`model.fastMode.effective=false`、`billingMultiplier=1`，并有 `effectiveReason` 或 `error`。
7. `data/billing/daily/<date>.json` entry 含 `fastMode`；只有 `effective=true` 时 `cost.estimatedCostUsd = baseEstimatedCostUsd * 2`。

前端：

1. 初始默认 `1x 普通速率`。
2. 模型菜单中可展开“速率”并切换 `1x` / `1.5x`。
3. 开启后上下文圆环左侧出现闪电 icon。
4. hover 闪电 icon 显示 `fast mode on`。
5. 切换到不支持 fast mode 的模型后高速选项消失或自动回落。

真实 runtime smoke：

1. Codex：选择支持 fast 的模型，发送短 prompt，确认 turn 正常完成。
2. Claude Code：选择暴露 `fast` option 的模型，发送短 prompt，确认 turn 正常完成。
3. Claude Code 如出现 fast mode rate-limit cooldown，确认 UI 不误写为关闭。

## 11. 最终建议

MVP 不要把 fast mode 当作新的 model id，也不要在 code-lite 直接写 Claude API 的 `speed: "fast"`。应把它作为 ACP session config option：

```text
code-lite 统一速率 UI
  -> selectedConfig.fast_mode = "on" | "off"
  -> RuntimeProfile 映射
     Codex: configId = "fast-mode"
     Claude Code: configId = "fast"
  -> ACP session/set_config_option
```

同时，消息记录和 daily billing 使用 code-lite 稳定字段保存本轮 fast mode 配置：

```json
{
  "fastMode": {
    "requested": true,
    "enabled": true,
    "configApplied": true,
    "effective": true,
    "speedMode": "fast",
    "displayRate": "1.5x",
    "billingMultiplier": 2
  }
}
```

这样前端交互、后端传参、会话回放和费用统计可以保持一致，并且不会把 Codex / Claude 的 runtime-specific id 泄漏到 UI 组件里。
