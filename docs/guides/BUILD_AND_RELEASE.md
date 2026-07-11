# 编译与发布

本文记录 code-lite Windows 原型阶段的本地编译、打包和发布产物整理流程。

## 环境要求

1. Node.js 与 npm。
2. Rust stable MSVC 工具链。
3. Visual Studio Build Tools 2022，包含 C++ Build Tools 和 Windows SDK。
4. uv。
5. Microsoft Edge WebView2 Runtime。

如网络需要代理，默认使用：

```powershell
http://127.0.0.1:7899
```

## 常用验证

发布前建议执行：

```powershell
npm run ui:build
uv run --project backend python -m code_lite_backend.main --help
python -m compileall backend\code_lite_backend
cargo check --manifest-path .\src-tauri\Cargo.toml
```

## 版本号

版本号以根目录 `VERSION` 文件为唯一手工维护入口。`package.json`、`ui/package.json`、`ui/package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`backend/pyproject.toml`、`backend/uv.lock` 和 `backend/code_lite_backend/version.py` 中的版本字段都是派生值，由脚本同步。

设置新版本：

```powershell
npm run version:set -- 0.1.2
```

也可以在发布时直接传入版本号：

```powershell
npm run release:win -- -Version 0.1.2
```

如果只手动修改了 `VERSION`，可执行：

```powershell
npm run version:sync
```

`release.ps1` 和 `scripts/package-windows.ps1` 会在打包前自动执行版本同步。安装态关于页优先使用 Tauri 启动 sidecar 时注入的版本环境变量，避免依赖源码仓库中的 `package.json` 或 `pyproject.toml`。

## 打包

完整 Windows 打包：

```powershell
npm run package:win
```

打包命令会在默认 Tauri 配置之外合并 `src-tauri/tauri.release.conf.json`，并把当前 backend sidecar 打入安装包。现阶段 sidecar 文件名仍可能使用历史 `code-lite-backend-x86_64-pc-windows-msvc.exe`，后续应随 code-lite 命名迁移。开发模式不合并该配置，因此无需预先生成 sidecar。

指定版本并打包：

```powershell
npm run package:win -- -Version 0.1.2
```

不使用代理：

```powershell
npm run package:win -- -NoProxy
```

只复用已有依赖：

```powershell
npm run package:win -- -SkipDependencySync
```

只复用已有 backend sidecar：

```powershell
npm run package:win -- -SkipDependencySync -SkipBackendBuild
```

Tauri 原始产物位于：

```text
src-tauri/target/release/
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

## 一键发布

根目录脚本 `release.ps1` 会先打包，再整理发布产物到 `dist/`：

```powershell
.\release.ps1
```

也可以通过 npm 调用：

```powershell
npm run release:win
```

如已经打包完成，只想重新整理 `dist/`：

```powershell
.\release.ps1 -SkipBuild
```

目标 `dist/` 产物命名应迁移为：

```text
code-lite_<version>_x64-setup.exe
code-lite_<version>_x64_en-US.msi
code-lite.exe
code-lite-backend.exe
```

当前脚本和 Tauri 配置可能仍输出历史名称，迁移发布产物名时应同步更新 `release.ps1`、`scripts/package-windows.ps1`、Tauri 配置和版本同步脚本。

`dist/` 是本地发布产物目录，已被 `.gitignore` 忽略，不提交到仓库。

## 发布给用户

当前阶段推荐手动分发 NSIS 或 MSI 安装包。用户安装新版本会保留运行时数据：

```text
%USERPROFILE%\.code-lite\config
%USERPROFILE%\.code-lite\conversations
%USERPROFILE%\.code-lite\events
%USERPROFILE%\.code-lite\logs
%USERPROFILE%\.code-lite\cache
```

兼容期需要继续读取旧 `%USERPROFILE%\.repair-agent` 数据，并提供一次性迁移或兼容读取策略。

自动更新规划见 `docs/guides/RELEASE_AND_UPDATE.md`。
