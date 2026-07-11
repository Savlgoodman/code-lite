# 远端聊天渲染增强、审批流修复与文件引用渲染设计

设计日期：2026-07-11

分支：`feat/remote-0711-chat-render-approval-fileref`

## 0. 相关文档

1. `docs/design/0709-REMOTE-CONTROL-DUAL-SYNC.md`（第 4.3 审批先到先得、`approval.resolved` 广播约定）
2. `docs/design/0710-REMOTE-CONTROL-PROTOCOL-FIX.md`（WsSession 统一 dispatch、会话生命周期同步）
3. `docs/design/0710-UNIFIED-SYNC-PROTOCOL.md`（SyncManager、session.running/stopped）
4. `docs/design/0707-AGENT-DIFF-ARTIFACT-LAZY-LOAD.md`（diff artifact 与 `diff.get` 懒加载）
5. `docs/design/0707-AGENT-MULTIMODAL-COMPOSER.md`（附件与 `attachment.get`）
6. `ui/AGENTS.md`（审批卡片在输入框上方、工具组折叠约定）
7. `ui-remote/AGENTS.md`（overlay 导航、Sheet、色彩令牌、SW 缓存）

## 1. 背景与问题

用户在远端（`ui-remote`，移动/PWA）使用时提出三类问题：

1. **远端不展示工具调用，也没有审批 UI**。远端 `MessageBubble` 只渲染 assistant 的
   reasoning、Markdown 正文和图片附件，`message.toolCalls` 被完全丢弃；`view.pendingApproval`
   有数据但没有任何卡片渲染，用户无法在远端同意/拒绝审批。
2. **审批交互有 bug**：
   - 桌面端点「允许/拒绝」后弹窗（卡片）有时不消失，像是没有得到返回。
   - 若审批挂起时切换会话或关窗，回到该会话时对话「已结束」，再发消息报 `busy`。
     即审批在后端一直挂着，前端重新附着后既看不到待审批卡片，也无法推进。
3. **消息正文里的文件引用没有渲染能力**。assistant 常输出
   `已创建 [test2.txt](H:\test\test2.txt)` 这类链接（示例见
   `data/record/20260711-213024-62f2a1ce017c4fd6/messages.json`）。当前 Markdown 链接一律
   渲染为 `<a target="_blank">`，点击在移动端/桌面端都没有合理行为。需要识别这类
   本地文件引用并按类型（文本 / Markdown / 图片 / 代码 / 其它）提供查看能力。

用户同时提出：聊天页这些主要渲染组件（工具组、编辑组，以及后续会更多）应抽成一个
**共享库**，方便桌面端与远端统一适配。

## 2. 现状梳理（代码级）

### 2.1 消息与视图数据流

- 协议类型集中在 `packages/protocol/src/domain.ts`：`ChatMessage.toolCalls: ToolCallItem[]`、
  `FileDiffSummary`、`ApprovalRequest`、`AgentEvent`（含 `approval.required`）。
- 会话视图 reducer 在 `packages/chat-core/src/sessionReducer.ts`：
  - `reduceAgentEvent` 已处理 `approval.required` → 写入 `state.pendingApproval` 且把工具
    卡片状态置为 `approval`（`sessionReducer.ts:233-261`），并把 `session.status` 置
    `approval`。
  - `agent.run.completed` / `agent.run.failed` 会清空 `pendingApproval` / `pendingInput`
    （`sessionReducer.ts:301-344`）。
  - **`sessionViewFromSnapshot` 显式把 `pendingApproval` / `pendingInput` 置 null**
    （`sessionReducer.ts:79-81`）。
- 客户端 `packages/chat-core/src/conversationClient.ts`：
  - `handleSnapshot` 用 `sessionViewFromSnapshot(snap.snapshot)` 重建视图
    （`conversationClient.ts:314-332`）。快照 payload 只有 `{session, messages}`。
  - `resolveApproval(approvalId, decision)` → RPC `approval.decision`
    （`conversationClient.ts:461-463`）。

### 2.2 桌面端渲染

- `ui/src/features/chat/MessageList.tsx`：`AssistantMessageContent` 调
  `buildAssistantInlineEntries`（`ui/src/features/chat/messageTools.ts`）按 `anchorOffset`
  把正文切段，工具按段分成 `toolGroups`（普通工具）与 `fileEditGroups`（有 fileDiff 的工具）。
- `ui/src/features/chat/ToolCallViews.tsx`：`ToolCallGroup`（「已调用 N 个工具」折叠）、
  `ToolCallCard`（入参/输出，`CollapsiblePre` 截断）、`FileEditGroup` + `FileDiffPreview`
  （懒加载 diff：`loadConversationDiff` → RPC `diff.get`，见 `conversationStore.ts:66-74`）。
- `ui/src/features/chat/fileDiffs.ts`：`fileDiffSummariesFromTool`、`buildDiffLines`、
  `mergeDiffStats` 等纯函数，已经和 React 无关。
- `ui/src/components/MessageRenderer.tsx`：`streamdown` 渲染，`a` 走
  `MarkdownLink`（`<a target="_blank">`，无文件识别）。
- 审批：`ChatWorkspace` → `ChatComposer` 在输入框上方渲染 `ApprovalCard`
  （`ChatComposer.tsx:567`），符合 `ui/AGENTS.md`「审批卡片显示在输入框上方，不进入消息历史」。

### 2.3 远端渲染

- `ui-remote/src/pages/ChatPage.tsx`：消息用 `MessageBubble` 渲染，输入区在底部，
  `ConfigBar` 在输入框上边缘。**无审批、无工具调用、无输入请求 UI**。
- `ui-remote/src/components/MessageBubble.tsx`：assistant 分支只渲染 reasoning + 
  `MessageRenderer` + 图片附件（`attachment.get` 懒加载）。`toolCalls` 未使用。
- 导航是 overlay 模式：`App.tsx` 用状态（`activeSessionId` 等）+ `ChatOverlay` /
  `SettingsOverlay`（CSS transform 滑入滑出）驱动，`ChatPage` 接 `onBack`。
- `ui-remote/src/components/MessageRenderer.tsx` 与桌面几乎逐字相同（streamdown + 
  `MarkdownLink`），是共享的强信号。

### 2.4 后端审批链路

- ACP `session/request_permission` 进入 `agents/acp/client.py:276-304`：
  生成 `approval_id = f"approval-{uuid...}"`，`approvals.create(approval_id, conversation_id, turn_id)`
  拿到 future，`mapper.map_permission_request(..., approval_id=approval_id)` 产出
  `approval.required` 事件（`approvalId` 与 future 同源，`mapper.py:721-756`），
  然后 `allowed = await future` **阻塞在 turn 后台 task 里**。
- `services/approvals.py`：`ApprovalBroker._pending: dict[approval_id, PendingApproval]`。
  `resolve(approval_id, decision)` pop 并 `set_result`；`reject_all()` 全部置 False。
- WS `approval.decision` → `_handle_approval_decision`（`ws.py:182-191`）：
  `services.approvals.resolve(approval_id, allowed)`，**只回 `{ok}`，不更新 session、不广播**。
  （对比 HTTP `approvals.py:13-32` 与 `inputs.py` 会 `update_session(status=...)`。）
- turn 在 `ActiveTurnRegistry` 后台 task（`turn_registry.py`）里运行；`await future` 期间
  task 未完成 → `is_running()` 为真 → `prepare_and_start_turn` 互锁返回 `busy=True`
  （`turns.py:724-726`, `ws.py:142-147`）。
- 订阅快照 `_handle_subscribe`（`ws.py:100-119`）：payload 只有
  `{snapshot, latestSequence}`，`snapshot = conversation_recorder.snapshot()` =
  `{session, messages}`（`conversation_recorder.py:595-614`），**不含任何 pending approval**。
- `_handle_turn_cancel`（`ws.py:168-179`）会 `reject_all()` + `inputs.cancel_all()`。

## 3. 问题根因

### 3.1 Bug A：桌面端点确认后卡片不消失

`_handle_approval_decision`（`ws.py:182-191`）只调用 `approvals.resolve()` 返回 `{ok}`，
不做任何状态广播。审批卡片的清除依赖两条隐式路径：

1. `resolveApproval` 里前端本地 `patchClientSession(status:"running")`（`ChatPage.tsx:1224`），
   但它只改 `session.status`，**不清 `view.pendingApproval`**。真正清空 `pendingApproval`
   的是 reducer 的 `agent.run.completed/failed`（`sessionReducer.ts:301-344`）。
2. 因此卡片消失完全依赖 future 被 resolve 后 → ACP 工具继续执行 → turn 最终产生
   terminal 事件。若该轮在审批后**没有很快产生 run.completed/failed**（例如工具执行
   较久、或后续又立刻发起下一个 permission、或 runtime 因故不再推终端事件），
   `pendingApproval` 就一直不清，卡片「卡住」。

结论：缺少一个「审批已被处理」的即时信号来清 `pendingApproval`。设计
`0709-REMOTE-CONTROL-DUAL-SYNC.md:126` 早已约定后端在 resolve 后广播 `approval.resolved`
清另一端的卡片，但代码未实现。这个信号对本端同样必要。

### 3.2 Bug B：挂起审批 + 重新附着 = 卡死报 busy

两处都把 pending approval 丢了：

1. 后端快照 `conversation_recorder.snapshot()` 只含 `{session, messages}`，
   不含 `ApprovalBroker` 里挂着的待审批（`conversation_recorder.py:595`，`ws.py:104`）。
2. 前端 `sessionViewFromSnapshot` 显式 `pendingApproval: null`（`sessionReducer.ts:79-81`）。

于是：审批挂起 → future 阻塞 → turn task 未完成 → `is_running()`=busy。用户切走再回来，
重新 subscribe 拿到的快照里 `session.status` 可能仍是 `approval`/`running` 但
`pendingApproval` 为 null → 前端无卡片可点 → 无法 resolve future → 发消息命中 busy 互锁。
表现即「对话已结束、发消息 busy」。

### 3.3 Bug 修复所需能力小结

- 后端需要能「列出某会话当前挂起的审批/输入请求」，并写进订阅快照。
- 后端 `approval.decision`（WS）resolve 后需广播一个「审批已处理」事件到会话频道。
- 前端 reducer 需要在收到该事件时清 `pendingApproval`，并让 `sessionViewFromSnapshot`
  能吃快照里的 pending approval。

## 4. 目标

1. 远端聊天页以**工具组**形式展示工具调用（与桌面一致的分组语义），默认折叠为
   「已调用 N 个工具」；点击某个工具卡片跳转到**新页面**展示入参/出参。
2. 远端以**文件编辑组**展示文件变更，点击后跳转新页面查看 diff。
3. 远端在**输入框上方**展示审批卡片（简版），支持同意/拒绝；输入请求同理。
4. 修复审批流：点确认即时清卡片（本端 + 对端），重新附着能恢复待审批卡片，
   不再假死报 busy。
5. 消息正文中的本地文件引用高亮渲染（偏深的浅蓝），点击后：
   - 桌面端：弹窗查看（文本/代码语法高亮、Markdown 渲染、图片内联）。
   - 远端：跳转新页面查看（同样按类型渲染），降低页面复杂度。
   - 图片引用在正文中直接内联渲染。
6. 把聊天主渲染逻辑（工具组分段、fileDiff、文件引用解析、审批/工具的展示型组件）
   下沉到**共享库**，两端复用，符合 `AGENTS.md` 双端同步约定。

## 5. 非目标

1. 不做 IDE 级 diff viewer（沿用现有行级 diff 卡片）。
2. 不实现任意路径的通用文件浏览器（文件引用只读打开单个文件，带安全边界）。
3. 不改 ACP mapper「来者不拒」的诊断原则。
4. 不在 PWA/生产静态部署放开会破坏安全边界的文件读取（走后端受控 RPC）。
5. 本期不做审批的多端「谁先点谁生效」竞态的完整可视化，只保证一致清除。

## 6. 共享库设计（`@code-lite/chat-render`）

### 6.1 定位与边界

新增一个 workspace 包，与 `packages/chat-core` 平级：

```text
packages/chat-render/
  package.json          # name: @code-lite/chat-render
  tsconfig.json
  src/
    index.ts
    grouping.ts         # 从 ui/features/chat/messageTools.ts 抽出的纯逻辑
    fileDiffs.ts        # 从 ui/features/chat/fileDiffs.ts 抽出的纯逻辑
    fileRefs.ts         # 新增：文件引用解析与分类（纯函数）
    types.ts            # 渲染层视图模型（AssistantInlineEntry 等）
```

铁律（沿用 `ui-remote/AGENTS.md` 分层精神）：

1. **只放纯函数与纯类型**，不 import React、不 import 任何一端的 service/hook，
   不写死颜色或 CSS。两端各自的 React 组件与样式仍留在各自仓内。
2. 依赖方向：`chat-render` 只依赖 `@code-lite/protocol`（类型），可被 `ui`、`ui-remote`
   同时 import。经 tsconfig paths + vite alias 指向 `../packages/chat-render/src`
   （与现有 `@code-lite/*` 一致）。
3. 展示型 React 组件**不下沉**（两端视觉、令牌、导航差异大），只共享「数据 → 视图模型」
   的计算。这样桌面继续用 `ToolCallViews.tsx`，远端新建自己的组件，但都吃同一份
   `buildAssistantInlineEntries` / `parseFileRefs` 结果。

> 说明：本期共享的是逻辑而非组件。若后续两端组件收敛度提高，可再评估把无样式的
> headless 组件也下沉，但不作为本期目标，避免过度抽象。

### 6.2 迁移内容

| 来源 | 去向 | 处理 |
|---|---|---|
| `ui/src/features/chat/messageTools.ts` | `chat-render/src/grouping.ts` | 原样迁移（去掉相对 import，改用 `@code-lite/protocol`），桌面改为 re-export |
| `ui/src/features/chat/fileDiffs.ts` | `chat-render/src/fileDiffs.ts` | 同上；`FileDiffContent`/`DiffLine`/`buildDiffLines` 等一并迁移 |
| 新增 | `chat-render/src/fileRefs.ts` | 见第 9 节 |

桌面端 `ui/src/features/chat/messageTools.ts`、`fileDiffs.ts` 改为从 `@code-lite/chat-render`
re-export，保证现有 import 路径不破坏、行为逐字一致（先迁移、后逐步替换 import）。

### 6.3 视图模型

`AssistantInlineEntry`（已存在于 messageTools）迁入 `chat-render/types.ts`，两端共用。
新增文件引用的视图模型见第 9.1。

## 7. 远端工具调用与文件编辑渲染

### 7.1 分组与内联

远端新增 `ui-remote/src/components/AssistantToolFlow.tsx`（或并入 `MessageBubble`），
用共享 `buildAssistantInlineEntries(message.content, message.toolCalls)` 得到分段，
在 assistant 正文之间按 `anchorOffset` 插入：

- **工具组**：`ui-remote/src/components/ToolCallGroup.tsx`（移动版）。折叠态只显示
  「已调用 N 个工具」；展开显示每个工具一行（图标 + 名称 + 状态 + 风险）。
  **点击某个工具行不再就地展开详情，而是 `onOpenToolDetail(tool)` 跳转新页面**
  （降低聊天页复杂度，符合用户要求）。
- **文件编辑组**：`ui-remote/src/components/FileEditGroup.tsx`（移动版）。折叠态显示
  「已完成 N 个文件的编辑与创建」+ 增删统计；点击某文件行 `onOpenDiff(diff)` 跳转
  diff 详情页。

运行中 / 等待审批的工具，组默认展开（与桌面 `ToolCallGroup` 的 `hasActiveTools` 一致）。

### 7.2 详情页（新全屏页面）

新增两个页面（`ui-remote/src/pages/`）：

- `ToolDetailPage.tsx`：展示单个工具的入参（`argumentsText`）、输出（`resultText`/`error`）、
  风险、状态、runtime 元信息。长文用可滚动代码块。
- `DiffDetailPage.tsx`：展示单个文件 diff。通过共享 client 懒加载：
  `client.request("diff.get", { conversationId, diffId })`（该 RPC 已存在，见
  `wire.ts:58`、桌面 `conversationStore.ts:66-74`；远端此前未用），用共享 `buildDiffLines`
  渲染行级 diff。legacy 会话若带 `legacyContent` 则直接用。

### 7.3 导航：新增页面栈

现有导航是 App 顶层 overlay 状态。工具/diff/文件详情页需要**层叠在 ChatOverlay 之上**、
从 ChatPage 内部触发、返回后回到聊天页原位。方案：

- 在 `ChatPage` 内维护一个轻量**局部页面栈** `const [detail, setDetail] = useState<DetailRoute | null>(null)`，
  `DetailRoute = { kind: "tool"; tool } | { kind: "diff"; diff } | { kind: "fileRef"; ref }`。
- 详情页经 `Portal` 渲染为全屏浮层（绕开 HomePager transform，遵循 `ui-remote/AGENTS.md`），
  用与 `ChatOverlay` 相同的「右侧滑入 / 退出保留 DOM」CSS 模式（`navigation.css` 复用）。
- 好处：不污染 App 顶层状态；ChatOverlay 退出时详情页随 ChatPage 一起卸载；栈语义简单
  （最多再叠一层，返回即清 `detail`）。

> 备选：把详情路由上提到 App，与 ChatOverlay 平级。因为详情页只属于聊天上下文、且需要
> 会话内的 client/conversationId，局部栈更内聚，选局部栈。

## 8. 审批（与输入请求）修复

### 8.1 后端：挂起审批可查询、可广播

1. `services/approvals.py` `ApprovalBroker` 增加：
   - 保存创建审批时的**展示 payload**（即 `mapper.map_permission_request` 产出的
     `approval.required` 事件体，或其可序列化子集），随 `PendingApproval` 存下。
   - `list_for_conversation(conversation_id) -> list[dict]`：返回该会话所有挂起审批的
     展示 payload。`services/inputs.py` 同样加 `list_for_conversation`。
2. 订阅快照 `_handle_subscribe`（`ws.py:100-119`）扩展 payload：
   ```json
   { "snapshot": {...}, "latestSequence": N,
     "pendingApprovals": [ ...approval.required payload... ],
     "pendingInputs": [ ...agent.input.required payload... ] }
   ```
   （放在 subscribe 结果里，避免改 `conversation_recorder.snapshot` 的 `{session,messages}`
   契约；快照重建时前端据此恢复 pending。）
3. `_handle_approval_decision`（`ws.py:182-191`）在 `resolve` 成功后：
   - `conversation_recorder.update_session(conversation_id, {"status": "running" if allow else "error"})`
     （与 HTTP `approvals.py`、`inputs.py` 对齐）。
   - 经 event bus **向该会话频道广播 `approval.resolved` 事件**
     （`0709-REMOTE-CONTROL-DUAL-SYNC.md:126` 约定）。事件体：
     `{ type:"approval.resolved", conversationId, turnId, approvalId, decision }`。
   - `resolve` 返回的 `PendingApproval` 已带 `conversation_id/turn_id`，用于路由。
   `input.response` 同理广播 `agent.input.completed`（该事件已存在于 `AgentEvent`，
   reducer 已处理 `sessionReducer.ts:280-285`；确保 WS 侧真的广播它）。

### 8.2 协议：新增 `approval.resolved` 事件

`packages/protocol/src/domain.ts` 的 `AgentEvent` 联合类型新增：

```ts
| {
    type: "approval.resolved";
    conversationId: string;
    turnId: string;
    approvalId: string;
    decision: "allow" | "deny";
  }
```

### 8.3 前端 reducer 修复

`packages/chat-core/src/sessionReducer.ts`：

1. 新增 `case "approval.resolved"`：若 `state.pendingApproval?.approvalId === event.approvalId`
   则清 `pendingApproval`（同时把工具卡片 `approval` 状态推进为 `running`/`complete` 的
   处理可选，先只清卡片，后续 tool 事件会覆盖状态）。
2. `sessionViewFromSnapshot` 增参：接收 `pendingApprovals` / `pendingInputs`，
   用第一个挂起项还原 `pendingApproval` / `pendingInput`（不再无条件置 null）。
3. `conversationClient.handleSnapshot`（`conversationClient.ts:314-332`）把 subscribe
   结果里的 `pendingApprovals/pendingInputs` 透传给 `sessionViewFromSnapshot`。

> 注意：`handleSnapshot` 目前从 `onSnapshot` 拿 `{snapshot}`。若把 pending 放在 subscribe
> 的 result 而非 snapshot 信封，需要让 transport 的 snapshot 通道带上这两个字段，或改成
> 由 client 在 subscribe 时读取 result。落地时统一：**snapshot 信封 payload 扩展**为
> `{ snapshot, latestSequence, pendingApprovals, pendingInputs }`，`handleSnapshot` 一并读。

### 8.4 桌面端

- Bug A 借 8.1/8.3 的 `approval.resolved` 即时清卡，不再等 run.completed。
- `ChatPage.resolveApproval`（`ChatPage.tsx:1220-1231`）保持，可去掉仅改 status 的乐观
  patch 或保留（幂等）。

### 8.5 远端审批卡片

- `ui-remote/src/components/ApprovalCard.tsx`（移动简版）：显示工具名、风险、用途、
  参数摘要 + 「允许 / 拒绝」两个按钮。渲染在**输入框上方**（`ChatPage` 的 composer 之上，
  ConfigBar 同区域），不进消息历史。样式走 `--tone-*` / 语义令牌。
- 复杂详情（完整入参、影响、回滚）在移动端可折叠或点开跳详情页，保持简洁。
- `onResolve` → `client.resolveApproval(approvalId, decision)`。
- 输入请求卡片（`agent.input.required`）本期可先只做审批，输入请求留桩（若时间充裕
  一并做简版）。

## 9. 文件引用渲染

### 9.1 解析（共享 `chat-render/src/fileRefs.ts`）

Markdown 链接形如 `[label](target)`。经 streamdown 渲染到 `a` 组件时能拿到 `href`。
在两端 `MarkdownLink` 里对 `href` 调用共享分类函数：

```ts
export type FileRefKind = "image" | "markdown" | "code" | "text" | "external";

export interface FileRef {
  kind: FileRefKind;
  path: string;          // 规范化后的绝对/相对路径
  label: string;
  ext: string;           // 小写扩展名（无点）
  language?: string;     // code 时的高亮语言
}

export function classifyHref(href: string, label: string): FileRef | null;
```

判定规则：

1. 明确的外链（`http(s):`、`mailto:` 等）→ `external`（走原有 `<a target="_blank">`）。
2. 本地文件引用：Windows 盘符路径（`H:\...`）、`file://`、以 `/`、`./`、`../` 开头，
   或带已知扩展名的裸路径。识别后按扩展名分类：
   - 图片：`png jpg jpeg gif webp bmp svg`（svg 视安全策略，先按文本或图片择一，
     默认按图片但用 `<img>` 不内联执行）。
   - Markdown：`md markdown`。
   - 代码：常见源码扩展（`ts tsx js jsx py rs go java c cpp h json yaml yml toml
     sh ps1 css html ...`），`language` 由扩展名映射。
   - 其它一律 `text`。
3. 无法判定为本地文件的 → 返回 null，回退外链渲染。

> 安全：解析只做分类，不读盘。真正读取内容走后端受控 RPC（见 9.3），带路径校验。

### 9.2 渲染入口（两端各自实现，逻辑共享）

改造两端的 `MarkdownLink`（`ui/src/components/MessageRenderer.tsx:46` 与
`ui-remote/src/components/MessageRenderer.tsx:44`）：

- `classifyHref` 命中本地文件 → 渲染为**文件引用 chip**：偏深的浅蓝高亮
  （新增语义令牌 `--file-ref-bg` / `--file-ref-text`，桌面在 `styles.css`、远端在
  `tokens.css` 的四种主题组合都给值），带文件图标 + label。
- 图片类型（`kind==="image"`）：不渲染成 chip，而是**在正文中直接内联渲染图片**
  （`<img>`，经 9.3 的 RPC 或直接 `file://`/`attachmentUrl` 取内容）。
- 其它类型 chip 点击：
  - **桌面**：打开弹窗（Portal + modal，仿 `TokenUsageModal` / `ImagePreview` 模式）。
    - text → 纯文本；code → 语法高亮（复用 streamdown code 或 `@streamdown/code`）；
      md → streamdown 渲染；图片已内联，弹窗仅用于放大预览。
  - **远端**：`onOpenFileRef(ref)` 跳转 `FileRefDetailPage`（第 7.3 页面栈），
    页面内按类型渲染（同上）。

MarkdownLink 需要一个回调把「点击了文件引用」冒泡给页面（桌面开弹窗、远端跳页）。
经 `MessageRenderer` 的新 prop `onOpenFileRef?: (ref: FileRef) => void` 透传；
图片内联渲染需要取内容 URL，见 9.3。

### 9.3 后端：受控文件读取 RPC

新增 WS RPC `fs.readFile`（与 `fs.list` 同一家族，`ws.py`）：

```text
req  fs.readFile { conversationId, path }
res  { path, kind, mimeType, encoding: "utf-8"|"base64", content, truncated, sizeBytes }
```

安全边界：

1. 路径必须落在**该会话 workspace 之内**（`conversation_recorder` 的 session.workspace，
   回退全局 workspace）。规范化后校验前缀，拒绝越界与符号链接逃逸。
2. 大小上限（如 1 MB 文本 / 5 MB 图片），超出 `truncated=true` 或拒绝。
3. 文本按 UTF-8 读，二进制（图片）base64。
4. 只读，不允许写、不允许列目录之外的能力。

> 图片也可复用：若引用其实是会话附件则走 `attachment.get`；一般本地文件走 `fs.readFile`。
> 桌面端因与 backend 同机，也统一走该 RPC，避免两套读取逻辑。

前端封装：`conversationClient` 加 `readFile(conversationId, path)`（`request("fs.readFile", ...)`）。

## 10. 任务拆解与提交计划

每完成一个小任务提交一次（`AGENTS.md` 提交规范：有文档时每步一提交）。

1. `docs: 新增远端聊天渲染/审批/文件引用设计文档`（本文件）。
2. `feat(packages): 新增 @code-lite/chat-render 共享库骨架`
   - 新建包、tsconfig、两端 alias/paths；迁移 `grouping.ts` + `fileDiffs.ts`；
     桌面改 re-export；两端 `npm run build` 通过。
3. `fix(approval): 后端广播 approval.resolved 并在订阅快照回传挂起审批`
   - `ApprovalBroker`/`InputBroker` 存展示 payload + `list_for_conversation`；
     `_handle_subscribe` 回 `pendingApprovals/pendingInputs`；`_handle_approval_decision`
     更新 session 状态 + 广播 `approval.resolved`；后端单测。
4. `fix(approval): 前端 reducer 处理 approval.resolved 与快照恢复挂起审批`
   - 协议加 `approval.resolved`；`sessionReducer` 新增 case + `sessionViewFromSnapshot`
     吃 pending；`conversationClient.handleSnapshot` 透传；两端 build。
   - 验证 Bug A（点确认即时清卡）与 Bug B（重连恢复卡片、不再 busy）。
5. `feat(ui-remote): 会话页展示工具组与文件编辑组`
   - `AssistantToolFlow` + 移动版 `ToolCallGroup`/`FileEditGroup`（用共享分组）；
     点击跳详情占位。
6. `feat(ui-remote): 工具详情页与 diff 详情页 + 页面栈导航`
   - `ToolDetailPage`/`DiffDetailPage`；ChatPage 局部页面栈 + Portal 滑入转场；
     diff 走 `diff.get`。
7. `feat(ui-remote): 会话页审批卡片（输入框上方）`
   - 移动版 `ApprovalCard`；接 `resolveApproval`；样式走令牌。
8. `feat(backend): 新增 fs.readFile 受控文件读取 RPC`
   - 路径/大小校验 + 单测；`conversationClient.readFile`。
9. `feat(packages): chat-render 新增文件引用解析 fileRefs`
   - `classifyHref` + 语言映射 + 单测（若包内配测试）。
10. `feat(ui): 桌面消息文件引用高亮与弹窗查看`
    - 改 `MarkdownLink`；文件引用 chip 令牌；文本/代码/md 弹窗；图片内联。
11. `feat(ui-remote): 远端文件引用高亮与详情页查看`
    - 改 `MarkdownLink`；文件引用 chip 令牌（四主题）；`FileRefDetailPage`；图片内联。

> 顺序原则：先共享库骨架（2），再修审批（3-4，用户痛点最急），再远端渲染（5-7），
> 最后文件引用（8-11）。每步独立可编译、可验证。若某步过大可再细分，但保持原子。

## 11. 双端同步说明

本设计涉及桌面端（`ui/`）与远端（`ui-remote/`）都存在的对话渲染区，按 `AGENTS.md`
「双端同步约定」：

- 共享逻辑（分组、fileDiff、文件引用解析、`approval.resolved` reducer）下沉 `packages/`，
  两端都需 `npm run build` 通过（`ui`、`ui-remote` 各一次）。
- 展示层各端分别实现：桌面文件引用走弹窗、远端走详情页；工具组桌面就地展开、
  远端跳详情页。差异是刻意的（移动端降复杂度）。
- 审批协议（`approval.resolved`、快照 pending）改 `protocol`/`chat-core`，两端行为一致。

## 12. 验证计划

后端：

1. `uv run --project backend python -m unittest`（审批 broker、快照 pending、fs.readFile
   路径校验相关新测）。
2. 手动：审批挂起时切会话再回，卡片恢复、可 resolve、不报 busy。

前端：

1. `npm run ui:build` 与 `npm run build --prefix ui-remote`（`tsc` strict + 打包）。
2. 桌面：点审批确认后卡片立即消失；文件引用点击弹窗（文本/代码/md/图片各一）。
3. 远端：工具组折叠/跳详情；文件编辑组跳 diff；审批卡片同意/拒绝；文件引用跳详情页、
   图片内联；重连恢复审批。
4. 远端改动排查 SW 缓存（`ui-remote/AGENTS.md`）。

## 13. 风险与取舍

1. 快照回传 pending 与 `approval.resolved` 广播若顺序错乱，可能短暂重复/缺失卡片；
   以 `approvalId` 幂等清除降低风险。
2. `fs.readFile` 是新的读盘面，必须严格限制在会话 workspace 内并防符号链接逃逸。
3. 共享库只抽逻辑不抽组件，短期两端仍有重复的展示代码；这是为避免过早抽象的取舍。
4. 文件引用分类靠扩展名启发式，可能误判无扩展名或伪装路径；未命中回退外链，保证不 regress。
5. 远端局部页面栈叠在 ChatOverlay 上，转场需与现有 `navigation.css` 协调，避免层级/裁剪问题
   （全屏浮层务必经 `Portal`）。


