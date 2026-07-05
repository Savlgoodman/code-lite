# ACP 协议能力调研：Token 统计、上下文压缩、Subagent、多模态

> 调研日期：2026-07-05
> 调研范围：codex-lite 项目中 Codex ACP 和 Claude Code ACP 的协议能力
> 分支：`research/acp-investigation`
> ACP SDK 版本：v0.12.2

---

## 目录

1. [Token 使用量信息：能否获取并展示](#1-token-使用量信息能否获取并展示)
2. [上下文压缩：如何手动触发](#2-上下文压缩如何手动触发)
3. [Subagent：如何展示](#3-subagent如何展示)
4. [多模态功能：图片传入](#4-多模态功能图片传入)
5. [附录：ACP SDK 完整 API 速查](#5-附录acp-sdk-完整-api-速查)
6. [总结与改进建议](#6-总结与改进建议)

---

## 1. Token 使用量信息：能否获取并展示

### 1.1 结论：可以获取，`PromptResponse.usage` 包含全部分项数据

**`PromptResponse.usage` 字段存在且包含完整的 token 分项数据**，但目前 codex-lite 完全没有读取。

ACP 协议定义了两个完全不同的 Usage 结构：

### 1.2 两个 Usage 结构对比

#### 结构一：`UsageUpdate` — 实时流式事件（当前已使用）

通过 `session/update` 以 `usage_update` 类型推送，**只携带 context window 维度信息**：

```python
# schema.py:1952-1970
class _UsageUpdate(BaseModel):
    field_meta: Optional[Dict[str, Any]]  # _meta
    cost: Optional[Cost]                  # 累积 session 费用 (可选)
    size: int                             # 总 context window 大小 (tokens)
    used: int                             # 当前 context 中使用的 tokens
```

**不包含** input_tokens / output_tokens / cache 分项。

#### 结构二：`Usage` — PromptResponse 中的 turn 汇总（⚠️ 当前未读取）

出现在 `PromptResponse.usage`（prompt 完成后的返回值中），携带**完整的分项 token 信息**：

```python
# schema.py:1907-1949
class Usage(BaseModel):
    cached_read_tokens: Optional[int]    # alias="cachedReadTokens", cache 读取 tokens
    cached_write_tokens: Optional[int]   # alias="cachedWriteTokens", cache 写入 tokens
    input_tokens: int                    # alias="inputTokens", 输入 tokens (必填)
    output_tokens: int                   # alias="outputTokens", 输出 tokens (必填)
    thought_tokens: Optional[int]        # alias="thoughtTokens", 推理/思考 tokens
    total_tokens: int                    # alias="totalTokens", 所有 token 类型总和 (必填)
```

**注意**：此字段标记为 **UNSTABLE**，`Optional`，不是所有 ACP agent 都会实现。

### 1.3 数据流对比

```
                          ACP Runtime
                              │
                 ┌────────────┴────────────┐
                 │                         │
      session/update (实时流)      PromptResponse (turn 结束返回值)
      type: "usage_update"        prompt_result.usage
                 │                         │
          UsageUpdate 对象             Usage 对象
          ┌──────────────┐      ┌──────────────────────┐
          │ used: 45000   │      │ input_tokens: 12000   │
          │ size: 200000  │      │ output_tokens: 3500   │
          │ cost: {...}   │      │ cached_read_tokens: 8000│
          └──────────────┘      │ cached_write_tokens: 2000│
                                │ thought_tokens: 1500  │
                                │ total_tokens: 27000   │
                                └──────────────────────┘
                 │                         │
          codex-lite 已读取 ✅       codex-lite 未读取 ❌
          (context ring 展示)       (完整分项数据被忽略)
```

### 1.4 当前代码的处理（关键缺口）

#### adapter.py — prompt_result.usage 被完全忽略

```python
# backend/.../agents/acp/adapter.py:248-277
prompt_result = await connection_sdk.prompt(...)

# 只读了 stop_reason，没有读 usage
logger.info("Prompt completed for %s (stop=%s)",
    request.turn_id, getattr(prompt_result, "stop_reason", None))

# usage 来自 handler.latest_usage（即 UsageUpdate 的 used/size），不是 PromptResponse.usage
usage_dict = handler_usage.to_dict() if handler_usage else ...
await output_queue.put({
    "type": "agent.run.completed",
    "usage": usage_dict,  # 只有 totalTokens/contextUsedTokens/contextWindowTokens
})
```

#### mapper.py — UsageSnapshot 字段有限

```python
# backend/.../agents/acp/mapper.py:170-192
@dataclass
class UsageSnapshot:
    total_tokens: int | None = None         # ← 来自 used
    context_used_tokens: int | None = None  # ← 来自 used
    context_window_tokens: int | None = None# ← 来自 size
    source: str = "acp.usage_update"
    # ❌ 没有 input_tokens, output_tokens, cached_read_tokens, cached_write_tokens, thought_tokens
```

### 1.5 接入方案

需要修改的文件和内容：

#### 后端改动（3 个文件）

**① `backend/.../agents/acp/mapper.py` — 扩展 UsageSnapshot**

```python
@dataclass
class UsageSnapshot:
    # 来自 PromptResponse.usage 的分项数据
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_read_tokens: int | None = None
    cached_write_tokens: int | None = None
    thought_tokens: int | None = None
    # 来自 UsageUpdate 的 context window 数据
    total_tokens: int | None = None
    context_used_tokens: int | None = None
    context_window_tokens: int | None = None
    source: str = "acp.usage"

    def to_dict(self) -> dict[str, Any]:
        result = {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cachedReadTokens": self.cached_read_tokens,
            "cachedWriteTokens": self.cached_write_tokens,
            "thoughtTokens": self.thought_tokens,
            "totalTokens": self.total_tokens,
            "contextUsedTokens": self.context_used_tokens,
            "contextWindowTokens": self.context_window_tokens,
            "source": self.source,
        }
        return {k: v for k, v in result.items() if v is not None}
```

新增函数，从 `PromptResponse.usage` 提取数据：

```python
def extract_prompt_response_usage(usage: Any) -> UsageSnapshot:
    """从 PromptResponse.usage (Usage 对象) 中提取完整分项 token 数据"""
    return UsageSnapshot(
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        cached_read_tokens=getattr(usage, "cached_read_tokens", None),
        cached_write_tokens=getattr(usage, "cached_write_tokens", None),
        thought_tokens=getattr(usage, "thought_tokens", None),
        total_tokens=getattr(usage, "total_tokens", None),
        source="acp.prompt_response.usage",
    )
```

**② `backend/.../agents/acp/adapter.py` — 读取 prompt_result.usage**

```python
# 在 prompt_result = await connection_sdk.prompt(...) 之后：
prompt_usage = getattr(prompt_result, "usage", None)
if prompt_usage is not None:
    # 优先使用 PromptResponse.usage（包含完整分项数据）
    usage_dict = extract_prompt_response_usage(prompt_usage).to_dict()
else:
    # fallback 到 usage_update 的累计数据
    usage_dict = handler_usage.to_dict() if handler_usage else ...
```

**③ `backend/.../agents/codex/adapter.py` — 同步修改**（同逻辑）

#### 前端改动（2 个文件）

**④ `ui/src/types.ts` — 扩展 UsageStats**

```typescript
export interface UsageStats {
  // 新增：PromptResponse.usage 分项数据
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  // 保留：UsageUpdate 的 context window 数据
  promptTokens?: number;       // 向后兼容
  completionTokens?: number;   // 向后兼容
  totalTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  source?: string;
}
```

**⑤ `ui/src/features/chat/` — 展示分项数据**

可在 turn 完成后展示一个 token breakdown 面板，显示：
- Input tokens / Output tokens
- Cache read / Cache write tokens
- Thought tokens（推理消耗）
- Total tokens

### 1.6 数据源汇总

| 维度 | `usage_update` (实时) | `PromptResponse.usage` (turn 结束) |
|------|:---:|:---:|
| input_tokens | ❌ | ✅ |
| output_tokens | ❌ | ✅ |
| cached_read_tokens | ❌ | ✅ |
| cached_write_tokens | ❌ | ✅ |
| thought_tokens | ❌ | ✅ |
| total_tokens | ❌ | ✅ |
| context_used (used) | ✅ | ❌ |
| context_window (size) | ✅ | ❌ |
| cost | 可选 | ❌ |

**结论**：两个数据源互补，合并后可获得完整视图。`PromptResponse.usage` 虽然标记为 UNSTABLE，但它是获取分项 token 数据的最直接方式，值得接入。

---

## 2. 上下文压缩：如何手动触发

### 2.1 结论：通过发送 `/compact` 作为 prompt 文本触发

ACP 协议**没有** `session/compact` 这样的专用 API。触发压缩的唯一方式是**将 `/compact` 字符串作为普通 prompt 文本通过 `session/prompt` 发送给 runtime**。

### 2.2 ACP 协议层面

- `AGENT_METHODS`（`meta.py:3-31`）中**没有** `session/compact`
- ACP SDK `schema.py` 全文搜索 `compact` — **零匹配**
- Runtime 通过 `available_commands_update` 事件广播 `compact` 为可用命令

### 2.3 触发流程

```
ACP Runtime 在 session/update 中发送 available_commands_update
  → 包含 { name: "compact", description: "Compact conversation..." }
  → 前端检测到 compact 命令可用
  → 用户点击"压缩"按钮（或输入 /compact）
  → 前端将 "/compact" 作为普通 prompt 文本发送
  → 后端 session/prompt(prompt=[text_block("/compact")])
  → Runtime 执行压缩
  → 返回文本 "Context compacted..."
  → 发送新的 usage_update（used 值突然下降）
  → 前端 ContextRing 百分比下降
```

### 2.4 VibeX 参考实现

VibeX 已经完整实现了 compact 功能，方式就是发送 `/compact` 作为 prompt：

**后端 — slash command 注册**（`crates/services/src/services/container.rs:171`）：
```rust
fn acp_slash_command_catalog(agent_type: AgentType) -> Vec<SlashCommandDescription> {
    match agent_type {
        AgentType::ClaudeCode => vec![
            slash_command("compact", "Compact conversation with an optional focus"),
        ],
        AgentType::Codex => vec![
            slash_command("compact", "Compact conversation with an optional focus"),
        ],
        AgentType::OpenCode => vec![
            slash_command("compact", "Compact the current session"),
        ],
    }
}
```

**前端 — 触发逻辑**（`frontend/src/components/tasks/follow-up/useSessionComposerContextCompact.ts`）：
```typescript
const handleCompactContext = useCallback(async () => {
    const compactTurnInput = buildCompactContextTurnInput({ ... });
    const turn = await sendAgentRuntimeTurn(compactTurnInput); // 发送 "/compact" 作为 text
    setPendingCompactProcessId(turn.turnId);
}, [...]);
```

**前端 — 状态检测**（`frontend/src/lib/contextCompact.ts`）：
```typescript
export const CONTEXT_COMPACT_RUNNING_TEXT = '正在执行上下文压缩...';
export const CONTEXT_COMPACT_SUCCESS_TEXT = '上下文已压缩';
export const CONTEXT_COMPACT_FAILED_TEXT = '上下文压缩失败';

export function isContextCompactPrompt(prompt: string | null | undefined): boolean {
  return typeof prompt === 'string' && /^\/compact(?:\s|$)/i.test(prompt.trim());
}
```

**注意**：VibeX 的 Codex Native Provider（不走 ACP，直接走 Codex app-server JSON-RPC）使用私有协议 `thread/compact/start` + `thread/compacted` 事件。但这是 Codex 私有协议，不是 ACP 标准。

### 2.5 codex-lite 实现建议

需要修改的文件：

| 文件 | 改动 |
|------|------|
| `ui/src/features/chat/ChatComposer.tsx` | 增加 `/compact` 斜杠命令或"压缩"按钮 |
| `ui/src/features/chat/ChatComposer.tsx` | 监听 `available_commands_update` 事件，检测 compact 命令是否可用 |
| `ui/src/features/chat/MessageList.tsx` | 检测压缩状态文本，展示 "上下文已压缩" 提示 |
| `backend/.../acp/client.py` | 处理 `available_commands_update` 事件，提取可用命令列表 |
| `ui/src/types.ts` | 增加 `availableCommands` 到事件类型 |

数据流：
```
Runtime 发送 available_commands_update (含 compact 命令)
  → AcpClientHandler 检测并记录 compact 可用
  → 推送 agent.commands.updated 事件给前端
  → ChatComposer 显示 /compact 斜杠命令或"压缩"按钮
  → 用户触发 → 发送 "/compact" 作为 prompt
  → 检测返回文本中 "compacted" 关键词
  → 显示 "上下文已压缩" 状态
```

### 2.6 Demo 中的验证命令

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py \
  --agent codex --temp-workspace --allow-real-turn --summary-only --prompt "/compact"
```

---

## 3. Subagent：如何展示

### 3.1 结论：ACP 协议没有原生 subagent 事件，VibeX 通过 MCP + Delegation Broker 实现

### 3.2 ACP 协议层面

ACP 协议有 `session/fork` 方法（UNSTABLE），可以创建新的独立 session：

```python
# schema.py:3840
class ForkSessionRequest(BaseModel):
    session_id: str
    cwd: str
    additional_directories: Optional[List[str]] = None
    mcp_servers: Optional[List[McpServerConfig]] = None

# schema.py:4711
class ForkSessionResponse(BaseModel):
    session_id: str  # 新 fork 的 session ID
```

但 ACP **没有**定义 `task_started`、`agent_spawned`、`delegation_started` 等 subagent 事件类型。

### 3.3 codex-lite 当前状态

**完全不存在** subagent / delegation 相关的类型、事件或 UI 组件。

`AgentEvent` 类型（`ui/src/types.ts:310-421`）只包含标准事件（text.delta、tool.started、context.updated 等），没有 subagent 相关事件。

### 3.4 VibeX 的实现方式（应用层方案）

VibeX 的 subagent 不依赖 ACP 协议层面的事件，而是在**应用层**通过 MCP 工具 + Delegation Broker 实现：

```
Agent 执行中
  → 调用 delegate_to_agent MCP 工具（由 vibex-mcp server 暴露）
  → Delegation Broker 启动子 agent session
  → 发射 AgentEvent::DelegationStarted
  → UI 渲染 DelegationCard（显示任务描述、agent 类型、运行状态）
  → 子 agent 完成
  → 发射 AgentEvent::DelegationCompleted
  → DelegationCard 更新为完成状态（显示结果预览、耗时）
```

**后端架构**（Rust）：
- `crates/delegation/` — broker/listener/spawner/resolver 完整架构
- `crates/delegation-proto/` — 协议定义
- `crates/vibex-mcp/` — MCP server，暴露 3 个工具：
  - `delegate_to_agent` — 启动子 agent
  - `get_delegation_status` — 查询状态
  - `cancel_delegation` — 取消

**前端数据模型**（`shared/types.ts:906`）：
```typescript
export type ConversationDelegation = {
  delegation_id: string,
  parent_tool_call_id: string,
  child_conversation_id: string,
  agent_type: AgentType,
  task_preview: string,
};

export type ConversationDelegationView = {
  delegation_id: string,
  parent_tool_call_id?: string | null,
  child_conversation_id?: string | null,
  agent_type?: AgentType | null,
  task_preview?: string | null,
  status: string,  // running / completed / failed
  result?: ConversationDelegationResult | null,
};
```

**前端 UI 组件**（`DelegationCard.tsx`）：
- 显示委派给哪个 agent（agent_type）
- 任务描述（task_preview）
- 状态标签（running/completed/failed）+ spinner 动画
- 完成后的结果预览（text_preview）
- 耗时（duration_ms）
- "打开子会话" 按钮（跳转到 child conversation）

### 3.5 codex-lite 实现 subagent 展示的可行方案

由于 ACP 协议没有原生 subagent 事件，有两种方案：

**方案 A：通过 tool_call 事件间接展示**（推荐，无需额外基础设施）

ACP 的 `tool_call` + `tool_call_update` 事件已经在流式传输。当 agent 使用内置的 subagent 工具（如 Claude Code 的 `Agent` 工具、Codex 的 subagent）时，tool_call 事件中会包含 subagent 的调用信息。可以在前端：

1. 检测特定的 tool_call name（如 `Agent`、`subagent`、`delegate`）
2. 将这类 tool_call 渲染为特殊的 "子任务卡片"
3. 从 tool_call_update 的 delta 中提取子 agent 的输出

**方案 B：构建 MCP Delegation Broker**（VibeX 方案，复杂但功能完整）

需要：
1. 实现 MCP server 暴露 delegation 工具
2. 实现 broker 管理子 agent 生命周期
3. 前端 DelegationCard 组件

---

## 4. 多模态功能：图片传入

### 4.1 结论：ACP 协议支持，SDK 已提供 `image_block()` 工厂函数，但 codex-lite 全链路未实现

### 4.2 ACP SDK 已提供图片支持

SDK `helpers.py` 已定义 `image_block()` 工厂函数：

```python
# helpers.py
def image_block(data: str, mime_type: str, ...) -> ImageContentBlock
```

`ContentBlock` 类型（`helpers.py:36-38`）包含 5 种 block：

| Block 类型 | type 值 | 关键字段 |
|-----------|---------|---------|
| `TextContentBlock` | `"text"` | `text: str` |
| `ImageContentBlock` | `"image"` | `data: str` (base64), `mime_type: str` |
| `AudioContentBlock` | `"audio"` | `data: str` (base64), `mime_type: str` |
| `ResourceContentBlock` | `"resource_link"` | `name: str`, `uri: str`, `mime_type: str` |
| `EmbeddedResourceContentBlock` | `"resource"` | `resource: TextResourceContents \| BlobResourceContents` |

`prompt()` 方法的签名已支持混合内容：

```python
async def prompt(
    self,
    prompt: list[TextContentBlock | ImageContentBlock | AudioContentBlock
                 | ResourceContentBlock | EmbeddedResourceContentBlock],
    session_id: str,
    message_id=None,
) -> PromptResponse
```

### 4.3 ImageContent 的完整定义

```python
# schema.py:2648
class ImageContent(BaseModel):
    data: str          # base64 编码的图片数据
    mime_type: str     # 如 "image/png", "image/jpeg"
    annotations: Optional[Annotations] = None
```

### 4.4 当前缺失与改造链路

```
当前: prompt=[acp.text_block("hello")]
目标: prompt=[acp.text_block("分析这张图"), acp.image_block(base64_data, "image/png")]
```

需要改造的完整链路：

| 层 | 文件 | 当前 | 目标 |
|----|------|------|------|
| **前端输入** | `ChatComposer.tsx` | textarea 纯文本 | 增加图片上传/粘贴/拖拽 |
| **前端类型** | `types.ts` | `ChatMessage.content: string` | 改为 content block array |
| **前端渲染** | `MessageList.tsx` | `<p>{content}</p>` | 渲染图片预览 |
| **API 路由** | `routes/turns.py` | `input: string` | 改为 content array |
| **请求模型** | `schemas/agent.py` | `AgentRunRequest.prompt: str` | 改为 `content: list[ContentBlock]` |
| **ACP adapter** | `acp/adapter.py` | `[acp.text_block(...)]` | `[text_block(...), image_block(...)]` |
| **Codex adapter** | `codex/adapter.py` | 同上 | 同上 |
| **事件映射** | `acp/mapper.py` | `_text_from_content()` 只提取 text | 处理 image 类型 |

### 4.5 已有基础设施

- `ModelCapabilities.vision` 字段已存在（`types.ts`、`SettingsPage.tsx`）
- 设置页有"多模态支持"开关
- `ChatComposer.tsx` 有 Paperclip 图标按钮（但无 `onClick` handler）
- SDK 已有 `image_block()` 工厂函数，无需额外封装

### 4.6 实现建议

分步实施：
1. **后端先行**：扩展 `AgentRunRequest` 支持 content array，adapter 支持 image block
2. **前端输入**：ChatComposer 增加图片粘贴（`onPaste`）、拖拽（`onDrop`）、文件选择（`<input type="file">`）
3. **前端渲染**：MessageList 渲染图片缩略图
4. **能力协商**：根据 `promptCapabilities.image` 和 `ModelCapabilities.vision` 控制图片功能可见性

---

## 5. 附录：ACP SDK 完整 API 速查

### 5.1 Client → Agent 方法（AGENT_METHODS）

```python
{
    "initialize", "logout",
    "session_new", "session_load", "session_list", "session_close",
    "session_prompt", "session_cancel", "session_fork", "session_resume",
    "session_set_mode", "session_set_model", "session_set_config_option",
    "authenticate",
    "document_did_open/save/change/focus/close",
    "nes_start/accept/reject/close/suggest",
    "providers_list/disable/set",
}
```

**注意**：没有 `session_compact`、没有 `session_delegate`。

### 5.2 Agent → Client 方法（CLIENT_METHODS）

```python
{
    "session_update",                    # 流式事件推送
    "fs_read_text_file", "fs_write_text_file",
    "terminal_create/output/wait_for_exit/kill/release",
    "session_request_permission",
    "elicitation_create/complete",
}
```

### 5.3 session/update 事件类型

| `session_update` 值 | 说明 |
|---|---|
| `agent_message_chunk` | Agent 消息片段 |
| `agent_thought_chunk` | Agent 思考片段 |
| `user_message_chunk` | 用户消息片段 |
| `tool_call` | 工具调用开始 |
| `tool_call_update` | 工具调用进度 |
| `plan` | 计划更新 |
| `available_commands_update` | 可用命令更新（含 compact） |
| `current_mode_update` | 当前模式更新 |
| `config_option_update` | 配置选项更新 |
| `session_info_update` | 会话信息更新 |
| `usage_update` | Token 使用量更新（只有 used/size） |

### 5.4 PromptResponse 完整定义

```python
# schema.py:3108-3155
class PromptResponse(BaseModel):
    field_meta: Optional[Dict[str, Any]]  # _meta
    stop_reason: StopReason               # "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
    usage: Optional[Usage]                # UNSTABLE — 完整分项 token 数据
    user_message_id: Optional[str]        # UNSTABLE — 回显的消息 ID
```

### 5.5 SDK Helper 工厂函数

```python
# helpers.py 导出的便捷函数
text_block(text)                          # 创建文本 block
image_block(data, mime_type)              # 创建图片 block
audio_block(data, mime_type)              # 创建音频 block
resource_link_block(name, uri, ...)       # 创建资源链接 block
embedded_text_resource(...)               # 创建嵌入文本资源
embedded_blob_resource(...)               # 创建嵌入二进制资源
resource_block(...)                       # 创建资源 block
tool_content(...)                         # 工具内容
tool_diff_content(...)                    # 工具 diff 内容
tool_terminal_ref(...)                    # 工具终端引用
plan_entry(...)                           # 计划条目
update_plan(...)                          # 更新计划
update_user_message(...)                  # 更新用户消息
update_agent_message(...)                 # 更新 agent 消息
update_agent_thought(...)                 # 更新 agent 思考
session_notification(...)                 # 会话通知
start_tool_call(...)                      # 开始工具调用
start_read_tool_call(...)                 # 开始读工具调用
start_edit_tool_call(...)                 # 开始编辑工具调用
update_tool_call(...)                     # 更新工具调用
```

---

## 6. 总结与改进建议

### 6.1 能力矩阵

| 能力 | ACP 协议支持 | SDK 工具 | codex-lite 现状 | 改进难度 |
|------|:---:|:---:|:---:|:---:|
| Token 分项统计 | ✅ `PromptResponse.usage` | ✅ Usage 类 | ❌ 未读取 | 🟢 低 |
| Context window 使用率 | ✅ `usage_update` | ✅ UsageUpdate 类 | ✅ 已实现 | — |
| 手动触发压缩 | ✅ 发送 `/compact` prompt | ✅ text_block | ❌ 未实现 | 🟢 低 |
| 压缩状态检测 | ✅ `available_commands_update` | ✅ 事件类型 | ❌ 未实现 | 🟡 中 |
| Subagent 展示 | ⚠️ 通过 tool_call 间接 | ✅ 已有事件 | ❌ 未实现 | 🟡 中 |
| 多模态图片输入 | ✅ `promptCapabilities.image` | ✅ image_block() | ❌ 未实现 | 🟠 中高 |

### 6.2 优先实施建议

1. **🔴 高优先级 — Token 分项统计**：改动最小（3 个后端文件 + 2 个前端文件），价值最高。读取 `prompt_result.usage` 即可获得 input/output/cache/thought tokens。

2. **🟡 中优先级 — 手动压缩**：发送 `/compact` 作为 prompt，监听 `available_commands_update` 检测 compact 可用性。参考 VibeX 的 `contextCompact.ts` 实现。

3. **🟡 中优先级 — Subagent 展示**：通过 tool_call 事件检测 subagent 类型的工具调用，在前端渲染为子任务卡片。无需额外 MCP 基础设施。

4. **🟠 中低优先级 — 多模态图片**：全链路改造，工作量大但 SDK 已提供所有基础设施。建议分步实施。

### 6.3 参考资源

| 资源 | 路径 | 说明 |
|------|------|------|
| ACP SDK Schema | `backend/.venv/.../acp/schema.py` | 完整类型定义 |
| ACP SDK Helpers | `backend/.venv/.../acp/helpers.py` | 工厂函数 |
| ACP SDK Meta | `backend/.venv/.../acp/meta.py` | AGENT_METHODS/CLIENT_METHODS |
| VibeX Compact | `ref/VibeX-master/frontend/src/lib/contextCompact.ts` | 压缩状态检测 |
| VibeX Delegation | `ref/VibeX-master/crates/delegation/` | Subagent 架构 |
| VibeX Usage | `ref/VibeX-master/crates/agents/src/parsers/claude.rs` | 转录文件 token 解析 |
| ACP Demo Probe | `demo/acp-demo/python_sdk_acp_probe.py` | Compact 验证命令 |
| 设计文档 | `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md` | ACP 实现设计 |
