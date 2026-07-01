# UI 与 Tauri 桌面壳开发文档

本文记录 code-lite 当前 UI 原型、Tauri 桌面壳和 Python Agent Hub 的开发方式。当前阶段 UI 通过 Tauri 启动本地 Python backend，并以流式事件展示 agent 输出；后续重点是接入 Codex、Claude Code、opencode，并加入远程同步观看。

## 当前状态

已落地的 UI 原型包含：

1. 类 Codex App 的简洁桌面布局。
2. 左侧全局会话列表，不按项目文件夹分组。
3. 主区域聊天界面、工具调用卡片、审批面板、底部输入框。
4. 新建会话、搜索会话、发送消息和 backend JSON 会话持久化。
5. `streamdown` Markdown 渲染，用于 assistant 流式消息。
6. Python backend 提供本地 HTTP NDJSON 流式接口，当前保留 nanobot 原型 adapter，并预留 Codex、Claude Code 等 adapter。
7. Tauri 2 桌面壳，默认窗口 `1200x756`，最小窗口 `900x620`，支持拉伸。
8. Windows 本地开发启动脚本，自动进入 VS Build Tools 环境并设置代理。

## 目录职责

```text
.
├── package.json              # 根脚本入口
├── scripts/
│   └── dev-tauri.ps1         # Windows Tauri 开发启动脚本
├── ui/
│   ├── package.json          # 前端依赖和脚本
│   ├── vite.config.ts        # Vite 配置
│   └── src/
│       ├── App.tsx           # 应用根入口，只组合全局 layout 和 page
│       ├── pages/            # 页面级状态与业务编排，例如 ChatPage
│       ├── layout/           # 桌面壳布局，例如标题栏和侧边栏
│       ├── features/         # 业务组件，例如 chat、runtime、remote
│       ├── components/       # 跨功能复用组件，例如 Markdown 消息渲染
│       ├── lib/              # 纯函数、格式化、状态工具
│       ├── services/         # 前端服务适配，例如 agentClient 和 conversationStore
│       ├── styles.css        # 全局样式
│       └── types.ts          # 前端类型定义
├── backend/
│   ├── pyproject.toml        # Python backend 依赖
│   ├── uv.lock               # uv 锁文件
│   └── pc_agent_backend/     # FastAPI backend 源码，历史包名后续可迁移
│       ├── main.py           # CLI/uvicorn 启动入口
│       ├── app.py            # FastAPI app 工厂
│       ├── api/              # health、conversation、turn、approval、settings 路由
│       ├── agents/           # nanobot/codex/claude_code/opencode adapter 层
│       ├── core/             # 配置、路径、编码、JSON 工具
│       ├── schemas/          # 后端内部协议类型
│       ├── services/         # 运行态服务、审批 broker、模型配置
│       └── storage/          # JSON 会话存储
└── src-tauri/
    ├── Cargo.toml            # Tauri Rust 工程配置
    ├── tauri.conf.json       # Tauri 应用、窗口、构建和图标配置
    ├── icons/                # Tauri 图标资源
    └── src/                  # Rust 入口代码
```

## 环境依赖

Windows 本地开发需要：

1. Node.js 与 npm。
2. Rust stable MSVC 工具链。
3. Visual Studio Build Tools 2022，需安装 C++ Build Tools 和 Windows SDK。
4. Microsoft Edge WebView2 Runtime。现代 Windows 通常已内置。
5. uv，用于管理 Python backend 环境。
6. 如网络需要代理，可使用本机 HTTP 代理，例如 `http://127.0.0.1:7899`。

当前脚本不会修改系统级环境变量，只会在本次启动进程内临时设置：

```text
HTTP_PROXY
HTTPS_PROXY
ALL_PROXY
PATH 中的 %USERPROFILE%\.cargo\bin
```

## 安装依赖

前端依赖安装在 `ui/` 下：

```powershell
npm install --prefix ui
```

Python backend 依赖使用 uv：

```powershell
npm run backend:sync
```

根目录 `package.json` 作为统一脚本入口，当前不需要在根目录安装额外 npm 依赖。

## 启动方式

推荐一键启动开发环境：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
```

该脚本会用 Windows Terminal 打开单窗口多标签：

1. `backend` 标签：启动 Python backend，默认监听 `http://127.0.0.1:8765`。
2. `tauri` 标签：启动 Tauri 桌面壳，Tauri 会自动启动 Vite。

默认代理为：

```text
http://127.0.0.1:7899
```

如不需要代理：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev.ps1 -NoProxy
```

如需要指定代理：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev.ps1 -Proxy http://127.0.0.1:7899
```

推荐使用 Windows 开发启动脚本：

```powershell
npm run tauri:dev:win
```

该命令会执行以下工作：

1. 调用 Visual Studio Build Tools 的 `VsDevCmd.bat`。
2. 临时把 `%USERPROFILE%\.cargo\bin` 加入 `PATH`。
3. 设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`。
4. 启动 `npm run tauri:dev`。
5. Tauri 自动启动 Vite，再启动桌面窗口。
6. UI 首次发送消息时，Tauri 会通过 `ensure_backend` 启动 Python backend。

开发态默认不声明 Tauri `externalBin`，因此不需要先生成 `src-tauri/binaries/pc-agent-backend-x86_64-pc-windows-msvc.exe`。打包时由 `src-tauri/tauri.release.conf.json` 注入 backend sidecar 配置，产物名后续会随 code-lite 命名迁移。

启动成功后，开发服务器默认监听：

```text
http://127.0.0.1:1420
```

Tauri 桌面窗口标题后续应迁移为：

```text
code-lite
```

Python backend 默认监听：

```text
http://127.0.0.1:8765
```

开发期也可以单独启动 backend：

```powershell
npm run backend:dev
```

默认开发环境由 `start-dev.ps1` 设置 `REPAIR_AGENTS_ENV=DEV`，backend 会读取或自动创建：

```text
data/config/nanobot_config.json
```

这是早期原型命名。后续应迁移为 code-lite 的统一 runtime 配置，同时保持兼容读取。

如果需要指定配置或切换 adapter：

```powershell
uv run --project backend python -m pc_agent_backend.main --config .\demo\nanobot_config.local.json --workspace . --agent-adapter nanobot
```

adapter 目标值包括 `nanobot`、`codex`、`claude_code`，后续会加入 `opencode`。

## 前端单独调试

如暂时只调 UI，不启动 Tauri：

```powershell
npm run ui:dev
```

前端开发服务器由 Vite 启动，浏览器调试时会使用同一套 React 代码，但无法覆盖 Tauri 桌面窗口能力。

## 构建与检查

前端构建检查：

```powershell
npm run ui:build
```

Tauri 后端检查可在 VS Build Tools 环境中执行：

```powershell
cd src-tauri
cargo check
```

如果普通 PowerShell 中无法识别 `cargo`，优先使用 `npm run tauri:dev:win` 或先进入 VS Build Tools 环境。

Python backend 入口检查：

```powershell
uv run --project backend python -m pc_agent_backend.main --help
```

## 日志位置

Tauri 启动 backend 时会把控制台输出写入运行时 data 目录：

```text
开发环境：data/logs/backend-*.log
安装环境：%USERPROFILE%\.repair-agent\logs\backend-*.log
```

安装环境目录仍是早期原型命名。迁移为 `%USERPROFILE%\.code-lite` 前需要先设计兼容迁移。

关闭桌面窗口或退出应用时，Tauri 会停止本次由它启动的 backend 进程树。若端口上已有手动启动的 backend，Tauri 会复用该服务，但不会在退出时杀掉外部进程。

## 窗口配置

窗口配置位于 `src-tauri/tauri.conf.json`：

```json
{
  "width": 1200,
  "height": 756,
  "minWidth": 900,
  "minHeight": 620,
  "resizable": true,
  "center": true,
  "decorations": false
}
```

当前使用自绘标题栏，因此 `decorations` 设置为 `false`。后续如果要接入系统原生标题栏，需要同步调整前端 titlebar 样式和 Tauri 窗口配置。

## 图标资源

图标资源位于 `src-tauri/icons/`。当前 `app-icon.svg` 是临时开发图标源，已生成 Tauri 需要的多尺寸图标，包括：

```text
src-tauri/icons/icon.ico
src-tauri/icons/icon.icns
src-tauri/icons/32x32.png
src-tauri/icons/128x128.png
src-tauri/icons/128x128@2x.png
```

替换品牌图标时，建议准备正方形 SVG 或 PNG，然后重新执行：

```powershell
npm exec --prefix ui -- tauri icon .\src-tauri\icons\app-icon.svg --output .\src-tauri\icons
```

## 当前 UI 数据策略

当前 UI 不再使用固定 mock 数据：

1. `ui/src/types.ts` 定义会话、消息、工具调用、审批请求和 Agent 事件类型。
2. `ui/src/services/agentClient.ts` 负责调用 Tauri `ensure_backend`，并读取 backend NDJSON 流。
3. `ui/src/components/MessageRenderer.tsx` 使用 `streamdown` 渲染 assistant Markdown。
4. `ui/src/services/conversationStore.ts` 只通过 backend conversation API 读取会话列表和加载会话内容。
5. 点击新对话只打开无 id 的空白草稿页；首次发送时不携带 `conversationId`，由 backend 在 `/api/turns/stream` 中生成真实会话 id 并返回给 UI。
6. 消息与 session 状态写入由 backend 在一轮对话结束时完成，UI 只根据流式事件更新当前展示态。
7. UI 不再使用 `localStorage` 保存或迁移主消息记录。
8. backend 未连接或配置缺失时，UI 会展示真实错误，不生成假回复。

## 后续集成建议

UI 与 backend 集成时建议优先拆分以下边界：

1. 会话读取接口：读取会话列表、读取消息和事件快照。
2. Agent 运行接口：发送用户输入，接收流式文本、工具调用、命令输出、文件变更和 token usage；无 `conversationId` 时由 backend 创建新会话。
3. Runtime 接口：展示 Codex、Claude Code、opencode、nanobot 的可用状态、能力边界和配置入口。
4. 审批接口：展示风险说明、操作范围、runtime 来源和确认结果。
5. 远程同步接口：展示连接码、观看者列表、连接状态、撤销入口和后续授权入口。

建议先让 UI 只依赖统一 `AgentEvent` 和 runtime descriptor，再由 adapter 适配各 SDK 或 CLI，避免组件直接绑定某个 runtime。

## 常见问题

### 端口 1420 被占用

检查占用进程：

```powershell
Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
```

如果已有旧的 Vite 或 Tauri 开发进程，需要先关闭旧进程再重启。

### 找不到 cargo

确认 Rust 已安装在当前用户目录：

```powershell
Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe"
```

如果存在但普通 PowerShell 找不到，使用：

```powershell
npm run tauri:dev:win
```

该脚本会为当前启动进程临时补充 Cargo PATH。

### 找不到 cl 或 link

说明当前 shell 不在 Visual Studio 开发者环境中。使用：

```powershell
npm run tauri:dev:win
```

脚本会自动调用 Visual Studio Build Tools 的 `VsDevCmd.bat`。

### 图标缺失导致 Windows Resource 构建失败

Tauri Windows 构建需要 `src-tauri/icons/icon.ico`。如图标文件缺失，重新生成：

```powershell
npm exec --prefix ui -- tauri icon .\src-tauri\icons\app-icon.svg --output .\src-tauri\icons
```

### 开发模式提示 backend sidecar 缺失

开发模式不应依赖 PyInstaller 生成的 backend sidecar。如果仍看到类似以下错误：

```text
resource path `binaries\pc-agent-backend-x86_64-pc-windows-msvc.exe` doesn't exist
```

请确认启动命令使用的是默认开发配置，例如 `npm run tauri:dev:win` 或 `npm run tauri:dev`，不要在开发命令里额外传入 `src-tauri/tauri.release.conf.json`。

### 网络下载依赖失败

确认本机代理端口可用，例如 `7899`。默认启动脚本使用：

```text
http://127.0.0.1:7899
```

也可以通过 `-Proxy` 参数指定其他地址。

### backend 配置缺失

backend 默认读取运行时 data 目录中的配置，并在文件不存在时自动创建最小配置：

```text
REPAIR_AGENTS_ENV=DEV  ->  <repo>/data/config/nanobot_config.json
其他环境              ->  ~/.repair-agent/config/nanobot_config.json
```

这是历史兼容路径。仓库内不维护真实本地配置，后续会迁移到 code-lite 的统一配置文件。需要临时调试其他配置时，可以使用 `--config` 指定显式路径。

API Key 使用环境变量：

```powershell
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
```

### backend 端口 8765 被占用

检查占用进程：

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
```

如果已有旧 backend 进程，可关闭后重新启动 Tauri。

## 提交注意事项

不要提交以下内容：

1. `ui/node_modules/`
2. `ui/dist/`
3. `src-tauri/target/`
4. `backend/.venv/`
5. `.cache/`
6. 日志、临时文件、本地密钥、真实用户数据和远程连接令牌。

提交前建议检查：

```powershell
git status --short
npm run ui:build
uv run --project backend python -m pc_agent_backend.main --help
```
