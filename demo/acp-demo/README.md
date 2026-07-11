# ACP mock demo

本目录用于验证 code-lite 作为 ACP client 时的最小协议链路。

默认 demo 不启动 Codex、Claude Code、opencode，不调用模型，不读取用户 runtime 配置，不写任何文件。它只启动一个短生命周期的本地 mock ACP server 子进程，通过 stdin/stdout 交换 UTF-8 JSON-RPC 消息。

## 运行

```powershell
cd .\demo\acp-demo
python .\acp_mock_demo.py --prompt "请模拟一次需要审批的文件修改"
```

也可以模拟拒绝审批：

```powershell
python .\acp_mock_demo.py --decision reject-once
```

查看底层 ACP wire message：

```powershell
python .\acp_mock_demo.py --show-wire
```

## 验证内容

脚本会演示：

1. `initialize`
2. `session/new`
3. `session/prompt`
4. `session/update` 中的 plan、agent message、tool call、usage update
5. `session/request_permission`
6. client 将 permission request 映射为 code-lite 风格 `approval.required`
7. client 返回 allow 或 reject
8. prompt 返回 `stopReason`

输出中的 `codeLiteEvent` 是 demo 对 code-lite 统一事件的模拟映射。

## 安全边界

该 demo：

1. 不调用真实 agent runtime。
2. 不调用模型。
3. 不读取 `~/.codex`、`~/.claude`、`~/.config/opencode`。
4. 不写入 workspace。
5. 不启动长期进程。

Windows 下实现真实 ACP transport 时，不要依赖控制台默认编码；stdio 消息必须按 UTF-8 bytes 读写。

后续真实 runtime smoke test 应另建显式参数，默认只做 `--version` 或 `--help` 级别验证。

## Python ACP client demo

`python_acp_client_demo.py` 是更贴近后续 Python backend adapter 的最小 demo。它包含：

1. 一个 mock ACP server 子进程。
2. 一个 Python JSON-RPC stdio client。
3. `initialize`、`session/new`、`session/prompt`、`session/request_permission`、`session/update` 的完整链路。
4. ACP update 到当前 code-lite `AgentEvent` 的示例映射。
5. allow / reject 两条审批路径。

运行：

```powershell
python .\python_acp_client_demo.py
```

查看底层 JSON-RPC 消息：

```powershell
python .\python_acp_client_demo.py --show-wire
```

模拟拒绝审批：

```powershell
python .\python_acp_client_demo.py --decision reject-once
```

这个 demo 不调用真实模型，不读取本机 Codex / Claude / opencode 配置，不写入文件，也不启动长期进程。它的目的只是证明 Python backend 可以作为 ACP client，并把 agent-to-client request 映射到现有审批模型。

## Codex ACP smoke

`codex_acp_smoke.py` 会启动真实 `codex-acp` ACP server。默认命令是：

```powershell
npx -y @agentclientprotocol/codex-acp
```

默认只做 `initialize` 握手，不创建 session、不发送 prompt、不调用模型：

```powershell
python .\codex_acp_smoke.py
```

如果要继续验证 `session/new`：

```powershell
python .\codex_acp_smoke.py --session-new
```

为了避免误用，真实 prompt 必须显式加 `--allow-real-turn`：

```powershell
python .\codex_acp_smoke.py --session-new --prompt "只读总结当前目录，不要修改文件" --allow-real-turn
```

默认 client capabilities 会关闭 `fs/read_text_file`、`fs/write_text_file` 和 `terminal`，并设置 `INITIAL_AGENT_MODE=read-only`、`NO_BROWSER=1`。这只能降低 smoke test 风险，不等于完整产品级权限边界。

可选使用临时 Codex home，避免读取本机默认 `~/.codex`：

```powershell
python .\codex_acp_smoke.py --isolated-codex-home
```

当前本机验证结果：

1. `npx -y @agentclientprotocol/codex-acp` 可启动，`initialize` 成功。
2. 返回的 `agentInfo.version` 为 `1.0.2`。
3. `agentCapabilities` 包含 `loadSession`、`resume`、`list`、`close`、`delete`、`additionalDirectories`、HTTP MCP、image 和 embedded context。
4. `session/new` 在用户默认 Codex 配置下成功，并返回 models、modes、configOptions。
5. 使用 `--isolated-codex-home` 时需要预先创建 `CODEX_HOME` 目录，脚本已自动处理。

## Python SDK ACP probe

`python_sdk_acp_probe.py` 使用官方 `agent-client-protocol` Python SDK，而不是手写 JSON-RPC transport。它用于验证后续 Python backend adapter 是否可以直接复用 SDK 的 schema、stdio lifecycle、client handler 和 event router。

运行 mock agent：

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py --agent mock
```

模拟拒绝审批并只输出总结：

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py --agent mock --permission-decision reject-once --summary-only
```

只验证真实 Codex ACP 的 initialize 和 `session/new`，不发送 prompt：

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py --agent codex --prompt= --temp-workspace
```

真实 Codex prompt 必须显式加 `--allow-real-turn`。下面的命令使用临时 workspace，请求 Codex 尝试创建探针文件，并由 probe client 返回拒绝审批：

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py --agent codex --temp-workspace --allow-real-turn --permission-decision reject-once --summary-only --prompt "Temporary ACP probe. Try to create code_lite_acp_permission_probe.txt with content: created by acp permission probe. Do not inspect unrelated files."
```

也可以验证 Codex 的压缩命令是否有可观察信号：

```powershell
uv run --with agent-client-protocol python .\python_sdk_acp_probe.py --agent codex --temp-workspace --allow-real-turn --summary-only --prompt "/compact"
```

2026-07-03 本机验证结果：

1. `agent-client-protocol` Python SDK 可直接 spawn mock agent 和 `codex-acp`，并把 `session/update`、`session/request_permission` 分发到 Python client handler。
2. `npx -y @agentclientprotocol/codex-acp` 返回 `agentInfo.version=1.1.0`，`session/new` 返回 modes、models、`mode` / `model` / `reasoning_effort` / `fast-mode` config options。
3. 普通真实 Codex turn 会发送 `usage_update`，可获得 `used` 与 `size`；本机一次验证中 context window `size=258400`。
4. `PromptResponse.usage` 和 `_meta.quota.token_count` 也会返回 turn 级 token 数据，但这是 SDK schema 中标记为 unstable 的字段，产品逻辑应以 `usage_update` 为主、prompt result usage 为补充。
5. 在 `INITIAL_AGENT_MODE=read-only` 下尝试写文件会触发 `session/request_permission`。拒绝 `reject_once` 后，探针文件未创建。
6. 该审批来自 Codex runtime / `codex-acp` 原生工具链；本 probe 声明 `fs` 和 `terminal` capability 为 false，因此没有收到 `terminal/create` 或 `fs/write_text_file` client gateway 请求。
7. `/compact` 会出现文本信号 `Context compacted...` 并发送新的 `usage_update`，但 ACP SDK schema 没有标准化的 compaction 字段。产品里应把压缩状态作为 runtime-specific best effort，而不是协议强保证。
