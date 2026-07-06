# 日统计与费用总览设计

## 1. 背景

当前 code-lite 已经完成会话级 Token 与费用统计的第一步：

1. ACP adapter 会从 `PromptResponse.usage` 提取 `inputTokens`、`outputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`thoughtTokens` 和 `totalTokens`。
2. `usage_update` 会补充 `contextUsedTokens` 和 `contextWindowTokens`，用于上下文圆环展示。
3. `ConversationRecorder` 会把 `agent.run.completed.usage` 写入 `data/record/<conversationId>/messages.json` 的 assistant message。
4. 前端 `ui/src/features/chat/billing.ts` 当前从单个会话 messages 聚合模型 usage，再结合 `BillingPriceStore` 的 LiteLLM 价格缓存估算费用。

这套能力适合“当前会话统计”，但不适合总览页直接扫描所有会话内容。后续需要项目总计、日总计和今日曲线图时，应在 backend 完成 turn 时同步写入一份脱敏 usage 统计 ledger，避免为了统计读取完整对话内容。

## 2. 目标

1. 在每个 agent turn 完成时，把最终 usage 记录提交到 backend 内部统计写入队列，再由单 writer 串行写入按日划分的统计 JSON 文件。
2. 统计文件只包含 runtime、模型、时间、token 分项、费用估算和会话引用，不包含用户输入、assistant 输出、工具结果或命令内容。
3. 支持总览页快速展示：
   - 今日 Token 总量和费用估算。
   - 今日按模型分组的 Token 与费用。
   - 今日不同时段的 input、output、cache、thought、total 和 cost 曲线。
   - 后续项目总计、日总计、时间范围筛选。
4. 复用现有 `BillingPriceStore` 和前端会话计费算法中的价格匹配规则，避免同一模型在会话页和总览页费用口径不一致。
5. 保持 JSON 文件可读、可迁移、可通过原子写入保护，不引入数据库作为 MVP 前提。

## 3. 非目标

1. 不把费用统计作为真实账单或结算依据，只展示 code-lite 根据 runtime 自报 usage 和本地价格表估算的结果。
2. 不记录会话内容、工具输入输出、命令输出、文件 diff 或审批详情。
3. 不保证所有 runtime 都有完整分项数据。缺失字段按 0 统计，并保留 `usageSource` 和 `confidence`。
4. 不在第一阶段做云端同步、多设备合并或跨机器统一账本。
5. 不在第一阶段引入 SQLite。若 JSON 文件增长到维护困难，再单独设计迁移。

## 4. 当前现状

### 4.1 后端 usage 流

```text
ACP session/update usage_update
  -> AcpClientHandler.latest_usage
  -> agent.context.updated
  -> ConversationRecorder 合并到 assistant.usage

PromptResponse.usage
  -> extract_prompt_response_usage()
  -> agent.run.completed.usage
  -> ConversationRecorder 覆盖 assistant.usage
  -> data/record/<conversationId>/messages.json
```

关键文件：

| 文件 | 当前职责 |
| --- | --- |
| `backend/code_lite_backend/agents/acp/mapper.py` | 提取 usage 分项和 context window 数据 |
| `backend/code_lite_backend/agents/acp/adapter.py` | 在 turn 完成时发出 `agent.run.completed.usage` |
| `backend/code_lite_backend/services/conversation_recorder.py` | 折叠事件并写入会话 messages |
| `backend/code_lite_backend/services/billing_prices.py` | 下载、缓存和归一化 LiteLLM 价格表 |
| `ui/src/features/chat/billing.ts` | 会话页按模型聚合 usage 并估算费用 |

### 4.2 现状问题

1. 日总览如果扫描 `data/record/**/messages.json`，会读取完整会话内容，不符合脱敏统计目标。
2. 会话文件越多，总览页初始化越慢。
3. 总览页需要按时间段画曲线，而会话页聚合结果只适合当前会话，不适合跨会话时间序列。
4. 当前价格匹配逻辑在前端，backend 后续写统计文件时也需要同等能力，否则日统计费用和会话页费用可能不一致。
5. 多个 agent 并发运行时，多个 completed turn 可能同时命中同一天统计文件。如果每个请求直接读写 `daily/<date>.json`，容易出现读旧数据、覆盖别人写入、Windows 文件占用或短时间 PermissionError 重试风暴。

## 5. 数据目录设计

新增运行时目录：

```text
data/
  billing/
    daily/
      2026-07-06.json
      2026-07-07.json
    monthly/
      2026-07.json
    projects/
      <projectKey>.json
    indexes/
      days.json
```

第一阶段只要求落地 `billing/daily/<yyyy-MM-dd>.json`。`monthly/`、`projects/` 和 `indexes/` 可以由 daily 文件重建，后续为性能优化再增量维护。

目录职责：

| 目录 | 职责 | 第一阶段 |
| --- | --- | --- |
| `billing/daily/` | 按本地日期保存 usage 明细、日聚合、小时桶 | 必做 |
| `billing/monthly/` | 月聚合缓存，避免总览页跨多天反复扫描 | 可选 |
| `billing/projects/` | 项目维度聚合缓存 | 可选 |
| `billing/indexes/` | 可用日期、项目 key、模型 key 的轻量索引 | 可选 |

## 6. 日统计文件格式

文件名使用用户本地日期：

```text
data/billing/daily/2026-07-06.json
```

时间字段同时保存本地时间和 UTC 时间：

1. `date`：本地统计日，格式 `yyyy-MM-dd`。
2. `timezone`：例如 `Asia/Shanghai`。
3. `timestamp`：本地毫秒时间戳，用于前端直接排序和画图。
4. `createdAtIso`：UTC ISO 字符串，用于跨时区调试。

示例：

```json
{
  "schemaVersion": 1,
  "date": "2026-07-06",
  "timezone": "Asia/Shanghai",
  "updatedAt": 1783334400123,
  "currency": "USD",
  "totals": {
    "turns": 12,
    "inputTokens": 12000,
    "outputTokens": 3500,
    "cachedReadTokens": 42000,
    "cachedWriteTokens": 6000,
    "thoughtTokens": 800,
    "totalTokens": 64300,
    "estimatedCostUsd": 0.1384,
    "unknownCostTurns": 1
  },
  "models": {
    "codex:gpt-5.5[xhigh]": {
      "runtime": "codex",
      "modelId": "gpt-5.5[xhigh]",
      "modelLabel": "gpt-5.5[xhigh]",
      "turns": 10,
      "inputTokens": 10000,
      "outputTokens": 3000,
      "cachedReadTokens": 40000,
      "cachedWriteTokens": 6000,
      "thoughtTokens": 800,
      "totalTokens": 59800,
      "estimatedCostUsd": 0.126,
      "priceModelId": "gpt-5.5",
      "unknownCostTurns": 0
    }
  },
  "hours": {
    "09": {
      "turns": 3,
      "inputTokens": 3200,
      "outputTokens": 900,
      "cachedReadTokens": 12000,
      "cachedWriteTokens": 2000,
      "thoughtTokens": 120,
      "totalTokens": 18220,
      "estimatedCostUsd": 0.041
    }
  },
  "entries": [
    {
      "id": "usage_1783334400123_turn_abc",
      "timestamp": 1783334400123,
      "createdAtIso": "2026-07-06T01:20:00.123Z",
      "localDate": "2026-07-06",
      "localHour": "09",
      "conversationId": "20260706-091955-a1b2c3d4e5f6g7h8",
      "turnId": "turn_abc",
      "workspaceKey": "sha256:...",
      "workspaceLabel": "code-lite",
      "runtime": "codex",
      "agentId": "codex",
      "modelId": "gpt-5.5[xhigh]",
      "modelLabel": "gpt-5.5[xhigh]",
      "modelCandidates": ["gpt-5.5[xhigh]", "gpt-5.5"],
      "usage": {
        "inputTokens": 1000,
        "outputTokens": 300,
        "cachedReadTokens": 4000,
        "cachedWriteTokens": 600,
        "thoughtTokens": 80,
        "totalTokens": 5980,
        "contextUsedTokens": 72000,
        "contextWindowTokens": 258400,
        "source": "acp.prompt_response.usage"
      },
      "cost": {
        "currency": "USD",
        "estimatedCostUsd": 0.0126,
        "inputCostUsd": 0.001,
        "outputCostUsd": 0.006,
        "cachedReadCostUsd": 0.003,
        "cachedWriteCostUsd": 0.002,
        "thoughtCostUsd": 0.0006,
        "priceModelId": "gpt-5.5",
        "priceSource": "litellm",
        "priceStale": false,
        "matched": true
      },
      "confidence": "measured"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `entries` | 脱敏 usage 明细，一条完成的 assistant turn 对应一条记录 |
| `totals` | 当前日全量聚合，写入时同步增量更新 |
| `models` | 当前日按 `runtime:modelId` 聚合 |
| `hours` | 当前日按本地小时聚合，供今日曲线快速渲染 |
| `workspaceKey` | 对 workspace 绝对路径做哈希，避免在统计文件里暴露完整本地路径 |
| `workspaceLabel` | 可展示名称，优先取项目目录名，不含绝对路径 |
| `conversationId` | 允许点击跳回会话，但不保存内容 |
| `confidence` | `measured` 表示来自 runtime 自报分项，`partial` 表示只有 context usage，`estimated` 保留给后续估算 |

## 7. 写入时机与去重

### 7.1 写入时机

推荐在 `/api/turns/stream` 收到 `agent.run.completed` 并完成 `ConversationRecorder.apply_agent_event()` 后，把 usage 统计提交给内存队列，而不是直接写日统计文件：

```text
agent.run.completed
  -> ConversationRecorder 保存 assistant usage
  -> BillingUsageRecorder.enqueue_turn_usage(...)
  -> BillingUsageWriter worker 串行 flush
  -> data/billing/daily/<date>.json 原子替换
```

这样可以保证：

1. 只统计成功完成的 turn。
2. 使用最终 usage，而不是中间 `agent.context.updated` 快照。
3. 与会话 messages 中的 usage 保持同源。

失败 turn 第一阶段不计入 `totals`。如 runtime 在失败时也返回了可靠 usage，后续可增加 `status: failed` entry，并在 UI 中单独展示。

### 7.2 队列与单 writer

统计写入必须采用“多 producer、单 consumer”的队列模型：

```text
Agent turn A completed ┐
Agent turn B completed ├─ enqueue(BillingUsageWriteTask) ──> asyncio.Queue
Agent turn C completed ┘                                      |
                                                               v
                                                     BillingUsageWriter
                                                     - 合并同日 pending tasks
                                                     - 读 daily JSON
                                                     - 幂等 upsert entries
                                                     - 重算 totals/models/hours
                                                     - atomic replace
```

设计原则：

1. API 请求线程或 stream coroutine 只做轻量 `enqueue`，不阻塞等待同日 JSON 写完。
2. 后端进程内只有一个 `BillingUsageWriter` 持有 daily 文件写权限，避免多个 agent 同时写同一个文件。
3. worker 可按日批处理，例如同一 event loop tick 或 200ms debounce 内的同一天任务合并成一次 flush。
4. 写入 daily JSON 时仍使用临时文件加原子替换；遇到 `PermissionError` 做短退避重试。
5. worker 写入失败时不影响 agent turn 完成响应，但需要记录 warning，并将失败任务放入内存重试队列。
6. backend 正常关闭时应 drain 队列，最长等待一个较短超时，例如 3 秒；超时后记录未写入数量。

第一阶段不要求跨进程并发安全。Tauri 正常只启动一个 backend sidecar；如果未来允许多个 backend 进程共享同一个 data 目录，需要再引入跨进程文件锁或迁移 SQLite。

### 7.3 幂等去重

entry id 使用稳定组合：

```text
<conversationId>:<turnId>:<assistantMessageId>
```

写入时如同一个 id 已存在，则先从聚合中扣除旧值，再写入新值，保证重试、刷新或重复 completed 事件不会重复计数。

为降低增量扣减复杂度，worker 第一阶段可以采用更稳妥的“upsert entries 后重算聚合”：

1. 读取当前 daily 文件。
2. 用 entry id 覆盖同 id 旧 entry。
3. 根据完整 `entries` 重新生成 `totals`、`models` 和 `hours`。
4. 原子替换写回。

日文件规模可控时，重算比增量扣减更不容易出错。后续如果 entries 很大，再改为增量聚合缓存。

## 8. Backend 服务设计

新增服务：

```text
backend/code_lite_backend/services/
  billing_usage.py
```

建议类：

```python
class BillingUsageRecorder:
    def __init__(self, billing_dir: Path, price_store: BillingPriceStore) -> None: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def enqueue_turn_usage(self, entry: BillingUsageEntry) -> None: ...
    def get_daily_summary(self, date: str) -> dict[str, Any]: ...
    def get_range_summary(self, start_date: str, end_date: str) -> dict[str, Any]: ...
```

内部建议拆分：

```python
class BillingUsageWriter:
    def enqueue(self, task: BillingUsageWriteTask) -> None: ...
    async def run(self) -> None: ...
    async def drain(self, timeout: float = 3.0) -> None: ...
```

新增职责：

1. 归一化 usage 数字字段，缺失值转 0。
2. 归一化模型候选 key，并调用价格匹配。
3. 将 turn usage 封装为 `BillingUsageWriteTask` 并入队。
4. 由单 writer 串行 flush，使用临时文件加原子替换写 JSON。
5. 维护 daily 文件中的 `entries`、`totals`、`models` 和 `hours`。
6. 提供只读查询给总览 API。

### 8.1 队列实现细节

推荐使用 `asyncio.Queue[BillingUsageWriteTask]`：

```python
@dataclass(frozen=True)
class BillingUsageWriteTask:
    entry_id: str
    local_date: str
    entry: dict[str, Any]
    enqueued_at_ms: int
    attempt: int = 0
```

worker flush 流程：

```text
while running:
  task = await queue.get()
  batch = [task] + drain_available_tasks(max_items=100, max_wait_ms=200)
  groups = group_by(local_date, batch)
  for date, tasks in groups:
    daily = read_daily(date)
    upsert entries by id
    rebuild totals/models/hours
    atomic_write_json(daily_path, daily)
```

注意事项：

1. `enqueue_turn_usage()` 应为非阻塞方法，队列满时记录 warning。MVP 可使用无界队列，后续改成有界队列并暴露健康状态。
2. 同一 date 的任务必须按入队顺序处理，但不同 date 可以先保持串行，避免第一阶段复杂化。
3. 查询 API 只读已落盘文件，不直接读取 pending queue。若需要更实时，可以在第二阶段维护内存 projection。
4. worker 内部不要保存会话正文，只传脱敏 entry。
5. 价格匹配建议在 enqueue 前完成，这样 worker 只负责文件聚合；如果价格表刷新失败，entry 中记录 `priceStale` 或 `matched=false`。

### 8.2 价格匹配

后端需要把 `ui/src/features/chat/billing.ts` 中的模型候选和匹配规则迁移或复刻到 Python：

1. 原始 `modelId`。
2. 去掉 provider 前缀后的模型名。
3. 去掉 Codex bracket effort 后的模型名。
4. 同时做大小写、分隔符归一化匹配。

费用计算口径：

```text
inputCostUsd = inputTokens * inputCostPerToken
outputCostUsd = outputTokens * outputCostPerToken
thoughtCostUsd = thoughtTokens * outputCostPerToken
cachedReadCostUsd = cachedReadTokens * (cachedReadCostPerToken or inputCostPerToken)
cachedWriteCostUsd = cachedWriteTokens * (cachedWriteCostPerToken or inputCostPerToken)
```

若价格表未命中：

1. `cost.matched = false`。
2. `estimatedCostUsd = 0`。
3. `unknownCostTurns += 1`。
4. UI 展示“价格未知，未计入费用”。

## 9. API 设计

新增路由：

```text
GET /api/billing/usage/today
GET /api/billing/usage/daily?date=2026-07-06
GET /api/billing/usage/range?start=2026-07-01&end=2026-07-06
```

第一阶段返回 daily 文件裁剪后的视图：

```json
{
  "date": "2026-07-06",
  "timezone": "Asia/Shanghai",
  "currency": "USD",
  "totals": {},
  "models": [],
  "series": [
    {
      "bucket": "09:00",
      "inputTokens": 3200,
      "outputTokens": 900,
      "cachedReadTokens": 12000,
      "cachedWriteTokens": 2000,
      "thoughtTokens": 120,
      "totalTokens": 18220,
      "estimatedCostUsd": 0.041
    }
  ],
  "recentEntries": []
}
```

API 不默认返回完整 `entries`。总览页只需要 `totals`、`models`、`series` 和少量 `recentEntries`。如未来需要审计明细，再增加分页接口。

## 10. 前端总览页设计

后续可以新增或扩展 overview 页面：

```text
ui/src/pages/OverviewPage.tsx
ui/src/features/billing/
  BillingOverview.tsx
  BillingTrendChart.tsx
  ModelUsageTable.tsx
  billingUsageClient.ts
```

主要模块：

1. 顶部摘要：今日总 Token、今日估算费用、今日 turn 数、价格未知模型数。
2. 模型分布：按模型展示 input、output、cache read、cache write、thought、total、费用。
3. 今日曲线：按小时展示 input/output/cache/费用，可切换指标。
4. 最近使用：展示时间、runtime、模型、token、费用、会话跳转入口。

UI 文案需要明确“估算费用”，避免用户误解为供应商账单。

## 11. 隐私与安全边界

统计文件禁止写入：

1. 用户输入内容。
2. assistant 回复内容。
3. reasoning 内容。
4. tool arguments 和 tool result。
5. command 文本和输出。
6. 文件路径 diff 和文件内容。
7. API Key、Token、账号密码或私钥。

workspace 只保存：

1. `workspaceKey`：绝对路径的哈希。
2. `workspaceLabel`：目录名或用户自定义项目名。

如用户清理会话记录，第一阶段不自动删除历史 billing entry，因为费用统计是独立账本。后续可以在设置页提供“清理统计数据”入口。

## 12. 实施阶段

### Phase 1：后端日统计账本

1. 在 `RuntimeConfig` 中新增 `billing_dir`，启动时创建 `data/billing/daily`。
2. 新增 `BillingUsageRecorder` 和 `BillingUsageWriter`，采用 `asyncio.Queue` 单 writer 串行落盘。
3. 在 turn completed 路径中调用 `enqueue_turn_usage()`，不在 stream coroutine 中直接写 daily JSON。
4. 将前端价格匹配逻辑迁移到 Python，复用 `BillingPriceStore` 的价格缓存。
5. 为 writer 添加单元测试，覆盖正常写入、并发 enqueue、重复 turn 去重、价格未知、字段缺失和 PermissionError 重试。

### Phase 2：统计查询 API

1. 新增 `/api/billing/usage/today` 和 `/api/billing/usage/daily`。
2. 返回总览页需要的 `totals`、`models`、`series` 和 `recentEntries`。
3. 对缺失文件返回空统计，不返回 404。

### Phase 3：总览页 UI

1. 新增 billing usage client。
2. 实现今日摘要、模型分布和小时曲线。
3. 保留“估算费用”和“价格未知”提示。
4. 后续再接项目筛选和时间范围筛选。

### Phase 4：项目总计与范围查询

1. 根据 `workspaceKey` 聚合项目维度。
2. 支持日、周、月和自定义范围。
3. 如 daily 文件较多，再引入 `monthly/` 和 `projects/` 缓存。

## 13. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| runtime usage 不完整 | 某些模型只有 context used，没有 input/output 分项 | 记录 `confidence=partial`，UI 单独提示 |
| 价格表未命中 | 费用低估 | unknown cost 不计入总费用，并展示数量 |
| 多 agent 同时写入 | 文件覆盖或 Windows 文件占用 | 所有 turn 只入队，由单 writer 串行 flush |
| JSON 文件重复写入 | 统计重复 | 使用稳定 entry id，upsert entries 后重算聚合 |
| 文件写坏 | 总览不可读 | 临时文件加原子替换，读取失败返回空统计并记录日志 |
| backend 异常退出 | 队列中少量统计未落盘 | 正常关闭 drain 队列，异常退出可接受少量统计丢失，后续可由 messages.json 重建 |
| 日文件过大 | 总览变慢 | 后续引入 monthly/project 聚合缓存或 SQLite 迁移 |
| 时区切换 | 日归属变化 | 统计按写入时本地日期归档，entry 保留 UTC ISO 方便追踪 |

## 14. 验收标准

1. 完成一次 Codex 或 ACP turn 后，`data/billing/daily/<today>.json` 自动创建或更新。
2. 日统计 entry 只包含 usage、模型、runtime、时间、会话引用和费用估算，不包含任何会话正文。
3. 并发完成多个 agent turn 时，所有统计先进入队列，并由单 writer 串行写入 daily JSON。
4. 同一个 turn 重复写入不会重复增加 totals。
5. 价格命中时能计算 input/output/cache/thought 分项费用。
6. 价格未命中时 token 仍计入总量，费用显示为未知且不计入总费用。
7. `/api/billing/usage/today` 能返回今日总量、模型分组和小时序列。
8. 总览页能展示今日 Token 总量、模型使用量和曲线图。

## 15. 待确认问题

1. 项目总计按 workspace 绝对路径哈希聚合，还是需要用户手动命名项目后再聚合？
2. 日统计以本地时区为准是否足够，是否需要用户在设置中选择统计时区？
3. 失败 turn 如果返回 usage，是否要计入费用总量？
4. 清理会话记录时，是否默认保留、同步删除或提示用户选择 billing 统计？
5. 是否需要为不同供应商维护用户自定义价格覆盖表，优先级高于 LiteLLM 价格表？
6. backend 异常退出后，是否需要提供从 `messages.json` 扫描重建 billing daily 文件的修复命令？
