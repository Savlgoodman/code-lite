# Agent 文件变更 Diff 按需加载设计

设计日期：2026-07-07

相关文档：

1. `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`
2. `docs/design/0703-AGENT-UNIFIED-ACP.md`
3. `docs/refactor/0703-RUNTIME-DATA-CHAT-UI.md`
4. `docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md`

## 1. 背景

ACP runtime 在文件编辑工具调用中会通过 `tool_call` 或 `tool_call_update` 的 `content[]` 返回 `type: "diff"` 内容。Codex ACP 当前会在 `tool_call` started 事件里提供完整 `oldText` / `newText`，而 completed 事件可能只返回状态。

现有实现为了快速可视化文件创建和修改，将完整 diff 保存在 `toolCalls[].metadata.rawUpdate.content[]` 中，并随 `messages.json` 和前端流式事件一起传输。这样能显示文件变更，但对真实大改动并不稳妥：

1. `messages.json` 会被大段文件内容膨胀。
2. ChatPage 初始化历史会话时必须把完整 diff 加载进 React state。
3. 流式 NDJSON 会携带大 payload，影响首屏和消息追加。
4. 折叠状态下虽然 DOM 可以不渲染，但完整文本仍占据前端内存。
5. 后续远程同步观看时，大 diff 会放大网络、重放和补偿成本。

因此需要将“文件变更摘要”和“完整 diff 内容”拆分：消息流和消息投影只携带轻量摘要，完整 diff 存在后端 artifact 中，前端在用户展开具体文件卡片时按需请求。

## 2. 目标

1. 文件编辑工具在聊天区默认只展示轻量摘要：文件路径、变更类型、增加行数、删除行数、diffId。
2. 完整 `oldText` / `newText` 不进入 `messages.json`，不进入前端初始会话 state。
3. 完整 diff 保存在会话目录下的 artifact 文件中，保留诊断和回放能力。
4. 前端展开某个文件变更卡片时，通过 `conversationId + diffId` 向后端获取完整 diff。
5. 折叠状态下不渲染 diff 正文；可按策略释放已加载 diff，优先保证消息区性能。
6. 保持现有 `events.ndjson` 的诊断价值，但避免产品级消息投影依赖大型原始 payload。

## 3. 非目标

1. 本阶段不实现 IDE 级完整 diff viewer，只提供可阅读的行级 diff 卡片。
2. 本阶段不做跨会话 diff 搜索。
3. 本阶段不做文件内容长期压缩归档策略，只定义可后续替换的 artifact 存储边界。
4. 本阶段不改变 ACP mapper “来者不拒”的诊断原则，但会在进入 UI 投影前瘦身。

## 4. 数据模型

### 4.1 ToolCall 消息投影

`messages.json` 中的文件编辑工具不再保存完整 `metadata.rawUpdate.content[].oldText/newText`，改为保存摘要：

```json
{
  "id": "call_hZvjvF8d4ySRIGCLWo5G8nH9",
  "name": "Editing files",
  "status": "complete",
  "metadata": {
    "runtime": "codex",
    "nativeSessionId": "019f3c10-...",
    "status": "completed",
    "fileDiffs": [
      {
        "diffId": "call_hZvjvF8d4ySRIGCLWo5G8nH9-0",
        "toolCallId": "call_hZvjvF8d4ySRIGCLWo5G8nH9",
        "path": "D:\\test\\hello_world.py",
        "changeType": "create",
        "added": 1,
        "removed": 0,
        "artifactPath": "diffs/call_hZvjvF8d4ySRIGCLWo5G8nH9-0.json"
      }
    ],
    "rawUpdateSummary": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_hZvjvF8d4ySRIGCLWo5G8nH9",
      "kind": "edit",
      "status": "in_progress",
      "title": "Editing files"
    }
  }
}
```

说明：

1. `fileDiffs[]` 是 UI 的正式数据源。
2. `rawUpdateSummary` 只保留可诊断的结构字段，不包含大文本。
3. `artifactPath` 是后端内部相对路径，前端不直接读文件，只用 `diffId` 请求 API。
4. `diffId` 必须在单个会话内稳定唯一。建议使用 `${toolCallId}-${contentIndex}`，当 `toolCallId` 缺失时使用 mapper 生成的工具 id。

### 4.2 Diff Artifact

完整 diff 保存到：

```text
data/record/<conversationId>/diffs/<diffId>.json
```

文件结构：

```json
{
  "schemaVersion": 1,
  "diffId": "call_hZvjvF8d4ySRIGCLWo5G8nH9-0",
  "conversationId": "20260707-181214-32eaf31fb68b4b83",
  "turnId": "turn-1674a8e8-0dac-4750-94f7-b9af689d078d",
  "toolCallId": "call_hZvjvF8d4ySRIGCLWo5G8nH9",
  "contentIndex": 0,
  "path": "D:\\test\\hello_world.py",
  "changeType": "create",
  "added": 1,
  "removed": 0,
  "oldText": null,
  "newText": "print(\"hello world\")\n",
  "createdAt": 1783419169182
}
```

可选扩展字段：

1. `oldTextHash` / `newTextHash`：用于校验和未来去重。
2. `byteSize`：用于大 artifact 阈值和 UI 提示。
3. `truncated`：如果未来引入超大 diff 截断策略，可以显式告诉 UI。

### 4.3 变更类型

`changeType` 由 `oldText` / `newText` 推导：

| 条件 | changeType |
| --- | --- |
| `oldText == null` 且 `newText` 非空 | `create` |
| `oldText` 非空且 `newText` 为空 | `delete` 或 `clear` |
| `oldText` 非空且 `newText` 非空 | `modify` |

如果 ACP content 带 `_meta.kind`，优先保留为 `nativeChangeKind`，但 UI 展示仍使用 code-lite 规范化后的 `changeType`。

## 5. 后端设计

### 5.1 新增 DiffArtifactStore

新增存储服务：

```text
backend/code_lite_backend/storage/diff_artifacts.py
```

职责：

1. 校验 `conversationId` 和 `diffId`，禁止路径穿越。
2. 保存完整 diff artifact。
3. 读取指定 diff artifact。
4. 删除会话时随会话目录一起删除，无需额外清理。

建议 API：

```python
class DiffArtifactStore:
    def save_diff(conversation_id: str, diff: dict[str, Any]) -> dict[str, Any]: ...
    def load_diff(conversation_id: str, diff_id: str) -> dict[str, Any] | None: ...
```

### 5.2 Recorder 投影职责

`ConversationRecorder.apply_agent_event()` 在处理工具事件时做两件事：

1. 从 `metadata.rawUpdate.content[]` 中提取 `type: "diff"` 项，保存 artifact。
2. 将 tool call metadata 中的完整 raw diff 替换为轻量 `fileDiffs[]` 和 `rawUpdateSummary`。

关键点：

1. started 事件携带 diff、completed 事件为空时，必须沿用 started 阶段提取出的 `fileDiffs[]`。
2. metadata 深合并时，`fileDiffs[]` 按 `diffId` 去重合并。
3. completed 事件的 `status` 可以覆盖为 `completed`，但不能抹掉 started 的 file diff summary。
4. `events.ndjson` 可以继续记录原始事件用于诊断，但产品读取 `messages.json` 时不依赖完整 raw diff。

### 5.3 Mapper 与 Event 瘦身

ACP mapper 仍应保留原始 raw update 供诊断链路使用。但在发送给前端流式 UI 前，需要增加一个“UI payload projection”步骤：

```text
ACP raw update
  -> mapper: 统一事件 + rawUpdate
  -> recorder: 保存 diff artifact + 生成 fileDiffs summary
  -> stream response: 发送瘦身后的事件
  -> frontend: 只持有 summary
```

短期实现可以在 `turns.py` 发送 NDJSON 前调用 projection helper，长期可以抽到专门的 `event_projection.py`。

注意：不要只在 recorder 内瘦身，否则前端实时流仍会收到完整 `oldText/newText`。

### 5.4 API 设计

新增接口：

```http
GET /api/conversations/{conversationId}/diffs/{diffId}
```

响应：

```json
{
  "diff": {
    "schemaVersion": 1,
    "diffId": "call_xxx-0",
    "path": "src/foo.ts",
    "changeType": "modify",
    "added": 61,
    "removed": 79,
    "oldText": "...",
    "newText": "..."
  }
}
```

错误：

| 状态码 | 场景 |
| --- | --- |
| 400 | 非法 `conversationId` 或 `diffId` |
| 404 | 会话或 diff artifact 不存在 |

安全边界：

1. `diffId` 只允许 `[A-Za-z0-9_.-]`。
2. API 不接收任意文件路径。
3. 只从 `data/record/<conversationId>/diffs/` 读取。

## 6. 前端设计

### 6.1 类型

新增轻量摘要类型：

```ts
export interface FileDiffSummary {
  added: number;
  changeType: "create" | "modify" | "delete" | "clear";
  diffId: string;
  path: string;
  removed: number;
  toolCallId?: string;
}
```

工具卡片使用 `tool.metadata.fileDiffs`，不再读取 `metadata.rawUpdate.content[]` 作为常规渲染源。

### 6.2 按需加载

`FileEditGroup` 和 `FileDiffPreview` 保持折叠结构，但每个文件卡片内部状态改为：

```text
idle -> loading -> loaded | error
```

行为：

1. 文件卡片默认折叠，只渲染标题和统计。
2. 用户展开某个文件卡片时，若未加载，则调用 diff API。
3. 加载成功后渲染 diff 正文。
4. 加载失败时显示轻量错误文案和重试按钮。
5. 用户折叠后，默认保留已加载 diff，避免反复请求；如果 diff 超过阈值，可释放内容。

### 6.3 渲染性能

短期策略：

1. 折叠时不渲染 `<pre>` 和 diff 行节点。
2. 展开后完整渲染，但 `.tool-file-diff-preview` 设置最大高度和滚动。
3. 对单个 diff 行数超过阈值时显示提示，例如 “此文件变更较大，已启用滚动查看”。

中期策略：

1. 引入虚拟列表，只渲染可视行。
2. 后端可支持 `?format=patch` 或 `?range=`，只返回 hunks 或窗口范围。
3. 对超过阈值的 diff，默认返回 unified patch，而不是 `oldText/newText` 全量。

### 6.4 前端缓存

建议在 `ChatPage` 或独立 hook 中维护会话级缓存：

```ts
Record<string, LoadedDiff>
```

key 使用 `${conversationId}:${diffId}`。

缓存策略：

1. 当前会话内保留已打开 diff。
2. 切换会话时清理缓存，避免跨会话内存积累。
3. 单个 diff 超过 1 MB 时，折叠文件卡片可以释放正文，只保留 summary。

## 7. 兼容与迁移

现有历史记录可能有两类：

1. 旧记录 `messages.json` 已经丢失 diff，但 `events.ndjson` 仍有完整 started 事件。
2. 新近记录 `messages.json` 已经包含完整 `metadata.rawUpdate.content[]`。

兼容策略：

1. UI 读取时优先使用 `metadata.fileDiffs`。
2. 若不存在 `fileDiffs`，但存在 `rawUpdate.content[]`，前端可以临时走 legacy fallback，保证旧会话仍可显示。
3. 后端可提供一次性迁移脚本：扫描 `events.ndjson` 和 `messages.json`，生成 `diffs/*.json` 并回写轻量 `fileDiffs[]`。
4. 迁移脚本不是主路径，先保证新会话正确。

## 8. 实施步骤

建议分 5 个提交完成：

1. `feat: 增加 diff artifact 存储`
   - 新增 `DiffArtifactStore`
   - 新增单元测试覆盖路径校验、保存、读取

2. `feat: 投影文件 diff 摘要`
   - recorder 提取 diff artifact
   - `messages.json` 只保存 `fileDiffs[]`
   - 保留 started/completed metadata 合并行为

3. `feat: 增加 diff 按需查询接口`
   - `GET /api/conversations/{conversationId}/diffs/{diffId}`
   - API 测试覆盖 404 和非法 id

4. `feat: 前端按需加载文件 diff`
   - `FileEditGroup` 改用 `fileDiffs[]`
   - 展开文件卡片时请求 API
   - 折叠时不渲染 diff 正文

5. `refactor: 瘦身流式文件 diff 事件`
   - 后端发送到前端的 NDJSON 只带 summary
   - 保证实时流和历史加载数据形态一致

## 9. 验证计划

后端：

1. `uv run --project backend python -m unittest backend.tests.test_conversation_recorder_plan backend.tests.test_acp_mapper`
2. 新增 diff artifact store 单测。
3. 新增 conversations diff API 单测。

前端：

1. `npm run ui:build`
2. 手动验证小文件创建：标题统计正确，展开后加载正文。
3. 手动验证大文件修改：初始消息加载不包含完整 diff，展开单文件卡片才请求接口。
4. 手动验证一个工具修改多个文件：编辑组总计正确，每个文件可独立加载。
5. 手动验证 completed 空 metadata 不覆盖 started 的 fileDiff summary。

性能观察：

1. 对比同一大 diff 会话的 `messages.json` 大小。
2. 对比打开历史会话的初始内存和响应耗时。
3. 浏览器 devtools 确认折叠状态下没有 diff 行 DOM。

## 10. 风险与取舍

1. 需要多一次网络请求：用户展开文件卡片时才请求 diff，换取初始加载和常态渲染性能。
2. artifact 与消息摘要可能不一致：通过 `diffId`、`added`、`removed` 和 hash 字段降低风险。
3. 旧会话迁移不一定完整：优先保证新会话，旧会话提供 fallback 和可选迁移。
4. `events.ndjson` 仍可能很大：这是诊断日志问题，不应阻塞产品消息瘦身；后续可做日志压缩和保留策略。

## 11. 结论

文件 diff 应从聊天消息主体中剥离出来。前端只持有摘要，完整 diff 由后端 artifact 持久化，并在用户展开具体文件卡片时按需加载。

这个方案可以同时满足：

1. 聊天区默认轻量、流畅。
2. 文件变更可视化仍完整。
3. 后端保留完整诊断数据。
4. 后续远程同步和历史回放不会被大 diff 拖垮。
