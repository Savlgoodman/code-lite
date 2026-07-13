# 开发流程规范

本文记录本项目的分支开发、合并和版本升级规则。所有开发者和 AI Coding Agent 在开始功能开发、Bug 修复、性能优化或其他代码变更前，都应先确认当前分支和工作区状态。

## 分支角色

项目长期保留两个主干分支：

1. `master`：稳定发布分支，只保留发布级合并、编译发布验证和用户明确授权的紧急修正。
2. `dev`：集成测试分支，用于在合并到 `master` 前汇总功能分支、修复分支和性能优化分支，并完成合并测试。

`master` 分支只保留以下操作：

1. 合并已经在 `dev` 完成集成验证且包含版本升级提交的内容。
2. 在合并后执行编译、打包和发布验证。
3. 用户明确授权的紧急文档或流程修正。

除上述情况外，不应直接在 `master` 上开发新功能、修复 Bug、做性能优化或重构。

`dev` 分支用于日常集成测试。文档修改、参数配置、流程说明等小幅度改动允许直接在 `dev` 上修改和提交；功能开发、Bug 修复、性能优化和重构仍应从 `dev` 新建独立分支。

## 分支命名

开发新功能、修复 Bug、性能优化、重构和测试补充等，都必须从 `dev` 新建分支。

分支命名格式：

```text
<type>/<scope>-<MMdd>-<name>
```

字段说明：

1. `<type>` 使用提交类型风格，例如 `feat`、`fix`、`perf`、`refactor`、`test`、`docs`、`chore`。
2. `<scope>` 表示影响范围、模块或任务编号，例如 `ui`、`backend`、`tauri`、`release`。
3. `<MMdd>` 使用创建分支当天的 4 位月日，例如 6 月 30 日写作 `0630`。
4. `<name>` 使用简短英文短横线描述，避免空格、中文和特殊符号。

示例：

```text
feat/settings-0630-model-provider
fix/backend-0630-sidecar-lifecycle
perf/overview-0630-cache
refactor/release-0630-version-sync
```

## 开发流程

推荐流程：

```powershell
git switch dev
git pull
git switch -c feat/settings-0630-model-provider
```

开发过程中保持小步提交，每个提交对应一个清晰目标。提交前应至少执行：

```powershell
git status --short
```

能用脚本、测试或静态检查验证的改动，应在分支内完成验证，并在合并说明中记录结果。

## 合并策略

所有合并尽量采用变基合并，保持 Git 提交树干净、线性和易读。

功能分支合入 `dev` 前，先在功能分支上变基到最新 `dev`：

```powershell
git switch dev
git pull
git switch feat/settings-0630-model-provider
git rebase dev
```

变基完成并验证后，再合入 `dev`。优先使用快进合并：

```powershell
git switch dev
git merge --ff-only feat/settings-0630-model-provider
```

如历史已经分叉且不能快进，应优先回到功能分支继续 `rebase dev`，避免无意义 merge commit。只有在需要保留分支上下文或用户明确要求时，才使用非快进合并。

`dev` 累积到可以发布的程度后，先完成集成验证，并在 `dev` 上完成独立版本升级提交，再变基合并到 `master`。发布合并必须使用变基 + 快进，禁止产生 merge commit，以保持 Git 提交树线性整洁：

```powershell
git switch dev
npm run version:set -- 0.1.3
git status --short
git add VERSION package.json ui/package.json ui/package-lock.json ui-remote/package.json ui-remote/package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock backend/pyproject.toml backend/uv.lock backend/code_lite_backend/version.py
git commit -m "chore: 升级版本到 0.1.3"
git rebase master
git switch master
git merge --ff-only dev
```

无论 `master` 与 `dev` 是否分叉，合并前都应先在 `dev` 上 `git rebase master`，确保快进合并成功。如果 rebase 有冲突，在 `dev` 上解决后再切回 `master` 执行 `--ff-only`。

## 版本升级与发布

发布前必须先在 `dev` 分支完成一次独立版本升级提交，再将 `dev` 变基到 `master` 后快进合并，最后在 `master` 上执行编译、打包和发布验证。

版本升级提交要求：

1. 必须在 `dev` 分支完成，且必须早于 `dev` 合并到 `master`。
2. 使用项目统一版本入口，例如 `npm run version:set -- 0.1.3` 或修改 `VERSION` 后运行 `npm run version:sync`。
3. 版本提交只包含版本相关文件，不混入功能代码。
4. 提交信息使用 Conventional Commits，例如 `chore: 升级版本到 0.1.3`。

推荐顺序：

```powershell
git switch dev
npm run version:set -- 0.1.3
git status --short
git add VERSION package.json ui/package.json ui/package-lock.json ui-remote/package.json ui-remote/package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock backend/pyproject.toml backend/uv.lock backend/code_lite_backend/version.py
git commit -m "chore: 升级版本到 0.1.3"
git rebase master
git switch master
git merge --ff-only dev
```

发布合并必须使用变基 + 快进（`rebase` + `--ff-only`），禁止使用 `--no-ff` 或普通 merge 产生 merge commit。目标是保持 `master` 提交树完全线性，每个提交都是有意义的功能或版本节点。

合并到 `master` 后，再执行编译、打包和发布验证。编译验证必须晚于 `master` 快进合并，以确认最终发布分支可构建：

```powershell
npm run ui:build
npm run tauri:build
```

版本升级提交已经在 `dev` 上完成并随快进合并进入 `master`，发布完成后不需要再把 `master` 上的版本提交同步回 `dev`。如果发布过程中在 `master` 产生了额外修正，应先评估是否需要回到 `dev` 补提交并重新走发布流程，避免 `master` 与 `dev` 长期分叉。

## AI Agent 要求

AI Coding Agent 在接到开发、修复、优化类任务时，应先检查当前分支：

```powershell
git branch --show-current
git status --short
```

如果当前在 `master` 且任务不是分支合并、编译发布验证或用户明确授权的例外，应先切换到 `dev` 或从 `dev` 创建符合规范的新分支再修改代码。

如果当前在 `dev` 且任务只是文档修改、参数配置或流程说明等小幅度改动，可以直接在 `dev` 上修改。其他开发、修复和优化任务应从 `dev` 新建分支。

遇到已有未提交改动时，不得擅自覆盖或回退，应先确认改动归属并保护用户工作。
