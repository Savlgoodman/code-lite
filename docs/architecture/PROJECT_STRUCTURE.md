# 项目目录结构设计

> 更新于 2026-07-10：双端统一同步协议大重构完成

## 根目录结构

```text
code-lite/
  backend/           Python Agent Hub（sidecar）
  ui/                桌面前端（Tauri WebView）
  ui-remote/         远端前端（任意设备浏览器）
  proxy_server/      中继服务器（可部署在公网）
  packages/          跨层共享协议包
  src-tauri/         Tauri 桌面壳（Rust）
  scripts/           开发、打包、版本脚本
  docs/              产品、架构、设计文档
  data/              运行时数据（不提交 git）
  demo/              ACP 探针和原型
  ref/               参考资料（VibeX 等）
```

## 共享协议包 `packages/`

所有跨层共享的协议、类型和纯逻辑都集中在这里。**不含 React 依赖**。

```text
packages/
  protocol/          AgentEvent 类型定义 + 线协议信封
    src/
      domain.ts      AgentEvent union、Session、ChatMessage、SessionCapabilities
      wire.ts        WireEnvelope、WireMethod、WireControlType
      index.ts       导出入口
    package.json     @code-lite/protocol

  transport/         WebSocket 传输抽象
    src/
      transport.ts   Transport 接口、TransportStatus、TransportError
      ws-transport.ts WsTransport 基类（统一 connect/request/subscribe/onEvent）
      index.ts       导出入口
    package.json     @code-lite/transport（依赖 protocol）

  sync/              双端统一同步协议
    src/
      types.ts       同步消息类型（session.running / config.batch / presence.*）
      manager.ts     SyncManager 核心类（feedEvent + 事件监听 + 主动操作）
      state-tracker.ts 运行态追踪器
      config-syncer.ts 配置同步器
      constants.ts   SyncEvents 常量 + isSyncEvent / extractSyncPayload
      index.ts       导出入口
    package.json     @code-lite/sync（依赖 protocol + transport）

  chat-core/         纯 reducer + 共享状态层（无 React 依赖）
    src/
      conversationClient.ts  ConversationClient 框架无关状态层
      sessionReducer.ts      reduceAgentEvent（单会话视图态 reducer）
      conversationList.ts    applyConversationListEvent（列表 reducer）
      messageReducer.ts      updateMessage / upsertToolCall / mergeMessagePlan
      modelGrouping.ts       groupModelsByFamily（模型族/思考强度二级联动）
      planSnapshots.ts       plan 快照工具
      index.ts               导出入口
    package.json     @code-lite/chat-core（依赖 protocol + sync + transport）
```

## 桌面前端 `ui/`

React + Vite + Tauri WebView。通过 `@code-lite/*` 别名引用 packages。

```text
ui/
  src/
    pages/
      ChatPage.tsx           主页面：会话编排 + 桌面独有逻辑（~1300 行）
                             - draft session 管理
                             - per-session capabilities/config 加载
                             - 图片附件上传
                             - codex/fast mode 特殊处理
                             - 状态全部来自 ConversationClient
      OverviewPage.tsx       总览页
      SettingsPage.tsx       设置页（远端控制、模型配置）
      settings/
        RemoteControlSettings.tsx  远端控制配置（pair key、relay URL）
    layout/
      Sidebar.tsx            侧栏（会话列表、搜索、归档）
      AppTitlebar.tsx        标题栏
    features/
      chat/
        ChatWorkspace.tsx    主工作区容器
        ChatComposer.tsx     输入框 + 附件 + 审批/输入卡片
        MessageList.tsx      消息流渲染
        ToolCallViews.tsx    工具调用视图（Bash/Edit/Read/Glob/Grep/Write）
        ApprovalCard.tsx     审批卡片
        InputRequestCard.tsx 输入请求卡片
        ConversationHeader.tsx 会话头部（标题、模型选择器、思考强度）
        ContextRing.tsx      上下文用量环
        PlanProgressPanel.tsx Plan 进度面板
        messageTools.ts      消息相关工具函数
        draftImages.ts       图片附件状态管理
        chatTypes.ts         本地类型
    services/
      agentClient.ts         getConversationClient 单例 + ensureBackend
      localTransport.ts      LocalWsTransport（直通 WsTransport 子类）
      useConversations.ts    useSyncExternalStore hook（React 绑定）
      conversationStore.ts   会话 API（现在全走 WS RPC）
      settingsStore.ts       设置 API
      billingStore.ts        计费 API
    lib/
      chatState.ts           StoredState + normalizeStoredState
      formatters.ts          格式化工具
    types.ts                 前端类型定义
    App.tsx                  顶层路由
  package.json
  tsconfig.json              paths 映射 @code-lite/* → ../packages/*/src
  vite.config.ts             alias 映射 @code-lite/*
```

## 远端前端 `ui-remote/`

React + Vite。与桌面端**完全同源**——共享 `ConversationClient` + `WsTransport` 基类。

```text
ui-remote/
  src/
    App.tsx                  远端工作台
                             - 配对页（relay URL + pair key）
                             - 会话列表页（显示运行态 + 新建按钮）
                             - 会话页（消息流 + 模型选择器 + 终止按钮）
                             - 状态来自 ConversationClient（与桌面同源）
    services/
      RelayTransport.ts      RelayWsTransport（中继 WsTransport 子类）
                             - 裹/拆 {type:"msg"} 外层
                             - hello/ready 握手
                             - 心跳 + host.online/offline
      useConversations.ts    useSyncExternalStore hook
    main.tsx                 入口
    styles.css               样式
  package.json
  tsconfig.json              paths 映射 @code-lite/*
  vite.config.ts             alias 映射
```

## 中继服务器 `proxy_server/`

FastAPI WebSocket 中继，可在公网部署。不解析业务 payload。

```text
proxy_server/
  main.py                FastAPI 应用
                         - /ws 端点（接受 host 和 remote 连接）
                         - RoomRegistry（roomId = SHA256(pairKey)）
                         - hello/ready 握手
                         - 盲转发 msg 帧
                         - 心跳 20s ping/pong
                         - /health 管理端点
```

## Python Backend `backend/`

```text
backend/
  code_lite_backend/
    main.py              uvicorn 入口
    app.py               FastAPI 应用构建 + 生命周期钩子
    
    api/
      router.py          路由注册
      dependencies.py    get_services 依赖注入
      routes/
        ws.py            /api/ws WebSocket 端点（所有 RPC handler 共用）
                         - subscribe / unsubscribe
                         - turn.start / turn.cancel
                         - conversation.list / get / create / archive / delete
                         - conversation.config.update
                         - session.initialize
                         - approval.decision / input.response
                         - diff.get
                         - remote.config.* / remote.peer.*
        turns.py         turn 生命周期
                         - prepare_and_start_turn
                         - run_turn_task（turn 执行 + 事件广播）
                         - turn.lock / turn.unlock（串行互锁）
        conversations.py HTTP 会话 API（部分已被 WS RPC 取代）
        sessions.py      session.initialize_core（capabilities）
        approvals.py     审批 API
        settings.py      运行时配置 API
    
    agents/
      acp/
        adapter.py       AcpAgentAdapter（通用 ACP 主线）
                         - stream_turn / cancel_turn
                         - ACP stdio client 管理
        client.py        ACP 子进程 client
        approvals.py     审批适配
        capabilities.py  capabilities 提取
        mapper.py        AgentEvent 映射
      runtimes/
        descriptors.py   RuntimeDescriptor 注册
        profiles.py      runtime profile（config / fast mode）
      claude_code/       Claude Code descriptor
      codex/             Codex descriptor
      nanobot/           legacy 兼容
    
    core/
      config.py          配置加载
      encoding.py        编码工具
      paths.py           路径工具
    
    schemas/
      agent.py           Pydantic 模型（AgentEvent / AgentRunRequest）
      events.py          事件 schema
      approvals.py       审批 schema
    
    services/
      event_bus.py       SessionEventBus（进程内 pub/sub）
                         - 按 conversationId 分频道
                         - publish 向频道所有订阅者 fan-out
      conversation_recorder.py  活动态会话状态管理
                         - turn 执行时更新 session.json
                         - status: running / idle / error / approval
      remote_bridge.py   远端桥接
                         - 主动 dial out 到 relay（NAT 穿透）
                         - 多 peer 多路复用（_PeerSession）
                         - 权限模型（pending / viewer / operator）
                         - 注入 _startedBy / _changedBy 来源标记
      sync_protocol.py   同步协议辅助
                         - SyncEvents 常量
                         - create_sync_event / broadcast_to_all
      runtime_config.py  运行时配置
      model_config.py    模型配置
    
    storage/
      conversations.py   ConversationStore
                         - session.json / messages.json 读写
                         - list_sessions / get_conversation
                         - 原子写入（atomic_write_json）
      event_store.py     事件持久化
      attachments.py     附件存储
  
  tests/                 后端测试
    test_turn_lifecycle.py
    test_ws_event_bus.py
    ...
  
  pyproject.toml         依赖管理（uv）
```

## Tauri 桌面壳 `src-tauri/`

```text
src-tauri/
  src/
    main.rs              入口
    lib.rs               Tauri command 注册
    commands/            Tauri command 实现
      backend.rs         ensure_backend（启动/监控 sidecar）
  tauri.conf.json        Tauri 配置
  Cargo.toml             Rust 依赖
```

## 运行时数据 `data/`

不提交到 git。

```text
data/
  record/                会话目录
    <conversation_id>/
      session.json       会话元数据（config / status / archived）
      messages.json      消息流
      native-session.json native ACP session 绑定
  config/
    app_config.json      全局配置
    agent_runtimes.json  runtime 注册
    remote_bridge.json   远端中继配置（pair_key / relay_url）
  runtimes/
    acp/                 ACP runtime 二进制
  events/                事件日志
  logs/                  运行日志
  cache/                 缓存
```

## 开发工具 `scripts/`

```text
scripts/
  sync-ui-deps.ps1       同步 ui 依赖（npm ci）
  dev-tauri.ps1          启动 Tauri 开发环境
  package-windows.ps1    Windows 打包
  set-version.ps1        版本同步
```

## 文档 `docs/`

```text
docs/
  README.md              文档入口
  architecture/
    ARCHITECTURE.md      总体架构（双端统一同步协议）
    PROJECT_STRUCTURE.md 本文件
  design/                专项设计文档（按日期编号）
    0709-REMOTE-CONTROL-DUAL-SYNC.md    远端双端同步（阶段一）
    0710-REMOTE-CONTROL-PROTOCOL-FIX.md 远端协议修复
    0710-UNIFIED-SYNC-PROTOCOL.md       统一同步协议设计
    0710-DUAL-END-UNIFICATION-REFACTOR.md 双端统一大重构方案
    ...
  development/           开发工作流
  guides/                使用指南（PRD、构建发布、UI 开发）
  refactor/              重构记录
  research/              技术调研（ACP、backend）
```

## 目录职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| AgentEvent 类型 | `packages/protocol` | 双端共享类型定义 |
| WebSocket 传输 | `packages/transport` | WsTransport 基类 + 两个子类 |
| 双端同步协议 | `packages/sync` | SyncManager + 事件类型 |
| 纯 reducer | `packages/chat-core` | reduceAgentEvent（无 React） |
| 状态层 + React 绑定 | `packages/chat-core` + `ui*/services` | ConversationClient + useConversations |
| 桌面独有逻辑 | `ui/pages/ChatPage` | draft session、caps、图片、fast mode |
| 远端独有逻辑 | `ui-remote/App.tsx` | 配对页、host.online/offline |
| RPC handler | `backend/api/routes/ws.py` | 所有 WS RPC 共用 |
| 事件总线 | `backend/services/event_bus.py` | 进程内 pub/sub |
| 远端桥接 | `backend/services/remote_bridge.py` | 主动 dial out + peer 管理 |
| 同步协议广播 | `backend/services/sync_protocol.py` | sync 事件构造 + 广播 |
| 会话存储 | `backend/storage/conversations.py` | session.json + messages.json |
| 中继服务器 | `proxy_server/main.py` | 盲转发 + 房间注册 |
