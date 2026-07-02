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
