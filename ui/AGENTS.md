# UI 模块协作规范

本文约束 `ui/` 前端模块的目录结构、组件拆分、视觉风格和样式写法。根目录 `AGENTS.md` 的 UTF-8、保护用户改动、禁止敏感信息、禁止 emoji 等规则同样适用于本目录。

## 目录结构

当前 UI 采用 React + Vite + Tauri 2，按职责拆分：

```text
ui/
  package.json            # 前端依赖与脚本（dev/build/tauri）
  vite.config.ts          # Vite 构建配置
  index.html              # HTML 入口
  AGENTS.md               # 本文档
  src/
    main.tsx              # React 入口，初始化主题系统
    App.tsx               # 应用根组件（.app-shell 布局壳）
    styles.css            # 全局 CSS 变量定义 + 主题变量（含暗黑模式）
    types.ts              # 共享前端类型
    lib/                  # 纯函数、格式化、状态工具
      chatState.ts
      formatters.ts
    services/             # 后端/Tauri 通信
      agentClient.ts      # Agent 流式运行、审批决策
      conversationStore.ts # 会话列表、消息读写
      settingsStore.ts    # 后端设置 API
      themeStore.ts       # 主题与外观状态管理
      localTransport.ts   # WebSocket 传输层
    components/           # 跨功能复用基础组件
      AgentIcon.tsx/.css  # Agent 图标（mask/image 两种模式）
      MessageRenderer.tsx/.css # Markdown 消息渲染器
    features/             # 领域业务组件
      chat/
        ChatWorkspace.tsx/.css    # 聊天工作区容器
        ChatComposer.tsx/.css     # 输入框 + 模型/模式选择器
        MessageList.tsx/.css      # 消息列表渲染
        ConversationHeader.tsx/.css # 对话标题栏
        ToolCallViews.tsx/.css    # 工具调用展示（diff/编辑/命令）
        ApprovalCard.tsx/.css     # 审批卡片
        AgentSelectionPanel.tsx/.css # 新建会话 Agent 选择
        ContextRing.tsx/.css      # 上下文环（运行态指示）
        ImagePreview.tsx/.css     # 图片预览
        InputRequestCard.tsx/.css # 输入请求卡片
        PlanProgressPanel.tsx/.css # 计划进度面板
        TokenUsageModal.tsx/.css  # Token 用量弹窗
    layout/               # 稳定布局组件
      AppTitlebar.tsx/.css # 自定义标题栏（窗口控制）
      Sidebar.tsx/.css    # 侧边栏（会话列表 + 导航）
      sidebar/
        SidebarGroupHeader.tsx/.css  # 会话分组头部
        SidebarSessionItem.tsx/.css # 会话条目
    pages/                # 页面级状态与业务编排
      ChatPage.tsx        # 聊天主页面（会话管理、视图调度）
      OverviewPage.tsx/.css # 总览页面（用量/会话概览）
      SettingsPage.tsx    # 设置页面入口（re-export）
      settings/           # 设置子页面
        types.ts          # SettingsSection 类型定义
        SettingsPage.tsx  # 设置页面容器（section 切换逻辑）
        SettingsLayout.tsx # 设置页面布局（侧边栏导航 + 内容区）
        SettingsPage.css  # 设置页面共享样式（最大，~1566 行）
        AppearanceSettings.tsx     # 外观设置（主题/字体/配色）
        AgentRuntimeSettings.tsx   # Agent Runtime 配置
        AcpConnectionSettings.tsx  # ACP 连接管理
        ModelProvidersSettings.tsx # 模型提供商配置
        LogsSettings.tsx           # 日志查看器
        ArchivedSessionsSettings.tsx # 归档会话管理
        RemoteControlSettings.tsx/.css # 远程控制
        AboutSettings.tsx          # 关于页面
        components/
          SettingsSelect.tsx       # 自定义下拉选择器
```

拆分原则：

1. `App.tsx` 不承载业务状态，只组合全局 layout 和 page。
2. `pages/` 管理页面级状态、effect 和服务调用。
3. `layout/` 只放稳定布局（标题栏、侧边栏）。
4. `features/` 放领域组件（聊天、审批、工具调用）。
5. `components/` 放跨功能复用组件，避免混入页面业务。
6. `lib/` 中只放无副作用工具函数。
7. `services/` 只处理外部通信，不直接操作 React state。

## 色彩规范

所有颜色使用 **语义化 CSS 变量**，定义在 `styles.css` 的 `:root` 中。配色基于 Happy Hues Palette 11。

### 变量定义（`styles.css`）

```css
:root {
  /* 背景 */
  --bg-primary: #f9f4ef;        /* 页面主背景 */
  --bg-secondary: #eaddcf;      /* 卡片/面板背景 */
  --bg-tertiary: #f3f2f0;       /* 侧边栏背景 */
  --bg-elevated: #fbfbfa;       /* 输入框/浮层/模态框 */
  --bg-elevated-alpha: rgba(251, 251, 250, 0.94); /* 半透明抬高背景（标题栏） */

  /* 文本 */
  --text-primary: #020826;      /* 标题、主文本 */
  --text-secondary: #716040;    /* 正文 */
  --text-tertiary: #8b9096;     /* 辅助说明 */
  --text-muted: #6f747b;        /* 占位符、弱化文本 */
  --text-inverse: #fffffe;      /* 深色背景上的文字 */

  /* 边框 */
  --border-primary: #dedbd7;
  --border-secondary: #e4e0dc;
  --border-tertiary: #eeebe7;

  /* 交互 */
  --accent-primary: #8c7851;    /* 按钮、链接 */
  --accent-secondary: #eaddcf;
  --accent-danger: #f25042;     /* 删除、危险操作 */

  /* 状态 */
  --color-success: #12845a;
  --color-warning: #9f5b00;
  --color-info: #1677ff;
  --color-error: #f25042;

  /* 交互遮罩 */
  --hover-overlay: rgba(2, 8, 38, 0.06);
  --active-overlay: rgba(2, 8, 38, 0.08);

  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(32, 36, 43, 0.05);
  --shadow-md: 0 14px 36px rgba(32, 36, 43, 0.14);
  --shadow-lg: 0 18px 50px rgba(30, 35, 42, 0.08);

  /* 字体 */
  --font-family-base: Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
  --font-family-mono: Consolas, "Cascadia Mono", "SFMono-Regular", ui-monospace, monospace;
  --font-size-base: 14px;
  --font-size-sm: 12px;
  --font-size-lg: 16px;
  --font-size-xl: 20px;
  --font-size-2xl: 24px;

  /* 间距 */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;

  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 999px;

  /* 过渡 */
  --transition-fast: 0.1s ease;
  --transition-base: 0.15s ease;
  --transition-slow: 0.22s ease;
}
```

### 暗黑模式（`[data-theme="dark"]`）

`styles.css` 中通过 `[data-theme="dark"]` 选择器覆盖上述变量，自动切换浅色/深色配色。切换由 `themeStore.ts` 的 `setThemeMode()` 控制。

### 旧变量兼容（禁止新增使用，仅保留兼容）

```
--panel    → var(--bg-elevated)
--sidebar  → var(--bg-tertiary)
--line     → var(--border-primary)
--muted    → var(--text-muted)
--subtle   → var(--text-tertiary)
--blue     → var(--color-info)
--green    → var(--color-success)
--orange   → var(--accent-danger)
```

### 色彩使用原则

1. **所有颜色必须使用 `var(--xxx)` 引用**，禁止硬编码 hex 值。
2. 背景以 `--bg-primary`（页面）、`--bg-elevated`（卡片/输入框）为主。
3. 边框以 `--border-primary` / `--border-secondary` 为主。
4. 主文本使用 `--text-primary`，次级文本使用 `--text-muted` / `--text-tertiary`。
5. 状态色只用于状态表达（success/green、warning/orange、error/red、info/blue）。
6. 新增颜色前先确认是否能复用现有 token。
7. **允许保留的情况**：`rgba()` 透明度遮罩、语义状态标签色（如 `#edf8f2` 成功标签）、access-mode 功能色调。

---

## 主题与外观切换

### 机制

通过 `<html data-theme="light|dark">` 属性切换。`styles.css` 在 `:root`（浅色）和 `[data-theme="dark"]`（深色）中分别定义变量。

### 状态管理（`services/themeStore.ts`）

三种模式：`"light"` / `"dark"` / `"system"`（跟随操作系统 `prefers-color-scheme`）。偏好持久化到 `localStorage`（key: `code-lite-appearance`）。

### Hooks

```typescript
import { useTheme, useThemeMode, useResolvedTheme, useAppearance } from "./services/themeStore";

const { mode, resolved } = useTheme();    // { mode: "system", resolved: "dark" }
const [mode, setMode] = useThemeMode();    // 双向绑定
const resolved = useResolvedTheme();       // "light" | "dark"
const appearance = useAppearance();        // 完整外观状态（主题+字体+字号）
```

### 字体切换

通过 `--font-family-base` 和 `--font-size-base` 变量动态控制。预设字体族定义在 `themeStore.ts` 的 `FONT_PRESETS` 常量中，支持自定义字体名称输入。

## 样式写法

1. 默认继续使用全局 `styles.css`，新增类名按组件语义命名。
2. 不引入 CSS-in-JS 或新的样式框架，除非先更新本文档并说明原因。
3. 样式以稳定尺寸和响应约束为主，避免 hover、文本变化或状态切换导致布局跳动。
4. 不使用 viewport 宽度驱动字体缩放。
5. 文本必须能在最小窗口 `900x620` 下正常容纳，不应重叠或溢出按钮。
6. 表格、代码块、工具结果等长内容必须可滚动或换行。
7. 聊天主内容宽度优先沿用 `width: min(760px, 100%)`。
8. 底部 composer 和审批卡片应保持同宽、贴齐、层级明确。

## 设置页面规范

每个设置 section 必须包裹在 `<section className="settings-content-column">` 中，使用标准卡片和表单类名。

### 页面结构

```tsx
<section className="settings-content-column">
  <div className="settings-page-heading">
    <span className="eyebrow">分类标签</span>
    <h1>页面标题</h1>
  </div>
  <div className="settings-card">
    <h3 style={{ margin: "0 0 4px", color: "var(--text-primary)", fontSize: "15px", fontWeight: 600 }}>
      区块标题
    </h3>
    <p style={{ margin: "0 0 16px", color: "var(--text-muted)", fontSize: "13px" }}>
      区块描述
    </p>
    {/* 表单控件 */}
  </div>
</section>
```

### 常用 CSS 类

| 类名 | 用途 |
|------|------|
| `settings-content-column` | 内容列容器（限宽居中，max 1008px） |
| `settings-page-heading` | 页头（eyebrow + 标题） |
| `settings-card` | 白色卡片容器（border + bg + padding） |
| `settings-field` | 表单字段（label + input 垂直排列） |
| `settings-primary-button` | 主操作按钮 |
| `settings-secondary-button` | 次要操作按钮 |
| `settings-danger-button` | 危险操作按钮 |
| `settings-select` / `SettingsSelect` | 自定义下拉选择器 |

### 新增设置页面步骤

1. 在 `settings/types.ts` 的 `SettingsSection` 类型中添加 ID
2. 在 `settings/SettingsLayout.tsx` 的 `settingsMenu` 数组中添加菜单项（图标 + 标签）
3. 在 `settings/SettingsPage.tsx` 中添加条件渲染（导入组件 + 三元表达式）
4. 组件内部使用 `settings-card` + `settings-field` 等标准类名
5. 如果需要独立的 CSS 文件，所有颜色必须用 `var(--xxx)`

### 设置页面菜单顺序

当前顺序：外观 → Agent Runtime → ACP 连接管理 → 模型提供商配置 → 日志 → 归档会话 → 远程控制 → 关于

## 组件交互规范

1. 审批卡片显示在输入框上方，不进入消息历史。
2. 审批卡片默认展示 runtime、工具名、风险、用途和参数摘要，详情展开后再展示完整入参、影响、风险和恢复方式。
3. 工具调用运行中和等待审批时展示入参。
4. 工具调用完成后默认折叠，展开后同时展示入参和输出。
5. 连续工具调用使用工具组折叠，折叠态只展示“已调用 xx 个工具”。
6. 对话界面底部不放固定推荐技能按钮，runtime 选择、workspace 状态和远程观看状态应放在稳定的头部或侧栏区域。
7. 用户消息使用纯文本换行，assistant 消息使用 `streamdown` 渲染 Markdown。
8. 文件变更、命令输出、token usage 和远程观看者状态应有可扫描的紧凑视图。
9. Runtime 能力差异要用状态和提示表达，不把 SDK 私有术语作为主要用户文案。

## 数据与服务边界

1. 主消息记录不写入浏览器 `localStorage`，由 backend conversation API 存储到 data 目录。
2. `localStorage` 只允许保留一次性旧数据迁移逻辑，不新增新的主状态存储。
3. `agentClient.ts` 负责 Agent 流式运行、审批决策和取消。
4. `conversationStore.ts` 负责会话列表、会话创建、消息读写。
5. 后续新增 `remoteClient.ts` 时，只负责远程连接状态、观看者列表和事件订阅，不直接改写聊天状态。
6. API Key、Token、真实用户仓库隐私、远程连接令牌不得写入 UI 文件。

## 验证

UI 改动完成后至少执行：

```powershell
npm run ui:build
```

如改动涉及 Tauri API、窗口行为或 backend 通信，还应按根目录文档执行相应 backend/Tauri 检查。
