# Agent 增强功能设计文档

> 日期：2026-07-05
> 分支：`research/acp-investigation`
> 状态：Draft

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [功能一：Token 分项统计与消息记录](#2-功能一token-分项统计与消息记录)
3. [功能二：上下文压缩感知与状态展示](#3-功能二上下文压缩感知与状态展示)
4. [功能三：上下文圆环 Token 详情弹窗](#4-功能三上下文圆环-token-详情弹窗)
5. [功能四：快捷指令面板](#5-功能四快捷指令面板)
6. [技术实现细节](#6-技术实现细节)
7. [影响文件清单](#7-影响文件清单)

---

## 1. 背景与目标

### 1.1 现状问题

1. **Token 分项数据缺失**：当前 messages.json 中的 `usage` 字段只有 `totalTokens`、`contextUsedTokens`、`contextWindowTokens` 三个值，缺少 input_tokens、output_tokens、cache_read_tokens、cache_write_tokens、thought_tokens 等分项数据，无法用于审计和统计
2. **压缩不可见**：执行 `/compact` 后上下文窗口使用量下降（如 34,558 → 6,887），但用户只能通过圆环百分比变化间接感知，没有明确的压缩状态反馈
3. **圆环功能单一**：ContextRing 仅展示百分比，无法查看完整的 token 使用明细
4. **快捷指令无 UI**：Codex/Claude Code 都支持 `/compact`、`/goal` 等斜杠命令，但前端没有任何引导，用户不知道可用命令

### 1.2 验证结论

通过实际 messages.json 数据验证：

| 验证项 | 结论 |
|--------|------|
| `/compact` 命令 | ✅ Codex 和 Claude Code 都支持，发送后 contextUsedTokens 显著下降 |
| 压缩后消息 | ✅ 压缩后 assistant 消息内容为 `"*Context compacted to fit the model's context window.*"` |
| usage 更新 | ✅ 压缩后 usage_update 正常推送，contextWindowTokens 保持 258400 不变 |
| `/plan` 命令 | ❌ Codex 不支持，返回 "Unknown command" 并列出可用命令 |
| `/goal` 命令 | ✅ Codex 支持（Set, pause, resume, or clear a task goal） |

**Codex 实际支持的完整命令列表**（来自真实 ACP 响应）：

| 命令 | 说明 |
|------|------|
| `/mcp` | 显示 MCP 服务器状态 |
| `/skills` | 列出可用 skills |
| `/status` | 显示会话配置和 token 使用 |
| `/review` | 审查未暂存的更改 |
| `/review-branch` | 与某个分支进行比较 |
| `/review-commit` | 审查特定 commit |
| `/compact` | 压缩上下文 |
| `/goal` | 设置/暂停/恢复/清除目标 |
| `/logout` | 退出登录 |

**Claude Code 实际支持的命令**（来自 VibeX 调研）：

| 命令 | 说明 |
|------|------|
| `/compact` | Compact conversation with optional focus |
| `/goal` | Set, inspect, pause, resume, or clear a long-running goal |
| `/init` | Initialize a CLAUDE.md file |
| `/resume` | Resume a Claude Code conversation |
| `/review` | Review a pull request |
| `/context` | Show Claude Code context usage |

### 1.3 数据来源验证

messages.json 中的实际 usage 数据（9 个出现点）：

```json
// 压缩前（消息 100）
{
  "totalTokens": 34558,
  "contextUsedTokens": 34558,
  "contextWindowTokens": 258400,
  "source": "acp.usage_update"
}

// 压缩后（消息 102）
{
  "totalTokens": 6887,
  "contextUsedTokens": 6887,
  "contextWindowTokens": 258400,
  "source": "acp.usage_update"
}
```

- `contextWindowTokens` 恒定为 258400（Codex 的 context window）
- `totalTokens` 始终等于 `contextUsedTokens`（因为都来自 usage_update 的 `used` 字段）
- **没有任何分项数据**（input/output/cache/thought）

---

## 2. 功能一：Token 分项统计与消息记录

### 2.1 目标

记录每次 assistant 响应的完整 token 分项数据（input_tokens、output_tokens、cached_read_tokens、cached_write_tokens、thought_tokens），保存到 messages.json 中，用于审计和会话统计。

### 2.2 数据流

```
ACP Agent
  → PromptResponse.usage (包含完整分项)
  → adapter.py 读取 prompt_result.usage
  → agent.run.completed 事件增加 usage 分项
  → conversation_recorder.py 写入 messages.json
  → 前端展示
```

### 2.3 后端改动

#### 2.3.1 扩展 UsageSnapshot

**文件**: `backend/code_lite_backend/agents/acp/mapper.py`

```python
@dataclass
class UsageSnapshot:
    # 来自 PromptResponse.usage 的分项数据（新字段）
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_read_tokens: int | None = None
    cached_write_tokens: int | None = None
    thought_tokens: int | None = None
    # 来自 UsageUpdate 的 context window 数据（保留）
    total_tokens: int | None = None
    context_used_tokens: int | None = None
    context_window_tokens: int | None = None
    source: str = "acp"

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

#### 2.3.2 adapter.py 读取 prompt_result.usage

**文件**: `backend/code_lite_backend/agents/acp/adapter.py`

在 `prompt_result = await connection_sdk.prompt(...)` 之后：

```python
# 优先使用 PromptResponse.usage（完整分项数据）
prompt_usage = getattr(prompt_result, "usage", None)
if prompt_usage is not None:
    usage_snapshot = extract_prompt_response_usage(prompt_usage)
    # 合并 usage_update 的 context window 数据
    if handler_usage:
        usage_snapshot.context_used_tokens = handler_usage.context_used_tokens
        usage_snapshot.context_window_tokens = handler_usage.context_window_tokens
    usage_dict = usage_snapshot.to_dict()
else:
    # fallback 到 usage_update 的累计数据
    usage_dict = handler_usage.to_dict() if handler_usage else None
```

#### 2.3.3 Codex runtime profile 同步修改

旧 `backend/code_lite_backend/agents/codex/adapter.py` 已从主线移除。Codex 相关差异应通过通用 `AcpAgentAdapter`、`RuntimeProfile` 和 `agents/runtimes/codex` 方向承载，不再维护独立 Codex adapter。

#### 2.3.4 消息记录

**文件**: `backend/code_lite_backend/agents/conversation_recorder.py`

当前 recorder 已经将 `event["usage"]` 写入 messages.json，无需额外改动。只要 adapter 发出的 `agent.run.completed` 事件中 `usage` 字段包含分项数据，messages.json 中就会自动记录。

### 2.4 前端类型扩展

**文件**: `ui/src/types.ts`

```typescript
export interface UsageStats {
  // PromptResponse.usage 分项数据（新增）
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  // UsageUpdate context window 数据（保留）
  promptTokens?: number;       // 向后兼容
  completionTokens?: number;   // 向后兼容
  totalTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  source?: string;
}
```

### 2.5 messages.json 预期输出

```json
{
  "id": "assistant-xxx",
  "role": "assistant",
  "content": "...",
  "usage": {
    "inputTokens": 12000,
    "outputTokens": 3500,
    "cachedReadTokens": 8000,
    "cachedWriteTokens": 2000,
    "thoughtTokens": 1500,
    "totalTokens": 27000,
    "contextUsedTokens": 34558,
    "contextWindowTokens": 258400,
    "source": "acp.prompt_response.usage"
  }
}
```

---

## 3. 功能二：上下文压缩感知与状态展示

### 3.1 目标

当用户执行 `/compact` 命令或 runtime 自动压缩时，前端能识别压缩状态并展示反馈。

### 3.2 压缩检测逻辑

**检测条件**（任一触发即视为压缩状态）：

1. **文本检测**：assistant 消息内容包含以下关键词：
   - `"Context compacted"`
   - `"Compacting..."`
   - `"context compressed"`
   - `"上下文已压缩"`
   - `"正在执行上下文压缩"`
2. **Usage 骤降**：`contextUsedTokens` 相比上一条 assistant 消息下降超过 50%
3. **命令检测**：用户发送的 prompt 以 `/compact` 开头

### 3.3 后端改动

#### 3.3.1 新增压缩检测事件

**文件**: `backend/code_lite_backend/agents/acp/mapper.py`

在事件映射层增加压缩检测逻辑，当检测到压缩信号时，在 `agent.run.completed` 事件中增加 `compacted` 标记：

```python
COMPACT_SIGNALS = [
    "context compacted",
    "compacting",
    "context compressed",
]

def _detect_compaction(content: str, prev_usage: dict | None, curr_usage: dict | None) -> bool:
    # 文本检测
    content_lower = content.lower()
    if any(signal in content_lower for signal in COMPACT_SIGNALS):
        return True
    # Usage 骤降检测
    if prev_usage and curr_usage:
        prev_used = prev_usage.get("contextUsedTokens") or prev_usage.get("totalTokens", 0)
        curr_used = curr_usage.get("contextUsedTokens") or curr_usage.get("totalTokens", 0)
        if prev_used > 0 and curr_used < prev_used * 0.5:
            return True
    return False
```

### 3.4 前端改动

#### 3.4.1 压缩状态 UI

在 MessageList 中，当检测到压缩相关的 assistant 消息时：

1. **消息样式变化**：使用特殊的视觉样式（如灰色斜体、压缩图标）
2. **状态标记**：在消息旁显示 "上下文已压缩" 标签
3. **Usage 变化展示**：显示压缩前后的 token 变化（如 "34,558 → 6,887 tokens，减少 80%"）

#### 3.4.2 `/compact` 命令发送

在 ChatComposer 中支持 `/compact` 命令的快捷发送：

```typescript
// 当用户输入 /compact 并发送时
if (draft.trim().startsWith('/compact')) {
  onSendMessage();  // 正常发送，后端会透传给 ACP runtime
}
```

### 3.5 压缩后 messages.json 记录

压缩后的 assistant 消息在 messages.json 中应体现压缩效果：

```json
{
  "id": "assistant-xxx",
  "role": "assistant",
  "content": "*Context compacted to fit the model's context window.*",
  "usage": {
    "totalTokens": 6887,
    "contextUsedTokens": 6887,
    "contextWindowTokens": 258400,
    "source": "acp.usage_update"
  },
  "compacted": true  // 新增标记
}
```

---

## 4. 功能三：上下文圆环 Token 详情弹窗

### 4.1 目标

点击 ContextRing 后弹出模态框，展示当前会话的完整 token 使用明细。

### 4.2 交互设计

```
用户点击 ContextRing
  → 弹出模态框（Modal）
  → 展示内容：
    - Context Window: 6,887 / 258,400 (2.7%)
    - ────────────────────────
    - Input Tokens:     12,000
    - Output Tokens:     3,500
    - Cache Read:        8,000
    - Cache Write:       2,000
    - Thought Tokens:    1,500
    - ─────────────────────────
    - Total Tokens:     27,000
```

### 4.3 组件设计

#### 4.3.1 新增 TokenUsageModal 组件

**文件**: `ui/src/features/chat/TokenUsageModal.tsx` (新建)

```typescript
interface TokenUsageModalProps {
  usage: UsageStats | null;
  open: boolean;
  onClose: () => void;
}
```

**UI 布局**：

```
┌──────────────────────────────────┐
│  Token Usage Details          ✕  │
──────────────────────────────────┤
│                                  │
│  Context Window                  │
│  ████████░░░░░░░░░░░░░░░░ 2.7%  │
│  6,887 / 258,400 tokens          │
│                                  │
│  ─────────────────────────────   │
│                                  │
│  Per-Turn Breakdown              │
│  ┌────────────────────────────  │
│  │ Input Tokens      12,000   │  │
│  │ Output Tokens      3,500   │  │
│  │ Cache Read         8,000   │  │
│  │ Cache Write        2,000   │  │
│  │ Thought Tokens     1,500   │  │
│  ────────────────────────────┘  │
│                                  │
│  ─────────────────────────────   │
│                                  │
│  Total Tokens          27,000    │
│                                  │
└──────────────────────────────────┘
```

**颜色方案**：
- Input Tokens: 蓝色 `#3182ce`
- Output Tokens: 绿色 `#38a169`
- Cache Read: 紫色 `#805ad5`
- Cache Write: 橙色 `#dd6b20`
- Thought Tokens: 青色 `#319795`

### 4.4 ContextRing 改动

**文件**: `ui/src/features/chat/ContextRing.tsx`

```typescript
interface ContextRingProps {
  usage: UsageStats | null;
  onTokenDetailsClick?: () => void;  // 新增：点击回调
}

// 添加点击事件
const handleClick = () => {
  onTokenDetailsClick?.();
};

return (
  <div
    className="context-ring clickable"  // 新增 clickable 样式类
    onClick={handleClick}
    ...
  >
    ...
  </div>
);
```

### 4.5 ChatComposer 集成

**文件**: `ui/src/features/chat/ChatComposer.tsx`

```typescript
// 新增 state
const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);

// ContextRing 添加 onClick
<ContextRing
  usage={contextUsage}
  onTokenDetailsClick={() => setIsTokenModalOpen(true)}
/>

// 模态框渲染
{isTokenModalOpen && (
  <TokenUsageModal
    usage={contextUsage}
    open={isTokenModalOpen}
    onClose={() => setIsTokenModalOpen(false)}
  />
)}
```

### 4.6 数据来源

Token 分项数据来源：
1. **优先**：最后一条 assistant 消息的 `usage` 字段中的 `inputTokens`、`outputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`thoughtTokens`（来自 PromptResponse.usage）
2. **Fallback**：如果分项数据不存在（旧消息或 ACP agent 未返回），只显示 context window 信息

---

## 5. 功能四：快捷指令面板

### 5.1 目标

在输入框左下角的 `+` 按钮（原 Paperclip 图标位置）点击后弹出快捷指令面板，展示**当前 agent runtime 支持的斜杠命令**。

**核心设计原则**：快捷命令必须跟随 agent 配置，和模型列表、思考强度一样作为 `SessionCapabilities` 的一部分，随 session 动态变化。不同 agent runtime（Codex / Claude Code / OpenCode）支持的命令不同，不能硬编码。

### 5.2 交互设计

```
用户点击 + 按钮
  → 弹出快捷指令面板（向上弹出，类似 access mode picker）
  → 面板内容跟随当前 agent runtime：
    - Codex 会话 → 显示 Codex 的命令列表
    - Claude Code 会话 → 显示 Claude Code 的命令列表
  → 每个命令显示图标 + 名称 + 描述
  → 点击命令 → 将 "/command" 填充到输入框
```

**面板布局**（以 Codex 为例）：

```
─────────────────────────────────────────────┐
│    压缩      压缩此线程的上下文              │
│    目标      设置或清除任务目标              │
│    状态      显示会话配置和状态              │
│    审查      审查未暂存的更改                │
│    MCP      显示 MCP 服务器状态              │
│    Skills   列出可用技能                    │
│    登出      退出登录                        │
└─────────────────────────────────────────────┘
```

### 5.3 数据流设计：跟随 SessionCapabilities

#### 5.3.1 架构对比

**错误方案**（硬编码命令列表）：
```
前端根据 agent.id 判断 → 使用预定义的 CLAUDE_CODE_COMMANDS / CODEX_COMMANDS
```
问题：命令会随 runtime 版本变化，硬编码容易过期。

**正确方案**（跟随 agent 配置）：
```
ACP session/new 返回 SessionCapabilities
  → 包含 modes / models / configOptions / commands（新增）
  → 前端根据 commands 渲染面板
  → 切换 agent 时自动更新命令列表
```

这和模型选择器、推理强度的数据流完全一致：
```
ACP session/new
  → NewSessionResponse { modes, models, configOptions }
  → build_session_capabilities() → SessionCapabilities
  → 前端收到 SessionCapabilities → 渲染所有 UI 控件
```

#### 5.3.2 数据来源

ACP 协议通过 `session/update` → `available_commands_update` 事件推送可用命令：

```python
# ACP SDK schema.py:3544-3588
class AvailableCommand(BaseModel):
    name: str                          # 命令名称（如 "compact"）
    description: str                   # 人类可读描述
    input: Optional[AvailableCommandInput]  # 输入规格（可选）

class AvailableCommandsUpdate(BaseModel):
    session_update: "available_commands_update"
    available_commands: List[AvailableCommand]
```

Runtime 在 session 建立后通过 `session/update` 推送命令列表。

#### 5.3.3 后端改动：提取 commands 到 SessionCapabilities

**文件**: `backend/code_lite_backend/schemas/session.py`

扩展 `SessionCapabilities`，增加 `commands` 字段：

```python
@dataclass(frozen=True)
class SlashCommand:
    """斜杠命令定义"""
    id: str        # 命令 ID（如 "compact"）
    label: str     # 中文展示名
    description: str  # 中文描述
    command: str   # 实际命令文本（如 "/compact"）

@dataclass(frozen=True)
class SessionCapabilities:
    agent: SessionAgentInfo
    modes: list[SessionMode]
    models: list[SessionModel]
    config_options: list[SessionConfigOption]
    commands: list[SlashCommand] = field(default_factory=list)  # 新增
```

更新 `to_dict()` 方法：

```python
def to_dict(self) -> dict[str, Any]:
    return {
        "agent": asdict(self.agent),
        "modes": [asdict(m) for m in self.modes],
        "models": [asdict(m) for m in self.models],
        "configOptions": [...],  # 保持不变
        "commands": [asdict(c) for c in self.commands],  # 新增
    }
```

**文件**: `backend/code_lite_backend/api/routes/sessions.py`

在 `build_session_capabilities()` 中增加 commands 解析：

```python
def build_session_capabilities(...) -> SessionCapabilities:
    # ... 现有逻辑 ...

    # 新增：从 ACP 可用命令构建命令列表
    commands = _build_commands(session_result, adapter_kind)

    return SessionCapabilities(
        agent=...,
        modes=modes,
        models=models,
        config_options=config_options,
        commands=commands,  # 新增
    )
```

`_build_commands()` 函数根据 ACP 返回的命令列表，映射为中文展示：

```python
# 命令 ID → 中文映射表
_COMMAND_LABELS: dict[str, str] = {
    "compact": "压缩",
    "goal": "目标",
    "init": "初始化",
    "resume": "恢复",
    "review": "审查",
    "context": "上下文",
    "mcp": "MCP",
    "skills": "Skills",
    "status": "状态",
    "logout": "登出",
}

_COMMAND_DESCRIPTIONS: dict[str, str] = {
    "compact": "压缩此线程的上下文",
    "goal": "设置或清除任务目标",
    "init": "初始化 CLAUDE.md 文件",
    "resume": "恢复会话",
    "review": "审查未暂存的更改",
    "context": "显示上下文使用情况",
    "mcp": "显示 MCP 服务器状态",
    "skills": "列出可用技能",
    "status": "显示会话配置和状态",
    "logout": "退出登录",
}

def _build_commands(session_result: Any, adapter_kind: str) -> list[SlashCommand]:
    """从 session_result 中提取可用命令列表"""
    raw_commands = extract_commands_from_session_result(session_result)

    commands = []
    for cmd in raw_commands:
        cmd_name = cmd.get("name", "")
        commands.append(SlashCommand(
            id=cmd_name,
            label=_COMMAND_LABELS.get(cmd_name, cmd_name),
            description=_COMMAND_DESCRIPTIONS.get(
                cmd_name, cmd.get("description", "")
            ),
            command=f"/{cmd_name}",
        ))
    return commands
```

**文件**: `backend/code_lite_backend/agents/acp/capabilities.py`

新增 `parse_commands_from_session_result()` 函数，从 ACP session/new 结果或 `available_commands_update` 事件中提取命令列表。

#### 5.3.4 前端类型扩展

**文件**: `ui/src/types.ts`

```typescript
// 新增 SlashCommand 类型
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  command: string;
}

// 扩展 SessionCapabilities
export interface SessionCapabilities {
  agent: SessionAgentInfo;
  modes: SessionMode[];
  models: SessionModel[];
  configOptions: SessionConfigOption[];
  commands: SlashCommand[];  // 新增：跟随 agent 配置的快捷命令
}
```

#### 5.3.5 ChatComposer Props 扩展

**文件**: `ui/src/features/chat/ChatComposer.tsx`

`ChatComposerProps` 增加 `commands` prop（从 SessionCapabilities 透传）：

```typescript
interface ChatComposerProps {
  // ... 现有 props ...
  commands: SlashCommand[];  // 新增：当前 agent 支持的快捷命令
}
```

数据流与 models/modes 一致：
```
ChatPage
  → sessionCapabilities.commands
  → <ChatComposer commands={commands} />
  → + 按钮点击 → 渲染命令面板
```

### 5.4 ChatComposer 改动

#### 5.4.1 附件按钮改为 + 图标

```tsx
// 原代码（第 335-337 行）
<button className="icon-button" aria-label="添加附件">
  <Paperclip size={17} />
</button>

// 改为
<button
  className="icon-button"
  aria-label="快捷指令"
  onClick={() => setIsCommandMenuOpen(!isCommandMenuOpen)}
>
  <Plus size={17} />
</button>
```

#### 5.4.2 命令面板状态和渲染

```typescript
// 新增 state
const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
const commandMenuRef = useRef<HTMLDivElement>(null);

// 点击外部关闭
useEffect(() => {
  if (!isCommandMenuOpen) return;
  const handler = (e: MouseEvent) => {
    if (commandMenuRef.current && !commandMenuRef.current.contains(e.target as Node)) {
      setIsCommandMenuOpen(false);
    }
  };
  window.addEventListener('mousedown', handler);
  return () => window.removeEventListener('mousedown', handler);
}, [isCommandMenuOpen]);

// 命令选择处理
const handleCommandSelect = (command: SlashCommand) => {
  onDraftChange(command.command);
  setIsCommandMenuOpen(false);
};
```

#### 5.4.3 命令面板 UI

```tsx
{isCommandMenuOpen && commands.length > 0 && (
  <div className="command-menu" ref={commandMenuRef}>
    {commands.map(cmd => (
      <button
        key={cmd.id}
        className="command-menu-item"
        onClick={() => handleCommandSelect(cmd)}
      >
        <span className="command-label">{cmd.label}</span>
        <span className="command-description">{cmd.description}</span>
      </button>
    ))}
  </div>
)}
```

### 5.5 斜杠命令自动触发（可选增强）

在 textarea 的 `onInput` 中检测 `/` 输入：

```typescript
const handleTextAreaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  const value = e.target.value;
  onDraftChange(value);

  // 检测是否刚输入了 /
  if (value.endsWith('/')) {
    setIsCommandMenuOpen(true);
  }
};
```

### 5.6 CSS 样式

```css
/* 命令面板 - 复用 access-mode-menu 的弹出模式 */
.command-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 100;
  background: var(--color-surface, #ffffff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
}

.command-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}

.command-menu-item:hover {
  background: rgba(32, 36, 40, 0.07);
}

.command-label {
  font-weight: 600;
  font-size: 13px;
}

.command-description {
  font-size: 12px;
  color: var(--color-text-secondary, #718096);
  margin-left: auto;
}
```

---

## 6. 技术实现细节

### 6.1 数据流全景

```
┌─────────────────────────────────────────────────────────────┐
│                      用户交互层                               │
│                                                             │
│  ──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ + 按钮       │  │ ContextRing  │  │ /compact 输入     │  │
│  │ → 命令面板   │  │ → Token 弹窗 │  │ → 压缩触发        │  │
│  │ (跟随 agent) │  │              │  │                  │  │
│  ──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
───────────────────────────┴─────────────────────────────────┐
│                      后端处理层                               │
│                                                             │
│  session.py: SessionCapabilities 增加 commands 字段            │
│  sessions.py: _build_commands() 从 ACP 提取命令列表            │
│  adapter.py: 读取 PromptResponse.usage → 分项 token 数据      │
│  mapper.py: 压缩检测逻辑 → compaction 标记                    │
│  recorder.py: 写入 messages.json（自动包含新增字段）            │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                      ACP Runtime                             │
│                                                             │
│  Codex / Claude Code                                        │
│  → session/new → SessionCapabilities { modes, models,        │
│                  configOptions, commands }                    │
│  → PromptResponse.usage (分项 token)                          │
│  → usage_update (context window)                             │
│  → available_commands_update (可用命令)                       │
│  → /compact 处理 + Compacting... 文本                         │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 向后兼容策略

- 所有新增字段都是 `Optional` 或有默认值，不影响现有功能
- `SessionCapabilities.commands` 默认空列表，旧版 ACP runtime 不返回命令时不显示面板
- 如果 ACP agent 不返回 `PromptResponse.usage`，fallback 到现有的 `usage_update` 数据
- messages.json 中旧的 usage 格式（只有 3 个字段）仍然有效
- 前端 TokenUsageModal 在分项数据不存在时只显示 context window 信息
- 命令面板在 `commands.length === 0` 时不渲染

### 6.3 性能考量

- `PromptResponse.usage` 只在 turn 结束时返回一次，不影响流式性能
- 压缩检测是纯文本匹配，开销可忽略
- 命令列表从 session/new 一次性获取，无需额外网络请求
- 命令面板是纯前端渲染，无性能影响

---

## 7. 影响文件清单

### 7.1 后端（Python）

| 文件 | 改动 |
|------|------|
| `backend/.../schemas/session.py` | 新增 `SlashCommand` 类型，扩展 `SessionCapabilities` 增加 `commands` 字段 |
| `backend/.../api/routes/sessions.py` | `_build_commands()` 从 ACP 提取命令列表，集成到 `build_session_capabilities()` |
| `backend/.../agents/acp/capabilities.py` | 新增 `parse_commands_from_session_result()` |
| `backend/.../agents/acp/mapper.py` | 扩展 `UsageSnapshot`，新增 `extract_prompt_response_usage()`，新增压缩检测 |
| `backend/.../agents/acp/adapter.py` | 读取 `prompt_result.usage`，合并分项 + context window 数据 |
| `backend/.../agents/runtimes/profiles.py` | Codex / Claude Code / opencode 的 runtime-specific 配置归位 |
| `backend/.../agents/conversation_recorder.py` | 无需改动（自动记录新的 usage 字段） |

### 7.2 前端（TypeScript/React）

| 文件 | 改动 |
|------|------|
| `ui/src/types.ts` | 扩展 `UsageStats` 接口，新增 `SlashCommand` 类型，扩展 `SessionCapabilities` |
| `ui/src/features/chat/ContextRing.tsx` | 新增 `onClick` 回调 prop，添加 clickable 样式 |
| `ui/src/features/chat/ContextRing.css` | clickable 状态样式 |
| `ui/src/features/chat/TokenUsageModal.tsx` | **新建** — Token 详情弹窗组件 |
| `ui/src/features/chat/TokenUsageModal.css` | **新建** — Token 弹窗样式 |
| `ui/src/features/chat/ChatComposer.tsx` | Paperclip → Plus 图标，命令面板，TokenModal 集成，commands prop |
| `ui/src/features/chat/chatTypes.ts` | `SessionConfig` 无需改动（commands 不在 config 中，而在 capabilities 中） |
| `ui/src/pages/ChatPage.tsx` | 传递 `commands` prop 给 ChatComposer |

### 7.3 消息格式

| 文件 | 改动 |
|------|------|
| `messages.json` | 每条 assistant 消息的 `usage` 字段增加分项数据（自动，无需代码改动） |

---

## 8. 实施顺序建议

| 阶段 | 功能 | 复杂度 | 依赖 |
|------|------|--------|------|
| **Phase 1** | Token 分项统计（后端） | 低 | 无 |
| **Phase 2** | TokenUsageModal + ContextRing 点击 | 中 | Phase 1 |
| **Phase 3** | 压缩感知与状态展示 | 中 | Phase 1 |
| **Phase 4** | 快捷指令面板（跟随 agent 配置） | 中 | 无（可并行） |

Phase 1 和 Phase 4 可以并行开发，无相互依赖。Phase 2 和 Phase 3 依赖 Phase 1 的 token 分项数据。
