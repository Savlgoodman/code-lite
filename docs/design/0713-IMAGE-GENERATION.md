# 图片生成功能设计（工作台工具页）

设计日期：2026-07-13

分支：`feat/image-0713-generation`（建议）

## 0. 相关文档

1. `AGENTS.md`（仓库总规范、双端同步约定、目录结构）
2. `ui/AGENTS.md`（桌面前端目录分层、色彩令牌、设置页规范）
3. `ui-remote/AGENTS.md`（远端开发约定：目录分层、Sheet、导航栈、AI 环境可用性、色彩令牌）
7. `docs/design/0712-REMOTE-NAV-AND-STREAMING.md`（远端导航栈与 AI 三环境流式策略，生图沿用同一套环境分流）
4. `docs/design/0703-RUNTIME-MODEL-PROVIDER.md`（模型供应商配置：供应商->模型结构、密钥遮蔽、后端代理外部请求）
5. `docs/design/0707-AGENT-MULTIMODAL-COMPOSER.md`（多模态输入与附件存储，参考图片上传复用其思路）
6. `docs/api/gpt-image` 兼容文档（GPT Image 2 的 `/v1/images/generations` 与 `/v1/images/edits` 接口格式）

## 1. 背景与目标

当前 code-lite 是一个以对话驱动 agent 的工作台。用户希望在对话之外，扩展一批
「小工具页面」，第一个就是**图片生成**：填提示词、选模型、可选参考图，调用兼容
OpenAI 图片接口的供应商生成图片，并且能反复调整提示词做二次生成、回看历史。

产品诉求拆成四块：

1. **统一生图核心**：把生图请求（apiKey / url / modelId / prompt / 参考图 / size / quality 等）
   封装成一个共享包，桌面端与远程端都能调用，只传参数即可发起生成。
2. **提示词优化**：桌面端和远程端都能用已配置的模型供应商（文本模型）对图片描述做
   润色扩写，方便把粗略描述细化成高质量提示词。
3. **桌面端工作台 UI**：
   - 侧边栏「技能」下方新增「更多工具」入口，展开后暴露「图片生成」选项卡（后续会有更多工具页）。
   - 「图片生成列表页」：方形图卡展示历史生成任务，卡片标题取提示词前 N 字，展示该任务最后一张生成图；右上角加号新建任务，加号旁设置按钮跳到供应商配置。
   - 「图片生成页」：左侧提示词输入 + 参数区；右上 1/4 参考图展示区；右下 3/4 生成图展示区；底部占约 1/5 的历史生成条，点击历史项把上方参数/提示词/生成图恢复为该次的状态，可再次修改二次生成。
4. **图片生成供应商配置**：在设置页「模型提供商配置」中，新增一类「图片生成供应商」，仅需 url + apiKey。

**本轮范围**：只做桌面端（`ui/` + `backend/` + 新共享包）。远程端（`ui-remote/`）
在本文只做接口对齐说明，不落地 UI，后续单独排期。

**非目标**：

1. 不实现异步图片任务轮询接口（`/docs/api/async-image`），本轮只走同步 `generations`/`edits`。
2. 不实现图片编辑遮罩（mask）高级编辑，参考图仅作为 `edits` 的输入图或 `generations` 的风格参考（取决于供应商能力，先支持 edits 传参考图）。
3. 不实现系统凭据存储迁移（沿用现有 `app_config.json` 明文密钥、接口遮蔽的短期策略）。
4. 不做批量并发生成队列，单任务单次生成（`n` 可配置但默认 1）。

## 2. 术语与数据流

- **图片生成供应商（image provider）**：一条「url + apiKey」连接配置，协议固定 OpenAI 图片兼容格式。
- **生图任务（generation record）**：一次「进入图片生成页并至少生成过一次」的持久记录，含提示词、参数、参考图引用、多次生成产出的图片。
- **生成批次（run）**：任务内的一次生成动作，产出 1..n 张图片，绑定当时的提示词与参数快照。历史条展示的是「批次」。

数据流（桌面端）：

```text
ui 图片生成页
  -> @code-lite/image-gen 组装请求参数（不含真实密钥）
  -> backend /api/image/generations（后端注入供应商密钥，代理外部供应商，规避 CORS 与密钥泄漏）
  -> 外部供应商 /v1/images/generations | /v1/images/edits
  -> backend 落盘图片 + 写生成记录（data/image-gen/）
  -> ui 展示 + 刷新历史
```

**为什么外部请求必须走后端**：与模型供应商配置一致（见 `0703-RUNTIME-MODEL-PROVIDER.md`
第 10 节与 `settings.py` 的 `_probe_models`）。桌面 Tauri webview 直连外部供应商会遇到 CORS，
且 API Key 不能下发到前端。后端代理同时解决三件事：CORS、密钥不出后端、图片统一落盘做历史。

## 3. 共享包 `@code-lite/image-gen`

### 3.1 定位

放在 `packages/image-gen/`，与 `chat-core` 同级。它是**纯 TypeScript、无 React、无 DOM 依赖**的
参数组装与类型层，桌面端与远程端共用。它**不直接发外部请求**（外部请求在后端），而是：

1. 定义生图请求/响应、供应商、任务、批次的**协议类型**（与后端 JSON 对齐）。
2. 提供**请求体构造**与**参数校验**纯函数（size 合法性、n 范围、参考图数量等）。
3. 提供一个**传输适配接口** `ImageGenTransport`，由各端注入具体的 HTTP 调用实现
   （桌面端注入基于 backend base_url 的 fetch，远程端后续注入中继转发实现）。
4. 提供**提示词优化**的请求构造（复用文本模型 chat/completions 的消息模板）。

这样「仅需传入 apiKey/url/modelId/prompt/参考图等参数即可调用」这一诉求由包的
`createImageGenClient(transport)` 满足：调用方只关心参数，不关心 CORS/密钥/落盘。

### 3.2 目录与导出

```text
packages/image-gen/
  package.json            # name: @code-lite/image-gen
  src/
    index.ts              # 汇总导出
    types.ts              # 协议类型（Provider/Request/Result/Record/Run/PromptOptimize）
    request.ts            # 请求体构造 + 参数校验纯函数
    client.ts             # createImageGenClient(transport)：generate / editWithReference / optimizePrompt
    transport.ts          # ImageGenTransport 接口定义
```

`packages/image-gen/package.json`（对齐 chat-core 写法）：

```json
{
  "name": "@code-lite/image-gen",
  "version": "0.1.4",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@code-lite/protocol": "0.1.4" }
}
```

### 3.3 核心类型（`types.ts`）

```ts
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageResponseFormat = "url" | "b64_json";

// 供应商（前端可见，密钥遮蔽，与后端 _public 对齐）
export interface ImageProvider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyPreview: string;
  defaultModel: string;      // 例如 gpt-image-2，可空
  createdAt: number;
  updatedAt: number;
}

// 一次生成的请求参数（前端组装，不含真实密钥；providerId 指向后端已存密钥）
export interface ImageGenRequest {
  providerId: string;
  model: string;             // modelId，如 gpt-image-2
  prompt: string;
  n?: number;                // 默认 1
  size?: string;             // "auto" 或 "1536x1024" 等
  quality?: ImageQuality;
  referenceAttachmentIds?: string[]; // 参考图（走 edits），后端据此读盘
}

export interface GeneratedImage {
  id: string;
  url: string;               // 后端静态路径 /api/image/records/{recordId}/images/{imageId}
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

// 一次生成批次（任务内的一次生成动作）
export interface ImageGenRun {
  id: string;
  createdAt: number;
  request: ImageGenRequest;  // 该批次的参数快照
  images: GeneratedImage[];
  error?: string;
}

// 生图任务（一个列表卡片 = 一个任务）
export interface ImageGenRecord {
  id: string;
  title: string;             // 提示词前 N 字，二次生成后取最近一次非空 prompt
  createdAt: number;
  updatedAt: number;
  latestImageUrl: string | null; // 封面：最近一次批次最后一张图
  runs: ImageGenRun[];
  referenceImages: GeneratedImage[]; // 任务级参考图（展示用引用）
}

// 提示词优化
export interface PromptOptimizeRequest {
  modelId: string;           // 产品级文本模型 id（ModelSettingsState.models[].id）
  prompt: string;
  style?: string;            // 可选：偏好风格提示
}
export interface PromptOptimizeResult {
  prompt: string;
}
```

### 3.4 传输接口与客户端

```ts
// transport.ts
export interface ImageGenTransport {
  post<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>; // 参考图上传
}

// client.ts
export function createImageGenClient(transport: ImageGenTransport) {
  return {
    listProviders(): Promise<ImageProvider[]>,
    createProvider(input): Promise<ImageProvider>,
    updateProvider(id, patch): Promise<ImageProvider>,
    deleteProvider(id): Promise<void>,
    listRecords(): Promise<ImageGenRecord[]>,
    getRecord(id): Promise<ImageGenRecord>,
    createRecord(): Promise<ImageGenRecord>,           // 空任务
    deleteRecord(id): Promise<void>,
    uploadReference(recordId, file): Promise<GeneratedImage>,
    generate(recordId, req: ImageGenRequest): Promise<ImageGenRun>,
    optimizePrompt(req: PromptOptimizeRequest): Promise<PromptOptimizeResult>,
  };
}
```

`request.ts` 负责把 `ImageGenRequest` 校验并转成后端 body：校验 `n` 在 [1, 4]，
`size` 命中 GPT Image 2 推荐分辨率或 `auto`，`prompt` 非空，参考图数量 <= 8。校验失败抛
`ImageGenValidationError`，UI 直接展示消息。

### 3.5 桌面端注入

桌面端在 `ui/src/services/imageGenStore.ts` 用 `ensureBackend()` 得到 base_url，构造
`ImageGenTransport`（fetch + FormData），再 `createImageGenClient(transport)`。远程端后续
在 `ui-remote/` 注入中继转发 transport，客户端逻辑与类型零改动复用。

### 3.6 构建接线

1. `ui/tsconfig.json` paths 增加 `"@code-lite/image-gen": ["../packages/image-gen/src/index.ts"]`。
2. `ui/vite.config.ts` alias 增加 `@code-lite/image-gen`。
3. 若根有 workspace（`package.json` workspaces），把 `packages/image-gen` 纳入；沿用现有
   `packages/*` 的登记方式。
4. `packages/tsconfig.check.json` 若列举子包，追加本包，保证 `npm run build` 类型检查覆盖。

## 4. 后端设计

### 4.1 配置存储：图片供应商

复用 `docs/0703` 的思路，但**图片供应商与文本模型供应商分开存储**，因为它们语义不同
（图片供应商仅 url+apiKey，无「供应商->模型->能力」层级）。

在 `app_config.json` 顶层新增 `imageProviders` 数组（`ModelConfigStore` 只管 `llmProviders`，
故新建独立 store 更清晰）：

```json
{
  "schemaVersion": 1,
  "imageProviders": [
    {
      "id": "imgprovider_xxx",
      "name": "12ai",
      "baseUrl": "https://cdn.12ai.org/v1",
      "apiKey": "sk-...",          // 仅后端持有，接口不回明文
      "defaultModel": "gpt-image-2",
      "enabled": true,
      "createdAt": 0,
      "updatedAt": 0
    }
  ]
}
```

新建 `backend/code_lite_backend/services/image_config.py`：`ImageProviderConfigStore`，
职责与 `ModelConfigStore` 平行：

- `list_providers()` -> 遮蔽密钥的 public 列表（`hasApiKey` / `apiKeyPreview`，复用 `_preview_secret` 思路）。
- `create_provider(name, base_url, api_key, default_model)`。
- `update_provider(id, patch)`：`apiKey` 为空表示不改。
- `delete_provider(id)`。
- `provider_connection(id)` -> `{baseUrl, apiKey, defaultModel}`（仅后端内部用，取真实密钥发外部请求）。

原子写、UTF-8、复用 `storage/conversations.atomic_write_json`。API Key 不进日志、不进接口响应。
考虑到 `ModelConfigStore` 已经独占 `app_config.json` 的读写与 normalize，为避免两个 store
互相覆盖顶层字段，`ImageProviderConfigStore` 单独落 `data/config/image_config.json`
（与 `app_config.json` 同目录），互不干扰，读写更安全。

### 4.2 生成记录存储

新建 `backend/code_lite_backend/storage/image_records.py`：`ImageRecordStore`，落盘到
`data/image-gen/`（新增目录，`RuntimeConfig` 追加 `image_gen_dir`）：

```text
data/image-gen/
  {recordId}/
    record.json           # ImageGenRecord（不含图片二进制，图片按下述文件存）
    references/{imgId}     # 参考图二进制 + {imgId}.json 元数据
    images/{imgId}         # 生成图二进制 + {imgId}.json 元数据
```

`record.json` 结构与 `@code-lite/image-gen` 的 `ImageGenRecord` 对齐（图片字段存 id 与元数据，
`url` 由接口渲染时拼成 `/api/image/records/{recordId}/images/{imgId}`）。

方法：`list_records()`（按 updatedAt 倒序，用于列表页）、`get_record(id)`、`create_record()`、
`delete_record(id)`、`append_run(id, run)`、`save_reference(id, ...)`、
`load_image(recordId, imgId)` / `load_reference(recordId, imgId)`（返回 FileResponse 用路径）。
落盘参考 `AttachmentStore`（sha256、大小限制、mime 白名单 `image/png|jpeg|webp`）。

### 4.3 生图代理与提示词优化：接口

新增路由文件 `backend/code_lite_backend/api/routes/image_gen.py`，注册进 `api/router.py`。
外部请求沿用后端既有的 stdlib `urllib`（`settings.py` 已用），不新增 httpx 依赖；生成属于耗时
IO，包在 `asyncio.to_thread` 里执行。

供应商配置（镜像 model-providers 风格）：

```text
GET    /api/image/providers                 列出图片供应商（密钥遮蔽）
POST   /api/image/providers                 新建（body: name, baseUrl, apiKey, defaultModel）
PATCH  /api/image/providers/{providerId}    更新（apiKey 空则不改）
DELETE /api/image/providers/{providerId}    删除
```

生成记录：

```text
GET    /api/image/records                    列表（列表页用，返回封面 latestImageUrl + title）
POST   /api/image/records                    新建空任务
GET    /api/image/records/{recordId}         任务详情（含全部 runs）
DELETE /api/image/records/{recordId}         删除任务
POST   /api/image/records/{recordId}/references   上传参考图（multipart，复用附件校验）
GET    /api/image/records/{recordId}/images/{imageId}       生成图二进制
GET    /api/image/records/{recordId}/references/{imageId}   参考图二进制
```

生成与优化：

```text
POST   /api/image/records/{recordId}/generate   发起一次生成，返回 ImageGenRun
POST   /api/image/optimize-prompt               提示词优化，返回 { prompt }
```

`POST /generate` 处理流程：

1. 读 body：`providerId, model, prompt, n, size, quality, referenceAttachmentIds`。
2. `provider_connection(providerId)` 取真实 `baseUrl/apiKey`。
3. 无参考图 -> 请求 `{baseUrl}/images/generations`（JSON，`response_format=url` 优先，
   拿不到 url 就退回 `b64_json`）；有参考图 -> 请求 `{baseUrl}/images/edits`
   （multipart，`image` 字段可重复，读 `references/` 下的图）。
4. 解析响应 `data[]`：`url` 则后端下载落盘，`b64_json` 则解码落盘；记录 `revised_prompt`。
5. `append_run(recordId, run)` 写盘，更新 `record.title`（取本次非空 prompt 前 N 字）与
   `latestImageUrl`（本次最后一张图）。
6. 返回渲染好的 `ImageGenRun`（图片 url 为后端静态路径）。
7. 失败：外部 4xx/5xx、超时、内容安全拦截（供应商 403）都归一为可读中文错误，`run.error` 落盘
   并返回 502/400，前端历史条展示失败态。

`POST /optimize-prompt` 处理流程：

1. body：`modelId`（产品级文本模型 id）、`prompt`、可选 `style`。
2. 用 `services.model_config_store.resolve_model(modelId)` 拿到文本模型的
   `provider baseUrl/apiKey/model`（复用现有模型供应商密钥，不新增配置）。
3. 组一条 chat/completions 请求（system 提示「你是图像提示词优化助手，把用户描述扩写为
   精细、结构化、利于文生图的英文/中文提示词，只返回提示词本身」）。
4. 返回 `{ prompt }`。失败归一为中文错误。

安全：所有接口不返回明文密钥；日志不打印密钥与 prompt 原文中的敏感信息；`recordId/imageId`
经 `_safe_id` 校验防路径穿越（复用 `attachments._safe_id`）。

### 4.4 服务接线

1. `RuntimeConfig` 增加 `image_gen_dir`（`data/image-gen/`）与 `image_config_path`
   （`data/config/image_config.json`），在 `resolve_runtime_config` 里创建目录。
2. `AppServices` 增加 `image_provider_config_store: ImageProviderConfigStore` 与
   `image_record_store: ImageRecordStore`，在 `app.py` 里实例化注入。
3. `api/router.py` include `image_gen.router`。

## 5. 桌面端 UI

### 5.1 视图路由

当前 `ChatPage` 用 `ActiveView = "chat" | "overview" | "settings"` 驱动主区。新增两个视图值：

```ts
type ActiveView = "chat" | "overview" | "settings" | "image-gen-list" | "image-gen-detail";
```

`ChatPage` 里：

- `image-gen-list` -> 渲染 `<ImageGenListPage />`。
- `image-gen-detail` -> 渲染 `<ImageGenDetailPage recordId={activeImageRecordId} />`（`activeImageRecordId` 为 `ChatPage` 新增 state，null 表示新建）。

进入设置页跳转到供应商配置：`SettingsPage` 已有 `activeSection` 内部 state 且初始为
`"appearance"`。为支持「从图片列表页设置按钮直达图片供应商配置」，给 `SettingsPage` 增加可选
`initialSection?: SettingsSection`，`ChatPage` 打开设置时传入。图片供应商配置作为一个新的
settings section。

### 5.2 侧边栏「更多工具」入口

`ui/src/layout/Sidebar.tsx` 现有底部结构：`sidebar-actions`（总览/新对话/搜索/技能）与
`sidebar-footer`（设置）。「技能」按钮当前无 onClick。在「技能」按钮下方新增「更多工具」
可展开分组：

- 新增 prop：`onOpenImageGen: () => void`、`activeView`（扩展类型以高亮）。
- 「更多工具」按钮（icon 用 `lucide-react` 的 `Wrench` 已被技能占用，改用 `LayoutGrid` 或
  `Boxes`；工具项「图片生成」用 `Image` icon）。点击「更多工具」展开/收起一个子列表，
  子列表项「图片生成」点击触发 `onOpenImageGen()`，`ChatPage` 里 `setActiveView("image-gen-list")`。
- 展开态用本地 `useState`，样式复用 `nav-command` + 缩进子项，遵循 `ui/AGENTS.md` 色彩令牌，
  不硬编码颜色。后续更多工具页只在子列表追加项。

`ChatPage` 在渲染 `Sidebar` 处传入 `onOpenImageGen` 与扩展后的 `activeView`；主区在
`activeView` 为 image-gen 两态时渲染对应页面（与 overview 平级的条件分支）。

### 5.3 图片生成列表页 `ImageGenListPage`

位置：`ui/src/pages/image-gen/ImageGenListPage.tsx`（+ `.css`）。工作台风格，网格卡片。

结构：

```text
section.imggen-list
  header.imggen-list-header
    h1 图片生成
    actions: [新建任务(加号, Plus)] [设置(Settings) -> 跳供应商配置]
  grid.imggen-card-grid
    card.imggen-card (方形, aspect-ratio:1)
      封面图(latestImageUrl, 无图占位)
      footer: 标题(提示词前 N 字, 单行省略) + 时间
      hover: 删除按钮
  空态: 「还没有生成记录，点右上角加号新建」
```

行为：

- 加载：`imageGenStore.listRecords()`，`useEffect` 拉取。
- 新建：`createRecord()` -> 得到空 record -> `setActiveImageRecordId(id)` -> `setActiveView("image-gen-detail")`。
  （或先不落盘，进入 detail 页首次生成时再 `createRecord`；本文取「先建空任务」以简化 id 归属。）
- 点击卡片：`setActiveImageRecordId(record.id)` + 切 detail 视图。
- 设置按钮：`onOpenSettings("imageProviders")`（`ChatPage` 打开设置并定位到图片供应商配置 section）。
- 删除卡片：确认后 `deleteRecord(id)`，刷新列表。

卡片标题取 `record.title`（后端已存提示词前 N 字，N 建议 24，与会话标题一致）。封面为
`record.latestImageUrl`，`object-fit: cover` 填满方卡。

### 5.4 图片生成页 `ImageGenDetailPage`

位置：`ui/src/pages/image-gen/ImageGenDetailPage.tsx`（+ `.css`）。这是核心页，点击卡片进入
与点加号新建进入是同一个组件。布局按用户描述：

```text
grid.imggen-detail  (整页三区：左栏 + 右栏；右栏内上下分；底部历史条通栏)
  ┌───────────────┬───────────────────────────────┐
  │  左栏(约2/5)   │  右上: 参考图区 (右栏高度 1/4) │
  │  提示词输入     ├───────────────────────────────┤
  │  优化按钮       │  右下: 生成图展示 (右栏 3/4)   │
  │  模型/供应商    │                               │
  │  size/quality  │                               │
  │  n             │                               │
  │  生成按钮       │                               │
  ├───────────────┴───────────────────────────────┤
  │  底部历史条 (通栏, 约总高 1/5, 横向滚动缩略图)  │
  └────────────────────────────────────────────────┘
```

CSS 用 grid：外层 `grid-template-rows: 1fr auto`（上部工作区 + 底部历史条约 20% 高，
历史条用固定高度如 `clamp(120px, 20vh, 200px)` 避免 vh 字体缩放问题，符合 ui/AGENTS.md）。
上部工作区 `grid-template-columns: minmax(320px, 2fr) 3fr`；右栏 `grid-template-rows: 1fr 3fr`
（参考图区:生成区 = 1:3）。最小窗口 900x620 下左栏可滚动，不重叠。

左栏参数区（组件 `ImageGenParamPanel`）：

- 提示词多行输入 `textarea`。
- 「优化提示词」按钮：调 `optimizePrompt({ modelId, prompt })`，把返回写回输入框；
  modelId 选择器复用产品级文本模型列表（`loadModelSettings().models`，取 enabled）。
  优化中禁用按钮 + spinner。文本模型未配置时按钮禁用并提示去设置。
- 图片供应商选择（`listProviders()` 的 enabled 项）。
- 模型 modelId 输入/选择（默认取供应商 `defaultModel`，可编辑，如 `gpt-image-2`）。
- size 选择（`auto` + GPT Image 2 推荐分辨率的分组下拉，复用 `SettingsSelect` 或本页自建）。
- quality 选择（auto/low/medium/high）。
- n（1-4，默认 1）。
- 「生成」主按钮：校验（`request.ts` 的纯函数）-> `generate(recordId, req)`；生成中禁用并展示进度态。

右上参考图区（`ImageGenReferencePanel`）：

- 展示当前任务参考图缩略图，支持拖拽/点击上传（`uploadReference`），可删除。
- 参考图存在时，生成走后端 edits 分支。

右下生成图区（`ImageGenCanvas`）：

- 展示「当前选中批次」的生成图（默认最近一次批次）。多张图时网格排列，点击放大预览
  （复用现有 `features/chat/ImagePreview` 思路或简单 lightbox）。
- 生成中显示骨架/占位；失败显示错误条。

底部历史条（`ImageGenRunStrip`）：

- 横向滚动，每个批次一个缩略图卡（取该批次最后一张图 + 小字提示词摘要 + 时间）。
- 点击某批次：把左栏参数/提示词恢复为 `run.request` 快照，右下生成区切到该批次的图，
  参考图区切到该批次使用的参考图。此时用户可改参数/提示词再次点「生成」做二次生成，
  新批次追加到历史条末尾（不覆盖旧批次）。
- 「当前选中批次」为本地 state；生成成功后自动选中新批次。

顶部返回：detail 页头部一个返回按钮回列表页（`setActiveView("image-gen-list")`）。

### 5.5 服务层 `imageGenStore.ts`

`ui/src/services/imageGenStore.ts`：用 `ensureBackend()` + fetch 构造 `ImageGenTransport`，
`createImageGenClient` 得到客户端并 re-export 各方法（与 `settingsStore.ts` 风格一致，
薄封装、错误消息取后端 `error` 字段）。图片 url 已是后端静态路径，`<img>` 直接用
`${baseUrl}${url}`（或后端直接返回带 base 的相对路径，前端拼 baseUrl）。

### 5.6 供应商配置 UI（图片生成供应商）

在设置页新增 section「图片生成供应商」：

1. `ui/src/pages/settings/types.ts`：`SettingsSection` 增加 `"imageProviders"`。
2. `ui/src/pages/settings/SettingsLayout.tsx`：`settingsMenu` 在「模型提供商配置」下方追加
   `{ id: "imageProviders", icon: Image, label: "图片生成供应商" }`。
3. `ui/src/pages/settings/SettingsPage.tsx`：`initialSection` 支持定位；新增
   `activeSection === "imageProviders"` 渲染 `<ImageProvidersSettings />`。
4. 新建 `ui/src/pages/settings/ImageProvidersSettings.tsx`：表单仅 url + apiKey（可选 name、
   defaultModel），列表展示已配供应商（密钥遮蔽、启用开关、编辑、删除），复用现有
   `settings-card`/`settings-field`/`settings-primary-button` 等类名与 `ModelProvidersSettings`
   的交互骨架（去掉「模型发现/能力」层，只留连接信息）。

## 6. 双端同步说明（本轮取舍）

按 `AGENTS.md`「双端同步约定」：生图属于两端都会有的功能，但本轮用户明确「先做桌面端」。
处理方式：

1. **共享逻辑下沉到 `packages/image-gen`**（类型、请求构造、客户端、transport 接口），
   保证远程端后续零改动复用协议与客户端，只注入自己的 transport。
2. **展示层（React 页面）桌面端先实现**，远程端后续按 `ui-remote/AGENTS.md` 的 Sheet/导航栈
   单独排期，届时在远端 AI 页右下角加号上方加「图片」切换按钮（用户已描述的远端交互）。
3. **后端接口两端通用**：远程端经中继转发到同一 backend 接口，无需二次开发后端。
4. 提交信息与本文注明：本轮仅桌面端 UI 落地，远程端 UI 待后续。

## 7. 分阶段落地

### 阶段 1：共享包 + 后端

1. 新建 `packages/image-gen`，接线 tsconfig/vite/workspace。
2. 后端：`RuntimeConfig` 目录、`ImageProviderConfigStore`、`ImageRecordStore`、
   `image_gen` 路由、`AppServices`/`app.py`/`router.py` 接线。
3. 验收：`uv` 后端可起，`curl` 走通供应商 CRUD、创建任务、生成（可用兼容供应商联调）、
   静态图片可访问、提示词优化返回文本。

### 阶段 2：设置页图片供应商配置

1. `SettingsSection` 扩展、菜单项、`ImageProvidersSettings` 组件、`initialSection` 定位。
2. 验收：新增/编辑/删除供应商，刷新后仍在，密钥不回明文。

### 阶段 3：桌面端图片生成页面

1. 侧边栏「更多工具」入口 + `ActiveView` 扩展。
2. 列表页（图卡、新建、设置跳转、删除）。
3. 生成页（左参数/右上参考/右下生成/底部历史、优化提示词、二次生成恢复快照）。
4. `imageGenStore` 服务层。
5. 验收：新建任务->生成->历史条出现->点历史恢复参数->改提示词二次生成->列表页封面与标题更新。

### 阶段 4（后续，非本轮）：远程端

1. 远端 AI 页加号上方「图片/聊天」切换按钮。
2. 远端注入中继 transport 复用 `@code-lite/image-gen`。
3. 远端列表页/生成页按 Sheet + 导航栈落地。

## 8. 验证

- 前端：`npm run ui:build`（`tsc && vite build`）通过。
- 包类型：`packages/image-gen` 纳入类型检查通过。
- 后端：本地起 backend，接口 `curl` 冒烟；密钥不出现在任何 GET 响应与日志。
- 编码：所有新增文件 UTF-8，无 emoji，颜色走语义令牌，无硬编码 hex。

## 9. 待确认问题

1. 参考图对「非 edits 能力」的供应商如何降级：若供应商不支持 edits，是报错还是忽略参考图走
   generations？本文默认：有参考图就走 edits，供应商不支持则返回可读错误。
2. 提示词优化的 system 模板语言（中文/英文/跟随输入）是否需要用户可配，本轮先固定跟随输入语言。
3. 列表页标题字数 N（暂定 24，与会话标题一致）。
4. `n>1` 时封面取「最后一张」还是「第一张」，本文取最后一张（与「展示最后一张生成图」一致）。
5. 是否需要在总览/计费里统计图片生成用量，本轮不纳入。

---

## 10. 远程端（ui-remote）设计

远程端与桌面端最大的不同：**生图是纯前端应用，不走 code-lite 后端**，与远端 AI 对话模块
（`aiClient` / `AiProviderStore` / `AiConversationStore`）同构——直连供应商、按环境分流、
配置与记录存本地。改动前必读 `ui-remote/AGENTS.md`。

### 10.1 环境分流（沿用 AI 对话的判定）

生图与 AI 对话一样直连大模型 API，可用性取决于运行环境，**统一走 `lib/environment.ts`
的 `isAiAvailable()`**，不新增判定点：

| 环境 | 生图是否可用 | 请求走向 |
|------|------------|---------|
| 原生 App | 可用 | 可取消的生成请求走 `capacitor-stream-http-v2` 收集完整 JSON；其它 JSON/图片下载走 `CapacitorHttp` |
| dev（Vite） | 可用 | 经同源 `/ai-proxy` 中间件转发 fetch（已支持 JSON body） |
| PWA / 生产静态 | 不可用 | 入口 gate 掉，显示「仅 App 可用」 |

生图接口返回一次性 JSON（`data[].url` 或 `b64_json`），正常不需要 SSE 解析。但生成任务需要支持
用户主动终止，因此原生生成 POST 复用 `capacitor-stream-http-v2` 的可取消请求，把 chunk 收集完后
一次性解析 JSON；提示词优化等无需任务取消的 JSON 请求，以及图片直链下载，仍使用能拿 HTTP status
的 `CapacitorHttp`。dev 环境统一用带 AbortSignal 的 fetch。

### 10.2 参考图统一走 base64 JSON（不引入 multipart 插件）

桌面端参考图走后端 `/v1/images/edits`（multipart）。远程端纯前端，multipart 二进制在原生
插件下不便发送，且 Capacitor 8 生态缺乏稳定的原生 multipart 上传插件。**远程端参考图改走
JSON + base64**：像 AI 多模态那样把参考图编码为 base64 放进请求体，避开 multipart，让
dev/原生两条路都用同一条 JSON 请求。

- 无参考图：`POST {baseUrl}/images/generations`（JSON）。
- 有参考图：`POST {baseUrl}/images/edits` 的 JSON 变体，`images` 数组每项 `{ image_url: <data URL> }`
  传参考图 base64（供应商约定的形状，报错 `images[].image_url is required` 即此接口）；若供应商
  只认 multipart 而报错，回落为可读错误提示，并允许纯文生图继续。

### 10.3 共享包扩展：直连传输实现

`@code-lite/image-gen` 已定义 `ImageGenTransport` 接口与 `createImageGenClient`（桌面端注入的
是"走 backend"的实现）。远程端需要一个**"直连供应商"的实现**，因此在包内新增一个
**直连客户端** `createDirectImageGenClient(deps)`，与走后端的 `createImageGenClient` 并存：

- 入参 `deps` 注入：`httpJson(url, init)`（由远端按环境用 CapacitorHttp / ai-proxy fetch 实现）、
  以及供应商解析函数（远端从本地 store 取 baseUrl/apiKey）。
- 暴露 `generate(providerConn, req)`、`optimizePrompt(textModelConn, req)` 等纯请求组装 +
  响应解析方法，返回 `{ images: {b64?/url?, revisedPrompt?}[] }` 这种"裸结果"，落盘/存储交给
  远端（IndexedDB）。
- 请求体构造复用 `request.ts` 的校验函数（`buildGenerateBody` 等），保证与桌面端参数校验一致。

这样"生图核心"仍集中在共享包，远端只注入传输与供应商解析，桌面端维持走后端不变。

### 10.4 图片存储：IndexedDB Blob

生图产物比对话缩略图大，base64 全塞 `localStorage`（5-10MB 上限）会很快溢出。远端图片二进制
存 **IndexedDB**（可存几百 MB），记录 JSON（走 Preferences/localStorage）里只存图片 id 与元数据，
展示时按 id 从 IndexedDB 取 `Blob` 转 `objectURL`。

新增 `services/imageBlobStore.ts`：
- `putImage(id, blob)` / `getImage(id): Promise<Blob | null>` / `deleteImage(id)` / `deleteMany(ids)`。
- 一个 object store `images`，key 为图片 id。
- 供应商返回 `url` 时，前端 fetch 下载为 Blob 再存；返回 `b64_json` 时解码为 Blob 再存。
  统一存 Blob，展示层不关心来源。

### 10.5 本地存储：供应商与记录

仿照 `AiProviderStore` / `AiConversationStore`（Preferences + localStorage 双写 + subscribe）：

- **`services/ImageProviderStore.ts`**：图片供应商（仅 url + apiKey + 可选 name / defaultModel），
  与 AI 文本供应商分开存（键 `image-providers`）。`subscribe/loadProviders/saveProvider/removeProvider`。
- **`services/ImageGenStore.ts`**：生图任务与批次记录。
  - 索引键 `image-records` 存任务元数据列表（id/title/createdAt/updatedAt/coverImageId/runCount）。
  - 每个任务的 runs 单独存 `image-record-runs-{id}`（每个 run 含参数快照、图片 id 列表、参考图 id 列表、error）。
  - 图片二进制在 `imageBlobStore`；删除任务时级联删除其 runs 键与 IndexedDB 里的图片。
  - `getSnapshot` 返回任务元数据列表，供 `useSyncExternalStore`。

提示词优化复用远端**已配置的 AI 文本模型**（`AiProviderStore` 的 model + provider），不新增文本
供应商配置——与桌面端"复用产品级文本模型"对应。

### 10.6 UI 结构与入口

**入口（按用户交互）**：在 AI Tab 右下角 FAB 上方增加一个小的「切换」按钮（风格类似远程页
最近/排序切换按钮，icon 用图片图标），点击切到「生图模式」：此时 AI Tab 的列表区展示**生图
历史任务卡片**，FAB 的加号变为「新建生图任务」；再点切换按钮（icon 变回聊天）切回 AI 对话列表。

即：AI Tab 内部有 `aiMode: "chat" | "image"` 本地态，两种模式复用同一个 Tab 容器与 FAB 位置，
只切换列表内容与新建动作。这样不新增底部 Tab，符合"加号上方切换按钮"的描述。

**页面（走导航栈，新增 `ScreenEntry` 变体）**：

1. **生图历史列表**：不单独作为整页——它就是 AI Tab 在 image 模式下的列表（方形/横条图卡，
   封面取任务最后一张图，标题取提示词前 N 字）。点卡片 `nav.push({ kind: "imageGen", recordId })`。
   FAB 新建：先建空任务再 push。
2. **`imageGen` 生成页**（新 `ScreenEntry`）：移动端竖向布局（与桌面端左右分栏不同）：
   - 顶部 header：返回 + 标题。
   - 参考图区（横向缩略图条，可加/删）。
   - 生成图展示区（当前选中批次的图，点击放大预览，复用 AI 页的 Portal lightbox）。
   - 底部输入/参数区：提示词 `TextArea` + 「优化」按钮（选文本模型）、供应商/模型/尺寸/画质/数量
     用 `Select`、生成主按钮。
   - 历史批次条：横向滚动缩略图，点击恢复该批次参数/提示词/参考图/生成图（与桌面端一致）。
3. **图片供应商配置**（新 `ScreenEntry`，如 `imageProviders` + `imageProviderForm`）：挂在
   设置页 AI 段落下新增一项「图片生成供应商」，仅 url + apiKey（+ 名称/默认模型）；表单基于
   `Input`，列表基于现有 `ai-provider-card` 样式复用。同样受 `isAiAvailable()` gate。

**移动端布局取舍**：桌面端是"左参数/右上参考/右下生成/底部历史"的宽屏四区；移动端竖屏改为
自上而下"参考图 → 生成图 → 输入参数 → 历史条"的纵向堆叠，生成图区占主要高度，历史条固定
高度横向滚动，参数区可随内容展开。所有颜色走 `tokens.css` 令牌，弹层基于 `Sheet`，全屏页经
导航栈 + `ScreenTransition`。

### 10.7 远程端落地步骤

1. 共享包：新增 `createDirectImageGenClient`（直连实现）与裸结果类型，复用 `request.ts` 校验。
2. `services/imageBlobStore.ts`（IndexedDB）+ `ImageProviderStore` + `ImageGenStore`（本地持久化）。
3. `services/imageHttp.ts`：按环境分流的 JSON 请求 seam（dev → `/ai-proxy` fetch；原生 →
   `CapacitorHttp`），供直连客户端注入。
4. hooks：`useImageProviders`、`useImageRecords`（订阅 store 快照）。
5. AI Tab 加 `aiMode` 切换按钮与 image 模式列表；新增生成页与供应商配置页的 `ScreenEntry` +
   `NavHost` case；设置页 AI 段落加入口（受 `isAiAvailable()` gate）。
6. 样式加进 `styles/` 对应文件（新建 `image-gen` 段落或并入 `chat.css`/`lists.css`），颜色走令牌。
7. `npm run build`（tsc strict + vite）通过；原生分支与参考图 base64 须真机验证。

### 10.8 后台运行与主动终止

生图任务由 `services/imageGenService.ts` 单例管理，不绑定 `ImageGenPage` 的挂载状态。每个活动
`recordId` 对应一个 AbortController：

- 应用进入后台或从生成页返回列表时不取消任务；只要 App 进程仍存活，原生请求继续执行，完成后
  图片照常写入 IndexedDB、批次写入 ImageGenStore。
- 生成页订阅活动任务。生成开始后主按钮从“生成”切换为“终止”，点击后中止当前 record 的请求；
  取消不记录为生成错误，已写入但尚未形成批次的临时图片要清理。
- 任务完成、失败或取消时清理 controller 与活动状态。用户或系统杀死 App 进程后，内存任务自然
  终止；本设计不引入 Android 前台服务或常驻通知。
