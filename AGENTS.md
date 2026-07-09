# code-lite - Agent 协作规范

本文件面向所有参与本仓库工作的 AI Coding Agent 和开发者。code-lite 是一个桌面端多 Agent 工作台，目标是接入 Codex、Claude Code、opencode 等 agent runtime，为用户完成编码任务和其他自动化任务，并支持远程连接、远程同步观看和后续授权协作。

当前 UI 与 Tauri 桌面壳已进入原型阶段，Python backend 已具备本地流式事件接口和早期 adapter 结构。后续重点是把产品叙事、adapter 抽象、远程同步、权限审批和运行时配置统一到 code-lite 方向。

## AI Coding 规范

所有 AI Coding Agent 必须遵守以下规则：

1. **UTF-8 编码**：读取、写入、修改任何代码文件和文档文件时，必须显式使用 UTF-8 编码，避免中文内容乱码。
2. **保护用户改动**：修改文件前先检查工作区状态，不覆盖、不回退用户已有改动；遇到不属于当前任务的改动，保持原样。
3. **禁止写入敏感信息**：不要把 API Key、Token、账号密码、私钥等敏感信息写入仓库文件；配置文件只保留环境变量占位或示例值。
4. **禁止 Emoji**：代码、注释、提交信息、文档和用户可见文案中不使用 emoji 表情。
5. **禁止擅自启动长期进程**：未经用户明确要求，不自行后台启动前端、后端、数据库、Agent 服务或其他长期运行进程。
6. **优先阅读文档**：开始涉及需求、架构、Agent Adapter、远程同步、demo 或目录设计的任务前，先阅读本文件和相关 `docs/` 文档。
7. **小步修改**：每次改动尽量围绕一个明确目标，不做无关重构，不顺手格式化无关文件。
8. **可验证优先**：能用脚本、命令或静态检查验证的改动，应在完成后执行验证，并在回复中说明结果。

对任意 Agent：请记住，本项目中任何文档和代码都必须以 UTF-8 的方式读取和写入。

## 文件编码要求

本项目包含大量中文文档，所有工具操作都必须注意编码。

PowerShell 读取文件时建议：

```powershell
Get-Content -Encoding UTF8 .\docs\guides\PRD.md
```

PowerShell 写入文件时必须显式指定 UTF-8：

```powershell
Set-Content -Encoding UTF8 .\path\to\file.md $content
```

Python 读写文件时必须显式指定编码：

```python
Path("docs/guides/PRD.md").read_text(encoding="utf-8")
Path("docs/guides/PRD.md").write_text(content, encoding="utf-8")
```

手动编辑文件时，也应确认编辑器保存编码为 UTF-8。

## 文档入口

当前主要文档如下：

| 路径 | 用途 |
|------|------|
| `docs/README.md` | 文档索引，说明当前主线、保留文档和已清理旧路线 |
| `docs/guides/PRD.md` | 产品需求文档，记录 code-lite 的产品定位、核心功能、MVP 范围和路线规划 |
| `docs/architecture/ARCHITECTURE.md` | 架构设计文档，记录 Tauri、Python Agent Hub、多 Agent Adapter、远程同步和权限边界 |
| `docs/architecture/PROJECT_STRUCTURE.md` | 项目目录结构规划，记录目标代码目录、职责边界和命名迁移策略 |
| `docs/guides/UI_DEVELOPMENT.md` | UI 与 Tauri 桌面壳开发文档，记录环境依赖、启动流程、目录职责和常见问题 |
| `docs/development/DEVELOPMENT_WORKFLOW.md` | 开发流程规范，记录 dev 集成、分支命名、master 使用范围、变基合并和版本升级要求 |
| `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md` | ACP Agent Adapter 实施设计，记录 Codex、Claude Code、opencode 的主线接入方案 |
| `docs/design/0703-AGENT-UNIFIED-ACP.md` | 统一前端交互协议设计，记录 session capabilities、模型、模式和事件映射 |
| `docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md` | Agent adapter 归位、结构化日志、诊断错误和设置页日志查看重构方案 |
| `docs/refactor/0709-ACP-RUNTIME-FORCE-DISCONNECT.md` | ACP Runtime 强制断开、进程树清理、设置变更联动断开和升级占用修复方案 |
| `docs/design/0702-REMOTE-SYNC.md` | 远程连接与同步观看设计，记录连接码、事件同步、权限和安全边界 |
| `docs/design/0703-RUNTIME-MODEL-PROVIDER.md` | 模型供应商配置设计，记录统一模型配置与 runtime 原生配置的关系 |
| `docs/guides/BUILD_AND_RELEASE.md` | 编译、打包和发布产物整理流程 |
| `demo/acp-demo/README.md` | ACP mock、Python SDK probe 和 Codex ACP smoke 使用说明 |

阅读建议：

1. 做产品需求相关任务，先读 `docs/README.md` 和 `docs/guides/PRD.md`。
2. 做架构、模块边界相关任务，先读 `docs/architecture/ARCHITECTURE.md` 和 `docs/architecture/PROJECT_STRUCTURE.md`。
3. 做 UI、Tauri 桌面壳、前端交互和启动环境相关任务，先读 `docs/guides/UI_DEVELOPMENT.md`。
4. 做 Codex、Claude Code、opencode、ACP adapter、runtime 事件、ACP 连接释放和进程清理相关任务，先读 `docs/design/0703-AGENT-ACP-IMPLEMENTATION.md`、`docs/design/0703-AGENT-UNIFIED-ACP.md`、`docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md` 和 `docs/refactor/0709-ACP-RUNTIME-FORCE-DISCONNECT.md`。
5. 做远程连接、远程同步观看和远端权限相关任务，先读 `docs/design/0702-REMOTE-SYNC.md`。
6. 做模型供应商、模型选择和 runtime 配置相关任务，先读 `docs/design/0703-RUNTIME-MODEL-PROVIDER.md`。
7. 做运行时数据、聊天 UI、adapter 迁移、日志或诊断重构相关任务，先读 `docs/refactor/0703-RUNTIME-DATA-CHAT-UI.md` 和 `docs/refactor/0706-AGENT-ADAPTER-LOGGING-DIAGNOSTICS.md`。
8. 做 ACP 协议、Python backend ACP client 或 SDK 探针相关调研，先读 `docs/research/0702-AGENT-ACP-RESEARCH.md` 和 `docs/research/0703-BACKEND-ACP-RESEARCH.md`。
9. 做 legacy nanobot demo 相关任务，只参考 `demo/nanobot-demo/README.md` 和当前代码，不把 nanobot 作为新功能主线。
10. 做功能开发、Bug 修复、性能优化、重构或发布合并前，先读 `docs/development/DEVELOPMENT_WORKFLOW.md`。

## 开发与启动入口

当前已落地的桌面 UI 原型由 `ui/`、`src-tauri/` 和 `backend/` 组成：

1. `ui/`：React + Vite 前端 UI，使用 `streamdown` 渲染 assistant Markdown，当前由 backend 流式事件驱动消息。
2. `src-tauri/`：Tauri 2 桌面壳，默认窗口为 `1200x756`，最小窗口为 `900x620`。
3. `backend/`：Python Agent Hub 原型，使用 uv 管理依赖，提供本地 NDJSON 流式接口；当前主线是通用 ACP adapter 与 Codex / Claude Code / opencode runtime descriptor，nanobot 仅作 legacy 兼容 adapter。
4. `scripts/dev-tauri.ps1`：Windows 本地开发启动脚本，会临时设置 VS Build Tools、Cargo PATH 和代理环境。

常用命令：

```powershell
npm install --prefix ui
npm run backend:sync
npm run ui:build
npm run tauri:dev:win
```

Windows 一键开发启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
```

如只需要启动前端浏览器调试：

```powershell
npm run ui:dev
```

如只需要单独启动 Python backend：

```powershell
npm run backend:dev
```

如需要自定义代理端口，可直接调用脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev-tauri.ps1 -Proxy http://127.0.0.1:7899
```

完整开发步骤、环境依赖、排错说明和 UI 结构说明见 `docs/guides/UI_DEVELOPMENT.md`。

## 分支开发流程

项目长期保留 `master` 和 `dev` 两个主干分支：

1. `master`：稳定发布分支，只保留发布级合并、编译发布验证和用户明确授权的紧急修正。
2. `dev`：集成测试分支，用于在合并到 `master` 前汇总功能分支、修复分支和性能优化分支，并完成合并测试。

功能开发、Bug 修复、性能优化、重构和测试补充等改动，必须从 `dev` 新建分支进行，不直接在 `master` 上开发。文档修改、参数配置、流程说明等小幅度改动允许直接在 `dev` 上修改和提交。

分支命名格式：

```text
<type>/<scope>-<MMdd>-<name>
```

示例：

```text
feat/adapter-0701-codex-runtime
feat/remote-0701-viewer-sync
fix/backend-0701-sidecar-lifecycle
perf/events-0701-stream-cache
```

`master` 分支只保留以下操作：

1. 合并已经在 `dev` 完成集成验证且包含版本升级提交的内容。
2. 在合并后执行编译、打包和发布验证。
3. 用户明确授权的紧急文档或流程修正。

所有合并尽量采用变基合并：功能分支先 `rebase dev`，再快进合并到 `dev`；`dev` 达到可发布状态后先完成集成验证，再在 `dev` 上完成独立版本升级提交，之后快进合并到 `master`。如 `dev` 与 `master` 分叉，应先 `git rebase master`，再 `git merge --ff-only dev`。

每次发布前，必须先在 `dev` 分支进行一次独立版本升级提交，然后才能合并至 `master` 并执行编译、打包和发布验证。版本升级使用统一入口，例如 `npm run version:set -- 0.1.3` 或修改 `VERSION` 后运行 `npm run version:sync`。版本提交只包含版本相关文件，不混入功能代码。

完整流程见 `docs/development/DEVELOPMENT_WORKFLOW.md`。

## 提交规范

提交信息使用 Conventional Commits 格式：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat:` | 新功能 | `feat: 增加 Codex adapter 原型` |
| `fix:` | 修复问题 | `fix: 修复远程事件重连序号错误` |
| `docs:` | 文档变更 | `docs: 更新 code-lite 架构文档` |
| `refactor:` | 重构 | `refactor: 调整 Agent Adapter 描述模型` |
| `test:` | 测试相关 | `test: 添加事件协议验证脚本` |
| `chore:` | 构建、依赖、工具链 | `chore: 更新 sidecar 打包配置` |
| `style:` | 纯格式调整 | `style: 统一 Markdown 表格格式` |
| `perf:` | 性能优化 | `perf: 优化远程同步事件缓存` |

提交规则：

1. 主语使用中文，简洁描述变更内容。
2. 一个提交对应一个清晰目标，避免把无关改动混在一起。
3. 提交前检查 `git status --short`，确认没有误加临时文件或敏感文件。
4. 不提交本地密钥、缓存、虚拟环境、日志、下载文件和运行时生成文件。
5. 如用户没有要求提交，Agent 不应主动创建 git commit。
6. 但是在有文档的情况下的话，每完成一步就提交一次，防止时间线错乱。

## 敏感信息与本地文件

以下内容不得提交：

1. API Key、Token、账号密码、私钥。
2. `.env`、本地配置、真实用户数据。
3. Python 虚拟环境、Node 依赖、Rust 编译产物。
4. 日志、下载缓存、运行时 session。
5. 包含真实仓库私密内容、用户隐私或远程连接令牌的诊断报告。

配置文件应提供示例模板，例如：

```text
config.example.json
.env.example
```

真实配置应使用 `.gitignore` 排除。

## 当前阶段约束

当前 UI 与 Tauri 桌面壳已进入原型阶段，`AGENTS.md` 只保留高频入口和协作规范；详细设计、启动流程、排错步骤和模块说明应写入 `docs/` 下的专项文档。后续 Codex、Claude Code、opencode、远程同步和权限审批等模块落地后，也应优先补充对应专项文档，再在本文件中加入简要入口。
