# ACP Adapter 技术路线设计

验证日期：2026-07-02

本文记录 code-lite 使用 ACP 作为 Claude Code、Codex、opencode 统一 adapter 路线的调研结论和落地建议。本文不替代 `docs/AGENT_SDK_CAPABILITY_RESEARCH.md`，而是补充一条新的接入路线：当 runtime 提供 ACP server 时，code-lite 可以作为 ACP client 统一控制 agent。

后续实现以 `docs/ACP_AGENT_ADAPTER_IMPLEMENTATION_DESIGN.md` 为主入口。本文保留为 ACP 协议、runtime 分发、权限和配置疑虑的调研记录。

## 1. 总结

ACP 的完整名称是 Agent Client Protocol。它是一套基于 JSON-RPC 2.0 的 agent-client 通信协议。典型本地形态是：

```text
code-lite backend
  作为 ACP Client
  启动或连接 ACP Agent Server
  通过 stdin/stdout 发送 JSON-RPC

ACP Agent Server
  可能是 codex-acp、claude-agent-acp、opencode acp
  负责把 ACP 请求转换为底层 agent runtime 调用
```

最关键的判断是：

1. ACP 本身只是协议，不自带任何 Codex、Claude Code 或 opencode 的二进制运行体。
2. 每个具体 ACP server 可能自带、依赖或调用底层 runtime。
3. code-lite 不直接连接“模型”，也不直接连接“Codex/Claude/opencode 内核”，而是连接一个可执行的 ACP server 命令。
4. ACP 可以显著降低 code-lite 接入多 agent 的协议成本，但不会消除 runtime 安装、认证、配置和权限边界问题。
5. code-lite 的产品级权限和远程同步仍必须建立在统一 `AgentEvent`、`ApprovalBroker` 和后续执行网关之上。

补充验证：2026-07-03 本机 `npm view` 显示 `@agentclientprotocol/codex-acp` 声明依赖 `@openai/codex`，`@agentclientprotocol/claude-agent-acp` 声明依赖 `@anthropic-ai/claude-agent-sdk`。因此 code-lite 设置页托管安装这些 ACP 包时，会同时安装对应 runtime SDK/CLI 依赖；但认证、本机配置、隔离目录、自定义 binary 和 opencode 分发方式仍要作为产品安装与预检流程处理。

## 2. ACP 与 MCP、SDK 的关系

| 概念 | 角色 | code-lite 中的定位 |
| --- | --- | --- |
| ACP | 工作台和 agent runtime 之间的控制协议 | code-lite 作为 client，agent 作为 server |
| MCP | agent 调用外部工具和数据源的协议 | code-lite 可把自有工具作为 MCP server 提供给 agent |
| Native SDK | 某个 runtime 的语言 SDK | Codex SDK、Claude Agent SDK、nanobot SDK 的直接 adapter 路线 |
| ACP wrapper | 把某个 runtime 包装成 ACP server 的程序 | `codex-acp`、`claude-agent-acp`、`opencode acp` |

建议保留两条 adapter 路线：

```text
Native SDK Adapter
  codex SDK / Claude Agent SDK / nanobot SDK

ACP Adapter
  通用 acp client
  通过配置启动不同 ACP server 命令
```

短期可以优先做 ACP adapter，因为它同时覆盖 Codex、Claude Code、opencode，且 opencode 已经直接提供 `opencode acp` 命令。

## 3. ACP 的基本流程

根据 ACP v1 文档，本地 stdio transport 的基本约束是：

1. Client 启动 Agent 子进程。
2. 双方通过 stdin/stdout 交换单行 JSON-RPC 消息。
3. 消息必须使用 UTF-8。
4. stdout 只能输出合法 ACP 消息，stderr 可用于日志。

典型会话流程：

```text
initialize
  协商 protocolVersion、clientCapabilities、agentCapabilities、authMethods

authenticate
  如 agent 要求认证，client 选择一种 auth method

session/new 或 session/load 或 session/resume
  传入 cwd、additionalDirectories、mcpServers
  agent 返回 sessionId、configOptions、modes 等

session/prompt
  发送用户输入
  agent 通过 session/update 流式输出消息、计划、工具调用和 usage
  agent 可通过 session/request_permission 请求审批
  client 可通过 session/cancel 取消
  agent 最终返回 stopReason
```

## 4. 二进制运行体问题

这是当前最容易混淆的地方，需要拆成三层：

```text
ACP protocol
  只定义消息格式，不包含 runtime。

ACP server wrapper
  可执行命令，例如 codex-acp、claude-agent-acp、opencode acp。

Underlying runtime
  Codex App Server、Claude Agent SDK / Claude Code binary、opencode runtime。
```

### 4.1 Codex

`@agentclientprotocol/codex-acp` 是 Codex 的 ACP server。它的 README 明确说明：

1. `codex-acp` 是 stdio ACP agent server。
2. 它会启动 Codex App Server。
3. 它把 ACP 请求转换为 Codex 操作，并把 Codex 事件映射回 ACP client。
4. npm 包包含兼容的 `@openai/codex` 依赖。
5. 如需使用其他 Codex 可执行文件，可设置 `CODEX_PATH`。

因此 Codex 的结论是：

| 问题 | 结论 |
| --- | --- |
| 是否必须预装 Codex CLI | 不一定。`codex-acp` npm 包可带兼容的 Codex 依赖。 |
| 是否能使用本机 Codex binary | 可以，通过 `CODEX_PATH=/path/to/codex`。 |
| code-lite 应启动谁 | 优先启动固定版本的 `codex-acp`，而不是直接启动 `codex`。 |
| 产品安装策略 | code-lite 托管固定版本 `codex-acp`，或让用户显式选择本机 `codex-acp` / `CODEX_PATH`。 |

### 4.2 Claude Code

`@agentclientprotocol/claude-agent-acp` 是基于 Claude Agent SDK 的 ACP server。它的 README 说明支持：

1. Context @-mentions。
2. Images。
3. Tool calls with permission requests。
4. Edit review、TODO lists、interactive/background terminals。
5. Custom slash commands。
6. Client MCP servers。

官方 Claude Agent SDK TypeScript 文档说明：

1. `@anthropic-ai/claude-agent-sdk` 会把平台对应的 native Claude Code binary 作为 optional dependency 捆绑。
2. 正常安装时，不需要用户单独安装 Claude Code。
3. 如果包管理器跳过 optional dependencies，会报缺少 native CLI binary。
4. 此时可通过 `pathToClaudeCodeExecutable` 指向单独安装的 `claude` binary。

因此 Claude 的结论是：

| 问题 | 结论 |
| --- | --- |
| 是否必须预装 Claude Code | 通常不需要，TS SDK 正常安装会带平台 native binary。 |
| 是否能使用本机 Claude binary | SDK 支持指定路径，但 `claude-agent-acp` 暴露的配置入口还需 smoke test。 |
| code-lite 应启动谁 | 优先启动固定版本的 `claude-agent-acp`。 |
| 产品安装策略 | code-lite 托管固定版本 npm 包，并检查 optional native binary 是否存在。 |

本仓库先前 Python SDK 调研已验证 `claude-agent-sdk` Python wheel 内含 `claude.exe`。ACP 路线主要依赖 TypeScript SDK，仍应在 demo 阶段做一次安装清单和 `--version` 检查。

### 4.3 opencode

OpenCode 官方 CLI 提供 `opencode acp`：

```text
opencode acp
```

官方 CLI 文档说明该命令启动一个通过 stdin/stdout 使用 nd-JSON 通信的 ACP server。

因此 opencode 的结论是：

| 问题 | 结论 |
| --- | --- |
| 是否必须预装 opencode | 需要有可执行的 `opencode` 命令或等价包入口。 |
| 是否有单独 wrapper | 当前路线是 opencode runtime 自身提供 `acp` 命令。 |
| 是否可用 npx/bun/pnpm 临时运行 | 可能可以，但产品不应每次运行都依赖临时拉包。 |
| code-lite 应启动谁 | `opencode acp`，并传入受控 cwd/env/config。 |

## 5. code-lite 的 runtime 安装策略

推荐按“发现、确认、托管”三步走。

### 5.1 发现优先级

1. 用户显式配置的 ACP server 命令和绝对路径。
2. code-lite 托管 runtime 目录中的固定版本。
3. 系统 PATH 中的 `codex-acp`、`claude-agent-acp`、`opencode`。
4. 用户明确授权后，用包管理器下载到 code-lite runtime 目录。

不要默认从项目目录、项目 `node_modules/.bin` 或工作区脚本中自动发现 agent runtime，除非用户明确选择。否则恶意仓库可以劫持可执行入口。

### 5.2 托管目录建议

```text
%APPDATA%/code-lite/runtimes/
  acp/
    codex-acp/<version>/
    claude-agent-acp/<version>/
    opencode/<version>/
```

每个 runtime manifest 保存：

```json
{
  "adapterId": "codex-acp",
  "command": "C:/Users/.../code-lite/runtimes/acp/codex-acp/0.1.0/codex-acp.cmd",
  "version": "0.1.0",
  "sha256": "...",
  "source": "code-lite-managed",
  "verifiedAt": "2026-07-02T00:00:00Z"
}
```

不要在 manifest 中保存 API key、token、账号密码或私钥。

### 5.3 设置页安装向导

`npx -y @agentclientprotocol/codex-acp` 对开发验证很方便，但不适合作为产品默认运行方式，原因：

1. 启动时可能联网下载，影响稳定性和延迟。
2. 版本可能漂移。
3. 缓存和安装路径不透明。
4. 供应链审计困难。

产品应在设置页提供“补全运行时”安装向导，而不是在每次对话时临时 `npx`：

```text
设置页 Agent Runtime 检测
  -> 检查 code-lite 托管 Node runtime
  -> 如缺失，提示用户安装托管 Node
  -> 使用托管 npm/npx 安装固定版本 ACP package
  -> 写入 runtime manifest
  -> 后续启动本地固定路径
```

Codex 与 Claude Code 的默认补全项：

| Runtime | 安装包 | 启动命令 | 说明 |
| --- | --- | --- | --- |
| Codex ACP | `@agentclientprotocol/codex-acp@<pinned>` | `codex-acp` | npm 包包含兼容的 `@openai/codex` 依赖；不要求用户单独预装 Codex CLI |
| Claude Code ACP | `@agentclientprotocol/claude-agent-acp@<pinned>` | `claude-agent-acp` | 依赖 Claude Agent SDK 的 native binary optional dependency；安装后需检查 binary 是否完整 |

如果用户没有 Node/npm 环境，code-lite 不要求用户手动安装系统 Node，而是由设置页安装 code-lite 托管 Node runtime。托管 Node 只用于运行 code-lite 管理的 ACP npm 包，不默认加入系统 PATH。

安装完成后 manifest 应记录：

```json
{
  "adapterId": "codex-acp",
  "package": "@agentclientprotocol/codex-acp",
  "packageVersion": "<pinned>",
  "nodeRuntime": "code-lite-managed",
  "command": "C:/Users/.../code-lite/runtimes/acp/codex-acp/<version>/node_modules/.bin/codex-acp.cmd",
  "source": "code-lite-managed-npm",
  "verifiedAt": "2026-07-02T00:00:00Z"
}
```

运行时仍允许高级用户选择系统命令或自定义绝对路径，但默认产品体验应是“设置页检测并补全”，而不是要求用户提前安装 Codex、Claude Code、Node 或 npm。

## 6. 配置与认证归属

ACP 只定义初始化、认证和会话参数，不统一各 runtime 的私有配置系统。code-lite 需要为每个 ACP server 显式决定使用“用户本机配置”还是“code-lite 隔离配置”。

### 6.1 两种配置模式

| 模式 | 含义 | 优点 | 风险 |
| --- | --- | --- | --- |
| user-native | 使用用户已有 `~/.codex`、`~/.claude`、`~/.config/opencode` 等配置 | 上手快，复用登录和偏好 | 不易审计，项目配置和全局配置可能改变行为 |
| code-lite-isolated | code-lite 设置专用 home/config dir，只映射必要配置 | 可控、可复现、适合远程同步和审计 | 需要引导登录和配置迁移 |

建议 MVP 默认提供两项：

1. 快速模式：使用用户本机配置，但 UI 明确显示“使用本机 runtime 配置”。
2. 隔离模式：使用 code-lite 专用配置目录，适合演示、远程协作和高风险 workspace。

### 6.2 Codex 配置

Codex 原生配置通常位于 `CODEX_HOME`，默认是 `~/.codex`。Codex 手册说明可用 `~/.codex/config.toml` 保存个人默认值，项目也可用 `.codex/config.toml` 保存仓库级配置。Codex 还支持 `AGENTS.md`、skills、MCP、approval policy、sandbox mode 等配置。

`codex-acp` 还支持这些环境变量：

| 变量 | 用途 |
| --- | --- |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | API key auth |
| `CODEX_PATH` | 指定自定义 Codex executable |
| `CODEX_CONFIG` | JSON 对象，合并到 Codex session config |
| `MODEL_PROVIDER` | 新会话的 model provider |
| `INITIAL_AGENT_MODE` | 初始模式，例如 `read-only`、`agent`、`agent-full-access` |
| `NO_BROWSER` | 隐藏浏览器登录方式 |
| `APP_SERVER_LOGS` | adapter 日志目录 |

code-lite 建议：

1. 快速模式不覆盖 `CODEX_HOME`，沿用用户本机 Codex 登录和配置。
2. 隔离模式设置 `CODEX_HOME=%APPDATA%/code-lite/runtime-state/codex`。
3. 产品权限优先映射到 `INITIAL_AGENT_MODE` 和 `CODEX_CONFIG`，但不能假设它覆盖所有动作。
4. API key 只通过环境变量注入子进程，不写入仓库文件。

### 6.3 Claude 配置

Claude Agent SDK 默认加载当前工作目录和用户目录下的 Claude Code 配置。官方 SDK overview 说明，默认会加载：

1. `.claude/skills/*/SKILL.md`
2. `.claude/commands/*.md`
3. `CLAUDE.md` 或 `.claude/CLAUDE.md`
4. `~/.claude/` 中的用户级配置

SDK 提供 `settingSources` / `setting_sources` 控制加载来源。ACP wrapper 是否完整暴露这些选项，需要后续 smoke test。

code-lite 建议：

1. 快速模式沿用用户 `~/.claude` 和项目 `.claude`。
2. 隔离模式优先让 wrapper 使用 code-lite 生成的设置，或通过环境变量隔离 Claude 配置目录。
3. 如 wrapper 暂无显式隔离参数，ACP Claude adapter 先标记为 `experimental`。
4. Skills、commands、CLAUDE.md 的加载结果应在 UI 中以“runtime 原生上下文”说明，而不是混同为 code-lite skill。

### 6.4 opencode 配置

OpenCode 官方配置文档说明配置源按优先级合并，包括 remote config、global config、custom config、project config、`.opencode` 目录、inline config 和 managed config。常用环境变量包括：

| 变量 | 用途 |
| --- | --- |
| `OPENCODE_CONFIG` | 指定自定义配置文件 |
| `OPENCODE_CONFIG_DIR` | 指定自定义配置目录 |
| `OPENCODE_CONFIG_CONTENT` | 注入 inline JSON 配置 |
| `OPENCODE_PERMISSION` | 注入权限配置 |
| `OPENCODE_DISABLE_CLAUDE_CODE` | 禁用读取 `.claude` prompt 和 skills |
| `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` | 禁用读取 `~/.claude/CLAUDE.md` |
| `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | 禁用加载 `.claude/skills` |

OpenCode 默认权限文档说明默认允许所有操作，用户可通过 `permission` 配置改为 ask 或 deny。

code-lite 建议：

1. 默认用 `OPENCODE_CONFIG_CONTENT` 注入 code-lite 本轮权限策略。
2. 如选择隔离模式，设置 `OPENCODE_CONFIG_DIR=%APPDATA%/code-lite/runtime-state/opencode/config`。
3. 对高风险 workspace，默认禁用自动更新、默认插件和不必要的 Claude Code 兼容读取。
4. 如果用户选择“继承项目配置”，UI 要标明 `.opencode` 和项目 `opencode.json` 会参与合并。

## 7. Skills 与项目上下文

ACP 本身不定义统一 skill 目录。它只支持：

1. `session/new.cwd` 指定工作目录。
2. `additionalDirectories` 指定额外根目录。
3. `mcpServers` 指定 agent 可连接的 MCP server。
4. `prompt` 中传入 text、resource link、embedded resource 等内容。

各 runtime 的 skill 加载仍由 runtime 自己决定。

| Runtime | 原生 skill / 指令来源 | ACP 路线建议 |
| --- | --- | --- |
| Codex | `AGENTS.md`、`~/.codex`、`.codex/config.toml`、Codex skills / plugins | 默认让 Codex 读原生上下文；code-lite skill 通过 prompt 注入或 MCP bridge 提供 |
| Claude | `.claude/skills/*/SKILL.md`、`CLAUDE.md`、`.claude/commands`、plugins | 快速模式继承原生目录；隔离模式只加载 code-lite 允许的 sources |
| opencode | `~/.config/opencode/skills`、`.opencode/skills`、agents、commands、plugins、instructions | 通过 `OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT` 控制加载范围 |

建议新增 `SkillBridge`：

```text
code-lite SkillRegistry
  -> ACP prompt embedded resource
  -> ACP mcpServers 中的 code-lite MCP server
  -> runtime native skill directory, only when user opts in
```

这样可以避免把 code-lite skill 直接复制进用户的全局 runtime 目录。

## 8. 上下文窗口与 usage 数据

ACP v1 定义了 `usage_update`：

```json
{
  "sessionUpdate": "usage_update",
  "used": 53000,
  "size": 200000,
  "cost": {
    "amount": 0.045,
    "currency": "USD"
  }
}
```

其中：

1. `used` 是当前 session context 已用 token。
2. `size` 是总 context window token。
3. `cost` 可选。

这比单独接 SDK 更适合统一 UI，因为 code-lite 可以直接映射为：

```text
agent.usage.updated
agent.context.updated
```

但要注意：

1. ACP 定义了 usage update，不代表每个 ACP server 都稳定发送。
2. `codex-acp` README 明确列出 token usage 事件，Codex 侧有较强基础。
3. Claude Agent SDK 有丰富 usage 信息，`claude-agent-acp` 是否完整映射为 ACP `usage_update` 需 smoke test。
4. OpenCode 有 stats、compaction 和模型配置能力，但 `opencode acp` 的 usage_update 发送频率仍需验证。

UI 策略：

1. 收到 `usage_update` 就展示 context used/size。
2. 未收到时显示“未知”或隐藏进度条。
3. source 字段记录为 `acp.usage_update`、`codex.native`、`claude.native` 或 `opencode.native`。
4. 不把 cost 作为结算数据，只作为 runtime 自报信息。

### 8.1 2026-07-03 Codex ACP 实测

使用 `demo/acp-demo/python_sdk_acp_probe.py` 和官方 `agent-client-protocol` Python SDK 连接真实 `codex-acp` 后，当前结论是：

1. `npx -y @agentclientprotocol/codex-acp` 可由 Python SDK 直接 spawn，`initialize` 返回 `agentInfo.version=1.1.0`。
2. `session/new` 返回 `read-only`、`agent`、`agent-full-access` 三种 mode，以及 `mode`、`model`、`reasoning_effort`、`fast-mode` 等 config options。
3. 普通真实 turn 会发送 `usage_update`，本机探针观察到 `used` 与 `size`；其中一次 context window `size=258400`。
4. `PromptResponse.usage` 和 `_meta.quota.token_count` 也会返回 turn 级 token 数据，但 Python SDK schema 标记这些字段为 unstable，产品逻辑应以 `usage_update` 为主。
5. `/status` 作为 slash command 不一定发送 `usage_update`，不能当作稳定的 context 采样 API。
6. `/compact` 会触发可观察文本和新的 `usage_update`，但 ACP SDK schema 没有标准化的 compaction 字段。code-lite 可以 best-effort 记录 runtime-specific 压缩信号，但不要把它设计成跨 runtime 强保证。

## 9. 权限与审批

ACP 的审批入口是 `session/request_permission`。Agent 可以在工具调用前向 Client 请求用户选择，例如 allow once 或 reject once。

这对 code-lite 很有价值，因为它把不同 runtime 的审批 UI 统一到一条协议上：

```text
session/request_permission
  -> approval.required
  -> 用户或远端 operator 决策
  -> ACP permission outcome
  -> approval.decided
```

但必须保守理解：

1. ACP 文档使用的是 “Agent MAY request permission”，不是“所有危险动作 MUST 经由 permission request”。
2. 只有当文件写入通过 `fs/write_text_file`、命令执行通过 `terminal/create`，code-lite 才能强制在执行前拦截。
3. 如果 ACP wrapper 内部直接调用底层 runtime 的 shell/file tools，code-lite 可能只能收到工具事件或权限请求，不能保证硬阻断。
4. runtime 自身 sandbox、permission mode、hooks、settings 仍然需要配置。

2026-07-03 Codex ACP 实测中，`INITIAL_AGENT_MODE=read-only` 下让 Codex 尝试创建临时文件时，`codex-acp` 通过 `session/request_permission` 发出了审批请求，options 包含 `allow_once`、`allow_always`、带 exec policy amendment 的 allow，以及 `reject_once`。probe client 选择 `reject_once` 后，临时文件没有创建。这说明 ACP 审批对 Codex compat mode 有实用价值，但仍应按照上面的 caveat 继续设计 gateway mode。

### 9.1 两种运行模式

| 模式 | 说明 | 适合阶段 |
| --- | --- | --- |
| compat mode | 使用 runtime 原生工具和配置，ACP 负责会话、事件、审批桥接 | MVP、快速接入、能力验证 |
| gateway mode | code-lite 声明并实现 `fs`、`terminal` 能力，让 agent 尽量通过 code-lite 执行动作 | 权限增强、远程审批、审计强化 |

MVP 建议先实现 compat mode，再逐步走向 gateway mode。

### 9.2 clientCapabilities 策略

保守 MVP：

```json
{
  "fs": {
    "readTextFile": true,
    "writeTextFile": false
  },
  "terminal": false
}
```

这允许 agent 读取 code-lite 提供的文件内容，但不允许它通过 ACP client 直接写文件或启动命令。写入和命令仍可能由 runtime 原生能力处理，因此 adapter descriptor 必须注明 caveat。

权限增强阶段：

```json
{
  "fs": {
    "readTextFile": true,
    "writeTextFile": true
  },
  "terminal": true
}
```

此时 code-lite 必须实现：

1. 路径归一化和 workspace root 检查。
2. 敏感文件读取保护。
3. 写入前 diff 生成和审批。
4. shell 命令风险分类、超时、输出截断和取消。
5. 审计事件和远程脱敏。

## 10. 统一事件映射

建议 ACP adapter 输出以下 code-lite 事件：

| ACP update / method | code-lite event |
| --- | --- |
| `session/update.user_message_chunk` | `agent.user.delta` 或仅用于 replay |
| `session/update.agent_message_chunk` | `agent.text.delta` |
| `session/update.plan` | `agent.plan.updated` |
| `session/update.tool_call` | `agent.tool.started` |
| `session/update.tool_call_update.status=in_progress` | `agent.tool.delta` |
| `session/update.tool_call_update.status=completed` | `agent.tool.completed` |
| `session/update.tool_call_update.status=failed` | `agent.tool.failed` |
| `ToolCallContent.diff` | `agent.file_change.delta` |
| `ToolCallContent.terminal` | `agent.command.started` 或 terminal 引用 |
| `session/update.usage_update` | `agent.usage.updated` 和 `agent.context.updated` |
| `session/update.config_option_update` | `agent.session.config.updated` |
| `session/request_permission` | `approval.required` |
| `session/prompt.result.stopReason=end_turn` | `agent.run.completed` |
| `stopReason=cancelled` | `agent.run.cancelled` |
| `stopReason=max_tokens` | `agent.run.failed`，reason=`max_tokens` |
| `stopReason=refusal` | `agent.run.failed` 或 `agent.run.refused` |

所有 ACP 原始字段可放入 `payload.runtimeRaw`，但 UI 主路径不依赖原始结构。

## 11. Adapter descriptor 建议

新增通用 ACP adapter descriptor：

```json
{
  "id": "acp",
  "label": "ACP Agent",
  "runtimeKind": "acp_stdio",
  "capabilities": {
    "streaming": true,
    "toolEvents": true,
    "permissionRequests": true,
    "contextUsage": "best_effort",
    "sessions": ["new", "load", "resume", "list"],
    "clientFsGateway": "configurable",
    "clientTerminalGateway": "configurable"
  }
}
```

具体 runtime 实例：

```json
{
  "id": "codex-acp",
  "baseAdapter": "acp",
  "command": ["codex-acp"],
  "managedPackage": "@agentclientprotocol/codex-acp",
  "defaultMode": "read-only",
  "configMode": "user-native"
}
```

```json
{
  "id": "claude-agent-acp",
  "baseAdapter": "acp",
  "command": ["claude-agent-acp"],
  "managedPackage": "@agentclientprotocol/claude-agent-acp",
  "defaultMode": "ask",
  "configMode": "user-native"
}
```

```json
{
  "id": "opencode-acp",
  "baseAdapter": "acp",
  "command": ["opencode", "acp"],
  "managedPackage": "opencode",
  "defaultMode": "ask",
  "configMode": "user-native"
}
```

## 12. 落地顺序

### 阶段 1：Mock ACP demo

1. 实现本地 Python mock ACP server。
2. 实现最小 ACP client。
3. 验证 initialize、session/new、session/prompt、session/update、session/request_permission、stopReason。
4. 不调用模型，不启动真实 agent runtime，不写文件。

### 阶段 2：通用 ACP stdio client

1. 抽出 `AcpJsonRpcTransport`。
2. 支持启动子进程、读 stdout、写 stdin、捕获 stderr。
3. 支持 request/response、notification、agent-to-client request。
4. 支持超时、取消、进程退出错误归一化。

### 阶段 3：事件映射和审批桥

1. 把 `session/update` 映射为统一 `AgentEvent`。
2. 把 `session/request_permission` 接到 `ApprovalBroker`。
3. 把 `session/cancel` 接到现有 cancel turn。
4. 记录 native session id 和 runtime command manifest。

### 阶段 4：真实 runtime smoke

只做显式、短时、只读验证：

1. `codex-acp --version` 或 `npx -y @agentclientprotocol/codex-acp --version`。
2. `claude-agent-acp --version` 或 `npx -y @agentclientprotocol/claude-agent-acp --version`。
3. `opencode --version`、`opencode acp --help`。
4. 不自动发送真实 prompt，不调用模型。

### 阶段 5：受控 turn 原型

1. 选择一个 runtime，例如 opencode acp。
2. 用测试 workspace 和只读 prompt 跑一轮。
3. clientCapabilities 默认禁用 write 和 terminal。
4. 记录事件和 caveat。

### 阶段 6：gateway mode

1. 实现 `fs/read_text_file`。
2. 实现 `fs/write_text_file` 的 diff、审批和 UTF-8 写入。
3. 实现 `terminal/create`、`terminal/output`、`terminal/kill`、`terminal/release`。
4. 与远程审批和审计联动。

## 13. 风险与待验证项

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| wrapper 内部绕过 client fs/terminal | 权限请求不等于所有动作硬拦截 | descriptor 标注 caveat；逐步推进 gateway mode |
| npx 临时下载版本漂移 | 产品运行不稳定且难审计 | code-lite 托管固定版本和 sha256 |
| 用户全局配置污染行为 | `~/.codex`、`~/.claude`、`~/.config/opencode` 可能改变权限和工具 | 提供 user-native / isolated 模式 |
| skills 加载不一致 | ACP 不统一 skill 目录 | SkillBridge 统一注入，原生 skills 作为 runtime capability |
| usage_update 不稳定 | ACP 支持不代表所有 server 都发送 | UI best-effort 展示 |
| Windows 进程和编码 | stdio 必须 UTF-8，Windows shell 路径和终止进程复杂 | transport 层统一 UTF-8，命令路径用绝对路径，取消做进程树管理 |

## 14. 资料来源

1. ACP introduction: <https://agentclientprotocol.com/get-started/introduction.md>
2. ACP transports: <https://agentclientprotocol.com/protocol/v1/transports.md>
3. ACP initialization: <https://agentclientprotocol.com/protocol/v1/initialization.md>
4. ACP session setup: <https://agentclientprotocol.com/protocol/v1/session-setup.md>
5. ACP prompt turn: <https://agentclientprotocol.com/protocol/v1/prompt-turn.md>
6. ACP tool calls and permission requests: <https://agentclientprotocol.com/protocol/v1/tool-calls.md>
7. ACP file system: <https://agentclientprotocol.com/protocol/v1/file-system.md>
8. ACP terminals: <https://agentclientprotocol.com/protocol/v1/terminals.md>
9. ACP session config options: <https://agentclientprotocol.com/protocol/v1/session-config-options.md>
10. codex-acp README: <https://github.com/agentclientprotocol/codex-acp>
11. claude-agent-acp README: <https://github.com/agentclientprotocol/claude-agent-acp>
12. Claude Agent SDK TypeScript docs: <https://code.claude.com/docs/en/agent-sdk/typescript.md>
13. Claude Agent SDK overview: <https://code.claude.com/docs/en/agent-sdk/overview.md>
14. OpenCode CLI docs: <https://opencode.ai/docs/cli.md>
15. OpenCode config docs: <https://opencode.ai/docs/config.md>
16. Codex manual: <https://developers.openai.com/codex/codex-manual.md>
17. ACP Python SDK: <https://github.com/agentclientprotocol/python-sdk>
18. ACP Python SDK quickstart: <https://agentclientprotocol.github.io/python-sdk/quickstart/>
