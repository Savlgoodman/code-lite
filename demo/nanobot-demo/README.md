# code-lite SDK 探针与命令行审批 Demo

这个目录保存 code-lite 的 SDK 探针和命令行审批 demo。现有 nanobot demo 用来验证 nanobot Python SDK 是否适合作为 code-lite 的兼容 adapter；Codex probe 用来验证 `openai-codex` Python SDK 的 adapter 接入能力。

它展示：

1. 实时输出 Agent 文本。
2. 实时显示工具调用开始、完成和失败。
3. 在工具真正执行前进行命令行审批。
4. 用户拒绝后中断当前 Agent turn。
5. 通过 `Ctrl+C` 或 `/cancel-after` 演示取消正在运行的 streamed run。

## 运行前准备

本 demo 使用 `uv`。

设置 DeepSeek API Key：

```powershell
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
```

复制配置文件：

```powershell
Copy-Item .\demo\nanobot_config.example.json .\demo\nanobot_config.local.json
```

配置文件中不会保存真实 key，只引用 `${DEEPSEEK_API_KEY}`。

## 安装依赖

```powershell
cd .\demo
uv sync
```

## 运行

```powershell
uv run python .\cli_approval_demo.py --config .\nanobot_config.local.json
```

进入交互后可以尝试：

```text
你好，简单介绍一下你自己。
列出当前 workspace 的顶层文件。
用命令查看当前目录。
/cancel-after 2 写一段较长的说明，介绍 coding agent 执行命令时的审批注意事项。
/exit
```

当 Agent 准备调用工具时，demo 会打印工具名和参数，并询问是否允许。

如果要在运行中手动取消当前 turn，可以按 `Ctrl+C`。如果要自动演示取消，可以使用：

```text
/cancel-after 2 请写一个较长的代码仓库任务检查清单。
```

## 重要说明

这个 demo 是 CLI 原型，不是最终安全机制。

Windows PowerShell 在管道执行 Python 脚本时可能出现中文被转成问号的情况。正常交互式运行通常问题少一些；如果仍然遇到乱码，可以先执行：

```powershell
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
```

在正式产品中，审批流应迁移到：

```text
Python nanobot hook
  -> Tauri UI 审批弹窗
  -> code-lite 产品层权限策略和后续执行网关二次审查
  -> 执行或拒绝
```

也就是说，nanobot hook 负责“提前发现工具调用并等待用户选择”，code-lite 产品层才是最终权限与审计边界。

## Codex SDK Adapter 探针

`codex_adapter_probe.py` 用来验证 `openai-codex` Python SDK 是否适合后续 Codex adapter 接入。默认只做本地 SDK 反射，不启动 Codex runtime，不调用模型，也不执行命令：

```powershell
cd .\demo
New-Item -ItemType Directory -Force .\.uv-cache | Out-Null
$env:UV_CACHE_DIR=(Resolve-Path .\.uv-cache).Path
uv sync
uv run python .\codex_adapter_probe.py
```

如果需要显式启动一次只读 smoke run，可以加 `--smoke`。这会启动本地 Codex runtime，可能调用模型并执行只读命令：

```powershell
uv run python .\codex_adapter_probe.py --smoke --permission-mode readonly
```

如需验证产品权限映射，可以使用：

```powershell
uv run python .\codex_adapter_probe.py --smoke --permission-mode ask --approval-decision deny
```

注意：`ask` smoke 可能在 `demo/` 工作区内创建或修改测试文件。不要在未隔离目录中用写入类 prompt 做验证。

当前主线已迁移到 ACP adapter。nanobot demo 仅作为 legacy 兼容资料保留；新的 adapter 设计入口见 `docs/README.md` 和 `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`。
