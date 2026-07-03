# 项目目录结构设计

本文档定义 code-lite 的目标仓库结构。当前仓库仍保留部分早期原型命名，后续迁移时应保持小步、可验证，不一次性重命名所有运行时代码。

## 根目录结构

```text
code-lite/
  docs/
  ui/
  src-tauri/
  backend/
  packages/
  scripts/
  demo/
  tests/
  assets/
  data/
  .gitignore
```

## 目录职责

### `docs/`

产品和工程文档。

核心入口：

```text
docs/
  PRD.md
  ARCHITECTURE.md
  PROJECT_STRUCTURE.md
  UI_DEVELOPMENT.md
  DEVELOPMENT_WORKFLOW.md
  AGENT_ADAPTER_REDESIGN.md
  MODEL_PROVIDER_CONFIGURATION_DESIGN.md
  REMOTE_SYNC_DESIGN.md        # 规划中
  ADR/
```

`ADR/` 用于保存架构决策记录。当某个技术选择足够重要，例如“远程同步采用 WebSocket 还是 SSE”，就可以写一篇 ADR。

历史维修或 nanobot 专项文档只作为原型资料保留，不再作为产品主方向入口。新增文档应优先围绕多 Agent、远程同步、权限审批、会话事件和运行时配置展开。

### `ui/`

桌面前端 UI 源码目录，当前采用 React + Vite。

建议结构：

```text
ui/
  AGENTS.md
  src/
    App.tsx
    pages/
      ChatPage.tsx
      SettingsPage.tsx
      RemotePage.tsx
    layout/
      AppTitlebar.tsx
      Sidebar.tsx
    components/
      MessageRenderer.tsx
      RuntimeBadge.tsx
    features/
      chat/
        ApprovalCard.tsx
        ChatComposer.tsx
        ConversationHeader.tsx
        MessageList.tsx
        ToolCallViews.tsx
        FileChangeList.tsx
        messageTools.ts
      runtime/
        RuntimePicker.tsx
        RuntimeStatusPanel.tsx
      remote/
        RemoteSessionPanel.tsx
        ViewerList.tsx
    lib/
      chatState.ts
      formatters.ts
      eventStream.ts
    services/
      agentClient.ts
      conversationStore.ts
      remoteClient.ts
      settingsClient.ts
    styles.css
    types.ts
  package.json
  tsconfig.json
  vite.config.ts
```

职责：

1. `App.tsx` 只组合全局 layout 和当前 page，不承载业务状态。
2. `pages/` 放页面级状态、effect 和业务编排。
3. `layout/` 放桌面壳稳定布局。
4. `features/chat/` 放对话、消息、工具调用、文件变更和审批组件。
5. `features/runtime/` 放 agent runtime 选择和能力展示。
6. `features/remote/` 放远程连接、观看者和授权状态。
7. `components/` 放跨功能复用组件。
8. `lib/` 放纯函数、格式化和事件状态工具。
9. `services/` 放 Tauri/backend 通信适配。
10. `ui/AGENTS.md` 记录 UI 模块的色彩、样式、组件拆分和交互规范。

### `src-tauri/`

Tauri 应用外壳和本地桌面能力目录。

建议结构：

```text
src-tauri/
  src/
    main.rs
    lib.rs
    commands/
      backend.rs
      workspace.rs
      window.rs
    sidecar/
      backend_process.rs
      protocol.rs
    security/
      permissions.rs
      audit.rs
    config/
  capabilities/
  binaries/
  tauri.conf.json
  Cargo.toml
```

职责：

1. 暴露给 UI 的 Tauri 命令。
2. Python backend sidecar 生命周期管理。
3. 打包和安装态资源管理。
4. 本地 workspace 选择和桌面集成。
5. 后续承载更强的本地权限边界、系统命令网关和审计落盘。

### `backend/`

Python Agent Hub，最终作为 sidecar 随 Tauri 应用分发。

当前目录仍使用 `code_lite_backend` 历史包名，目标职责已经转向 code-lite。后续可择机迁移为 `code_lite_backend`。

建议目标结构：

```text
backend/
  code_lite_backend/
    main.py
    app.py
    api/
      router.py
      dependencies.py
      routes/
        health.py
        conversations.py
        turns.py
        approvals.py
        settings.py
        remote.py
        runtimes.py
    agents/
      registry.py
      descriptors.py
      base.py
      codex/
        adapter.py
        events.py
        permissions.py
      claude_code/
        adapter.py
        cli.py
        events.py
      opencode/
        adapter.py
        cli.py
        events.py
      nanobot/
        adapter.py
        events.py
        hooks.py
    core/
      config.py
      encoding.py
      json_utils.py
      paths.py
    schemas/
      agent.py
      events.py
      approvals.py
      remote.py
      settings.py
    services/
      event_bus.py
      conversations.py
      approvals.py
      remote_sessions.py
      runtime_config.py
      model_config.py
    storage/
      conversations.py
      events.py
      audit.py
      settings.py
  tests/
  pyproject.toml
```

职责：

1. 提供本地 backend API 和流式事件接口。
2. 通过统一 Agent Adapter 协议隔离 Codex、Claude Code、opencode 和 nanobot。
3. 将 runtime 私有事件映射为统一 `AgentEvent`。
4. 管理会话、事件序号、审计日志和运行时配置。
5. 为远程同步提供快照、增量事件和权限控制。
6. 对敏感配置和会话导出做脱敏处理。

### `packages/`

跨层共享协议和生成类型目录。

建议结构：

```text
packages/
  protocol/
    schema/
      agent-event.schema.json
      approval.schema.json
      runtime.schema.json
      remote.schema.json
    typescript/
    python/
    rust/
```

可能用途：

1. 共享 `AgentEvent` JSON Schema。
2. 共享审批对象和远程连接对象定义。
3. 共享 runtime descriptor。
4. 生成 TypeScript、Python 或 Rust 类型。

### `demo/`

原型和 SDK 探针目录。

现有内容：

1. nanobot CLI 审批 demo。
2. Codex adapter probe。

后续可新增：

```text
demo/
  claude_code_adapter_probe.py
  opencode_adapter_probe.py
  remote_sync_probe.py
```

demo 可以调用模型或启动 runtime 的脚本必须在 README 中明确说明风险、环境变量和是否会写 workspace。

### `scripts/`

开发、打包、版本和验证脚本目录。

建议结构：

```text
scripts/
  dev/
  build/
  package/
  verify/
  migration/
```

可能脚本：

1. 启动 UI 和 backend 开发环境。
2. 构建 Python sidecar。
3. 打包 Tauri 应用。
4. 校验 protocol schema。
5. 运行 lint、测试和静态检查。
6. 执行命名迁移和版本同步。

### `tests/`

跨层集成测试和测试夹具目录。

建议结构：

```text
tests/
  fixtures/
  integration/
  e2e/
  remote/
```

单元测试应尽量靠近具体实现。根目录 `tests/` 主要放跨模块、跨语言或端到端测试。

### `assets/`

产品静态资源目录。

建议结构：

```text
assets/
  icons/
  branding/
  screenshots/
```

不要把用户仓库、模型输出、会话记录、日志、下载缓存或远程令牌放在这里。

## 运行时数据

运行时数据不应提交到 git。

目标本地运行时目录：

```text
data/
  config/
    app_config.json
    model_config.json
    runtime_config.json
  conversations/
  events/
  logs/
  remote/
  cache/
```

兼容期可能仍存在：

```text
data/
  config/
    nanobot_config.json
  record/
```

这些属于早期原型命名，迁移时应提供兼容读取和一次性迁移，避免破坏已有用户数据。

## 初始目录创建策略

推荐第一阶段按这个顺序推进：

1. 固化 `AgentEvent`、`AgentAdapterDescriptor` 和审批对象 schema。
2. 在现有 backend 包名下补齐 Codex、Claude Code、opencode descriptor。
3. 完成 Codex adapter 原型。
4. 建立 `remote` API 和只读事件订阅。
5. 将 UI 增加 runtime 状态和远程观看入口。
6. 验证链路稳定后，再规划包名和产物名迁移。

## 命名迁移建议

从旧原型迁移到 code-lite 时，建议分批处理：

1. 文档和 UI 文案。
2. package name、Tauri product name、窗口标题和发布产物名。
3. Python 包名和 Rust crate 名。
4. 运行时目录名，例如从 `~/.repair-agent` 迁移到 `~/.code-lite`。
5. 旧配置自动迁移和兼容读取。

每批迁移都应单独验证，避免把产品改名和业务功能变更混在一起。
