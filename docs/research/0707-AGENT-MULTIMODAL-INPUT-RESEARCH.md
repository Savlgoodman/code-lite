# Agent 多模态图片输入调研

调研日期：2026-07-07

验证环境：

1. 仓库分支：`docs/agent-0707-multimodal-input`
2. 后端 ACP SDK：`agent-client-protocol 0.10.1`
3. Codex ACP npm 包：`@agentclientprotocol/codex-acp 1.1.0`
4. Claude Agent ACP npm 包：`@agentclientprotocol/claude-agent-acp 0.56.0`
5. 本次只做协议和落地路径调研，未发送真实图片 turn 给外部模型。

## 1. 核心结论

code-lite 的多模态图片输入应优先走 ACP 标准 `ContentBlock[]`，不要为 Codex、Claude Code、opencode 分别设计一套图片传输协议。

推荐路线：

```text
React ChatComposer
  -> /api/turns/stream contentBlocks
  -> AgentRunRequest.input_blocks
  -> AcpAgentAdapter.to_acp_prompt_blocks()
  -> session/prompt prompt=[text_block(...), image_block(...)]
  -> codex-acp / claude-agent-acp / opencode acp
```

短期 MVP 可以使用 base64 图片直传，因为 ACP `ImageContentBlock` 已经定义 `data` 和 `mimeType` 字段，Python SDK 也已提供 `acp.image_block(data, mime_type, uri=None)`。中长期应引入 code-lite 附件存储，把 UI、会话记录、远程同步和审计里的图片保存为引用，只有发送给 runtime 时再按能力转换为 base64 或资源块。

## 2. 官方资料与本地验证

### 2.1 ACP 协议

ACP `session/prompt` 的 prompt 参数是内容块数组，而不是纯字符串。相关能力由 agent initialize 阶段返回的 prompt capabilities 表达，其中 `promptCapabilities.image` 表示 agent 支持图片内容块，`promptCapabilities.embeddedContext` 表示支持嵌入资源上下文。

本地 SDK 验证：

```powershell
uv run --project backend python -c "import inspect, acp; from acp import helpers; print(inspect.signature(helpers.image_block))"
```

结果：

```text
(data: 'str', mime_type: 'str', *, uri: 'str | None' = None) -> 'ImageContentBlock'
```

本地 `acp.schema.ImageContent` 字段：

```text
data: str
mime_type: str  # JSON alias: mimeType
uri: str | None
```

影响：

1. backend 不需要自己拼 ACP JSON-RPC；继续使用 Python SDK helper 即可。
2. `AgentRunRequest.prompt: str` 是当前最大阻塞点，需要升级为内容块输入，同时保留纯文本兼容字段。
3. 能力协商要读取 initialize result，而不是只看模型名。

### 2.2 Codex

Codex 官方手册确认 CLI 支持图片输入：可以粘贴图片到交互式 composer，也可以用 `codex -i screenshot.png "Explain this error"` 或 `codex --image img1.png,img2.jpg "Summarize these diagrams"` 传入图片。手册说明常见格式包括 PNG 和 JPEG。

对 code-lite 的影响：

1. Codex 产品层具备图片输入能力。
2. `codex-acp` 已在历史探针中暴露 image capability，但仍需用 code-lite 的 ACP 链路做真实图片 smoke。
3. Codex CLI 的 `--image` 是 CLI 私有入口；code-lite 通过 ACP 时不应调用 CLI flag，而应发送 `ImageContentBlock`。

### 2.3 OpenAI API 直连模型

OpenAI Responses API 的图片输入使用 `input_image`，支持 URL 或 base64 data URL。这个形态主要服务 legacy nanobot、非 ACP workflow 或未来直连 OpenAI provider，不应成为 ACP runtime 的主协议。

对 code-lite 的影响：

1. 产品级模型能力里的 `vision` 字段仍然有价值，尤其用于 legacy nanobot / 通用 provider。
2. ACP runtime 的图片能力优先看 `promptCapabilities.image`，不能只看 `ModelCapabilities.vision`。
3. 如后续做 direct OpenAI adapter，需要单独把 code-lite 图片块转换成 Responses API `input_image`。

### 2.4 Claude / Claude Code

Anthropic Messages API 的 vision 输入使用内容块，图片来源可为 base64 或 URL，并带 `media_type`。这说明 Claude 模型层支持图片输入，但 Claude Code ACP wrapper 是否把 ACP image block 完整传到底层 Claude Agent SDK，仍需真实 smoke。

对 code-lite 的影响：

1. Claude Code 在 UI 上应标为“图片输入待 runtime smoke”，不要仅因底层模型支持 vision 就默认开放。
2. `claude-agent-acp` 当前 npm 版本为 `0.56.0`，本轮未验证 `promptCapabilities.image` 返回值。
3. 如果 Claude Code ACP 暂不支持图片，code-lite 应在发送前阻断并给出可解释错误。

### 2.5 opencode

本轮未找到足够稳定的 opencode 官方图片输入资料，也未完成 `opencode acp` 图片 smoke。opencode 应暂时标记为 unknown / experimental。

对 code-lite 的影响：

1. runtime descriptor 中不要预置 `image=true`。
2. 以 initialize capability 和 smoke 结果为准。
3. 若 capability 未声明，UI 不展示图片按钮；若用户通过旧客户端传入图片，backend 返回明确错误。

## 3. 当前 code-lite 缺口

当前链路仍是纯文本：

| 层 | 当前状态 | 影响 |
| --- | --- | --- |
| 前端请求 | `StartTurnOptions.input: string` | 无法携带图片元数据 |
| UI 消息 | `ChatMessage.content: string` | 历史消息不能展示附件 |
| API 路由 | `/api/turns/stream` 读取 `input` 字符串 | 无法校验文件类型、大小、数量 |
| backend schema | `AgentRunRequest.prompt: str` | adapter 只能发 text block |
| ACP adapter | `prompt=[acp.text_block(request.prompt)]` | 图片无法进入 ACP runtime |
| SessionCapabilities | 只暴露 modes/models/configOptions/commands | 前端不知道当前 runtime 是否支持图片 |
| 会话存储 | user message 只保存 `content` | 远程同步和恢复无法重建附件 |

已有基础：

1. `ModelCapabilities.vision` 已存在于前端类型和模型设置。
2. `ChatComposer` 已有 `Plus` 快捷入口，可扩展为附件入口或新增 paperclip/image 按钮。
3. `docs/research/0705-ACP-CAPABILITIES-INVESTIGATION.md` 已确认 SDK 有 `image_block()`，但未形成完整落地协议。

## 4. 推荐数据模型

### 4.1 code-lite 内容块

新增产品层统一输入块，避免 UI、API、ACP、legacy provider 直接互相绑定：

```typescript
type UserContentBlock = TextInputBlock | ImageInputBlock;

interface TextInputBlock {
  type: "text";
  text: string;
}

interface ImageInputBlock {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  source:
    | {
        kind: "inline_base64";
        data: string;
      }
    | {
        kind: "attachment";
        attachmentId: string;
      };
  name?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
}
```

MVP 可只实现 `inline_base64`。但类型上建议一次预留 `attachment`，因为会话记录和远程同步最终不适合长期塞大 base64。

### 4.2 turn 请求

兼容期请求体：

```json
{
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "input": "分析这张图",
  "contentBlocks": [
    { "type": "text", "text": "分析这张图" },
    {
      "type": "image",
      "mimeType": "image/png",
      "source": {
        "kind": "inline_base64",
        "data": "<base64>"
      },
      "name": "screenshot.png",
      "sizeBytes": 183245
    }
  ],
  "modelId": "gpt-5.5",
  "accessMode": "read-only",
  "selectedConfig": {}
}
```

规则：

1. 新客户端优先发送 `contentBlocks`。
2. 旧客户端只发送 `input` 时，backend 自动构造一个 text block。
3. `input` 在兼容期保留，用于标题、preview、日志摘要和 legacy adapter。
4. 禁止把完整 base64 写入普通日志；日志只记录图片数量、mime、大小和 hash。

### 4.3 会话消息

`ChatMessage` 建议保留 `content: string` 作为摘要，同时新增 `contentBlocks` 或 `attachments`：

```typescript
interface ChatMessage {
  content: string;
  contentBlocks?: UserContentBlock[];
  attachments?: MessageAttachment[];
}

interface MessageAttachment {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  sha256: string;
  previewUrl?: string;
}
```

这样既不破坏现有 Markdown 渲染，也能让 MessageList 渲染用户图片缩略图。

## 5. ACP 转换策略

### 5.1 转换函数

建议在 `backend/code_lite_backend/agents/acp/` 增加独立转换模块：

```python
def build_acp_prompt_blocks(request: AgentRunRequest) -> list[Any]:
    blocks = []
    for block in request.input_blocks:
        if block.type == "text":
            blocks.append(acp.text_block(block.text))
        elif block.type == "image":
            data = load_inline_or_attachment_base64(block)
            blocks.append(acp.image_block(data, block.mime_type, uri=block.uri))
    return blocks
```

然后把当前：

```python
prompt=[acp.text_block(request.prompt)]
```

替换为：

```python
prompt=build_acp_prompt_blocks(request)
```

### 5.2 能力校验

发送前必须校验：

1. 当前 runtime initialize result 是否声明 `promptCapabilities.image=true`。
2. 当前产品模型或 runtime model 是否被标记为 vision capable。ACP runtime 以第 1 条为准，legacy provider 同时看模型能力。
3. 图片 mime 是否在 allowlist。
4. 图片数量和总大小是否超过 code-lite 限制。

如果不满足，返回 `agent.run.failed`：

```json
{
  "type": "agent.run.failed",
  "error": "当前 Agent Runtime 未声明支持图片输入。请切换到支持图片的模型或移除图片后重试。"
}
```

### 5.3 SessionCapabilities 扩展

建议新增能力字段：

```typescript
interface SessionCapabilities {
  inputCapabilities?: {
    text: boolean;
    image: {
      supported: boolean;
      source: "acp.promptCapabilities" | "model.capabilities" | "descriptor" | "unknown";
      maxImages?: number;
      maxImageBytes?: number;
      acceptedMimeTypes: string[];
      caveats?: string[];
    };
  };
}
```

构建规则：

1. ACP runtime：从 `initialize_result.agent_capabilities.prompt_capabilities.image` 读取。
2. legacy nanobot：从产品模型 `capabilities.vision` 读取。
3. descriptor 只作为 fallback 和 UI caveat，不作为最终真相。

## 6. 附件存储与远程同步

### 6.1 MVP：inline base64

优点：

1. 实现最快，不需要新增文件 API。
2. 与 ACP `ImageContentBlock.data` 完全匹配。
3. 适合小图、截图、设计参考图的首轮 smoke。

缺点：

1. NDJSON 请求和会话消息体会变大。
2. 远程同步事件可能携带大量 base64。
3. 日志和诊断更容易误泄露用户图片。

MVP 限制建议：

| 项 | 建议 |
| --- | --- |
| 单张图片 | 5 MB |
| 单轮图片数量 | 4 张 |
| 单轮图片总大小 | 10 MB |
| mime allowlist | `image/png`, `image/jpeg`, `image/webp` |
| GIF | 先拒绝或只取首帧，避免多帧语义不一致 |
| SVG | 先拒绝，避免脚本和外链风险 |

### 6.2 正式版：AttachmentStore

建议目录：

```text
data/
  attachments/
    conversations/
      <conversationId>/
        <attachmentId>/
          original
          preview.webp
          metadata.json
```

metadata 示例：

```json
{
  "id": "att_...",
  "kind": "image",
  "name": "screenshot.png",
  "mimeType": "image/png",
  "sizeBytes": 183245,
  "width": 1440,
  "height": 900,
  "sha256": "...",
  "createdAt": "2026-07-07T12:00:00Z",
  "conversationId": "conv_..."
}
```

远程同步规则：

1. 本地 UI 事件只发送附件 metadata 和可访问的 preview 引用。
2. 远端 viewer 默认只看缩略图，原图下载需要本机授权或短期签名 URL。
3. 审计日志记录 hash、大小、mime，不记录 base64。
4. 删除会话时级联删除附件目录。

## 7. 前端交互路径

### 7.1 输入方式

建议第一阶段支持：

1. 文件选择：图片按钮打开 `<input type="file" accept="image/png,image/jpeg,image/webp" multiple>`。
2. 粘贴：`onPaste` 捕获 clipboard image。
3. 拖拽：`onDrop` 捕获图片文件。

UI 行为：

1. 图片以缩略图 chip 显示在 composer 上方。
2. 每张图片可删除。
3. runtime 不支持图片时，图片按钮 disabled 并展示 tooltip。
4. 发送中保留图片占位，失败后不清空草稿，便于用户移除图片重试。

### 7.2 消息展示

用户消息：

1. 文本仍走现有 `.user-message-text`。
2. 图片附件在文本下方展示缩略图网格。
3. 点击缩略图打开本地预览 modal。

assistant 消息：

1. 普通文本仍由 `streamdown` 渲染。
2. 如果未来 ACP 返回 image content block，再新增 assistant attachment 渲染；本轮重点只处理用户输入图片。

## 8. 后端实施步骤

### 阶段 1：协议与 schema

1. 新增 `UserContentBlock` / `ImageInputBlock` Python dataclass 或 Pydantic schema。
2. 扩展 `AgentRunRequest`：保留 `prompt: str`，新增 `input_blocks: list[InputContentBlock]`。
3. `/api/turns/stream` 解析 `contentBlocks`，旧 `input` 自动降级为 text block。
4. `ConversationRecorder.start_turn()` 保存 `contentBlocks` 或 `attachments`，标题仍使用 text 摘要。

验证：

```powershell
uv run --project backend python -m py_compile backend/code_lite_backend/schemas/agent.py backend/code_lite_backend/api/routes/turns.py
```

### 阶段 2：ACP adapter

1. 新增 `agents/acp/prompt_blocks.py`。
2. 实现 text/image 到 `acp.text_block()` / `acp.image_block()` 的转换。
3. 在 `AcpAgentAdapter._run_turn()` 中替换固定 text prompt。
4. 从 runtime connection initialize result 提取 `promptCapabilities.image` 做发送前校验。
5. 对不支持图片的 runtime 返回清晰错误。

验证：

```powershell
uv run --project backend pytest
uv run --project backend python -m py_compile backend/code_lite_backend/agents/acp/adapter.py
```

### 阶段 3：SessionCapabilities

1. `schemas/session.py` 增加 `inputCapabilities`。
2. `build_session_capabilities()` 从 initialize result 或 connection binding 读取 prompt capability。
3. nanobot capabilities 从产品模型 vision 字段构建。
4. 前端 `SessionCapabilities` 类型同步。

### 阶段 4：前端输入与展示

1. `ChatComposer` 增加图片选择、粘贴、拖拽。
2. `agentClient.streamAgentTurn()` 支持 `contentBlocks`。
3. `ChatPage` 草稿状态增加 pending images。
4. `MessageList` 渲染用户图片缩略图。
5. 图片按钮由 `capabilities.inputCapabilities.image.supported` 控制。

### 阶段 5：附件存储

1. 新增 backend attachment API。
2. 图片上传先写 `AttachmentStore`，turn 请求只带 `attachmentId`。
3. 发送给 ACP runtime 时再读取文件并 base64 编码。
4. 远程同步只发送 metadata 和授权 preview。

## 9. Runtime 验证矩阵

| Runtime | 当前判断 | 必做验证 |
| --- | --- | --- |
| Codex ACP | 高概率支持，Codex CLI 官方支持图片输入，历史 initialize 观测到 image capability | 用 `codex-acp` 发送一张小 PNG，确认 assistant 能识别图片内容 |
| Claude Code ACP | 底层模型支持 vision，但 ACP wrapper 能力未验证 | initialize 是否返回 `promptCapabilities.image`；真实图片 turn 是否成功 |
| opencode ACP | 未确认 | initialize capability；真实图片 turn；失败时 stderr 和错误形态 |
| nanobot legacy | 取决于 provider/model 和 nanobot 当前 multimodal 支持 | OpenAI Responses / Anthropic provider 的图片转换能力需单独调研 |

建议新增 smoke 脚本：

```powershell
uv run --project backend python .\demo\acp-demo\python_sdk_acp_probe.py --agent codex --image .\demo\fixtures\small.png --prompt "Describe this image in one sentence."
```

脚本要求：

1. 默认使用临时 workspace。
2. 默认使用小尺寸 fixture 图片。
3. 不把 base64 写入 stdout。
4. 输出 initialize capability、stopReason、usage 和 assistant 摘要。

## 10. 安全与隐私

1. 图片可能包含个人信息、代码、密钥、内部系统截图，默认只保存在本地 data 目录。
2. 任何日志、诊断包、远程同步事件都不得包含图片 base64。
3. SVG、HTML、PDF 不作为图片输入直接透传，避免脚本、外链和解析差异。
4. 所有图片读取必须限制在用户上传的临时文件或 AttachmentStore，不允许通过用户构造的路径任意读取本机文件。
5. 远程 operator 发送图片属于写入会话上下文的行为，需要权限记录和审计。
6. 图片 hash 可用于去重和审计，但不能替代权限判断。

## 11. 对现有文档和架构的影响

需要后续同步更新：

1. `docs/design/0703-AGENT-UNIFIED-ACP.md`：把 `UnifiedTurnRequest.input` 扩展为 `contentBlocks`。
2. `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`：把 adapter 发送 prompt 的示例改为 ContentBlock 转换。
3. `docs/design/0703-RUNTIME-MODEL-PROVIDER.md`：明确产品模型 `vision` 只适用于 legacy/direct provider，ACP runtime 以 initialize capability 为准。
4. `docs/design/0702-REMOTE-SYNC.md`：增加附件同步、缩略图和远端权限规则。
5. `docs/refactor/0703-RUNTIME-DATA-CHAT-UI.md`：会话消息结构增加附件引用。

## 12. 未验证项

1. `codex-acp 1.1.0` 真实图片 turn 是否完全可用。
2. `claude-agent-acp 0.56.0` 是否声明并传递 ACP image block。
3. `opencode acp` 是否支持 image block。
4. nanobot 当前版本对 OpenAI Responses / Anthropic vision 的封装能力。
5. 大图 token 计费、缩放策略和不同 runtime 对图片尺寸限制的差异。
6. ACP `resource` / `resource_link` 是否可替代 base64 图片用于大附件，需后续专项 smoke。

## 13. 最终建议

第一阶段先做“小而完整”的图片输入闭环：

1. `contentBlocks` 请求协议。
2. `AgentRunRequest.input_blocks`。
3. ACP text/image block 转换。
4. `promptCapabilities.image` 能力协商。
5. 前端图片选择、粘贴、缩略图。
6. Codex ACP 小图 smoke。

第二阶段再做附件存储和远程同步，不要在第一阶段就把文件系统、签名 URL、远端授权全部铺开。这样既能尽快验证核心 runtime 路径，又不会把 base64 长期固化进会话和事件协议。

## 14. 参考来源

1. ACP content blocks：`https://agentclientprotocol.com/protocol/v1/content`
2. ACP initialization capabilities：`https://agentclientprotocol.com/protocol/v1/initialization`
3. ACP prompt turn：`https://agentclientprotocol.com/protocol/v1/prompt-turn`
4. OpenAI image input guide：`https://developers.openai.com/api/docs/guides/images-vision`
5. Codex CLI image inputs：`https://developers.openai.com/codex/cli/features`
6. Anthropic Claude vision：`https://docs.anthropic.com/en/docs/build-with-claude/vision`
7. 本地 SDK：`backend/.venv/Lib/site-packages/acp/helpers.py`
8. 既有调研：`docs/research/0705-ACP-CAPABILITIES-INVESTIGATION.md`
