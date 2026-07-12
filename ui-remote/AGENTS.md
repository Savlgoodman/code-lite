# ui-remote 开发指导

code-lite 的移动端远程控制界面（React 18 + TypeScript + Vite，Capacitor 打包 Android）。
通过 Relay 连接桌面端 code-lite，远程浏览工作区目录、管理会话、与 AI agent 对话。

本文件是给人和 AI 协作者的**约定基线**。改动 UI 前先读这里，保持与既有模式一致，
不要另起炉灶。

---

## 技术栈

- **框架**：React 18（函数组件 + hooks，不用 class 组件）
- **语言**：TypeScript，`strict` 全开，`noUnusedLocals` / `noUnusedParameters` 生效
- **构建**：Vite；`npm run build` = `tsc && vite build`
- **图标**：`lucide-react`
- **Markdown 渲染**：`streamdown`（见 `MessageRenderer`）
- **移动壳**：Capacitor（`@capacitor/preferences` 持久化、`android/` 原生工程）
- **协议 / 通信**：workspace 包 `@code-lite/protocol`、`@code-lite/chat-core`、
  `@code-lite/sync`、`@code-lite/transport`（经 tsconfig paths 与 vite alias 指向 `../packages/*/src`）

改动后**必须**跑 `npm run build` 确认 `tsc` 与打包都通过再提交。

---

## 目录结构

```
src/
  main.tsx              # 入口：挂载 App，引入 streamdown 与 styles/index.css
  App.tsx               # 应用外壳：Tab 状态、连接生命周期、HomePager + NavHost 组合

  pages/                # 整页级视图（占满视口的独立页面）
    ChatPage.tsx        #   会话页：消息流 / 输入区 / 配置栏 / 上下文弹窗

  tabs/                 # 底部 Tab 对应的四个主页面板
    RemoteTab.tsx       #   远程：按项目分组的会话列表
    AiTab.tsx           #   AI：独立对话模块（会话列表；环境不可用时显示“仅 App 可用”）
    DevicesTab.tsx      #   设备：多设备管理
    SettingsTab.tsx     #   设置：外观（主题/深色）等

  sheets/               # 底部抽屉式弹层（都基于 components/ui/Sheet）
    AddDeviceSheet.tsx
    ConfigSheet.tsx
    DirectoryBrowser.tsx
    NewConversationSheet.tsx

  components/           # 可复用展示组件
    ui/                 #   与业务无关的 UI 原子（见下），统一从 index.ts 桶导出
    HomePager.tsx       #   主界面横向分页容器（Tab 平移 + 手指拖拽）
    NavHost.tsx         #   遍历导航栈渲染整页（配合 ui/ScreenTransition 统一转场）
    DetailOverlay.tsx   #   会话内详情页的页面切换（DetailContent，转场交给导航栈）
    AgentIcon.tsx       #   agent 图标
    ConfigBar.tsx       #   会话页配置信息栏（模型/访问模式/思考强度 chip）
    MessageBubble.tsx   #   单条消息
    MessageRenderer.tsx #   streamdown Markdown 渲染

  hooks/                # 可复用逻辑 hook
    useConversations.ts #   订阅 ConversationClient 状态快照
    useSessionConfig.ts #   拉取/同步单会话的模型/强度/访问模式配置
    useTheme.ts         #   主题（配色方案）与明暗模式

  services/             # 无 UI 的单例 / 类：连接、存储、传输
    ConnectionManager.ts
    DeviceStore.ts
    RelayTransport.ts

  lib/                  # 纯函数工具
    formatters.ts

  styles/               # 全部 CSS（见「样式系统」）
    index.css tokens.css base.css ui.css navigation.css
    lists.css chat.css sheets.css markdown.css

  assets/               # agent 图标等静态资源
```

### 新代码放哪里（放置逻辑）

按「它是什么」而不是「它属于哪个功能」来分层：

| 你要加的东西 | 放到 | 判断依据 |
|---|---|---|
| 占满整个视口的页面 | `pages/` | 有自己的 header、独立于 Tab 结构 |
| 底部 Tab 的一个面板 | `tabs/` | 挂在 `App` 的 `TABS` 数组里，随 Tab 切换 |
| 底部抽屉弹层 | `sheets/` | 从底部滑入，基于 `Sheet` 组件 |
| 跨页面复用、与业务无关的 UI 原子 | `components/ui/` | 不 import 任何 service/hook，纯展示 |
| 复用的展示组件（可含少量业务） | `components/` | 被多处引用，但不够“原子” |
| 可复用的有状态逻辑 | `hooks/` | 以 `use` 开头，返回状态/操作 |
| 连接、存储、传输等无 UI 逻辑 | `services/` | 单例或类，不 import React |
| 纯函数（格式化、计算） | `lib/` | 无副作用、无状态、易单测 |

原则：
- **UI 原子零业务依赖**——`components/ui/` 里的东西不得 import `services/`、`hooks/`
  或 `@code-lite/*`。它们只认 props。业务数据在 `pages`/`tabs`/`sheets` 里取好再传进去。
- **service 是单例**——`connectionManager`、`deviceStore` 以单例导出，组件直接 import 用，
  不要在组件里 new。
- **状态尽量上提到最近的公共祖先**。例：会话浮层 `activeSessionId` 放在 `App`，
  而非某个 Tab 内部，这样 Tab 切换与会话浮层能共存。

---

## 色彩使用条例

**唯一铁律：任何颜色都必须走 CSS 变量，禁止在样式里写死十六进制/rgb。**
所有令牌定义在 `styles/tokens.css`。硬编码颜色会破坏主题与深色模式。

（唯一例外：`EffortSlider` 最高挡的 WebGL 火焰与其暗色底，是刻意的、脱离主题的
特效层，颜色写死在 shader 与该组件样式里，勿模仿这一处。）

### 主题机制

颜色令牌按 `data-theme`（`mono` / `warm`）× `data-mode`（`light` / `dark`）四种组合定义，
挂在 `<html>` 上。`mono` = 黑白调（默认），`warm` = Happy Hues 11（暖奶油）。
由 `hooks/useTheme.ts` 读写 `localStorage` 并同步 `<html>` 属性；`index.html` 有内联脚本
在首屏前套用，避免闪白。**新增颜色令牌时，四种组合都要给值**，否则切主题/深色会缺色。

### 语义色令牌（写组件时用这些，别用具体颜色名）

中性 / 表面：

| 令牌 | 用途 |
|---|---|
| `--bg` | 页面背景 |
| `--panel` | 卡片 / 面板 / 抽屉背景 |
| `--surface` | 更实的表面（如 Tab 栏） |
| `--sidebar` | 次级背景（代码块头、轨道底） |
| `--hover` / `--active` | 悬停 / 按下态背景 |
| `--line` | 分隔线 / 边框 |
| `--text` | 主文字 |
| `--muted` | 次要文字 |
| `--subtle` | 更弱的文字 / 占位符 |

强调 / 功能：

| 令牌 | 用途 |
|---|---|
| `--accent` / `--accent-pressed` | 主强调（主按钮、填充）与其按下态 |
| `--on-accent` | 强调色上的文字（保证对比） |
| `--green` / `--green-soft` | 成功 / 在线 / 空闲 |
| `--orange` / `--orange-pressed` / `--orange-soft` | 危险 / 取消 / 离线 |

语义色（跨主题恒定，定义在 `:root`，勿主题化）：
`--tone-codex-full`、`--tone-claude-*`（bypass/accept/plan/auto/dontask）、
`--tone-effort-xhigh|max|ultra`——专用于会话配置栏 chip 与思考强度标签。

### 用法示例

```css
/* ✅ 对：走令牌 */
.my-card { background: var(--panel); color: var(--text); border: 1px solid var(--line); }

/* ❌ 错：写死颜色，切主题即失效 */
.my-card { background: #fbfbfa; color: #1f2328; }
```

### 其它设计令牌

| 类别 | 令牌 | 说明 |
|---|---|---|
| 圆角 | `--radius-sm/md/lg/xl/pill` | 8 / 10 / 16 / 20 / 999px |
| 阴影 | `--shadow-card/pop/fab/toast` | 由弱到强 |
| 动效时长 | `--dur-fast/base/slow` | 0.15 / 0.25 / 0.32s |
| 缓动 | `--ease-standard` / `--ease-page` | 通用 / 页面转场 |
| 层级 | `--z-fab/tabbar/chat/modal/toast` | 99 / 100 / 150 / 200 / 300 |

写间距、圆角、动画时长、`z-index` 时**优先用令牌**，别塞魔法数字；层级尤其要用
`--z-*`，避免 z-index 混战。

---

## 样式系统

- **全局单一 CSS 体系**，无 CSS-in-JS、无 CSS Modules。所有样式在 `styles/`，用
  BEM 味的扁平类名（`.session-item`、`.modal-sheet`），组件用 `className` 挂上。
- `styles/index.css` 是唯一入口，`@import` 顺序即层叠顺序，**不可乱**：

  ```
  tokens → base → ui → navigation → lists → chat → sheets → markdown
  ```

  令牌在最前（供全体引用），组件层在页面层之前。

| 文件 | 职责 |
|---|---|
| `tokens.css` | 全部设计令牌 + 主题定义。**只有这里能写死颜色** |
| `base.css` | reset、`html/body`、`.app-shell`、`.page-title` 等全局基元 |
| `ui.css` | `components/ui/` 原子的样式（按钮/FAB/Sheet/Select/滑块…） |
| `navigation.css` | Tab 栏、HomePager、`.screen-layer`（ScreenTransition）转场 |
| `lists.css` | 列表类页面（会话/设备/设置）、主题选择器、开关 |
| `chat.css` | 会话页：消息、输入区、配置栏、上下文、思考流光、toast |
| `sheets.css` | 抽屉内专属（agent 网格、目录浏览器等） |
| `markdown.css` | streamdown 渲染样式 |

加样式时放进语义最贴近的那个文件，别都堆进 `ui.css`。新样式引用现有令牌。

---

## 组件设置

### UI 原子（`components/ui/`，统一从 `index.ts` 桶导入）

```tsx
import { Sheet, Button, Input, Fab, EmptyState, Select, EffortSlider, Portal, ScreenTransition } from "../components/ui";
```

| 组件 | 用途 | 关键点 |
|---|---|---|
| `Button` | 通用按钮 | `variant="primary"\|"secondary"`、`block`；透传原生 button 属性 |
| `Input` | 文本输入 | 防御式读值（onChange/onInput/onBlur/onPaste + rAF 兜底），解决安卓 WebView 粘贴不触发 onChange；用 `value` + `onValueChange`，别再用裸 `<input>` 收表单值 |
| `Fab` | 悬浮操作按钮 | `variant="primary"\|"secondary"`、`active`；**经 Portal 渲染到 body**（脱离 HomePager 的 transform）；仅在所属 Tab 激活时渲染 |
| `Sheet` | 底部抽屉弹层 | 见下，所有弹窗的基座 |
| `Select` | 自定义下拉 | 内联展开面板（原生 `<select>` 面板无法跨端定制）；`options: {value,label}[]` |
| `EffortSlider` | 思考强度滑块 | 圆形滑块 + 挡位点；最高挡触发 WebGL 火焰（`useWebglFire` + `effortShaders`） |
| `EmptyState` | 空状态占位 | `icon` / `title` / children 说明文字 |
| `Portal` | 渲染到 `document.body` | 全屏浮层的逃逸舱，绕开父级 transform 裁剪 |
| `ScreenTransition` | 整页进出场转场原语 | 唯一的 rAF 相位机；`from="right"\|"bottom"`；配合 NavHost + 导航栈，别再各页自写动画 |

### Sheet：所有弹窗的基座

新增弹窗**一律基于 `Sheet`**，不要手写 `.modal-overlay`。它统一了：遮罩、圆角抽屉、
头部关闭按钮、**进场滑入 + 离场滑出动画**。

```tsx
<Sheet
  title="标题"
  onClose={() => setShow(false)}         // 离场动画结束后才触发（父组件在此卸载）
  footer={(close) => (                    // footer/children 可用渲染函数拿到 close
    <>
      <Button variant="secondary" onClick={() => close()}>取消</Button>
      <Button variant="primary" onClick={() => close(() => onSave(data))}>保存</Button>
    </>
  )}
>
  {/* body 内容 */}
</Sheet>
```

关键约定：
- 父组件仍用 `{show && <Sheet .../>}` 条件挂载；`Sheet` 内部维护 `closing` 状态，
  关闭动作先播离场动画，`animationEnd` 后才回调 `onClose` 卸载。
- **确认类操作（保存/选择）用 `close(() => 实际操作)`**，让它也走离场动画，别直接
  在 onClick 里调 `onSave` 然后瞬间卸载。
- 会「保持打开」的动作（异步创建可能失败、测试连接）**不要**预关闭，直接调各自 handler。
- 嵌套弹层（如 `NewConversationSheet` 里的 `DirectoryBrowser`）作为 `Sheet` 的兄弟节点
  渲染，各自独立。

### 导航栈（`services/navStore` + `hooks/useNav` + `components/NavHost`）

远端全应用只有一份「全屏层级」真源：**底部 Tab 是根基座**，其上叠加的所有整页
（会话页、AI 对话页、模型供应商配置及其子页、已归档页、会话内详情页）都是 `navStore`
栈的条目。导航动词只有 `push` / `pop` / `replaceTop` / `reset`（经 `useNav()` 拿到）。
**完整设计见 `docs/design/0712-REMOTE-NAV-AND-STREAMING.md`。**

- **`HomePager`**——四个 Tab 排成横向轨道，`translateX` 平移切换，支持手指拖拽
  （纵向滚动优先、边缘阻尼、过阈值提交）。向每个 pane 注入 `active` 布尔，pane 据此
  决定是否渲染 FAB 等全屏浮层（所有 pane 同时挂载，不 gate 会互相叠加）。
- **`NavHost`**——遍历导航栈，每个条目套一层 `ScreenTransition` 渲染整页；已弹出条目在
  离场动画期间保留，动画结束再卸载。
- **`ScreenTransition`（`components/ui/`）**——唯一的整页转场原语（rAF 相位机），
  收敛了旧的 ChatOverlay/AiChatOverlay/SettingsOverlay/DetailOverlay 四套重复动画。
- **系统返回**——`useSystemBack`（`App` 只调一次）把安卓 `@capacitor/app` backButton 与
  浏览器/PWA `popstate` 都接到 `navStore.back()`：优先关最上层瞬态层（经 `useDismissable`
  注册的 Sheet/预览），再弹出栈顶页面，栈到根才放行退出。

**新增页面**：在 `ScreenEntry` 增一个变体 → `NavHost` 的 `ScreenBody` 加一个 `case` →
触发处 `nav.push(...)`。转场自动统一，不要再各写一套动画，也不要在页内自建「返回」面包屑
（`onBack` 已由 NavHost 绑定为 pop，透传给 header 返回按钮即可）。新增弹层基于 `Sheet`，
并在打开时 `useDismissable` 注册关闭，使系统返回能先关它。

### 编写组件的约定

- 函数组件 + hooks；props 用 `interface` 显式声明，不用 `React.FC`。
- 事件/回调命名 `onXxx`；布尔 prop 用肯定式（`active` 而非 `inactive`）。
- 有离场/入场动画的东西，遵循「动画期间保留 DOM」模式，别一 `false` 就卸载。
- 全屏浮层（盖住 HomePager 的）必须经 `Portal`，否则会被 Tab 轨道的 transform 裁剪/错位。
- 注释、UI 文案用中文，与现有代码一致。

---

## 数据流与服务

- **`connectionManager`（单例）**——管理与桌面端的连接生命周期：存/取 Relay 配置、
  创建销毁 `ConversationClient`、设备切换重连。组件通过 `connectionManager.getClient()`
  拿 client。
- **`deviceStore`（单例）**——多设备持久化（Capacitor Preferences + localStorage 双写）、
  活跃设备追踪、legacy 配置迁移。
- **`useConversations(client)`**——`useSyncExternalStore` 订阅 client 的会话/视图快照。
- **`useSessionConfig(client, sessionId)`**——拉取并同步单会话的模型/思考强度/访问模式。
- **持久化**：设备与连接用 Capacitor Preferences（Android 可靠持久）；主题等轻量偏好
  用 localStorage。

大致数据流：`services`（连接/存储）→ `hooks`（订阅/派生状态）→ `pages`/`tabs`/`sheets`
（取数并组织）→ `components/ui`（纯展示）。数据向下流，事件通过回调向上冒泡。

---

## AI 功能的环境可用性

AI 对话是**独立于 code-lite 业务**的附加模块，直连大模型 API（`/v1/chat/completions`
与 `/v1/responses`）。它的可用性**取决于运行环境**，判定集中在 `lib/environment.ts`
的 `isAiAvailable()`，**新增任何 AI 入口都必须先过这道闸**。

### 为什么要按环境区分

浏览器的 CORS 是拦在“网页 JS 读取跨域响应”这一层的安全机制，**任何网页内代码都无法绕过**。
而多数大模型供应商（如 beeapi）不返回 `Access-Control-Allow-Origin`，甚至预检 OPTIONS
直接 403 —— 浏览器网页因此无法直连。三种环境的处理各不相同：

| 环境 | 判定 | AI 是否可用 | 请求走向 |
|---|---|---|---|
| **原生 App**（Capacitor Android/iOS） | `isNativeApp()` | ✅ 可用 | 直连目标 URL（原生 HTTP 不受 CORS 约束；后续接安卓原生模块） |
| **开发环境**（Vite dev） | `import.meta.env.DEV` | ✅ 可用 | 经同源 `/ai-proxy` 中间件转发（见 `vite.config.ts`），绕开 CORS 且保留流式 |
| **PWA / 生产静态部署** | 上面两者皆否 | ❌ 禁用 | 无 `/ai-proxy` 转发、供应商又不给 CORS 头 → 入口与页面统一显示“仅 App 可用” |

### 实现约定

- **唯一判定点**：`lib/environment.ts` 的 `isAiAvailable()`。别在组件里各自判断
  `import.meta.env` 或 `Capacitor.getPlatform()`，一律走这个函数。
- **入口 gate**：
  - `tabs/AiTab.tsx`：不可用时提前 return “仅 App 可用”空状态，不渲染会话列表/FAB。
  - `tabs/SettingsTab.tsx`：不可用时 AI 段落渲染为禁用项（`.settings-item-nav.disabled`），
    且不挂载 `AiSettingsSheet` / `AiArchivedSheet`。
- **请求转发**：HTTP 传输经 `services/httpTransport.ts` 的 seam 按环境分流——dev 走
  `/ai-proxy`，原生走 `capacitor-stream-http-v2` 原生 HTTP（绕 WebView CORS，事件桥接为
  ReadableStream 保留逐字流式）。生产 PWA 不会走到这里，因为入口已被 gate 掉。
  `aiClient` 只认 `openStream` / `collectText`，不关心底层实现。
- **`/ai-proxy` 仅存在于 dev**：它是 `vite.config.ts` 里的 dev 中间件，`vite build` 产物
  **不包含**它。若将来要在服务器上让网页版也能用 AI，需在服务器（nginx/caddy/node）
  固化一个同源反向代理，并相应放开 `isAiAvailable()` —— 但当前策略是网页版不做 AI。

三种环境的传输走向、原生插件选型与流式取舍（原生拿不到 HTTP status、须真机验证、
改动后需 `npx cap sync android`）详见 **`docs/design/0712-REMOTE-NAV-AND-STREAMING.md` 第 3 节**。

---

## 开发流程

```bash
npm run dev      # Vite 开发服务器（端口 5174）
npm run build    # tsc 类型检查 + vite 打包，提交前必跑
npm run preview  # 预览打包产物
```

- 提交前 `npm run build` 必须通过（`tsc` strict + 打包）。
- 提交信息用 conventional commits + 中文描述，与仓库历史一致，例：
  `feat(ui-remote): 新增设备卡片长按菜单`、`fix(ui-remote): 修正 Tab 栏对齐`。
- 一个改动一次提交，保持原子。
- 触摸手势（HomePager 拖拽、滑块拖动）用指针/触摸事件，桌面浏览器鼠标不一定触发，
  真机或移动模拟器验证。

### Service Worker 缓存陷阱（改代码不生效先看这里）

`ui-remote` 注册了 Service Worker（`public/sw.js`）以支持 PWA 安装，它对带 hash 的
JS 静态资源走 **cache-first**。历史上 `main.tsx` 无 dev 判断就注册 SW，导致 **改了代码
`npm run dev` 也看不到效果**：SW 返回缓存的旧 bundle，改动不生效、`console.log` 不出现，
重启 dev 也没用。桌面 `ui/` 无 SW，所以同一份共享 `packages/` 修复"桌面立即生效、
remote 死活不生效"——极易误判成逻辑/解析 bug（曾为此绕一大圈）。

约定与排错：

- **在 `ui-remote` 改代码却看不到效果时，第一反应是 SW 缓存，不要先当逻辑 bug 查。**
- 现已修复：`main.tsx` 在 `import.meta.env.DEV` 下**不注册 SW**并主动 unregister + 清
  `caches`。若仍遇旧代码：DevTools → Application → Service Workers → Unregister，
  再 Clear site data，然后硬刷新（Ctrl+Shift+R）。
- **发版/PWA 部署**：改动静态资源缓存策略或需要强制刷新时，升 `sw.js` 的 `CACHE_VERSION`
  （activate 时会清理非当前版本的缓存），否则老用户拉不到新 bundle。
- **安卓 App**：Capacitor 壳内不走 SW，但 JS 是打包进 APK 的；改动需重新 `npm run build`
  打包并重装，旧 APK 里是旧代码。

## 快速自查清单（改 UI 前后过一遍）

- [ ] 颜色全走 `var(--*)`，没有写死的十六进制/rgb（火焰特效除外）。
- [ ] 新增颜色令牌覆盖了 mono/warm × light/dark 四种组合。
- [ ] 新文件按「是什么」放进了正确的层（page/tab/sheet/ui/hook/service/lib）。
- [ ] `components/ui/` 里没有 import service/hook/`@code-lite/*`。
- [ ] 新弹窗基于 `Sheet`；确认操作走 `close(fn)` 以保留离场动画。
- [ ] 全屏浮层经 `Portal`。
- [ ] 间距/圆角/时长/层级尽量用令牌。
- [ ] 改动看不到效果时先排查 Service Worker 缓存（见「开发流程」）。
- [ ] `npm run build` 通过。




