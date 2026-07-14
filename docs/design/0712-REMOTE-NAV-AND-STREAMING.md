# 远端导航栈架构与 AI 流式环境策略

设计日期：2026-07-12

分支：`feat/remote-0712-nav-arch`

## 0. 相关文档

1. `ui-remote/AGENTS.md`（远端开发约定：目录分层、Sheet、色彩令牌、SW 缓存、AI 环境可用性）
2. `docs/design/0710-REMOTE-ANDROID-APP-DESIGN.md`（Capacitor 安卓打包设计）
3. `docs/design/0703-RUNTIME-MODEL-PROVIDER.md`（模型供应商配置）
4. `AGENTS.md`（仓库总规范与双端同步约定）

## 1. 背景与问题

用户在安卓 App（Capacitor 打包）与 PWA 中使用远端遥控界面时提出五类问题，
经排查它们同源于一个缺口：**远端没有中央导航模型**。

1. **安卓/PWA 原生返回无效**。侧滑返回、系统返回键、PWA 浏览器返回都无法返回上一屏或
   关闭弹窗。没有任何地方监听 `@capacitor/app` 的 `backButton`，也从不写入浏览器 history，
   返回手势/按键无栈可弹：安卓直接退出 App，PWA 直接离开页面。
2. **添加供应商时粘贴无法启用保存**。安卓 WebView（`captureInput: true`）下粘贴 URL/Key
   有时不触发 React 绑定的 `onChange`，受控 state 不更新，`canSave` 一直为假、保存按钮常灰，
   只有逐字手敲才生效。
3. **原生请求仍受 CORS 约束**。原生分支此前仍用浏览器 `fetch`，在 Android WebView 里同样
   撞 CORS，遇到不返回 CORS 头的供应商就失败。
4. **多余的返回面包屑**。「模型供应商配置」的获取模型页有两个返回入口：header 返回关整个
   设置浮层，页内又有一个「‹ 返回」小面包屑回列表，语义重叠、易误触。
5. **进出场动画不连贯**。`ChatOverlay` / `AiChatOverlay` / `SettingsOverlay` /
   `DetailOverlay` 各自复制同一套 rAF 相位机，`AiSettingsPage` 的子视图切换则完全没有动画。
   每新增一个页面都要重写一套转场，维护成本高、风格漂移。

## 2. 导航栈架构

### 2.1 核心模型

远端全应用只有一份「全屏层级」真源：**底部 Tab 是根基座**，其上叠加的所有整页
（会话页、AI 对话页、模型供应商配置及其子页、已归档页、会话内详情页）都是导航栈的条目。

```
services/navStore.ts   栈单例：screens: StackItem[] + 瞬态层注册表
hooks/useNav.ts        useSyncExternalStore 订阅栈快照 + 导航动词
hooks/useDismissable.ts 让 Sheet/预览等瞬态层参与系统返回
hooks/useSystemBack.ts 安卓返回键 + 浏览器 popstate 单点接线
components/NavHost.tsx  遍历栈渲染整页,每层套 ScreenTransition
components/ui/ScreenTransition.tsx  统一转场原语(rAF 相位机)
```

栈条目是判别联合 `ScreenEntry`，`kind` 决定 `NavHost` 渲染哪个页面，其余字段是页面参数：

```ts
type ScreenEntry =
  | { kind: "chat"; sessionId: string }
  | { kind: "aiChat"; conversationId: string }
  | { kind: "aiSettings" }
  | { kind: "aiSettingsProviderForm"; provider: AiProvider | null }
  | { kind: "aiSettingsPickModels"; provider: AiProvider }
  | { kind: "aiArchived" }
  | { kind: "detail"; route: DetailRoute };
```

导航动词只有四个：`push` / `pop` / `replaceTop` / `reset`。每个栈项带一个稳定 `key`，
供 React 列表与 NavHost 的离场追踪用。

### 2.2 转场原语

`ScreenTransition` 收敛了历史上四处重复的 rAF 相位机：进入前先把层停在屏幕外
（`from-right` 停右侧 / `from-bottom` 停底部），双 `requestAnimationFrame` 提交初始位后
再过渡到位；`show` 变 false 时播离场过渡，`transitionend` 后回调 `onExited` 让父级卸载。

样式全走 `styles/navigation.css` 的 `.screen-layer`（配合 `.from-right` / `.from-bottom` 与
`.enter` / `.exit` 相位类），时长/缓动用令牌 `--dur-slow` / `--ease-page`，视觉与旧 overlay 一致。

`NavHost` 遍历栈，每个条目套一层 `ScreenTransition`。已弹出的条目在离场动画期间保留在末尾
（叠在最上层滑出），动画结束再从渲染列表移除。DOM 顺序天然决定叠放，后压入者盖在上层。

### 2.3 系统返回接线

`useSystemBack`（全应用只在 `App` 调用一次）把两个平台的返回都接到 `navStore.back()`：

- **原生 Android**：监听 `@capacitor/app` 的 `backButton`。`canGoBack()` 为真则 `back()`，
  否则 `App.exitApp()`。iOS 无硬件返回键，此监听自然不触发。插件经动态 `import` 加载，
  非原生环境静默跳过。
- **浏览器 / PWA**：用一个「哨兵」history 记录承接手势/浏览器返回。首次放一格哨兵，
  每次 `popstate` 表示用户触发返回：栈里还有可返回层就 `back()` 消费掉并补回一格哨兵
  （维持「总有一格可退」，避免直接离开页面）；栈空则不再补哨兵，放行真正后退。

`back()` 的优先级由 `navStore` 决定：**先关最上层瞬态层（Sheet/预览），再弹出栈顶页面**；
已在 Tab 根且无可关闭层时返回 false，调用方据此放行退出。

### 2.4 瞬态层（Sheet / 预览）

Sheet、全屏图片预览等不进页面栈，而是经 `useDismissable(active, onDismiss)` 注册一个关闭回调
到 `navStore` 的瞬态层栈（LIFO）。返回时优先调用最上层的 `onDismiss`（应触发其带离场动画的关闭）。
已接入：`ChatPage` 的配置 Sheet / 上下文 Sheet / 图片预览，`AiChatPage` 的模型 Sheet / 图片预览。

### 2.5 新增页面指南

- **加一个整页**：在 `ScreenEntry` 增一个变体 → 在 `NavHost` 的 `ScreenBody` 加一个 `case`
  渲染页面组件 → 在触发处 `nav.push({ kind: "...", ... })`。转场自动统一，无需另写动画。
- **同级跳转**（如表单保存后进入下一步）：用 `nav.replaceTop(...)` 替换栈顶，返回时直接回上一级。
- **加一个弹层**：基于 `Sheet` 组件实现，并在其打开时调用 `useDismissable` 注册关闭，
  使系统返回能先关它。
- **返回**：页面组件收到的 `onBack` 已由 NavHost 绑定为 `pop`，直接透传给 header 返回按钮即可；
  不要再自建页内「返回」面包屑。

## 3. AI 流式的环境策略

AI 对话是独立于 code-lite 业务的附加模块，直连大模型 API，会撞上浏览器/WebView 的 CORS。
可用性判定集中在 `lib/environment.ts` 的 `isAiAvailable()`，HTTP 传输集中在
`services/httpTransport.ts` 的 seam。三种环境各走一条路：

| 环境 | 判定 | AI 是否可用 | HTTP 走向 | 流式 |
|---|---|---|---|---|
| **开发（浏览器）** | `import.meta.env.DEV` | 可用 | 同源 `/ai-proxy` 中间件转发（`vite.config.ts`），绕开 CORS | fetch + ReadableStream 真流式 |
| **原生 App（Android/iOS）** | `isNativeApp()` | 可用 | `capacitor-stream-http-v2` 原生 HTTP，绕开 WebView CORS | 插件 chunk/end/error 事件桥接为 ReadableStream，逐字流式 |
| **PWA / 生产静态部署** | 上面两者皆否 | 禁用 | 无 `/ai-proxy`、供应商又不给 CORS 头 → 入口整体禁用 | — |

### 3.1 传输 seam

`httpTransport.ts` 对上层暴露 `openStream(url, init): Promise<ReadableStream<Uint8Array>>` 与
`collectText(stream)`。上层 `aiClient` 只认这两个，不关心底层是 fetch 还是原生插件：

- **dev/web 分支**：`fetch(/ai-proxy/{realUrl})`，开流前校验 HTTP 状态（非 2xx 抛带状态码
  与响应片段的错误），返回 `resp.body`。
- **原生分支**：`StreamHttp.startStream` 发起请求，把 `chunk` 事件 enqueue 进 `ReadableStream`，
  `end` 关闭流、`error` 使流 error 出来；`AbortSignal` 触发时调 `cancelStream` 并 abort 流。

`aiClient` 的 `fetchModels`（GET /models，非流式）走 `openStream + collectText + JSON.parse`；
`streamChat`（POST，流式）走 `openStream` + 统一的 `readSse` 读 `data:` 事件。两条路读取逻辑一致。

### 3.2 原生插件选型与取舍

选用 `capacitor-stream-http-v2`（`chatboxai/capacitor-stream-http` 的 Capacitor 8 更新分支，
peer-dep `@capacitor/core ^8.3.0`，匹配本项目 8.4.1）。它用原生 HTTP 发起请求，绕开 WebView CORS，
并提供 chunk 级事件，得以在原生侧保留逐字流式（不整段缓冲）。

局限与注意：

- 插件事件只有 `chunk` / `end` / `error`，**拿不到 HTTP status 与响应头**，因此原生分支无法像
  fetch 那样在开流前判定 `resp.ok`。非 2xx 通常经 `error` 事件到达，由 `aiClient` 的 try/catch
  统一转成 `onError`。
- 升级插件或改动原生 HTTP 行为后需 `npx cap sync android` 重新同步，并重装 APK（旧 APK 内是旧代码）。
- 原生流式行为**须真机验证**：本仓库的 dev/PWA 构建不覆盖原生分支，CI 与本地 `npm run build`
  只保证类型与打包通过。

### 3.3 AI 对话思考强度与 Token 显示

思考强度和 Token 显示是远端独立 AI 对话模块的全局偏好，不影响远程 Agent 会话、图片生成或
提示词优化。偏好由 `services/AiChatSettingsStore.ts` 通过 Capacitor Preferences 与
`localStorage` 双写持久化，默认值为：

- 思考强度：`null`（兼容模式）。可选值为 `null / low / medium / high / xhigh`。
- 显示 Token 消耗：关闭。

`null` 不是发送给供应商的字符串值，而是明确表示省略思考强度字段，以兼容不支持 reasoning
参数的模型。非空值按供应商协议映射：

| 协议 | 请求字段 |
|---|---|
| `chat_completions` | `reasoning_effort: "low|medium|high|xhigh"` |
| `responses` | `reasoning: { effort: "low|medium|high|xhigh" }` |

打开 Token 显示后，`chat_completions` 请求增加 `stream_options: { include_usage: true }`；
`responses` 从流式完成事件读取 `response.usage`。客户端把两种协议归一化为每条 assistant 消息上的
`inputTokens / outputTokens / reasoningTokens / totalTokens`，随消息历史一起持久化。界面按轮展示输入、
输出 Token；供应商返回思考 Token 时一并展示。关闭开关只隐藏统计并停止主动请求 Chat Completions
流式 usage，不改写已有消息中的统计数据。

## 4. 防御式文本输入（安卓 WebView IME）

安卓 WebView 开着输入法预测 / 滑行输入 / 联想 / 自动补全 / 粘贴时，输入的字符会落进 DOM，
却不一定派发 React 绑定的 change 事件，或事件里的 value 滞后一个字——表现为「刚打的字
检测不到，要删一个字才被识别」，以及「粘贴 URL/Key 后保存按钮一直灰」。PWA / 桌面浏览器无此问题。

对策集中在 `components/ui/textFieldValue.ts` 的 `useDefensiveTextValue`（不与 IME 对抗）：

- 浏览器 / PWA 保持完全受控（`value`）；原生 App 使用半受控 `defaultValue`，避免 React 渲染
  把旧 state 强写回 DOM、打断组合输入。
- 原生输入框聚焦期间由 DOM 完全持有值，每 32ms 读取一次真实 `el.value` 同步 state，不依赖
  `input` / `change` / `compositionend` 是否到达 React；`compositionupdate` 和输入事件后的
  `requestAnimationFrame` 仍作为即时同步路径。
- 聚焦期间禁止 layout effect 回写 DOM，即使输入法没有派发 `compositionstart`，也不会因 state
  稍慢一拍而吞掉尾字；失焦时强制复位 composition 状态，并在下一帧对齐外部 value。
- 消息发送直接读取 textarea 当前 DOM 值，清空时同步清 DOM 与 state，避免最后几个字尚未进入
  state 时发送或清空不完整。

真机上若出现「输入后按钮仍灰，但点击可发送；点空白或输入标点再删除才激活」，说明触摸按钮时
先由 `blur` 把 DOM 值补进 state、随后同一次触摸才触发 `click`，本质仍是输入状态未实时同步，
不能按纯 CSS 重绘问题处理。

它被 `Input`（单行）与 `TextArea`（多行）两个原子共用。**收文本值一律用这两个原子，
不要用裸 `<input>` / `<textarea>`**。`TextArea` 的 `onEnter` 只在非组合期回车触发，避免输入法
选词的回车被误当作发送。已迁移：两个消息输入框、供应商表单、手动加模型、设备表单、
目录浏览器新建文件夹、新建会话工作区路径。

- 新增：`navStore` / `useNav` / `useDismissable` / `useSystemBack` / `NavHost` /
  `ScreenTransition` / `Input` / `TextArea` / `textFieldValue` / `httpTransport`。
- 改动：`App.tsx`（去除散落导航 flag，改用栈 + NavHost + useSystemBack）、`ChatPage` /
  `AiChatPage`（detail 入栈、瞬态层注册）、`AiSettingsPage`（子页拆为栈条目、去面包屑、用 Input）、
  `aiClient`（改用 seam）、`navigation.css`（`.screen-layer`）、`package.json`（新增插件）、Android 工程。
- 退休：`ChatOverlay` / `AiChatOverlay` / `SettingsOverlay` 及 `DetailOverlay` 的动画机
  （`DetailOverlay` 保留类型与 `DetailContent` 页面切换）。
- 验证：`npm run build`（tsc strict + vite 打包）通过；颜色全走令牌；`npx cap sync android`
  成功注册插件。原生返回键与原生流式须真机验证。
