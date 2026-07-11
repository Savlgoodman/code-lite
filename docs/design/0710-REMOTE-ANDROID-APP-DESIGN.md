# 远端 Android App 产品化设计文档

> 创建于 2026-07-10 | 基于现有 `ui-remote` 改造为 Capacitor Android App

---

## 1. 技术栈选型

| 层次 | 选型 | 说明 |
|---|---|---|
| 框架 | **Capacitor 5+** | React 资产 90%+ 复用，原生能力通过插件扩展 |
| UI 库 | React + Vite (现有) | 继承 `ui-remote` 全部状态层（`ConversationClient`/`WsTransport`/`SyncManager`） |
| 状态层 | `packages/chat-core` + `packages/sync` | 零改动复用，双端同源 |
| 原生壳 | Kotlin + Capacitor Plugins | 推送/安全存储/Deep Link 等原生能力 |
| 部署形态 | 自带 bundle 离线跑 | Vite 产物打入 apk，不依赖外部浏览器 |
| 目标用户 | 内部小范围 | 无需上架 Google Play，直接分发 APK |

---

## 2. 产品架构（底部四 Tab）

```
┌─────────────────────────────────────────────────────────┐
│                        App Shell                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  │  远程 (Tab1) │  │   AI (Tab2) │  │  设备 (Tab3) │  │  设置 (Tab4) │
│  │  Remote     │  │  Chatbot    │  │  Devices    │  │  Settings   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
└─────────────────────────────────────────────────────────┘
```

---

### 2.1 Tab1: 远程（Remote）

**功能**: 连接 code-lite 远端访问器，展示对话列表，进入对话页。

#### 2.1.1 连接状态栏

```
┌─────────────────────────────────────────────────────────┐
│  [H logo]  收件箱  ● 已连接          [+用户 icon]        │
─────────────────────────────────────────────────────────┘
```

- 左侧: App logo (类似图中 "H" 像素风)
- 中间: 当前设备名 + 连接状态 (绿色圆点 "已连接" / 灰色 "未连接")
- 右侧: 添加设备按钮

#### 2.1.2 对话列表（按项目分组）

```
┌─────────────────────────────────────────────────────────┐
│   code-lite                                            │
│    ├─ 重构双端同步协议          ● (运行中)               │
│    ├─ 修复 sendTurn bug         ○                        │
│    ├─ 模型选择器二级联动        ○                        │
│    ├─ 文档更新                  ○                        │
│    └─ 架构文档重写              ○                        │
│       └─ 展开更多 (5+)                                  │
│                                                         │
│  📁 vibe-check                                           │
│    ├─ 前端性能优化              ○                        │
│    └─ 测试用例编写              ○                        │
─────────────────────────────────────────────────────────┘
```

- **分组规则**: 按 `session.workspace` 字段分组，每个项目最多展示 5 条
- **状态指示**:
  - 🔵 蓝色小圆点: 运行中 (`status: "running"`)
  - 🟢 绿色小圆点: 空闲 (`status: "idle"`)
  - ⚪ 灰色: 归档/错误
- **折叠逻辑**: 项目内会话超过 5 条时，显示"展开更多"按钮
- **空状态**: 参考图 1 的笑脸 + "收件箱为空 / 与好友建立连接，开始共享会话"

#### 2.1.3 对话页（Chat View）

```
┌─────────────────────────────────────────────────────────┐
│  ←  test / 调研主流 Python Agent 框架                   │
├─────────────────────────────────────────────────────────┤
│  [想要更轻量的一体化 Python 框架]      [Agno]  (用户气泡) │
│                                                         │
│  总体判断: 新项目默认 shortlist 可以放 LangGraph...      │
│                                                         │
│  [请问llamaindex是一个怎么样的项目？]  (用户气泡)          │
│                                                         │
│  我再核一下 LlamaIndex 的官方资料...                     │
│  (AI 回答无边框，左侧对齐)                               │
│                                                         │
│  ↓ 滚动加载历史                                          │
├─────────────────────────────────────────────────────────┤
│  访问模式: 自动  |  模型: Claude  |  思考: 低             │
│                                                         │
│  [⚙️] [◎ 62%]   [发送 ↑]                                │
└─────────────────────────────────────────────────────────┘
```

**设计风格** (参考图 2):
- **用户消息**: 右侧对齐，有边框气泡，背景浅色
- **AI 消息**: 左侧对齐，无边框瀑布流，markdown 渲染
- **Markdown 渲染**: 使用 `streamdown` 组件 (与桌面端对齐)
- **顶部信息栏**: 输入框上方边缘，显示 `访问模式 / 模型 / 思考强度`
- **底部输入区**:
  - 左侧: ⚙️ 设置按钮 (调出模型/思考强度/accessMode 选择器)
  - 中间: 上下文窗口圆环 (显示 token 用量百分比)
  - 右侧: 发送按钮 (灰色圆形箭头)
- **状态提示**: "此会话处于非活动状态。● 最后活跃时间 6月1日"

---

### 2.2 Tab2: AI（Chatbot）

**功能**: 本地直接调用大模型 API (GPT/DeepSeek/Claude 等) 进行对话。

#### 2.2.1 与"远程"的区别

| 维度 | 远程 (Tab1) | AI (Tab2) |
|---|---|---|
| 后端 | code-lite Python Backend | 直接调用第三方 API |
| 会话存储 | 后端 `session.json` | 本地 SQLite / SharedPreferences |
| 模型选择 | 后端配置的模型列表 | 用户自定义 API Key + 模型 ID |
| 工具调用 | 支持 (Bash/Edit/Read 等) | 不支持 (纯对话) |
| 计费 | 后端统一计费 | 用户自己的 API 配额 |

#### 2.2.2 设置项

- API URL (如 `https://api.openai.com/v1`)
- API Key
- 模型 ID (如 `gpt-4o`, `deepseek-chat`, `claude-opus-4-8`)
- Temperature / Top-P
- System Prompt

---

### 2.3 Tab3: 设备（Devices）

**功能**: 管理可连接的 code-lite 设备列表，切换设备，新增设备。

#### 2.3.1 设备列表

```
┌─────────────────────────────────────────────────────────┐
│  我的设备                                                 │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ️ Kevin-Desktop                                │   │
│  │     relay.example.com | pair_key: ****1234       │   │
│  │     最后活跃: 2分钟前          [● 在线]          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  🖥️ Work-Laptop                                  │   │
│  │     192.168.1.100:8765 | pair_key: ****5678     │   │
│  │     最后活跃: 3小时前            [○ 离线]         │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [+ 添加新设备]                                          │
└─────────────────────────────────────────────────────────┘
```

#### 2.3.2 添加设备流程

1. 点击 "添加新设备"
2. 输入:
   - 设备名称 (如 "客厅台式机")
   - Relay URL 或直接 IP:Port
   - Pair Key
3. 测试连接 → 保存

#### 2.3.3 切换设备

- 点击设备卡片 → 弹出确认框 "切换到 Kevin-Desktop?"
- 切换后 Tab1 自动刷新该设备的对话列表
- 当前选中设备在顶部状态栏显示

---

### 2.4 Tab4: 设置（Settings）

**功能**: 全局配置入口，API 配置，关于页面。

#### 2.4.1 设置项分类

**AI 配置** (控制 Tab2 的行为):
- API URL
- API Key
- 默认模型
- Temperature
- Max Tokens
- System Prompt

**远程配置** (控制 Tab1 的行为):
- 默认 Relay URL
- 自动重连开关
- 心跳间隔

**通用**:
- 主题 (跟随系统 / 浅色 / 深色)
- 语言 (中文 / English)
- 通知权限
- 关于 Code-Lite Remote

**关于页面**:
- 版本号
- 构建日期
- GitHub 链接
- 开源协议

---

## 3. 图标与视觉风格

### 3.1 底部 Tab 图标 (参考图 1)

| Tab | 图标 | 说明 |
|---|---|---|
| 远程 | `*` 星号/雪花 (带通知红点) | 表示"连接/收件箱" |
| AI | `` 四角星 | 表示"AI/智能" |
| 设备 | `⊞` 网格/九宫格 | 表示"设备矩阵" |
| 设置 | `⋮⋮` 九点矩阵 | 表示"设置/更多" |

### 3.2 配色方案

```css
:root {
  --bg-primary: #f5f5f7;        /* 浅灰背景 */
  --bg-card: #ffffff;            /* 卡片白色 */
  --text-primary: #1a1a1a;       /* 主文字 */
  --text-secondary: #6b7280;     /* 次要文字 */
  --accent-green: #22c55e;       /* 在线状态 */
  --accent-blue: #3b82f6;        /* 运行中状态 */
  --accent-gray: #d1d5db;        /* 离线状态 */
  --border-color: #e5e7eb;       /* 边框 */
}
```

### 3.3 圆角与阴影

- 卡片圆角: `16px`
- 按钮圆角: `50%` (圆形) 或 `8px` (小按钮)
- 阴影: `box-shadow: 0 1px 3px rgba(0,0,0,0.1)`

---

## 4. 数据流与状态管理

### 4.1 远程 Tab 数据流

```
RelayTransport (WebSocket)
    ↓
ConversationClient (packages/chat-core)
    ↓
useConversations (React hook)
    ↓
RemoteTab UI (会话列表 + 对话页)
```

- 复用现有 `RelayTransport` + `ConversationClient`
- 设备切换时: 销毁旧 transport → 创建新 transport → 重新 connect

### 4.2 AI Tab 数据流

```
用户输入
    ↓
LocalChatStore (SQLite)
    ↓
OpenAI SDK / 自定义 fetch
    ↓
Stream 响应
    ↓
UI 渲染
```

- 不依赖 `ConversationClient`
- 本地存储会话历史
- 直接调用第三方 API

---

## 5. Capacitor 集成要点

### 5.1 必要插件

```json
{
  "@capacitor/core": "^5.0.0",
  "@capacitor/android": "^5.0.0",
  "@capacitor/push-notifications": "^5.0.0",
  "@capacitor/local-notifications": "^5.0.0",
  "@capacitor/preferences": "^5.0.0",
  "@capacitor/app": "^5.0.0",
  "@capacitor/haptics": "^5.0.0",
  "@capacitor/keyboard": "^5.0.0"
}
```

### 5.2 原生能力封装

| 功能 | 插件 | 用途 |
|---|---|---|
| 推送通知 | `@capacitor/push-notifications` | 收到新消息时推送 |
| 本地存储 | `@capacitor/preferences` | 存储 pairKey/API Key |
| 键盘适配 | `@capacitor/keyboard` | 输入框避免被键盘遮挡 |
| 震动反馈 | `@capacitor/haptics` | 发送成功/失败反馈 |
| App 生命周期 | `@capacitor/app` | 后台/前台切换时重连 WebSocket |

### 5.3 打包流程

```bash
# 1. 构建 Web 产物
cd ui-remote && npm run build

# 2. 复制到 Android 项目
npx cap sync android

# 3. 打开 Android Studio
npx cap open android

# 4. 在 Android Studio 中构建 APK
```

---

## 6. 实施计划（分阶段）

### Phase 1: 远程 Tab 核心功能（本阶段）

- [ ] 搭建 Capacitor 项目骨架
- [ ] 迁移现有 `ui-remote` 代码到 Capacitor 壳
- [ ] 实现对话列表（按项目分组 + 状态指示）
- [ ] 实现对话页（streamdown 渲染 + 底部输入区）
- [ ] 实现模型/思考强度选择器
- [ ] 实现设备切换逻辑

### Phase 2: AI Tab

- [ ] 设计本地会话存储 schema
- [ ] 集成 OpenAI SDK
- [ ] 实现流式对话 UI
- [ ] 实现 API 配置页面

### Phase 3: 设备 Tab

- [ ] 设备列表 UI
- [ ] 添加/删除设备
- [ ] 设备切换联动 Tab1

### Phase 4: 设置 Tab + 打磨

- [ ] 设置页面 UI
- [ ] 主题切换
- [ ] 推送通知集成
- [ ] 性能优化 + 测试

---

## 7. 参考资源

- [Capacitor 官方文档](https://capacitorjs.com/docs)
- [streamdown 组件](https://github.com/nicepkg/streamdown) (与桌面端对齐)
- 图 1: 底部 Tab 布局参考 (收件箱/终端/设置)
- 图 2: 对话页风格参考 (用户气泡 + AI 瀑布流)

---

## 8. 风险与应对

| 风险 | 应对 |
|---|---|
| WebSocket 在后台被杀 | 使用 Capacitor App 生命周期监听，前台时自动重连 |
| Android 碎片化 | 目标 API 33+，测试主流机型 (小米/华为/Pixel) |
| 包体积过大 | 按需加载模块，Vite tree-shaking |
| 推送通知权限 | 首次启动时引导用户授权 |

---

**下一步**: 开始 Phase 1 实施，优先搭建 Capacitor 项目骨架 + 迁移现有代码。
