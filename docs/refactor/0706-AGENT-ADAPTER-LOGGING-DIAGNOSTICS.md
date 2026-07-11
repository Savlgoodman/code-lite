# Agent Adapter、日志与诊断重构方案

创建日期：2026-07-06

本文记录下一阶段对 code-lite agent adapter 层、日志系统、错误诊断和设置页日志查看的重构方案。目标是在功能不退化的前提下，把 Codex、Claude Code、opencode 的专属逻辑归位到 runtime descriptor / profile，把 ACP 链路、接口请求、Python 内部运行和 runtime stderr 的日志统一落盘并可在 UI 中查看，同时补齐 ACP 链路后的错误上下文。

## 1. 背景

当前代码已经从早期 Codex 专属 adapter 迁移到通用 ACP adapter 主线：

```text
React UI
  -> FastAPI /api/sessions/{id}/initialize
  -> FastAPI /api/turns/stream
  -> AgentRouterAdapter
  -> AcpAgentAdapter
  -> RuntimeDescriptor
  -> AcpRuntimeManager
  -> codex-acp / claude-agent-acp / opencode acp
```

已落地的关键模块：

| 路径 | 现状 |
| --- | --- |
| `backend/code_lite_backend/agents/acp/adapter.py` | 当前 ACP 主线 adapter |
| `backend/code_lite_backend/agents/acp/runtime_manager.py` | 常驻 ACP 连接和 native session 绑定 |
| `backend/code_lite_backend/agents/acp/client.py` | ACP client handler，接收 update 和 permission request |
| `backend/code_lite_backend/agents/acp/mapper.py` | ACP update 到 `AgentEvent` 的映射 |
| `backend/code_lite_backend/agents/runtimes/descriptors.py` | Codex / Claude Code / opencode descriptor |
| `backend/code_lite_backend/agents/runtimes/profiles.py` | Codex / Claude Code / opencode runtime profile |
| `backend/code_lite_backend/agents/codex/adapter.py` | 已删除，Codex 不再维护独立 adapter |
| `backend/code_lite_backend/agents/claude_code/adapter.py` | 已删除，Claude Code 不再维护 placeholder adapter |

当前 Codex、Claude Code、opencode 均通过 `AcpAgentAdapter` + `RuntimeProfile` 进入 ACP 主线，不再存在独立 Codex / Claude Code adapter 入口。

## 2. 当前问题

### 2.1 Adapter 职责仍未完全归位

虽然已经有 `AcpAgentAdapter` 和 `RuntimeDescriptor`，但通用 adapter 中仍存在 runtime 专属分支：

1. `_resolve_command()` 中直接判断 `codex`、`claude_code`。
2. `_resolve_env()` 中直接拼 Codex / Claude Code 环境变量。
3. `_resolve_mode()` 中直接包含 Codex / Claude Code mode 规则。
4. `_configure_session()` 中直接判断 Claude Code 的 `model` 和 `effort` 配置项。
5. `AgentRuntimeConfigStore` 中仍有大量 Codex 专属方法，例如 `codex_command()`、`codex_env()`、`codex_mode()`。

这些逻辑不应该留在通用 adapter 中。通用 adapter 应只负责 ACP 共性流程：连接、session、配置应用、prompt、取消、事件输出。runtime 差异应移动到 descriptor / profile。

### 2.2 日志链路可用但不可治理

当前已有日志能力：

1. Tauri 启动 backend 时创建 `data/logs/backend-*.log`。
2. backend `--log-file` 会将 stdout / stderr 重定向到文件。
3. Python logger 输出到 stdout。
4. ACP runtime stderr 被 ring buffer 保存到 handler / connection。
5. Codex / Claude Code 通过 `APP_SERVER_LOGS` 可让 runtime 写自己的日志目录。

但问题是：

1. API 请求、ACP 生命周期、Python 内部任务、runtime stderr 混在同一个 backend 文本日志中。
2. 日志没有统一结构，难以按 conversation、turn、runtime、stage、level 过滤。
3. ACP stderr 只在错误时拼接进前端错误字符串，平时不可检索。
4. 设置页只能看到 data 目录信息，不能直接查看日志。
5. 用户描述的“ACP 链路之后很多报错获取失效”很可能来自错误上下文分散在 logger、stderr、SDK exception、前端 event 之间。

### 2.3 错误信息缺少结构化上下文

当前 `agent.run.failed` 多数只携带 `error: string`。这对用户可读，但对排查不足：

1. 不知道失败阶段是 spawn、initialize、session/new、session/load、set mode、set model、prompt、permission 还是 stream parse。
2. 不知道 runtime、command source、native session、process pid、return code。
3. 不知道最近 stderr、SDK RequestError payload、JSON-RPC method。
4. 部分配置失败只写 warning，不会形成前端可见诊断。
5. 前端无法展示“简洁错误 + 详情展开 + 复制诊断”的层次。

## 3. 目标

1. 保持现有 Codex / Claude Code / nanobot 主功能不退化。
2. 明确 `agents/codex/adapter.py` 为 legacy，停止扩展，最终删除。
3. 让 `AcpAgentAdapter` 只承载 ACP 共性流程，不包含 Codex / Claude Code 的专属判断。
4. 将 runtime 差异归位到 `RuntimeDescriptor`、`RuntimeProfile` 或等价结构。
5. 重构日志为结构化、多分类、可落盘、可查询、可在设置页查看。
6. 将 ACP 链路错误统一成结构化 `DiagnosticError`，同时写日志、写事件、返回前端。
7. 保留文本日志兼容，方便用户直接打开文件排查。

## 4. 非目标

1. 本轮不实现 gateway mode 的强权限拦截。
2. 本轮不改变 ACP Python SDK 版本和外部协议。
3. 本轮不要求把日志迁移到数据库，MVP 仍使用文件。
4. 本轮不把 nanobot 改造成 ACP server。
5. 本轮不引入云端日志上传，所有日志默认留在本机 data 目录。

## 5. 目标架构

### 5.1 Adapter 目标结构

```text
backend/code_lite_backend/agents/
  registry.py
  router.py
  acp/
    adapter.py              # ACP 共性流程
    client.py               # ACP client handler
    mapper.py               # ACP update -> AgentEvent
    runtime_manager.py      # ACP process/session 生命周期
    diagnostics.py          # ACP stage/error capture
  runtimes/
    descriptors.py          # runtime 注册入口
    profile.py              # RuntimeProfile 协议
    codex.py                # Codex command/env/session config/profile
    claude_code.py          # Claude Code command/env/session config/profile
    opencode.py             # opencode command/env/session config/profile
  nanobot/
    adapter.py              # legacy adapter
```

核心边界：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `AcpAgentAdapter` | 调用 profile，执行 ACP 通用 turn 生命周期 | 判断 Codex / Claude Code 细节 |
| `AcpRuntimeManager` | spawn、initialize、session load/new、连接复用、stderr tail | 解释模型、mode、reasoning 语义 |
| `RuntimeProfile` | command、env、mode、model、config option 应用策略 | 直接写前端事件 |
| `AcpEventMapper` | ACP update 到统一事件 | 启动进程、读配置 |
| `DiagnosticLogger` | 结构化日志和错误上下文 | 改变业务流程 |

### 5.2 RuntimeProfile 草案

```python
class RuntimeProfile(Protocol):
    descriptor: RuntimeDescriptor

    def resolve_command(self, store: AgentRuntimeConfigStore) -> list[str]:
        ...

    def build_env(
        self,
        store: AgentRuntimeConfigStore,
        runtime_config: RuntimeConfig,
    ) -> dict[str, str]:
        ...

    def resolve_mode(self, requested_mode: str | None) -> str | None:
        ...

    async def apply_turn_config(
        self,
        *,
        conn: Any,
        session_id: str,
        request: AgentRunRequest,
        diagnostics: DiagnosticLogger,
    ) -> None:
        ...
```

`AcpAgentAdapter` 的目标流程：

```text
profile = runtime_profile_registry.get(self.name)
command = profile.resolve_command(config_store)
env = profile.build_env(config_store, runtime_config)
connection = runtime_manager.ensure_connection(...)
binding = runtime_manager.ensure_session(...)
await profile.apply_turn_config(conn, binding.native_session_id, request, diagnostics)
prompt_result = await conn.prompt(...)
```

这样新增 runtime 时只增加 profile 和 descriptor，不再编辑通用 adapter。

## 6. 日志系统设计

### 6.1 分类

日志分类建议使用稳定 category，而不是只靠颜色：

| category | 含义 | 控制台颜色 | UI 颜色建议 |
| --- | --- | --- | --- |
| `api` | HTTP API 请求、响应、参数摘要 | 沿用当前默认色 | 沿用当前默认色 |
| `acp` | ACP spawn、initialize、session、prompt、permission、JSON-RPC 阶段 | 青色 | 蓝绿色 |
| `python` | backend 内部任务、存储、billing、配置、启动关闭 | 蓝色 | 蓝色 |
| `runtime.stderr` | codex-acp / claude-agent-acp / opencode 的 stderr | 浅红色 | 红色弱化 |
| `diagnostic` | 结构化错误诊断 | 浅红色 | 深红色 |
| `tauri` | Tauri sidecar 启动、停止、复用 backend | 默认色 | 默认色 |
| `ui` | 前端捕获的可诊断错误，后续可选 | 默认色 | 默认色 |
| `audit` | 审批、远程操作、权限相关审计 | 默认色 | 高对比色 |

颜色只用于控制台和 UI 展示，不写入 JSONL 日志文件。backend 使用 `--log-file` 写文本文件时也默认关闭 ANSI 颜色，避免日志文件出现转义码。

### 6.2 文件布局

开发环境：

```text
data/logs/
  current/
    backend.log
    api.jsonl
    acp.jsonl
    python.jsonl
    runtime-stderr.jsonl
    diagnostics.jsonl
  archive/
    20260706-153012/
      backend.log
      api.jsonl
      acp.jsonl
      python.jsonl
      runtime-stderr.jsonl
      diagnostics.jsonl
```

安装环境：

```text
%USERPROFILE%\.code-lite\logs\
  current\
  archive\
```

保留 `backend-*.log` 兼容路径一段时间。新实现可以先写新文件，同时继续让 Tauri 捕获 stdout / stderr 到旧 backend log。

### 6.3 结构化日志格式

JSONL 每行一个对象：

```json
{
  "id": "log_...",
  "timestamp": "2026-07-06T12:00:00.000Z",
  "level": "info",
  "category": "acp",
  "source": "code_lite_backend.agents.acp.runtime_manager",
  "runtime": "codex",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "nativeSessionId": "019f...",
  "stage": "initialize",
  "message": "ACP initialize completed.",
  "fields": {
    "pid": 1234,
    "commandSource": "managed-npm"
  }
}
```

敏感信息规则：

1. 不记录 API key、token、账号密码、私钥。
2. command 可以记录 argv，但需要过滤包含 key、token、password、secret 的参数值。
3. env 默认只记录 key 名，不记录 value。
4. 用户 prompt 不默认写入结构化日志；如需要，只写长度和前 80 字摘要，并在设置中可关闭。
5. runtime raw payload 默认只写 diagnostic 文件，并做大小限制。

### 6.4 Python logging 集成

建议新增：

```text
backend/code_lite_backend/core/logging.py
```

职责：

1. 配置 root logger。
2. 增加 category filter / formatter。
3. 同时输出 human log 和 JSONL。
4. 提供 `get_logger(__name__, category="python")` 或 logging extra 约定。
5. 提供 `DiagnosticLogger`，便于 ACP 链路按 stage 记录。

示例：

```python
logger.info(
    "ACP initialize completed",
    extra={
        "category": "acp",
        "runtime": descriptor.id,
        "conversationId": conversation_id,
        "stage": "initialize",
    },
)
```

## 7. 诊断错误设计

### 7.1 DiagnosticError 格式

```python
@dataclass
class DiagnosticError:
    code: str
    message: str
    category: str
    stage: str
    runtime: str | None = None
    conversation_id: str | None = None
    turn_id: str | None = None
    native_session_id: str | None = None
    retryable: bool = False
    user_action: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
```

前端事件：

```json
{
  "type": "agent.run.failed",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "error": "Codex ACP 初始化失败。",
  "diagnostic": {
    "code": "acp.initialize_failed",
    "category": "acp",
    "stage": "initialize",
    "runtime": "codex",
    "retryable": true,
    "userAction": "请检查 Codex ACP 安装和登录状态。",
    "details": {
      "stderrTail": ["..."],
      "commandSource": "managed-npm"
    }
  }
}
```

### 7.2 推荐错误码

| code | stage | 含义 |
| --- | --- | --- |
| `acp.command_not_found` | `spawn` | ACP 命令不存在 |
| `acp.spawn_failed` | `spawn` | 子进程启动失败 |
| `acp.initialize_timeout` | `initialize` | initialize 超时 |
| `acp.initialize_failed` | `initialize` | initialize 返回错误 |
| `acp.session_new_failed` | `session.new` | 创建 native session 失败 |
| `acp.session_load_failed` | `session.load` | 恢复 native session 失败 |
| `acp.configure_mode_failed` | `configure.mode` | 设置 mode 失败 |
| `acp.configure_model_failed` | `configure.model` | 设置模型失败 |
| `acp.configure_option_failed` | `configure.option` | 设置 config option 失败 |
| `acp.prompt_failed` | `prompt` | prompt 调用失败 |
| `acp.permission_failed` | `permission` | 审批回传失败 |
| `acp.process_exited` | `process` | runtime 进程提前退出 |
| `api.bad_request` | `api` | 接口参数错误 |
| `storage.write_failed` | `storage` | 会话或事件写入失败 |

配置类 warning 是否升级为前端可见，需要按影响决定：

1. mode/model 设置失败但 prompt 可继续：写 `agent.diagnostic` 可选事件，不中断。
2. prompt 无法继续：写 `agent.run.failed`。
3. session/load 失败但 session/new 成功：写 warning，不中断。

## 8. 设置页日志查看设计

### 8.1 API

新增 routes 建议：

```text
GET /api/logs
GET /api/logs/files
GET /api/logs/tail?category=acp&limit=500
GET /api/logs/search?level=error&runtime=codex&conversationId=...
GET /api/logs/diagnostics/{conversation_id}
POST /api/logs/archive
POST /api/logs/clear
```

MVP 可以只做：

1. `GET /api/logs/files`：列出当前日志文件和大小。
2. `GET /api/logs/tail`：读取最后 N 行，支持 category。
3. `GET /api/logs/diagnostics/{conversation_id}`：返回该会话最近错误。

### 8.2 前端

设置页新增菜单项：

```text
设置
  Agent Runtime
  模型提供商配置
  日志
  归档会话
  关于
```

日志页能力：

1. category tabs：全部、ACP、API、Python、Runtime stderr、诊断。
2. level filter：error、warning、info、debug。
3. runtime filter：Codex、Claude Code、opencode、nanobot。
4. 搜索框：按 conversationId、turnId、stage、关键字过滤。
5. 日志详情展开：显示 fields、stderrTail、diagnostic details。
6. 复制诊断摘要。
7. 打开日志目录或显示路径。

MVP 不需要实时 WebSocket，可用刷新按钮和 tail API。

## 9. 实施阶段

### 阶段 1：文档和边界确认

目标：

1. 明确旧 `agents/codex/adapter.py` 不再扩展。
2. 明确通用 ACP adapter + runtime profile 为主线。
3. 固化日志 category、文件目录和错误码草案。

验收：

1. 本文档纳入 `docs/README.md`。
2. `AGENTS.md` 的阅读入口包含本文档。

### 阶段 2：Adapter 归位

目标：

1. 新增 `RuntimeProfile`。
2. 将 command/env/mode/model/reasoning/config option 从 `AcpAgentAdapter` 移入 profile。
3. `AcpAgentAdapter` 不再出现 `if self.name == "codex"` / `claude_code`。
4. `AgentRuntimeConfigStore` 中 Codex 专属方法逐步收敛为 runtime 通用方法或移动到 Codex profile。
5. 标记 `agents/codex/adapter.py` 为 legacy，确认无引用后删除。

实现状态：

1. 已新增 `backend/code_lite_backend/agents/runtimes/profiles.py`。
2. `AcpAgentAdapter` 的 command / env / mode / model / reasoning 配置已移动到 runtime profile。
3. `agents/codex/adapter.py`、`agents/codex/__init__.py`、`agents/claude_code/adapter.py`、`agents/claude_code/__init__.py` 已删除。
4. `registry.py` 和 `router.py` 已改为统一从 descriptor registry 创建 ACP adapter。

建议验证：

```powershell
uv run --project backend pytest
uv run --project backend python -m code_lite_backend.main --help
```

如本机有对应 runtime，再做 Codex / Claude Code initialize smoke。

### 阶段 3：结构化日志

目标：

1. 新增 logging 配置模块。
2. 输出 `api.jsonl`、`acp.jsonl`、`python.jsonl`、`runtime-stderr.jsonl`、`diagnostics.jsonl`。
3. ACP stderr tail 同时写 ring buffer 和 `runtime-stderr.jsonl`。
4. 保留旧 backend 文本日志兼容。

实现状态：

1. 已新增 `backend/code_lite_backend/core/structured_logging.py`。
2. backend 启动时会在 `data/logs/current/` 下写入分类 JSONL 日志。
3. `runtime.stderr` 会同时保留 ring buffer，并写入 `runtime-stderr.jsonl`。
4. 旧 `--log-file` 文本日志仍保留。
5. 控制台输出已按 category 上色：ACP 青色、runtime stderr / diagnostic 浅红、Python 蓝色、API 默认色。`CODE_LITE_LOG_COLOR=always` 可强制开启，`CODE_LITE_LOG_COLOR=never` 或 `NO_COLOR=1` 可关闭。

建议验证：

1. 启动 backend 后 `data/logs/current/` 自动创建。
2. 调用 `/api/health` 生成 api 日志。
3. 初始化 Codex session 生成 acp 日志。
4. runtime stderr 可以从文件看到，但不泄露敏感 env value。

### 阶段 4：诊断错误

目标：

1. 新增 `DiagnosticError` 和 helper。
2. spawn / initialize / session / configure / prompt 各阶段捕获并写诊断。
3. `agent.run.failed` 附带 `diagnostic`。
4. 配置失败等非致命问题通过 `agent.diagnostic` 可选事件输出。

实现状态：

1. `DiagnosticError` 已落地在结构化日志模块。
2. turn prompt 失败、ACP command 不存在、session initialize 失败、runtime model probe 失败会写入 `diagnostics.jsonl`。
3. `agent.run.failed` 和 session initialize HTTP 错误会附带 `diagnostic`。
4. configure mode / model / reasoning 的非致命失败当前作为 ACP warning 日志记录。

建议验证：

1. 配置不存在的 ACP command，前端收到 `acp.command_not_found`。
2. initialize timeout 时日志包含 stderr tail 和 command source。
3. session/load 失败但 fallback 成功时只出现 warning，不中断 turn。

### 阶段 5：设置页日志查看

目标：

1. backend 增加 logs API。
2. 设置页新增“日志”栏目。
3. 支持 tail、filter、详情展开、复制诊断摘要。

实现状态：

1. 已新增 `/api/logs/files`、`/api/logs/tail`、`/api/logs/diagnostics/{conversation_id}`。
2. 设置页已新增“日志”栏目，可刷新、按 category / level / query 过滤、展开 JSON 详情。
3. MVP 暂未加入复制诊断摘要按钮，详情 JSON 已可直接查看。
4. UI 日志颜色约定已落地：ACP 蓝绿色、runtime stderr 浅红、API 中性灰、Python 蓝色、diagnostic 深红。

建议验证：

```powershell
npm run ui:build
uv run --project backend python -m code_lite_backend.main --help
```

手工验证：

1. 设置页能查看 ACP/API/Python/runtime stderr 日志。
2. 错误详情可展开。
3. 没有日志文件时显示空状态而不是报错。

### 阶段 6：清理与收口

目标：

1. 删除 legacy `agents/codex/adapter.py` 和 `agents/codex/__init__.py`，或保留空兼容入口并注明废弃。
2. 更新旧文档中“同步修改 Codex adapter”的描述，避免误导。
3. 补充测试和 smoke README。

## 10. 兼容策略

1. `AcpAgentAdapter` 重构时保持现有 `AgentRunRequest` 字段兼容。
2. 结构化日志新增文件，不立即移除旧 backend log。
3. `agent.run.failed.error` 仍保留字符串，`diagnostic` 作为新增字段。
4. 设置页日志 API 只读取 data logs，不访问 workspace 任意路径。
5. 旧会话没有 diagnostic 数据时，UI 隐藏详情入口。

## 11. 回滚点

| 阶段 | 回滚方式 |
| --- | --- |
| Adapter 归位 | 保留旧 `AcpAgentAdapter` 流程，profile 先只包装现有逻辑 |
| 结构化日志 | 保留 stdout/backend log，关闭 JSONL handler 不影响功能 |
| 诊断错误 | 前端继续读取 `error` 字符串，忽略 `diagnostic` |
| 设置页日志 | 日志 API 和 UI 可独立移除，不影响 chat 主流程 |

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| profile 抽取时改变 Codex 行为 | Codex 对话、mode、model 配置异常 | 先写行为对照表和 smoke，再删除旧代码 |
| Claude Code 的 config option 仍有未验证差异 | 模型或 effort 设置失败 | profile 中按 capabilities 判断，失败降级为 warning |
| 日志过大 | 长会话占用磁盘 | tail 限制、单文件大小限制、archive/clear |
| 日志泄露敏感信息 | 安全风险 | 默认脱敏 env、headers、token-like 字段 |
| 过多诊断事件打扰用户 | UI 噪音 | fatal 才展示错误卡，warning 放详情或日志页 |

## 13. 验收标准

1. `AcpAgentAdapter` 不包含 Codex / Claude Code 专属分支。
2. Codex 通过通用 ACP profile 可以完成 initialize、session、prompt、usage、approval。
3. Claude Code 通过通用 ACP profile 可以完成 initialize、session、prompt，未验证能力有清晰 caveat。
4. `agents/codex/adapter.py` 不再存在，或明确标记 legacy 且无主流程引用。
5. `data/logs/current/` 有分类日志文件。
6. ACP 失败时前端收到结构化 `diagnostic`，日志中可查同一 `turnId`。
7. 设置页能查看日志 tail，并按 category / level 过滤。
8. `npm run ui:build` 和 backend 基础检查通过。

## 14. 当前结论

本轮不应推倒重写 adapter，而应顺着已经落地的通用 ACP 骨架继续收敛：

1. `agents/codex/adapter.py` 是迁移遗留，不再作为 Codex 主线。
2. Codex、Claude Code、opencode 的专属行为应归位到 runtime profile。
3. 日志和诊断应作为独立基础设施重构，避免继续把 stderr 和 exception 拼进单一错误字符串。
4. 设置页日志查看依赖结构化日志和 logs API，应放在日志落盘之后实现。

## 15. 2026-07-06 实施记录

本轮实现已完成 adapter 归位、结构化日志、基础诊断、控制台日志颜色和设置页日志查看。

已验证：

```powershell
uv run --project backend python -m py_compile backend/code_lite_backend/core/structured_logging.py backend/code_lite_backend/agents/runtimes/profiles.py backend/code_lite_backend/agents/acp/adapter.py backend/code_lite_backend/agents/acp/runtime_manager.py backend/code_lite_backend/api/routes/logs.py backend/code_lite_backend/api/routes/sessions.py backend/code_lite_backend/api/routes/settings.py backend/code_lite_backend/app.py backend/code_lite_backend/main.py
npm run ui:build
git diff --check
```

补充验证：

1. 使用临时目录验证结构化日志会生成 `api.jsonl`、`runtime-stderr.jsonl`、`diagnostics.jsonl`。
2. 使用 FastAPI TestClient 验证 `/api/logs/files` 和 `/api/logs/tail` 在空日志目录下返回 200。
3. 使用 `logger.exception` 验证 Python 异常堆栈会进入 `python.jsonl` 的 `fields.exception`。

未完成项：

1. 当前 backend 依赖未包含 pytest，`uv run --project backend python -m pytest` 无法运行。
2. 需要后续在本机已安装 Codex / Claude Code ACP wrapper 的环境中做真实 initialize / prompt smoke。
3. 日志轮转、清理和复制诊断摘要按钮留到下一轮。
