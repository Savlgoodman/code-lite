# UI 模块协作规范

本文约束 `ui/` 前端模块的目录结构、组件拆分、视觉风格和样式写法。根目录 `AGENTS.md` 的 UTF-8、保护用户改动、禁止敏感信息、禁止 emoji 等规则同样适用于本目录。

## 目录结构

当前 UI 采用 React + Vite，建议按职责拆分：

```text
ui/src/
  App.tsx                 # 应用根入口，只组合全局 layout 和 page
  pages/                  # 页面级状态和业务编排
    ChatPage.tsx
  layout/                 # 桌面壳布局组件
    AppTitlebar.tsx
    Sidebar.tsx
  features/               # 业务功能组件
    chat/
      ChatComposer.tsx
      ConversationHeader.tsx
      MessageList.tsx
      ToolCallViews.tsx
      ApprovalCard.tsx
      messageTools.ts
  components/             # 可复用基础组件
    MessageRenderer.tsx
  lib/                    # 纯函数、格式化、状态工具
    chatState.ts
    formatters.ts
  services/               # 后端/Tauri 通信
    agentClient.ts
    conversationStore.ts
  styles.css              # 全局样式与设计 token
  types.ts                # 共享前端类型
```

拆分原则：

1. `App.tsx` 不承载业务状态，只组合全局 layout 和 page。
2. `pages/` 可以管理页面级状态、effect 和服务调用。
3. `layout/` 只放稳定布局，例如标题栏、侧边栏。
4. `features/` 放领域组件，例如聊天、审批、工具调用。
5. `components/` 放跨功能复用组件，避免混入页面业务。
6. `lib/` 中只放无副作用工具函数。
7. `services/` 只处理外部通信，不直接操作 React state。

## 视觉风格

code-lite 是桌面端多 Agent 工作台，不是营销站点。UI 应保持安静、克制、清晰，适合长时间阅读 agent 输出、审阅工具调用、查看文件变更和同步观看远程任务。

风格要求：

1. 优先使用信息密度适中的工作台布局，不做大 hero、宣传卡片或装饰性大图。
2. 页面区域保持平铺和分栏，避免卡片套卡片。
3. 卡片仅用于消息、工具调用、审批、列表项等明确边界对象。
4. 圆角控制在 8px 左右；输入框这类核心控件可保持现有 20px 胶囊风格。
5. 图标按钮优先使用 `lucide-react`，不要手写 SVG 图标。
6. 不使用 emoji。
7. 不使用渐变球、光斑、装饰性背景图。
8. 不使用大量紫色、深蓝、棕橙或单一色系铺满界面。

## 色彩规范

全局颜色优先维护在 `styles.css` 的 `:root` 变量中：

```css
:root {
  --line: #dedbd7;
  --muted: #6f747b;
  --subtle: #8b9096;
  --panel: #fbfbfa;
  --sidebar: #f3f2f0;
  --hover: #eceff3;
  --active: #e7ebf0;
  --blue: #1677ff;
  --green: #12845a;
  --orange: #e85d2a;
  --warning: #9f5b00;
}
```

使用原则：

1. 背景以 `--panel`、`--sidebar` 和白色为主。
2. 边框以 `--line` 或浅灰色为主。
3. 主文本使用接近 `#20242b` 的深灰，不使用纯黑大面积铺开。
4. 次级文本使用 `--muted` 或 `--subtle`。
5. 状态色只用于状态表达：
   - `--blue`：运行中或主动状态。
   - `--green`：完成或成功。
   - `--orange`：审批、中风险、需要注意。
   - 红色只用于错误和失败。
6. 新增颜色前先确认是否能复用现有 token。

## 样式写法

1. 默认继续使用全局 `styles.css`，新增类名按组件语义命名。
2. 不引入 CSS-in-JS 或新的样式框架，除非先更新本文档并说明原因。
3. 样式以稳定尺寸和响应约束为主，避免 hover、文本变化或状态切换导致布局跳动。
4. 不使用 viewport 宽度驱动字体缩放。
5. 文本必须能在最小窗口 `900x620` 下正常容纳，不应重叠或溢出按钮。
6. 表格、代码块、工具结果等长内容必须可滚动或换行。
7. 聊天主内容宽度优先沿用 `width: min(760px, 100%)`。
8. 底部 composer 和审批卡片应保持同宽、贴齐、层级明确。

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
