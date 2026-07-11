# code-lite 模型提供商配置调研与设计

本文记录 code-lite 模型提供商配置修复与完善的调研结论、目标数据模型、后端接口、前端交互和各 Agent Runtime 的接入策略。当前 coding agent 主线已经收敛到 ACP，Codex、Claude Code 和 opencode 的模型、模式、思考强度优先来自 runtime 原生配置与 ACP `session/new` 返回；本文的 LLM provider 配置主要服务 legacy nanobot、通用模型供应商管理和后续非 ACP 工作流。

## 1. 背景

当前项目已经形成以下运行时边界：

1. 应用运行配置落在运行时 data 目录，当前配置文件包括 `app_config.json`、`agent_runtimes.json` 和 legacy `nanobot_config.json`；正式用户目录为 `~/.code-lite/`。
2. UI 通过 Tauri `ensure_backend` 拉起或连接 Python backend。
3. Python backend 通过 FastAPI 提供 `/api/turns/stream` NDJSON 流式接口；coding agent 通过通用 ACP adapter 接入，legacy nanobot adapter 仍调用 `Nanobot.from_config(...)` 与 `run_streamed(...)`。
4. 设置页已有“模型提供商配置”原型，但目前只覆盖“输入 URL/API Key，获取模型列表，写入一个默认模型”的最短链路。

本轮要修复的核心问题是：模型配置应从“LLM 供应商”开始，再到“供应商下的模型”，用户可以选择添加哪些模型，并为每个模型配置协议方式、能力、上下文长度和默认使用策略。

## 2. 目标

本阶段目标：

1. 明确产品级模型配置以 `data/config` 下 JSON 文件为准。
2. 建立“供应商 -> 模型”的配置结构。
3. 供应商保存名称、Base URL、API Key 引用或密文、协议类型等连接信息。
4. 通过模型列表接口获取供应商可用模型，由用户选择添加哪些模型。
5. 模型保存协议方式、上下文长度、最大输出、多模态能力、reasoning 能力等元数据。
6. 支持删除模型、删除供应商，并处理默认模型被删除后的降级规则。
7. 支持新会话默认模型策略：沿用上次使用模型，或固定使用指定模型。
8. 支持对话中为下一轮切换模型，用于横向对比不同模型效果。
9. 将产品配置安全同步给需要派生配置的 legacy runtime，例如 nanobot 的 `providers`、`modelPresets`、`agents.defaults.modelPreset`。
10. 对 ACP runtime 只保存 code-lite 管理所需的安装、命令、配置模式和展示偏好，不试图覆盖 runtime 原生模型系统。

非目标：

1. 本文不实现系统凭据存储，只定义后续应迁移方向。
2. 本文不实现各家非标准模型列表接口的完整适配，只定义可扩展接口。
3. 本文不改变 nanobot SDK 源码。
4. 本文不覆盖 Codex、Claude Code、opencode 的原生模型管理。ACP runtime 的可选模型应优先从 `session/new.models` 获取，再由 descriptor 提供 fallback。

## 3. 当前实现现状

### 3.1 配置文件

当前 backend 默认通过 `backend/code_lite_backend/core/config.py` 解析配置：

```text
CODE_LITE_ENV=DEV -> <repo>/data/
其他环境          -> ~/.code-lite/
```

产品级模型配置当前落在：

```text
开发环境 -> <repo>/data/config/app_config.json
普通环境 -> ~/.code-lite/config/app_config.json
```

ACP runtime 配置当前落在：

```text
开发环境 -> <repo>/data/config/agent_runtimes.json
普通环境 -> ~/.code-lite/config/agent_runtimes.json
```

legacy nanobot 配置缺失时仍会创建最小配置，主要字段为：

```json
{
  "providers": {
    "<providerKey>": {
      "apiKey": "${ENV_NAME}",
      "apiBase": "https://api.example.com"
    }
  },
  "modelPresets": {
    "<modelPresetId>": {
      "provider": "<providerKey>",
      "model": "<model-name>"
    }
  },
  "agents": {
    "defaults": {
      "modelPreset": "<modelPresetId>"
    }
  }
}
```

注意：`data/` 已被 `.gitignore` 忽略，可以保存本机运行数据，但仍不应把真实 API Key 写入可提交文件。后续实现应优先使用系统凭据存储或本地加密存储；短期若仍写入 data 配置，所有接口和 UI 必须默认遮蔽 API Key。

### 3.2 设置页后端接口

当前 `backend/code_lite_backend/api/routes/settings.py` 已有两个模型提供商接口：

1. `POST /api/settings/model-providers/models`：接收 `baseUrl` 和 `apiKey`，尝试请求 `<baseUrl>/models` 或 `<baseUrl>/v1/models`。
2. `POST /api/settings/model-providers/default`：把连接信息固定写入 `providers.custom`，把第一个模型固定写成 `modelPresets.pcAgentDefault`，并设置为 `agents.defaults.modelPreset`。

当前问题：

1. 所有新增供应商都会覆盖 `providers.custom`，无法保存多个供应商。
2. 获取到的模型列表没有持久化为“供应商候选模型”和“用户已启用模型”。
3. UI 自动选择第一个模型作为默认模型，用户不能选择。
4. 没有模型删除、供应商删除和默认模型重选。
5. 只传 `supportsReasoning`，没有保存协议方式、多模态、上下文长度、最大输出等模型能力。
6. 没有读取完整配置的接口，设置页刷新后只剩页面内存状态。

### 3.3 设置页前端

当前 `ui/src/pages/SettingsPage.tsx` 的模型提供商配置仅保存在组件本地 state：

1. 输入 URL 和 API Key。
2. 点击“获取模型并添加”。
3. 后端返回模型列表。
4. 前端临时展示模型 chip。
5. 页面刷新后丢失展示状态。

当前问题：

1. 设置页没有从 backend 加载真实配置。
2. 没有供应商详情、模型勾选、模型编辑、删除、设为默认。
3. “支持思考”和“支持多模态”挂在供应商层，但实际应主要属于模型层。
4. 没有“默认模型策略”设置。
5. 聊天页模型选择器还没有接入真实模型配置。

### 3.4 nanobot adapter

当前 `backend/code_lite_backend/agents/nanobot/adapter.py` 每一轮都创建新的 `Nanobot.from_config(...)`，并调用：

```python
run = await bot.run_streamed(
    prompt,
    session_key=request.conversation_id,
    hooks=[UiApprovalHook(...)]
)
```

当前问题：

1. `AgentRunRequest` 没有 `modelPreset` 或 `modelId` 字段。
2. `run_streamed(...)` 没有传入 per-run `model_preset`。
3. UI 不能为某一轮选择模型。
4. backend 当前每轮重建 `Nanobot`，配置变更后下一轮自然生效，但不适合未来复用 bot 时做精细热切换。

## 4. nanobot 调研结论

本次本地环境锁定 `nanobot-ai 0.2.2`，并通过 PyPI 与 GitHub 上游源码确认当前公开版本仍为 `0.2.2`。参考来源：

1. PyPI：`https://pypi.org/project/nanobot-ai/`
2. GitHub：`https://github.com/HKUDS/nanobot`

### 4.1 是否支持热模型切换

结论：支持“下一轮或本轮启动时切换模型”，不支持“同一个正在生成的 run 中途无缝换模型继续生成”。

依据：

1. `Nanobot.from_config(...)` 支持 `model` 和 `model_preset` 参数。
2. `Nanobot.run(...)` 与 `Nanobot.run_streamed(...)` 支持 per-run `model` 和 `model_preset` 参数。
3. `SDKRuntimeController.override(...)` 会在单次 run 期间临时切换 provider/model，结束后恢复默认 runtime。
4. 带模型覆盖的 run 会走独占 gate，避免多个模型覆盖请求同时修改同一个 AgentLoop 的 provider 状态。
5. `AgentLoop.set_model_preset(...)` 可切换后续 turn 的 runtime provider/model。

对本项目的设计含义：

1. 对话中切换模型应定义为“下一轮使用新模型”，不是“当前正在输出的 assistant 消息中途换模型”。
2. 如果用户在运行中切换模型，UI 应提示“将用于下一轮”；若想立即使用，需要先停止当前 turn，再重新发送或继续。
3. 后端请求协议应支持 `modelPresetId`，nanobot adapter 调用 `run_streamed(..., model_preset=modelPresetId)`。
4. 当前 backend 每轮新建 `Nanobot`，配置文件变更后下一轮可生效；后续若缓存 Nanobot 实例，也可以继续使用 per-run `model_preset`。

### 4.2 nanobot 上下文机制

结论：nanobot 并不是简单“按多少 K 上下文全量塞入”，也不是只按轮数。它同时使用模型配置中的 token 预算、历史消息回放窗口和压缩机制。

本地 `nanobot-ai 0.2.2` 源码中的关键机制：

1. `ModelPresetConfig.context_window_tokens` 默认存在，当前配置支持 `contextWindowTokens` 这种 JSON 别名。
2. `AgentDefaults.max_messages` 控制最多回放多少条 session history，当前默认约为 120。
3. `AgentLoop._replay_token_budget()` 会用 `context_window_tokens - max_tokens - 1024` 估算历史回放预算。
4. `Consolidator.maybe_consolidate_by_tokens(...)` 会按 token 预算把旧消息压缩归档。
5. `AutoCompact` 还会按 idle session 策略做会话压缩。
6. 模型切换后，`context_window_tokens` 会跟随目标 model preset 更新，并同步给 consolidator。

对本项目的设计含义：

1. UI 里仍应让用户填写模型上下文长度，因为它会影响 nanobot 历史回放和压缩阈值。
2. UI 文案不应承诺“该模型每轮一定保留 N K 全部上下文”，应描述为“上下文窗口预算”。
3. 模型配置里需要保存 `contextWindowTokens` 和 `maxTokens`，并同步到 nanobot `modelPresets`。
4. 新会话默认模型切换到较小上下文模型时，已有长会话可能触发更积极压缩，这是预期行为。

### 4.3 协议方式限制

nanobot `ProviderConfig` 支持 `api_type`，但在当前 schema 中 `api_type` 只允许用于内置 `providers.openai`，额外自定义 provider 或其他内置 provider 设置非 `auto` 会触发校验错误。

对本项目的设计含义：

1. 产品 UI 可以提供协议字段：`openai`、`anthropic`、`openai_responses`。
2. 写入 nanobot 原生配置时必须映射到 nanobot 当前支持的 provider 结构：
   - `openai` 协议：优先写入自定义 provider，走 OpenAI-compatible chat completions。
   - `openai_responses` 协议：短期只能写入 `providers.openai.apiType = "responses"` 或等待 nanobot 支持自定义 provider 的 `api_type`。
   - `anthropic` 协议：应使用 nanobot 内置 `providers.anthropic` 或已知 Anthropic-compatible 内置 provider，不应当作普通 custom provider。
3. 如果同一个 Base URL 需要 responses 协议，但又不是 OpenAI 官方 provider，需要先作为产品级配置保存，nanobot 同步层应给出“不支持当前 nanobot 映射”的错误，而不是写出无效配置。

## 5. 目标配置模型

建议引入产品级配置文件：

```text
data/config/app_config.json
```

其中保存产品 UI 需要的完整结构；`nanobot_config.json` 作为 nanobot 运行时派生配置，由 backend 根据产品配置生成或同步。

原因：

1. nanobot 原生 schema 不包含“供应商模型发现缓存”“模型是否启用”“默认策略”“能力标签”等 UI 信息。
2. 产品级配置可以稳定演进，不必完全受 nanobot 字段命名约束。
3. ACP runtime 不应被产品级模型配置覆盖；可复用的只是 UI 展示偏好、最近选择记录和 fallback 元数据。

### 5.1 产品级配置草案

```json
{
  "schemaVersion": 1,
  "modelSettings": {
    "defaultStrategy": "last_used",
    "defaultModelId": null,
    "lastUsedModelId": "model_deepseek_deepseek_v4_flash"
  },
  "llmProviders": [
    {
      "id": "provider_deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyRef": "provider_deepseek_api_key",
      "protocol": "openai",
      "enabled": true,
      "modelsEndpoint": "https://api.deepseek.com/models",
      "lastModelsRefreshAt": 1782790000000,
      "discoveredModels": [
        {
          "id": "deepseek-v4-flash",
          "label": "deepseek-v4-flash"
        }
      ],
      "models": [
        {
          "id": "model_deepseek_deepseek_v4_flash",
          "providerId": "provider_deepseek",
          "model": "deepseek-v4-flash",
          "label": "DeepSeek V4 Flash",
          "protocol": "openai",
          "enabled": true,
          "capabilities": {
            "text": true,
            "vision": false,
            "audio": false,
            "tools": true,
            "reasoning": false
          },
          "limits": {
            "contextWindowTokens": 65536,
            "maxOutputTokens": 4096
          },
          "generation": {
            "temperature": 0.1,
            "reasoningEffort": "none"
          }
        }
      ]
    }
  ]
}
```

### 5.2 字段说明

供应商字段：

1. `id`：稳定 ID，不随名称修改而变化。
2. `name`：用户可编辑展示名。
3. `baseUrl`：供应商 API Base URL。
4. `apiKeyRef`：凭据引用。短期可以映射到 data 配置内密文或遮蔽值，长期接系统凭据存储。
5. `protocol`：默认协议，作为新增模型的默认值。
6. `enabled`：是否启用供应商。
7. `modelsEndpoint`：最后一次成功获取模型列表的 endpoint。
8. `discoveredModels`：供应商模型列表缓存，供 UI 复选添加。
9. `models`：用户已添加并启用管理的模型。

模型字段：

1. `id`：产品级模型 ID，用于 UI、会话记录和默认模型。
2. `providerId`：所属供应商。
3. `model`：发送给供应商的真实模型名。
4. `label`：用户可编辑展示名。
5. `protocol`：模型实际使用协议，可覆盖供应商默认值。
6. `capabilities`：模型能力声明。
7. `limits.contextWindowTokens`：上下文窗口预算。
8. `limits.maxOutputTokens`：单次最大输出预算，对应 nanobot `maxTokens`。
9. `generation.temperature`：默认温度。
10. `generation.reasoningEffort`：reasoning 模型的思考强度。

默认策略：

1. `defaultStrategy = "last_used"`：新会话默认使用 `lastUsedModelId`。
2. `defaultStrategy = "fixed"`：新会话默认使用 `defaultModelId`。
3. 若策略指向的模型被删除或禁用，降级为第一个启用模型，并提示用户重新设置。

## 6. nanobot 配置同步策略

产品级模型同步到 `nanobot_config.json` 的规则：

1. 每个启用供应商写入 `providers.<providerKey>`。
2. 每个启用模型写入 `modelPresets.<presetId>`。
3. 根据默认策略写入 `agents.defaults.modelPreset`。
4. 保留工具、安全、Skill 相关 nanobot 配置，不因模型设置覆盖。

### 6.1 providerKey 生成

建议 provider key 使用稳定、可读、无特殊字符的 slug：

```text
provider_deepseek -> deepseek
provider_openrouter -> openrouter
provider_my_proxy -> my_proxy
```

若与 nanobot 内置 provider 冲突：

1. 协议和供应商语义匹配时使用内置 key，例如 `deepseek`、`openai`、`anthropic`。
2. 自定义代理不应使用内置 key，使用 `custom_<slug>` 或用户 provider id 的 slug。

### 6.2 modelPresetId 生成

建议直接从产品模型 ID 派生：

```text
model_deepseek_deepseek_v4_flash -> pc_model_deepseek_deepseek_v4_flash
```

不要复用当前固定的 `pcAgentDefault`，避免多个模型互相覆盖。

### 6.3 同步示例

产品级模型：

```json
{
  "providerId": "provider_deepseek",
  "model": "deepseek-v4-flash",
  "protocol": "openai",
  "limits": {
    "contextWindowTokens": 65536,
    "maxOutputTokens": 4096
  }
}
```

同步后的 nanobot 片段：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "${DEEPSEEK_API_KEY}",
      "apiBase": "https://api.deepseek.com"
    }
  },
  "modelPresets": {
    "pc_model_deepseek_deepseek_v4_flash": {
      "label": "DeepSeek V4 Flash",
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "maxTokens": 4096,
      "contextWindowTokens": 65536,
      "temperature": 0.1,
      "reasoningEffort": "none"
    }
  },
  "agents": {
    "defaults": {
      "modelPreset": "pc_model_deepseek_deepseek_v4_flash"
    }
  }
}
```

## 7. 后端 API 设计

### 7.1 读取设置

```text
GET /api/settings/model-providers
```

返回：

```json
{
  "providers": [],
  "models": [],
  "defaultStrategy": "last_used",
  "defaultModelId": null,
  "lastUsedModelId": "model_deepseek_deepseek_v4_flash",
  "effectiveDefaultModelId": "model_deepseek_deepseek_v4_flash"
}
```

要求：

1. API Key 不返回明文。
2. 返回 `hasApiKey`、`apiKeyPreview` 即可，例如 `已保存，末尾 4 位：abcd`。
3. 返回模型和供应商的删除阻塞原因，例如是否正在使用、是否是默认模型。

### 7.2 创建或更新供应商

```text
POST /api/settings/model-providers
PATCH /api/settings/model-providers/{providerId}
```

字段：

```json
{
  "name": "DeepSeek",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "<用户输入的 API Key>",
  "protocol": "openai"
}
```

要求：

1. `apiKey` 为空时表示不修改已有密钥。
2. `baseUrl` 修改后应提示重新刷新模型列表。
3. 保存后触发 nanobot 配置同步。

### 7.3 刷新模型列表

```text
POST /api/settings/model-providers/{providerId}/models/refresh
```

行为：

1. 使用供应商保存的 Base URL 和 API Key 获取模型列表。
2. 对 OpenAI-compatible 默认尝试 `/models` 与 `/v1/models`。
3. 对 Anthropic 或其他协议保留 adapter 扩展点。
4. 只更新 `discoveredModels`，不自动启用所有模型。

### 7.4 启用模型

```text
POST /api/settings/model-providers/{providerId}/models
```

字段：

```json
{
  "model": "deepseek-v4-flash",
  "label": "DeepSeek V4 Flash",
  "protocol": "openai",
  "capabilities": {
    "vision": false,
    "reasoning": false,
    "tools": true
  },
  "limits": {
    "contextWindowTokens": 65536,
    "maxOutputTokens": 4096
  },
  "generation": {
    "temperature": 0.1,
    "reasoningEffort": "none"
  }
}
```

要求：

1. 用户可以从发现列表勾选多个模型批量添加。
2. 同一供应商下真实 `model` 不重复启用。
3. 保存后生成对应 nanobot model preset。

### 7.5 更新模型

```text
PATCH /api/settings/models/{modelId}
```

可更新：

1. `label`
2. `protocol`
3. `capabilities`
4. `limits`
5. `generation`
6. `enabled`

保存后同步 nanobot 配置。若当前默认模型被禁用，应重新计算默认模型。

### 7.6 删除模型

```text
DELETE /api/settings/models/{modelId}
```

规则：

1. 删除模型前检查是否为 `defaultModelId` 或 `lastUsedModelId`。
2. 若是默认模型，需要请求端传 `replacementModelId`，或后端自动选择第一个启用模型并在响应中说明。
3. 从产品配置删除模型，并从 `nanobot_config.json.modelPresets` 删除对应 preset。
4. 已有会话记录中只保留历史 `modelId/modelLabel`，不因模型删除而改写历史。

### 7.7 删除供应商

```text
DELETE /api/settings/model-providers/{providerId}
```

规则：

1. 默认删除供应商下所有模型。
2. 如果供应商下存在默认模型，需要先选择替代默认模型。
3. 删除后清理 nanobot `providers` 和相关 `modelPresets`。
4. 已有历史会话不改写。

### 7.8 默认模型策略

```text
PATCH /api/settings/models/default
```

字段：

```json
{
  "defaultStrategy": "fixed",
  "defaultModelId": "model_deepseek_deepseek_v4_flash"
}
```

规则：

1. `last_used` 策略允许 `defaultModelId = null`。
2. `fixed` 策略必须提供启用模型。
3. 每轮成功启动时更新 `lastUsedModelId`。
4. backend 同步 nanobot `agents.defaults.modelPreset` 为当前有效默认模型。

## 8. Agent 请求协议设计

ACP 主线下，请求协议应逐步从 `modelId`、`accessMode`、`reasoningEffort` 等单独字段演进为 `selectedModel`、`selectedMode` 和 `selectedConfig`。这些字段直接对应 ACP `session/new` 返回的 models、modes 和 configOptions。旧字段在兼容期继续保留，供当前 UI 和 legacy nanobot 使用。

### 8.1 AgentRunRequest 扩展

`backend/code_lite_backend/schemas/agent.py` 建议扩展：

```python
@dataclass(frozen=True)
class AgentRunRequest:
    conversation_id: str
    turn_id: str
    prompt: str
    workspace: Path
    model_id: str | None = None
    model_preset_id: str | None = None
```

前端 `/api/turns/stream` 请求增加：

```json
{
  "conversationId": "...",
  "prompt": "...",
  "modelId": "model_deepseek_deepseek_v4_flash"
}
```

后端根据 `modelId` 解析为 nanobot `modelPresetId`，传给 adapter。

### 8.2 nanobot adapter 调用

```python
run = await bot.run_streamed(
    prompt,
    session_key=request.conversation_id,
    model_preset=request.model_preset_id,
    hooks=[UiApprovalHook(...)]
)
```

规则：

1. 如果请求不带模型，使用当前有效默认模型。
2. 如果请求模型已删除或禁用，返回明确错误，不静默换模型。
3. `agent.run.started.metadata` 应包含实际使用的 `modelId`、`modelPresetId`、`providerId` 和 `modelLabel`。
4. 会话记录应保存每轮实际模型，便于后续对比。

### 8.3 运行中切换模型

UI 行为：

1. 当前没有运行时，选择模型立即成为下一轮输入框选中模型。
2. 当前正在运行时，选择模型只设置为下一轮模型，并显示轻提示。
3. 若用户想用新模型重新回答，应先停止当前 turn，再重新发送同一问题或使用后续“重新生成”能力。

后端规则：

1. 不尝试对已启动的 `RunStream` 中途替换 provider。
2. `cancel_turn` 仍只负责取消当前 turn。
3. 新 turn 启动时再读取请求中的模型选择。

## 9. 前端设计建议

### 9.1 设置页信息架构

模型提供商设置建议拆成三层：

1. 顶部默认模型策略：上次使用 / 固定默认模型。
2. 供应商列表：名称、Base URL、协议、连接状态、已启用模型数量。
3. 供应商详情：刷新模型列表、勾选模型、编辑模型能力和限制。

### 9.2 供应商添加流程

推荐流程：

1. 用户填写供应商名称、Base URL、API Key、默认协议。
2. 点击“测试并获取模型”。
3. 后端保存供应商并刷新模型列表。
4. UI 展示可用模型列表，用户勾选要启用的模型。
5. 用户为选中模型批量设置协议、上下文长度、最大输出、能力标签。
6. 保存后模型出现在“已启用模型”区域。

### 9.3 模型列表展示

每个模型行建议展示：

1. 展示名和真实模型名。
2. 所属供应商。
3. 协议：OpenAI / Anthropic / OpenAI Responses。
4. 能力标签：工具、多模态、reasoning。
5. 上下文预算，例如 `64K`。
6. 最大输出。
7. 操作：编辑、设为默认、禁用、删除。

### 9.4 聊天页模型选择

聊天输入区或顶部模型 chip 应从后端加载启用模型：

1. 新会话打开时根据默认策略选模型。
2. 用户切换模型后，该模型成为当前草稿会话的下一轮模型。
3. 发送后更新 `lastUsedModelId`。
4. 消息或 turn 元数据展示实际使用模型，避免用户混淆。

## 10. 安全与敏感信息

短期要求：

1. `GET` 接口不得返回明文 API Key。
2. 后端日志不得打印请求中的 API Key。
3. 文档、代码、示例配置不得写真实 key。
4. 保存配置时使用 UTF-8，原子写入，避免 JSON 损坏。
5. 删除供应商时同步删除或失效对应凭据引用。

长期建议：

1. Tauri/Rust 提供系统凭据存储桥接。
2. Python backend 只保存 `apiKeyRef`，运行时通过本地安全通道获取密钥。
3. 导出诊断包时自动剔除模型供应商密钥与本机隐私路径。

## 11. 分阶段开发计划

### 阶段 1：配置读写与同步层

1. 新增 `app_config.json` 最小结构和 resolver。
2. 新增模型配置 repository，负责 UTF-8 读写、原子写入和迁移。
3. 实现产品配置到 `nanobot_config.json` 的同步函数。
4. 保留现有 `nanobot_config.json` 兼容读取，首次启动可从旧配置迁移出一个供应商和模型。

验收：

1. `GET /api/settings/model-providers` 能返回真实配置。
2. 新增供应商和模型后，`nanobot_config.json` 生成多个 provider/model preset。
3. 不覆盖无关 tools、agents 其他字段。

### 阶段 2：供应商与模型管理 API

1. 替换当前 `default` 接口为完整 CRUD。
2. 实现刷新模型列表。
3. 实现模型添加、编辑、删除。
4. 实现供应商删除和默认模型降级。
5. 实现默认模型策略 API。

验收：

1. 多供应商可共存。
2. 多模型可共存。
3. 删除默认模型时有可解释的替代规则。
4. API Key 不在读取接口中泄漏。

### 阶段 3：设置页 UI

1. 设置页加载真实配置。
2. 改造添加供应商流程。
3. 增加模型勾选、编辑和删除。
4. 增加默认模型策略 UI。
5. 增加错误态和连接测试结果。

验收：

1. 刷新页面后供应商和模型仍存在。
2. 用户可以选择添加哪些模型，而不是自动使用第一个模型。
3. 用户可以修改模型能力和上下文预算。

### 阶段 4：聊天页模型选择与 nanobot per-run 切换

1. 扩展 `AgentRunRequest` 和 `/api/turns/stream` 请求体。
2. nanobot adapter 传入 `model_preset`。
3. 聊天页模型 chip 接入启用模型列表。
4. 保存每轮实际模型元数据。
5. 更新 `lastUsedModelId`。

验收：

1. 新会话按默认策略选模型。
2. 同一会话连续两轮可以使用不同模型。
3. 运行中切换模型只影响下一轮。
4. `agent.run.started` 能返回实际模型元数据。

### 阶段 5：凭据存储强化

1. 接入 Tauri/Rust 系统凭据存储。
2. 将 data 配置中的明文 key 迁移为 `apiKeyRef`。
3. 增加凭据缺失、凭据失效、重新输入的 UI 流程。

验收：

1. data 配置不再保存明文 key。
2. 已有本地配置可平滑迁移。
3. backend 日志和 API 响应均不泄漏密钥。

## 12. 需要注意的边界

1. nanobot `api_type` 当前只允许 `providers.openai` 使用，不能随意写到 custom provider。
2. Anthropic 协议不能简单等同于 OpenAI-compatible Base URL，需要走 nanobot 支持的 provider backend。
3. 上下文长度是 token 预算输入，不是 UI 可承诺的完整记忆长度。
4. 模型热切换应以 turn 为边界，不支持 run 中途无缝换模型。
5. 当前 `data/config/nanobot_config.json` 是运行时文件，开发时可能含本机密钥；任何调试输出和文档都不能复制其中密钥。
6. 删除模型不应重写历史会话，只影响后续 turn。

## 13. 待确认问题

1. 短期是否允许 API Key 明文写入被 git ignore 的 data 配置，还是本轮就必须接系统凭据存储。
2. `openai_responses` 是否只支持 OpenAI 官方 provider，还是需要支持任意兼容网关。
3. 模型能力是否先由用户手动配置，还是为常见模型内置一份能力规则表。
4. 默认策略是否需要区分“全局默认模型”和“当前会话固定模型”。
5. 删除供应商时，是否默认连带删除其模型，还是要求用户逐一确认。
