# ACP 协议能力调研：Token 统计、模式控制、多模态

> 调研日期：2026-07-05
> 调研范围：codex-lite 项目中 Codex ACP 和 Claude Code ACP 的协议能力
> 分支：`research/acp-investigation`

---

## 目录

1. [Token 使用量信息](#1-token-使用量信息)
2. [上下文压缩 (Context Compression)](#2-上下文压缩-context-compression)
3. [Plan Mode](#3-plan-mode)
4. [Goal Mode](#4-goal-mode)
5. [多模态功能（图片传入）](#5-多模态功能图片传入)
6. [总结与改进建议](#6-总结与改进建议)

---

## 1. Token 使用量信息

### 1.1 ACP 协议定义了两个 Usage 结构

ACP 协议（`acp.schema`）定义了两类携带 token 信息的结构：

#### 结构一：`UsageUpdate` — 实时流式事件

通过 `session/update` 以 `usage_update` 类型推送，**只携带 context window 维度信息**：

```python
class _UsageUpdate(BaseModel):
    field_meta: Optional[Dict[str, Any]]  # _meta
    cost: Optional[Cost]                  # 累积 session 费用 (可选)
    size: int                             # 总 context window 大小 (tokens)
    used: int                             # 当前 context 中使用的 tokens
```

**关键**：`UsageUpdate` **不包含** input_tokens / output_tokens / cache_creation / cache_read 等分项。

#### 结构二：`Usage` — PromptResponse 中的 turn 汇总

出现在 `PromptResponse.usage`（prompt 完成后的返回值中），携带**丰富的分项 token 信息**：

```python
class Usage(BaseModel):
    cached_read_tokens: Optional[int]    # cache 读取 tokens
    cached_write_tokens: Optional[int]   # cache 写入 tokens
    input_tokens: int                    # 输入 tokens
    output_tokens: int                   # 输出 tokens
    thought_tokens: Optional[int]        # 推理/思考 tokens
    total_tokens: int                    # 所有 token 类型的总和
```

**注意**：此字段标记为 **unstable**，不是所有 ACP agent 都会实现。

### 1.2 codex-lite 当前实现

#### 后端处理

`UsageSnapshot`（`backend/.../agents/acp/mapper.py`）只提取 `used` 和 `size`：

```python
@dataclass
class UsageSnapshot:
    total_tokens: int | None = None
    context_used_tokens: int | None = None
    context_window_tokens: int | None = None
    source: str = "acp.usage_update"

def _extract_usage(update: Any) -> UsageSnapshot:
    return UsageSnapshot(
        total_tokens=getattr(update, "used", None),
        context_used_tokens=getattr(update, "used", None),
        context_window_tokens=getattr(update, "size", None),
    )
```

**`PromptResponse.usage`（包含完整分项数据）从未被读取**。代码只提取了 `prompt_result.stop_reason`，忽略了 `prompt_result.usage`。

#### 前端类型

`UsageStats`（`ui/src/types.ts`）定义了 `promptTokens` 和 `completionTokens` 字段，但后端 ACP 路径**从未填充**这些字段：

```typescript
export interface UsageStats {
  promptTokens?: number;       // 定义但从未填充
  completionTokens?: number;   // 定义但从未填充
  totalTokens?: number;        // ✅ 从 used 填充
  contextUsedTokens?: number;  // ✅ 从 used 填充
  contextWindowTokens?: number;// ✅ 从 size 填充
  source?: string;
}
```

### 1.3 VibeX 参考实现

VibeX（`ref/VibeX-master`）实现了更完整的 token 统计，但数据来源不同：

- **实时流**：同样只从 `UsageUpdate` 获取 `used`/`size`，转换时 `input_tokens = used`，其余分项**硬编码为 0**
- **完整分项数据**：来自 Claude Code **JSONL 转录文件的离线解析**（`parsers/claude.rs`），而非 ACP 实时流

```rust
// VibeX: 从 ACP UsageUpdate 转换时
AgentEvent::Usage { usage } => Some(ConversationEvent::UsageUpdated {
    usage: ConversationUsage {
        input_tokens: usage.used,       // 用 used 填充
        output_tokens: 0,               // 硬编码 0
        cache_creation_input_tokens: 0, // 硬编码 0
        cache_read_input_tokens: 0,     // 硬编码 0
        context_window_max: usage.limit,
    },
}),
```

### 1.4 Token 信息来源对比

| 维度 | ACP `usage_update` (实时流) | ACP `PromptResponse.usage` (turn 结束) | Claude Code 转录文件 |
|------|:---:|:---:|:---:|
| input_tokens | ❌ | ✅ | ✅ |
| output_tokens | ❌ | ✅ | ✅ |
| cache_creation_input_tokens | ❌ | ❌ | ✅ |
| cache_read_input_tokens | ❌ | ❌ | ✅ |
| thought_tokens | ❌ | ✅ | ❌ |
| total_tokens | ❌ | ✅ | 可计算 |
| context_used (used) | ✅ | ❌ | ❌ |
| context_window (size) | ✅ | ❌ | ❌ |
| cost | 可选 | ❌ | ❌ |

### 1.5 改进建议

1. **读取 `PromptResponse.usage`**：当前代码完全忽略了这个字段。应当在 `agent.run.completed` 事件中提取 `prompt_result.usage`，获取 input_tokens / output_tokens / cached_read_tokens / cached_write_tokens / thought_tokens
2. **合并两个数据源**：实时流中的 `usage_update` 提供 context window 信息，`PromptResponse.usage` 提供分项 token 信息，两者互补
3. **扩展 `UsageSnapshot`**：增加 `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`thought_tokens` 字段
4. **前端适配**：`UsageStats` 已有 `promptTokens` / `completionTokens` 字段，只需后端填充即可

---

## 2. 上下文压缩 (Context Compression)

### 2.1 现状：不自行实现，完全依赖 ACP runtime

codex-lite **没有**自己实现任何 context compression 或 summarization 逻辑。压缩功能完全由各 ACP runtime（Codex、Claude Code）在其内部处理。

### 2.2 触发方式

压缩有两种触发途径：

1. **自动触发**：runtime 内部在上下文窗口接近满时自动执行
2. **手动触发**：用户在 runtime 原生界面中通过 `/compact` 命令触发

code-lite 无法直接触发压缩，也没有暴露压缩按钮或 API。

### 2.3 可观测性

当 runtime 执行压缩时，会发生两件事：

1. **文本信号**：runtime 发送一段文本（如 `Context compacted...`），`AcpEventMapper` 将其映射为 `agent.text.delta` 事件展示在聊天界面
2. **Usage 更新**：发送新的 `usage_update`（`used` 和 `size` 值），前端 `ContextRing` 组件的百分比会突然下降

用户可以从 ContextRing 的百分比下降**间接观察**到压缩发生了。

### 2.4 协议限制

> `/compact` 会触发可观察文本和新的 `usage_update`，但 ACP SDK schema 没有标准化的 compaction 字段。code-lite 可以 best-effort 记录 runtime-specific 压缩信号，但不要把它设计成跨 runtime 强保证。
> — `docs/research/0703-BACKEND-ACP-RESEARCH.md`

### 2.5 上下文窗口管理

- **默认窗口大小**：`DEFAULT_CONTEXT_WINDOW_TOKENS = 65_536`（`services/model_config.py`）
- **前端展示**：`ContextRing` 组件（24px SVG 圆环），颜色分级：<50% 正常、50-80% 警告、>80% 危险
- **相关文件**：
  - `backend/.../services/model_config.py` — 模型配置
  - `ui/src/features/chat/ContextRing.tsx` — 前端圆环组件

---

## 3. Plan Mode

### 3.1 定义

Plan Mode 是 **Claude Code runtime** 提供的一种 **access mode**，通过 ACP 协议的 mode 机制实现。

### 3.2 各 Runtime 支持的模式

**Claude Code**（`runtimes/descriptors.py`）：

| Mode ID | 说明 |
|---------|------|
| `ask` | 只问答，不修改代码 |
| `code` | 正常编码模式 |
| `plan` | 计划模式 — 只规划不执行 |

**Codex**（`runtimes/descriptors.py`）：

| Mode ID | 说明 |
|---------|------|
| `read-only` | 只读模式 |
| `agent` | 代理模式 |
| `agent-full-access` | 完全访问代理模式 |

**注意**：Codex 没有 `plan` mode，只有 Claude Code 提供。

### 3.3 触发流程

```
ACP session/new 返回 modes 列表
  → parse_modes_from_session_result() 提取
  → _build_modes() 三源合并（configOptions > session_result.modes > default）
  → SessionCapabilities.modes 返回前端
  → ChatComposer 渲染 access-mode-menu 下拉菜单
  → 用户选择 "plan"
  → updateSessionConfig({ accessMode: "plan" })
  → sendMessage() 携带 accessMode: "plan"
  → 后端 _resolve_mode("plan") → "plan" (Claude Code 直接透传)
  → conn.set_session_mode(session_id, mode_id="plan")
  → Claude Code runtime 切换到 plan 模式
```

### 3.4 UI 交互

- **位置**：`ChatComposer.tsx` 输入框左下角的 access mode 下拉菜单
- **图标**：Plan mode 使用 `FileText` 图标（lucide-react）
- **Per-session 隔离**：每个会话的 mode 独立存储，切换会话时保持各自 mode 不变

### 3.5 关键文件

| 文件 | 职责 |
|------|------|
| `backend/.../runtimes/descriptors.py` | Mode 映射表和 resolve 函数 |
| `backend/.../acp/adapter.py` | `_configure_session()` 每轮 turn 前调用 `set_session_mode()` |
| `backend/.../acp/capabilities.py` | `parse_modes_from_session_result()` 从 ACP 提取 modes |
| `backend/.../api/routes/sessions.py` | `_build_modes()` 三源合并构建 modes 列表 |
| `ui/src/features/chat/ChatComposer.tsx` | Access mode picker UI |
| `ui/src/pages/SettingsPage.tsx` | Codex 全局默认 mode 配置 |

---

## 4. Goal Mode

### 4.1 结论：本项目中不存在

经过对整个项目的全面搜索：

- `goalMode` / `goal_mode` / `goal-mode` / `GoalMode` — **0 匹配**
- `goal` 在代码和文档中 — **0 相关匹配**

本项目**没有**任何 Goal Mode 的实现、配置、文档或讨论。

如果 Goal Mode 是其他产品（如 Claude Code 原生 CLI）中的功能，那么它可能：
- 尚未通过 ACP 协议暴露
- 尚未被 code-lite 项目集成
- 是产品路线图中的未来功能

---

## 5. 多模态功能（图片传入）

### 5.1 ACP 协议层面的支持

ACP 协议的 `initialize` 响应中，agent 通过 `agentCapabilities.promptCapabilities.image` 声明是否支持图片输入：

```python
"promptCapabilities": {
    "image": True/False,    # 是否支持图片
    "audio": True/False,    # 是否支持音频
    "embeddedContext": True, # 是否支持嵌入上下文
}
```

**真实 Codex ACP runtime 声明支持 image 能力**（见 `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`）。

### 5.2 ACP Content Block 预期格式

ACP `session/prompt` 接受 `prompt` 数组，每个元素是一个 content block。当前代码只处理 `type: "text"` 的 block：

```python
# 当前实现（acp/adapter.py）
prompt_result = await connection_sdk.prompt(
    session_id=binding.native_session_id,
    prompt=[acp.text_block(request.prompt)],  # 只有文本
)
```

图片 content block 的预期格式推断为：

```json
{"type": "image", "data": "<base64-encoded>", "mimeType": "image/png"}
```

或 resource URL 形式。但项目代码中**完全没有实现** image block 的构造。

### 5.3 当前项目各层现状

| 层面 | 现状 | 缺失 |
|------|------|------|
| **ACP 协议** | `promptCapabilities.image` 字段已定义；Codex 声明支持 | mock agent 都设为 `False` |
| **后端 API** | `/api/turns/stream` 只接受 `input: string` | 需要改为接受 content array |
| **AgentRunRequest** | `prompt: str` 纯文本 | 需要改为 `content: list[ContentBlock]` |
| **ACP adapter** | 只用 `acp.text_block()` | 需要添加 `acp.image_block()` 或等效构造 |
| **前端 ChatMessage** | `content: string` | 需要改为 content array |
| **前端 ChatComposer** | Paperclip 按钮无功能；textarea 只接受文本 | 需要添加图片上传、粘贴、拖拽 |
| **前端消息渲染** | 用户消息只渲染 `<p>{content}</p>` | 需要渲染图片预览 |
| **模型能力** | `vision` 字段已存在于类型定义和设置页 | 需要在发送时根据 vision 能力决定是否允许图片 |

### 5.4 已有的基础

项目已有一些基础设施为多模态做了准备：

1. **`ModelCapabilities.vision`**（`ui/src/types.ts`）：模型级别的视觉能力标记
2. **设置页面**：`SettingsPage.tsx` 有"多模态支持"开关，可设置 `vision: supportsMultimodal`
3. **附件按钮**：`ChatComposer.tsx` 有 Paperclip 图标按钮（但无 `onClick` handler）

### 5.5 关键文件

| 文件 | 当前状态 |
|------|----------|
| `backend/.../schemas/agent.py` | `AgentRunRequest.prompt: str` — 纯文本 |
| `backend/.../api/routes/turns.py` | `prompt = str(body.get("input") or "").strip()` — 强制字符串 |
| `backend/.../acp/adapter.py` | `prompt=[acp.text_block(request.prompt)]` — 只发文本 |
| `backend/.../acp/mapper.py` | `_text_from_content()` 只提取 text 字段 |
| `backend/.../codex/adapter.py` | 同样只用 `acp.text_block()` |
| `ui/src/types.ts` | `ChatMessage.content: string` — 纯文本 |
| `ui/src/features/chat/ChatComposer.tsx` | Paperclip 按钮无功能 |
| `ui/src/features/chat/MessageList.tsx` | 用户消息只渲染 `<p>{content}</p>` |

### 5.6 实现多模态需要修改的链路

```
前端 ChatComposer
  ↓ 添加图片上传/粘贴/拖拽
  ↓ content 从 string 改为 ContentBlock[]
  ↓
API 路由 /api/turns/stream
  ↓ input 从 string 改为 ContentBlock[]
  ↓
AgentRunRequest
  ↓ prompt 从 str 改为 list[ContentBlock]
  ↓
ACP adapter
  ↓ 构造 [text_block(...), image_block(...)] 数组
  ↓
ACP session/prompt
  ↓ runtime 处理多模态输入
```

---

## 6. 总结与改进建议

### 6.1 能力成熟度矩阵

| 能力 | ACP 协议支持 | codex-lite 实现 | 优先级 |
|------|:---:|:---:|:---:|
| Token 分项统计 (input/output/cache) | ✅ `PromptResponse.usage` | ❌ 未读取 | 🔴 高 |
| Context window 使用率 | ✅ `usage_update` | ✅ 已实现 | — |
| 上下文压缩 | ✅ runtime 内部 | ⚠️ 仅被动观测 | 🟡 中 |
| Plan Mode (Claude Code) | ✅ access mode | ✅ 已实现 | — |
| Goal Mode | ❌ 不存在 | ❌ 不存在 | — |
| 多模态图片输入 | ✅ `promptCapabilities.image` | ❌ 未实现 | 🟡 中 |

### 6.2 优先改进项

#### 高优先级：读取 PromptResponse.usage

当前 `PromptResponse.usage` 中的完整 token 分项数据被完全忽略，这是最容易获取也最有价值的改进：

```python
# 建议在 adapter.py 的 agent.run.completed 事件中增加：
usage = getattr(prompt_result, "usage", None)
if usage:
    detailed_usage = {
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
        "cache_read_tokens": getattr(usage, "cached_read_tokens", None),
        "cache_write_tokens": getattr(usage, "cached_write_tokens", None),
        "thought_tokens": getattr(usage, "thought_tokens", None),
        "total_tokens": getattr(usage, "total_tokens", None),
    }
```

#### 中优先级：上下文压缩可观测

- 检测压缩信号（如文本包含 "compacted" 或 `used` 值突然下降）
- 在前端显示 "上下文已压缩" 的提示
- 记录压缩事件到会话历史

#### 中优先级：多模态图片支持

需要全链路改造（前端 → API → adapter → ACP），建议分步实施：
1. 后端先支持 content array 格式的 prompt
2. ACP adapter 增加 image block 构造
3. 前端增加图片上传/粘贴功能
4. 根据模型 `vision` 能力控制图片功能可见性

### 6.3 参考资源

- VibeX 的转录文件解析方案（`ref/VibeX-master/crates/agents/src/parsers/claude.rs`）可作为获取完整 token 统计的备选方案
- ACP 协议 `promptCapabilities` 机制可作为多模态能力协商的标准方式
