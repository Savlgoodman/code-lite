# nanobot Python SDK 调研记录

> 历史资料：本文来自早期 nanobot 原型调研，保留用于理解 nanobot 作为兼容 adapter 的能力。code-lite 当前产品方向以 Codex、Claude Code、opencode 等多 Agent Runtime 接入和远程同步观看为主。

## 1. 调研对象

仓库：`HKUDS/nanobot`

本次查看版本：仓库 `main` 分支，项目版本 `nanobot-ai 0.2.2`。

本次关注问题：

1. 是否能实时看到 Agent 输出。
2. 是否能实时看到 Agent 的工具调用。
3. 是否能在工具调用前做审批。
4. 是否能拒绝或打断工具调用。
5. 是否适合接入 PC Repair Agent 的命令审批机制。
6. 是否支持注册我们自定义的 Tool。
7. 是否支持自动注入或自动发现 Skill。
8. SDK 配置方式是否适合桌面端 Python 后台集成。

## 2. 结论摘要

nanobot Python SDK 基本满足我们对“实时观察 Agent”和“工具调用前审批”的需求。

确认能力：

1. 支持 `bot.stream(...)` 实时获取结构化事件。
2. 支持实时文本输出事件：`text.delta`。
3. 支持 reasoning 输出事件：`reasoning.delta`、`reasoning.completed`。
4. 支持工具调用开始事件：`tool.started`。
5. 支持工具调用完成事件：`tool.completed`。
6. 支持工具调用失败事件：`tool.failed`。
7. 支持 `RunStream.cancel()` 取消正在运行的 Agent turn。
8. 支持通过 `AgentHook.before_execute_tools(...)` 在工具真正执行前观察工具调用。
9. 支持在 `before_execute_tools` 中异步等待用户审批。
10. 支持在审批拒绝时通过抛出异常中断整轮 Agent 执行，但 hook 需要使用 `reraise=True`。
11. 支持通过 Python entry point 注册自定义 Tool，entry point group 为 `nanobot.tools`。
12. 自定义 Tool 可以被 `ToolLoader` 自动发现并注册到 `ToolRegistry`。
13. 支持 workspace 级 Skill 自动发现，路径为 `<workspace>/skills/<skill-name>/SKILL.md`。
14. 支持 `always: true` Skill 自动完整注入 Agent 上下文。
15. 普通 Skill 会自动出现在 Skill 摘要里，Agent 可按需读取完整 `SKILL.md`。
16. 支持通过 `disabledSkills` 禁用指定 Skill。
17. 支持通过 `requires.bins`、`requires.env` 标记 Skill 依赖，并过滤不可用 Skill。

需要注意的限制：

1. `before_execute_tools(context)` 里能看到待执行工具，但 nanobot 当前 runner 实际执行时仍使用 `response.tool_calls`，不是 `context.tool_calls`。因此“只删除某一个 tool call，让剩下的继续执行”不是稳定能力。
2. 审批拒绝的推荐方式是中断整个 turn，而不是只跳过某个工具。
3. SDK 自带的 `tool.started` 事件来自 `SDKStreamingHook.before_execute_tools`，它本身不会等待用户确认。真正审批应使用我们自定义的 `AgentHook`。
4. nanobot 内置 `exec` 工具已有一些 deny pattern，但这不能替代我们产品自己的 Tauri/Rust 执行网关。
5. 自定义 Tool 虽然能注册，但是否被模型主动调用仍取决于工具名、描述、参数 schema 和 prompt 引导。
6. `always: true` Skill 会占用上下文，不适合放大段业务流程；大型流程应作为普通 Skill，让 Agent 按需读取。
7. 自定义 Tool 的 `execute(...)` 运行在 Python 后台进程内，涉及系统修改、驱动安装、环境变量、注册表等动作时，仍应转成“待审批 action”，不要直接执行高风险操作。

## 3. 关键源码依据

### 3.1 Python SDK 入口

文件：`nanobot/nanobot.py`

关键接口：

```python
Nanobot.from_config(...)
await bot.run(...)
await bot.run_streamed(...)
async for event in bot.stream(...)
await bot.aclose()
```

`run_streamed(...)` 会创建：

1. `SDKStreamEmitter`
2. `SDKStreamingHook`
3. `SDKCaptureHook`
4. `RunStream`

这说明 SDK 的流式能力是公开能力，不是 WebUI 私有实现。

### 3.2 流式事件定义

文件：`nanobot/sdk/types.py`

稳定事件类型：

```text
run.started
text.delta
text.completed
reasoning.delta
reasoning.completed
tool.started
tool.completed
tool.failed
run.completed
run.failed
```

`StreamEvent` 字段包含：

```text
type
delta
content
result
name
tool_call_id
arguments
iteration
resuming
usage
error
metadata
```

这对我们的 UI 很有用：Tauri 前端可以把文本增量、工具开始、工具完成、错误、token usage 都展示出来。

### 3.3 工具事件转发

文件：`nanobot/sdk/streaming.py`

`SDKStreamingHook.before_execute_tools(...)` 会在工具执行前发出 `tool.started` 事件：

```python
async def before_execute_tools(self, context):
    for call in context.tool_calls:
        await self._emitter.emit(StreamEvent(
            type=STREAM_EVENT_TOOL_STARTED,
            name=call.name,
            tool_call_id=call.id,
            arguments=deepcopy(call.arguments),
            iteration=context.iteration,
        ))
```

`SDKStreamingHook.after_iteration(...)` 会把工具执行结果转为：

1. `tool.completed`
2. `tool.failed`

### 3.4 工具执行前 hook

文件：`nanobot/agent/hook.py`

`AgentHook` 暴露了：

```python
async def before_execute_tools(self, context: AgentHookContext) -> None:
    pass
```

`AgentHookContext` 中包含：

```text
iteration
messages
response
usage
tool_calls
tool_results
tool_events
final_content
stop_reason
error
session_key
```

### 3.5 工具执行顺序

文件：`nanobot/agent/runner.py`

工具执行的关键顺序：

```text
LLM 返回 tool_calls
  -> 构造 assistant_message
  -> 写入 checkpoint
  -> await hook.before_execute_tools(context)
  -> await self._execute_tools(...)
```

这说明 `before_execute_tools` 确实发生在工具执行前，适合挂审批。

### 3.6 hook 异常处理

文件：`nanobot/agent/hook.py`

`CompositeHook` 默认会捕获并记录 hook 异常，避免一个 hook 破坏 Agent loop。

如果要让审批拒绝真正中断执行，需要自定义 hook 时调用：

```python
super().__init__(reraise=True)
```

否则抛出的异常可能会被组合 hook 吞掉，工具仍可能继续执行。

### 3.7 自定义 Tool 注册机制

文件：

```text
nanobot/agent/tools/base.py
nanobot/agent/tools/loader.py
nanobot/agent/tools/registry.py
```

自定义工具需要继承：

```python
from nanobot.agent.tools.base import Tool
```

核心接口：

```python
class Tool:
    @property
    def name(self) -> str: ...

    @property
    def description(self) -> str: ...

    @property
    def parameters(self) -> dict: ...

    async def execute(self, **kwargs): ...
```

参数 schema 可以用官方提供的装饰器生成：

```python
from nanobot.agent.tools.base import tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema

@tool_parameters(
    tool_parameters_schema(
        required=["city"],
        city=StringSchema("城市名称"),
        date=StringSchema("查询日期", nullable=True),
    )
)
class WeatherTool(Tool):
    ...
```

外部工具插件通过 Python package entry point 注册：

```toml
[project.entry-points."nanobot.tools"]
demo_weather = "pc_agent_nanobot_demo.weather_tool:WeatherTool"
```

`ToolLoader._discover_plugins()` 会读取：

```python
entry_points(group="nanobot.tools")
```

然后在 `ToolLoader.load(ctx, registry, scope="core")` 中实例化并注册工具。

已确认行为：

1. 插件类必须是 `Tool` 子类。
2. 抽象类会被跳过。
3. `_plugin_discoverable = False` 的类不会被自动发现。
4. 默认 scope 是 `core`，工具类可通过 `_scopes` 控制注册范围。
5. `enabled(ctx)` 可根据配置决定是否启用。
6. `create(ctx)` 可从运行上下文构造工具实例。
7. 插件工具如果与内置工具重名，会被跳过并记录 warning。
8. 插件工具如果与已有非内置工具重名，会覆盖并记录 warning。

### 3.8 Skill 自动发现与注入机制

文件：

```text
nanobot/agent/skills.py
nanobot/agent/context.py
nanobot/templates/agent/skills_section.md
```

Skill 是目录形式的 Markdown 能力说明：

```text
<workspace>/skills/<skill-name>/SKILL.md
```

workspace Skill 会优先于同名 builtin Skill。也就是说，如果 workspace 中有：

```text
skills/weather/SKILL.md
```

它会 shadow nanobot 内置的同名 `weather` Skill。

`ContextBuilder.build_system_prompt(...)` 的 Skill 注入顺序：

```text
读取 identity / bootstrap / tool contract / memory
  -> get_always_skills()
  -> load_skills_for_context(always_skills)
  -> 将 always Skill 完整写入 # Active Skills
  -> build_skills_summary(exclude=always_skills)
  -> 将普通 Skill 的摘要和路径写入 # Skills
```

`always: true` 写法：

```markdown
---
name: safe-command-review
description: 高风险命令审批与风险解释规范。
always: true
---

# Safe Command Review

...
```

也支持 nanobot metadata 写法：

```markdown
---
description: 驱动自动安装工作流。
metadata: {"nanobot":{"always":true}}
---
```

依赖声明示例：

```markdown
---
description: GitHub CLI 工作流。
metadata: {"nanobot":{"requires":{"bins":["gh"],"env":["GITHUB_TOKEN"]}}}
---
```

依赖检查能力：

1. `requires.bins` 使用 `shutil.which(...)` 检查命令是否存在。
2. `requires.env` 使用环境变量检查。
3. `list_skills(filter_unavailable=True)` 会过滤不可用 Skill。
4. `build_skills_summary()` 会把不可用 Skill 标记为 unavailable，并说明缺失依赖。

对我们的含义：

1. `safe-command-review` 可以作为 `always: true` Skill，保证每轮都知道审批规范。
2. `driver-auto-install`、`laptop-oem-driver`、`runtime-completion` 这类长流程不建议 always 注入，适合作为普通 Skill。
3. 普通 Skill 只进摘要，Agent 需要时再读取完整 `SKILL.md`，这样更省上下文。

### 3.9 AgentLoop 工具注册调用链

文件：`nanobot/agent/loop.py`

`AgentLoop` 初始化时会创建：

```python
self.tools = ToolRegistry()
self._register_default_tools()
```

`_register_default_tools()` 会构造 `ToolContext`：

```python
ctx = ToolContext(
    config=self.tools_config,
    workspace=str(self.workspace),
    ...
)
```

然后调用：

```python
registered = ToolLoader().load(ctx, self.tools)
```

这说明 entry point 工具不是只在测试中可用，而是在正常 Agent 运行时就会被加载。

## 4. 对 PC Repair Agent 的影响

### 4.1 推荐接入方式

在 Python 后台中，用 nanobot SDK 跑 Agent：

```text
Python backend
  -> Nanobot.from_config(...)
  -> bot.run_streamed(..., hooks=[ApprovalHook()])
  -> 将 StreamEvent 转发给 Tauri UI
  -> ApprovalHook 在工具执行前向 Tauri 发起审批请求
```

Tauri/Rust 仍然作为最终安全边界：

```text
nanobot 工具调用
  -> Python ApprovalHook 拦截
  -> 发送审批请求给 Tauri
  -> 用户确认
  -> Rust Execution Gateway 再做风险分级
  -> 执行或拒绝
```

### 4.2 不建议直接依赖 nanobot 的 exec 安全机制

nanobot 的 `exec` 工具有内置 deny pattern，例如会阻止部分删除、格式化、重启、磁盘操作等命令。

但我们的产品不能只靠它：

1. 它是 Agent 工具级安全，不是产品级安全边界。
2. 我们需要面向普通用户展示用途、风险和回滚方案。
3. 我们需要统一审计日志。
4. 我们需要覆盖驱动安装、环境变量、注册表、服务、安装器等更细粒度风险。

因此 nanobot 的工具安全只能作为辅助防线，最终执行仍应走 Tauri/Rust Execution Gateway。

### 4.3 Tool 与 Skill 的推荐分工

对 PC Repair Agent 来说，建议把 Tool 和 Skill 明确分层：

```text
Tool = 可被 Agent 调用的原子能力
Skill = 指导 Agent 如何组合 Tool 完成一个维修工作流
```

推荐 Tool：

1. `hardware_scan`：读取 CPU、GPU、主板、BIOS、笔记本品牌、系统版本。
2. `driver_catalog_search`：根据硬件信息检索官方驱动候选。
3. `download_candidate`：下载文件到受控缓存目录。
4. `hash_verify`：校验文件 hash 和签名。
5. `runtime_scan`：检测 VC++、.NET、DirectX、常见游戏运行库。
6. `create_pending_action`：创建待审批操作，不直接执行高风险命令。
7. `execution_gateway_request`：向 Tauri/Rust 执行网关发起执行请求。

推荐 Skill：

1. `safe-command-review`：命令风险分级、审批文案、回滚提示。适合 `always: true`。
2. `driver-auto-install`：台式机硬件识别、驱动搜索、下载、校验、安装审批流程。
3. `laptop-oem-driver`：笔记本优先走品牌官网支持页。
4. `runtime-completion`：运行时环境扫描、缺失项解释、下载和安装建议。
5. `general-pc-diagnosis`：疑难杂症诊断工作流。

关键原则：

1. Tool 不承载复杂业务流程。
2. Skill 不直接绕过审批执行系统修改。
3. 高风险 Tool 应返回结构化待审批 action。
4. Tauri/Rust Execution Gateway 是最终执行边界。
5. 所有 Tool 调用事件都转发到 UI，用于展示 Agent 正在做什么。

## 5. Demo 设计

本仓库 `demo/` 下提供一个命令行 demo：

1. 使用 `uv` 管理环境。
2. 使用 `nanobot-ai` 作为依赖。
3. 通过 `demo/nanobot_config.example.json` 配置 DeepSeek OpenAI-compatible endpoint。
4. 通过 `DEEPSEEK_API_KEY` 环境变量注入密钥。
5. 实时打印文本输出。
6. 实时打印工具调用事件。
7. 在工具执行前询问用户是否允许。
8. 用户拒绝时中断当前 Agent turn。
9. 用户输入 `/cancel-after <秒数> <提示词>` 或按 `Ctrl+C` 可取消正在运行的 streamed run。
10. 通过 `nanobot.tools` entry point 注册了一个自定义天气工具 `demo_weather`。

### 5.1 自定义天气 Tool 验证

为了验证自定义 Tool 注册链路，demo 中新增了：

```text
demo/pc_agent_nanobot_demo/weather_tool.py
demo/check_weather_tool.py
```

`pyproject.toml` 中注册：

```toml
[project.entry-points."nanobot.tools"]
demo_weather = "pc_agent_nanobot_demo.weather_tool:WeatherTool"
```

`demo_weather` 行为：

1. 接收 `city` 和可选 `date`。
2. 任意城市、任意日期都固定返回 `40度，多云`。
3. `read_only=True`，用于证明只读 Tool 可以安全注册和并发调度。
4. 返回 JSON 字符串，便于后续 UI 结构化展示。

验证命令：

```powershell
cd D:\project\PC-agent\demo
uv sync
uv run python .\check_weather_tool.py
```

已验证输出：

```text
entry_point_demo_weather=True
registered_demo_weather=True
registry_has_demo_weather=True
tool_name=demo_weather
tool_read_only=True
{"city": "北京", "date": "明天", "temperature": "40度", "weather": "多云", "summary": "北京明天天气：40度，多云。"}
```

这证明：

1. Python package entry point 能被当前 uv 环境识别。
2. nanobot `ToolLoader` 能发现 `demo_weather`。
3. `ToolRegistry` 能注册并通过名称取回该工具。
4. 工具 `execute(...)` 能正常运行并返回结果。

### 5.2 Demo 配置方式

`demo/nanobot_config.example.json` 使用 DeepSeek OpenAI-compatible endpoint：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "${DEEPSEEK_API_KEY}",
      "apiBase": "https://api.deepseek.com"
    }
  },
  "modelPresets": {
    "deepseekFlash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    }
  }
}
```

真实 key 不写入配置文件，运行时通过环境变量注入：

```powershell
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
```

本地配置文件：

```powershell
Copy-Item .\demo\nanobot_config.example.json .\demo\nanobot_config.local.json
```

`demo/nanobot_config.local.json` 已在 `.gitignore` 中排除。

### 5.3 SDK 使用方式

命令行审批 demo 的核心调用：

```python
async with Nanobot.from_config(config_path=config_path, workspace=workspace) as bot:
    run = await bot.run_streamed(
        prompt,
        session_key=session_key,
        hooks=[ApprovalHook()],
    )

    async for event in run.stream_events():
        ...
```

审批 hook：

```python
class ApprovalHook(AgentHook):
    def __init__(self) -> None:
        super().__init__(reraise=True)

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for call in context.tool_calls:
            allowed = await ask_user_approval(call.name, call.arguments)
            if not allowed:
                raise ToolApprovalRejected(...)
```

正式产品中，`ask_user_approval(...)` 不应该使用命令行 `input(...)`，而应替换为：

```text
Python ApprovalHook
  -> 通过 IPC 向 Tauri UI 发起审批请求
  -> UI 展示用途、参数、风险、回滚建议
  -> 用户确认或拒绝
  -> Python 收到结果
  -> 若允许，再交给 Rust Execution Gateway 二次审查和执行
```

## 6. 配置建议

### 6.1 Python 后台依赖管理

MVP 阶段建议继续使用 `uv`：

```powershell
cd .\demo
uv sync
uv run python .\cli_approval_demo.py --config .\nanobot_config.local.json
```

正式项目中可以拆为：

```text
backend/
  pyproject.toml
  code_lite_backend/
    runtime/
    nanobot_tools/
    adapters/
```

自定义 Tool 放在 `code_lite_backend.nanobot_tools` 下，并在 `backend/pyproject.toml` 注册 entry point。

### 6.2 nanobot 配置建议

建议保留一个产品级配置模板：

```json
{
  "agents": {
    "defaults": {
      "modelPreset": "deepseekFlash",
      "maxToolIterations": 20,
      "failOnToolError": true,
      "disabledSkills": []
    }
  },
  "tools": {
    "restrictToWorkspace": true,
    "exec": {
      "enable": false
    },
    "file": {
      "enable": true
    },
    "web": {
      "search": {
        "enable": false
      },
      "fetch": {
        "enable": false
      }
    }
  }
}
```

说明：

1. `exec.enable` 在正式产品中建议默认关闭，或替换为我们自己的受控执行 Tool。
2. `restrictToWorkspace` 应默认开启。
3. web search/fetch 是否启用要由产品策略控制；驱动下载工作流更推荐走我们自己的官方源检索 Tool。
4. `disabledSkills` 可用于灰度关闭不成熟 Skill。
5. 不要在配置文件里写明文 API key，统一使用环境变量或系统凭据存储。

### 6.3 我们项目的集成建议

建议集成链路：

```text
Tauri UI
  -> Python sidecar
  -> Nanobot SDK
  -> Custom Tools / Skills
  -> ApprovalHook
  -> Tauri 审批弹窗
  -> Rust Execution Gateway
  -> 审计日志
```

其中：

1. nanobot 负责 Agent loop、工具选择、上下文、Skill 提示。
2. Python backend 负责适配 nanobot、注册 Tool、管理 Skill 文件。
3. Tauri UI 负责用户可见的审批体验和状态展示。
4. Rust Execution Gateway 负责最终权限边界。

## 7. 建议后续验证

1. 用 DeepSeek `deepseek-v4-flash` 验证工具调用格式兼容性。
2. 验证 `exec`、`read_file`、`list_dir`、`web_search` 等不同工具的事件输出。
3. 验证审批拒绝后的 session 记录是否符合预期。
4. 验证长任务中 `RunStream.cancel()` 是否能及时取消工具执行。
5. 如果需要“拒绝单个工具但保留本轮继续执行”，考虑给 nanobot 提 PR 或在我们的适配层改造 tool registry。
6. 将 `safe-command-review` 做成第一个 workspace Skill，并验证 `always: true` 是否符合预期。
7. 将 `driver-auto-install` 做成普通 Skill，验证 Agent 能否先看到摘要、再按需读取完整 `SKILL.md`。
8. 增加一个 `create_pending_action` Tool，验证高风险操作只生成待审批 action，不直接执行。
9. 增加 Tauri IPC mock，验证 `ApprovalHook` 能等待 UI 审批结果。
10. 验证打包后 Python sidecar 中 entry point 元数据是否仍可被 `importlib.metadata.entry_points(...)` 发现。
