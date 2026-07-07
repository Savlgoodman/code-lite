# Agent 多模态输入框与图片附件设计

设计日期：2026-07-07

相关文档：

1. `docs/research/0707-AGENT-MULTIMODAL-INPUT-RESEARCH.md`
2. `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`
3. `docs/design/0703-AGENT-UNIFIED-ACP.md`
4. `docs/refactor/0703-RUNTIME-DATA-CHAT-UI.md`

## 1. 背景

code-lite 后续需要支持用户在聊天输入框中粘贴、拖拽或选择图片，并把图片作为多模态输入传给 Codex、Claude Code、opencode 等 ACP runtime。用户期望的输入框形态是：

1. 图片缩略图展示在输入框上方。
2. 图片预览为裁剪式矩形，仅影响展示，不裁剪真实发送内容。
3. 多张图片保持同一行展示。
4. 文本过多时输入框自动增高，直到达到 ChatPage 高度的一半，再出现滚动条。
5. 粘贴但未发送的图片不进入持久化附件库，用户撤回图片时不留下数据。

本文在已有 ACP 图片输入调研基础上，补充图片数量、大小、压缩策略和输入框 UI 设计。

## 2. 外部限制调研结论

### 2.1 ACP

ACP `session/prompt.prompt` 是 `ContentBlock[]`，内容可以包含 text、image、resource 等。ACP 本身不定义图片数量、图片大小或压缩策略，只要求 client 按 initialize 阶段协商到的 Prompt Capabilities 限制内容类型。

影响：

1. code-lite 必须自己定义产品级图片数量和大小上限。
2. 是否允许图片输入，应优先看 runtime initialize 返回的 `promptCapabilities.image`。
3. 图片过大时，code-lite 应在传入 ACP 前完成压缩或拒绝，不等 runtime 报错。

### 2.2 OpenAI / Codex

OpenAI Images and Vision 文档中，Responses API 图片输入支持 PNG、JPEG、WEBP 和非动画 GIF，当前 API 文档给出的上限是每请求最多 1500 个 image input，总 payload 最多 512 MB。Codex CLI 官方文档确认可以把截图或设计图随 prompt 一起传入，支持粘贴到 composer，也支持 `codex -i screenshot.png` 和 `codex --image img1.png,img2.jpg`。

但 Codex CLI / `codex-acp` 官方文档未给出面向 ACP 的单张图片大小和数量上限。

影响：

1. OpenAI API 的上限很宽，不适合作为 code-lite 桌面 UI 的默认上限。
2. Codex ACP 路径仍需真实 smoke，验证 `ImageContentBlock` 到底层模型的传递和失败形态。
3. code-lite 默认限制应以产品体验、内存、NDJSON payload、远程同步和 Claude / opencode 兼容为准。

### 2.3 Claude / Claude Code

Anthropic Vision 文档给出的限制：

1. Claude API：200k context 模型最多 100 张图片；其他模型最多 600 张图片。
2. claude.ai：每条消息最多 20 张图片。
3. 单张图片最大尺寸 8000x8000 px。
4. 如果一次请求超过 20 个 image / document block，需要更严格的尺寸限制；为跨平台稳定，应让每张图不超过 2000 px。
5. Claude API 直连单张图片最大 10 MB base64 encoded；Amazon Bedrock / Google Cloud 为 5 MB base64 encoded。
6. 标准 endpoint 还可能先撞到 32 MB 请求大小限制。

Claude Code 官方文档确认支持三种图片输入：拖拽图片、复制图片后在 CLI 中粘贴、在 prompt 中提供图片路径。

影响：

1. 5 张图片远低于 Claude 的数量上限，适合作为 code-lite 默认。
2. 单张传输目标控制在 5 MB base64 encoded，可以覆盖 Bedrock / Google Cloud 等更保守路径，也与 opencode 默认一致。
3. 图片尺寸压到 2000x2000 以内，可以避开 many-image request 的跨平台尺寸问题。

### 2.4 opencode

opencode 官方配置文档说明，opencode 默认会在图片超过 `2000x2000` 像素或 `5242880` base64 bytes 时自动 resize；相关配置为：

```json
{
  "attachment": {
    "image": {
      "auto_resize": true,
      "max_width": 2000,
      "max_height": 2000,
      "max_base64_bytes": 5242880
    }
  }
}
```

opencode 入门文档也确认可以拖拽图片到 terminal，将图片加入 prompt。

影响：

1. code-lite 默认图片规范可以直接对齐 opencode：最长边 2000，base64 payload 5 MiB。
2. 即便 opencode ACP 后续支持图片，code-lite 也不应把超大图直接传给它。
3. `max_base64_bytes` 是编码后的大小，不是原始文件大小；实现时不能只看 `File.size`。

## 3. 产品默认限制

推荐默认值：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 单轮图片数量 | 5 张 | 贴近用户设计参考、截图对比、错误截图场景；远低于 OpenAI / Claude API 上限 |
| 单张传输上限 | 5 MiB base64 bytes | 对齐 opencode 默认和 Claude 保守平台限制 |
| 单轮传输总量 | 20 MiB base64 bytes | 给 JSON、文本、历史上下文和 runtime 包装预留空间 |
| 最大发送尺寸 | 2000x2000 px box | 保持宽高比缩放，避免 Claude many-image request 问题 |
| 草稿导入硬上限 | 20 MiB raw file | 只用于允许压缩；超过直接拒绝，避免浏览器内存风险 |
| 支持格式 | PNG、JPEG、WEBP | MVP 先不支持 GIF、SVG |
| GIF | 暂不支持 | GIF 多帧语义和不同 runtime 处理不一致 |
| SVG | 不支持 | 避免脚本、外链和解析差异 |

这里的“单张 5 MiB”建议按 base64 payload 计算，而不是按原始文件大小计算。原因是 ACP `ImageContentBlock.data`、Claude API 和 opencode 默认限制都更接近“编码后的请求负载”。用户看到的文案可以简化为“单张约 5MB，过大将自动压缩”。

## 4. 压缩策略

### 4.1 处理原则

1. 预览裁剪只用于 UI 展示，不改变实际图片内容。
2. 发送压缩保持完整画面，只做等比缩放和重新编码。
3. 优先保留截图文字可读性，再考虑文件大小。
4. 压缩失败时提示用户手动裁剪或选择更小图片。

### 4.2 前端归一化

粘贴、拖拽或选择图片后，前端创建 `DraftImage`：

```typescript
interface DraftImage {
  id: string;
  file: File;
  objectUrl: string;
  name: string;
  mimeType: string;
  rawBytes: number;
  width?: number;
  height?: number;
  normalized?: NormalizedDraftImage;
  error?: string;
}

interface NormalizedDraftImage {
  blob: Blob;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  base64Bytes: number;
  width: number;
  height: number;
  wasCompressed: boolean;
}
```

归一化流程：

```text
read File metadata
  -> reject unsupported mime
  -> reject raw file > 20 MiB
  -> decode image dimensions
  -> if dimensions <= 2000 box and base64Bytes <= 5 MiB:
       keep original blob
     else:
       draw to canvas with max width/height 2000
       encode as JPEG or WEBP quality 0.86
       if still too large, lower quality stepwise to 0.72
       if still too large, downscale further to 1600, then 1280
       if still too large, reject
```

截图类 PNG 常含大量文字和纯色区域，直接转 JPEG 可能产生文字边缘噪声。建议策略：

1. PNG 小于上限：保留 PNG。
2. PNG 超过上限：先缩放后尝试 PNG；仍超限再转 JPEG / WEBP。
3. 照片类 JPEG / WEBP：优先保留或同格式压缩。
4. 初版可统一输出 JPEG，后续再按图像类型优化。

### 4.3 后端兜底校验

前端压缩只是体验优化，backend 仍必须校验：

1. 图片数量不超过 5。
2. 单张 base64 payload 不超过 5 MiB。
3. 单轮总 base64 payload 不超过 20 MiB。
4. mime 在 allowlist 中。
5. base64 可解码。
6. 不把 base64 写入日志或诊断。

如果后端发现超限，返回 `agent.run.failed`，并保留前端草稿，方便用户删图或重试。

## 5. 附件生命周期

### 5.1 总原则

粘贴或拖拽到输入框中的图片，在发送前只存在于前端内存和浏览器 object URL，不进入 `AttachmentStore`。

这样用户删除草稿图片时，不会产生孤儿附件，也不会留下隐私图片。

### 5.2 状态流

```text
用户粘贴图片
  -> ChatComposer 创建 DraftImage
  -> objectUrl 用于本地缩略图预览
  -> 前端完成压缩和校验
  -> 用户可删除 DraftImage
  -> 用户点击发送
  -> /api/turns/stream 携带 normalized image inline block
  -> backend 创建或确认 conversationId
  -> backend 将图片写入 AttachmentStore
  -> backend 将 userMessage.attachments 写入会话记录
  -> backend 构造 ACP image_block 发给 runtime
```

撤回规则：

1. 发送前删除：仅 `URL.revokeObjectURL()`，不调用后端。
2. 发送中失败且未创建 turn：backend 应清理本轮已写入的临时附件。
3. 发送成功进入 turn：图片成为会话记录的一部分，不再随草稿删除。
4. 用户删除整条会话：级联删除该会话的 attachments。

### 5.3 为什么不先写 AttachmentStore

不采用“粘贴即上传”的原因：

1. 用户经常会误粘贴或撤回图片。
2. 截图可能包含敏感信息，未发送前不应落盘。
3. 新会话发送前可能还没有真实 conversationId。
4. 先落盘会引入草稿附件清理、超时 GC 和孤儿文件问题。

### 5.4 发送后的存储内容

MVP 建议只保存“实际发送给 runtime 的归一化图片”，不保存原始超大图。

目录：

```text
data/
  attachments/
    conversations/
      <conversationId>/
        <attachmentId>/
          image
          preview.webp
          metadata.json
```

metadata：

```json
{
  "id": "att_...",
  "kind": "image",
  "name": "screenshot.png",
  "mimeType": "image/jpeg",
  "sizeBytes": 482193,
  "base64Bytes": 642924,
  "width": 1600,
  "height": 900,
  "sha256": "...",
  "createdAt": "2026-07-07T12:00:00Z",
  "conversationId": "conv_...",
  "source": "user-paste",
  "wasCompressed": true
}
```

## 6. 输入框 UI 设计

### 6.1 结构

推荐结构：

```text
composer-wrap
  composer-stack
    pending approval / input request / plan
    composer-shell
      image-strip
        image-thumb * n
      textarea
      composer-actions
```

图片、文本和底部控制条都属于同一个输入框外壳，视觉上是一块连续区域。

### 6.2 图片预览

缩略图规则：

1. 图片展示在输入框顶部。
2. 固定尺寸矩形，建议 `76x76` 或 `84x72`，移动端可降到 `64x64`。
3. 使用 `object-fit: cover` 做展示裁剪。
4. 真实发送图片不裁剪。
5. 右上角提供删除按钮。
6. 多张图片使用单行 `flex-wrap: nowrap`。
7. 由于单轮最多 5 张，桌面宽度通常足够；窄窗口下允许 image strip 横向滚动，但不换行。

示意：

```text
+------------------------------------------------------+
| [ img x ] [ img x ] [ img x ]                        |
| 输入文字...                                          |
|                                                      |
| +  权限/模型/上下文                          发送    |
+------------------------------------------------------+
```

### 6.3 弹性 textarea

当前输入框固定 `rows={2}`。目标是根据文本内容自动增高：

```text
minHeight: 2 行
preferredHeight: textarea.scrollHeight
maxComposerHeight: ChatPage 可用高度 * 0.5
overflowY: preferredHeight > maxTextHeight ? auto : hidden
```

实现建议：

1. `textarea` 每次 `draft` 变化后设置 `height = "auto"`，再取 `scrollHeight`。
2. 用 `ResizeObserver` 或 ChatPage 容器 ref 计算 `chatPageHeight`。
3. `composer-shell` 最大高度为 `chatPageHeight * 0.5`。
4. 图片 strip 和 action bar 占用固定高度后，剩余空间给 textarea。
5. 到达最大高度后，只让 textarea 内部滚动，不让整个输入框继续撑高。

伪代码：

```typescript
const maxComposerHeight = chatPageHeight * 0.5;
const fixedHeight = imageStripHeight + actionBarHeight + paddings;
const maxTextareaHeight = Math.max(72, maxComposerHeight - fixedHeight);

textarea.style.height = "auto";
textarea.style.height = `${Math.min(textarea.scrollHeight, maxTextareaHeight)}px`;
textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
```

### 6.4 发送按钮和状态栏

底部 action bar 保持贴底：

1. 左侧：附件入口、快捷指令、权限模式。
2. 右侧：上下文环、模型 / 推理强度、发送按钮。
3. 输入框增高时，底部控制条不随 textarea 内容滚动。
4. active turn 时发送按钮保持 stop 状态。

## 7. 前后端协议

### 7.1 turn 请求

发送时前端传递归一化后的 inline image block：

```json
{
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "input": "按这张图改一下输入框",
  "contentBlocks": [
    {
      "type": "text",
      "text": "按这张图改一下输入框"
    },
    {
      "type": "image",
      "mimeType": "image/jpeg",
      "source": {
        "kind": "inline_base64",
        "data": "<base64>"
      },
      "name": "screenshot.png",
      "sizeBytes": 482193,
      "base64Bytes": 642924,
      "width": 1600,
      "height": 900,
      "wasCompressed": true
    }
  ]
}
```

backend 接收后：

1. 校验 inline image。
2. 写入 AttachmentStore。
3. 将会话消息中的图片替换成 attachment metadata。
4. 构造 ACP `image_block(data, mime_type)`。
5. 不把 base64 写入 `messages.json`、`events.ndjson`、日志或远程同步事件。

### 7.2 会话消息

`ChatMessage` 保留 `content`，新增 `attachments`：

```typescript
interface ChatMessage {
  content: string;
  attachments?: MessageAttachment[];
}

interface MessageAttachment {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  previewUrl?: string;
  wasCompressed?: boolean;
}
```

历史消息加载时，MessageList 根据 `attachments` 渲染用户消息图片。

### 7.3 SessionCapabilities

扩展：

```typescript
interface SessionInputCapabilities {
  text: boolean;
  image: {
    supported: boolean;
    acceptedMimeTypes: string[];
    maxImagesPerTurn: number;
    maxBase64BytesPerImage: number;
    maxBase64BytesPerTurn: number;
    maxWidth: number;
    maxHeight: number;
    autoResize: boolean;
    source: "acp.promptCapabilities" | "model.capabilities" | "descriptor" | "unknown";
    caveats?: string[];
  };
}
```

UI 根据 `image.supported` 控制图片入口是否可用。backend 即使收到旧客户端传来的图片，也必须重复校验。

## 8. 实施阶段

### 阶段 1：前端草稿图片与弹性输入框

目标：

1. `ChatComposer` 支持 paste / drop / file select。
2. 图片只进入内存 `DraftImage[]`。
3. 图片 strip 单行裁剪式展示。
4. textarea 自动增高，最大为 ChatPage 高度一半。
5. 未发送删除图片不调用后端。

验证：

1. 粘贴图片后能看到缩略图。
2. 删除图片后无 backend 请求。
3. 多张图片保持一行。
4. 长文本输入框增高，到 1/2 页面高度后 textarea 内部滚动。

### 阶段 2：图片归一化与校验

目标：

1. 前端压缩到 2000x2000 box 和 5 MiB base64。
2. 单轮最多 5 张。
3. 单轮总 base64 不超过 20 MiB。
4. 错误以图片 chip 或 composer 内提示展示，不清空草稿。

验证：

1. 6 张图片第 6 张被拒绝。
2. 大图自动压缩。
3. 压缩后仍超限的图片提示失败。
4. SVG、GIF 被拒绝或按明确策略处理。

### 阶段 3：backend AttachmentStore 与 turn 协议

目标：

1. `/api/turns/stream` 支持 `contentBlocks`。
2. 发送后才把图片写入 AttachmentStore。
3. user message 保存 attachment metadata。
4. ACP adapter 发送 image block。
5. 日志和 events 不包含 base64。

验证：

1. 发送前 `data/attachments` 不新增文件。
2. 发送成功后会话目录有附件 metadata 和 preview。
3. 重新打开会话能显示用户图片。
4. `events.ndjson` 不包含 base64。

### 阶段 4：runtime smoke

目标：

1. Codex ACP：1 张和 5 张小图 smoke。
2. Claude Code ACP：initialize capability 和真实图片 turn。
3. opencode ACP：initialize capability 和真实图片 turn。
4. 不支持图片的 runtime 在 UI 和 backend 都有清晰阻断。

## 9. 风险与决策

| 风险 | 决策 |
| --- | --- |
| 各 runtime 图片限制不同 | code-lite 默认使用更保守的 5 张、5 MiB base64、2000x2000 |
| base64 请求过大影响 NDJSON 和内存 | 第一阶段只在发送请求中短暂携带，落盘后只保存附件引用 |
| 用户误粘贴隐私截图 | 发送前不落盘；删除草稿只清理内存 |
| UI 预览裁剪被误认为真实裁剪 | 文档和实现都区分 `object-fit: cover` 与真实图片压缩 |
| 前端压缩不可信 | backend 重复校验数量、mime、base64 大小和总量 |
| Claude / opencode 可用性随模型变化 | 以 runtime initialize capability 和 smoke 结果为准 |

## 10. 验收标准

1. 粘贴图片后，未发送状态下不会写入 AttachmentStore。
2. 删除草稿图片不会产生本地附件文件。
3. 单轮最多 5 张图片。
4. 单张图片超过目标限制时自动压缩到 2000x2000 box 和 5 MiB base64 内。
5. 压缩后仍超限时拒绝发送，并保留用户文本和其他图片草稿。
6. 输入框能随文本增长，最大高度不超过 ChatPage 高度的 1/2。
7. 到达最大高度后，只有 textarea 出现滚动条。
8. 图片缩略图在一行内展示，真实发送图片不被 UI 裁剪。
9. 发送成功后，图片作为 attachment metadata 写入会话记录，base64 不写入日志、事件和消息 JSON。
10. runtime 不支持图片时，图片入口不可用；旧客户端强行发送图片时 backend 返回明确错误。

## 11. 参考来源

1. ACP prompt turn：`https://agentclientprotocol.com/protocol/v1/prompt-turn`
2. OpenAI Images and Vision：`https://developers.openai.com/api/docs/guides/images-vision`
3. Codex CLI features：`https://developers.openai.com/codex/cli/features`
4. Anthropic Claude Vision：`https://docs.anthropic.com/en/docs/build-with-claude/vision`
5. Claude Code common workflows：`https://docs.anthropic.com/en/docs/claude-code/common-workflows`
6. opencode config image attachments：`https://opencode.ai/docs/config/`
7. opencode intro image prompt：`https://opencode.ai/docs/`
