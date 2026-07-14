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

## 统一版本号

版本信息分为两层：

1. **发行版本**：根目录 `VERSION` 是唯一手工维护入口，使用 SemVer，例如 `0.2.1`。
2. **构建标识**：每次正式构建开始时自动生成，格式为 `build-YYYY-MM-DD-HH-mm`，例如 `build-2026-07-13-23-49`。

应用内展示的完整版本为两者拼接：

```text
0.2.1 build-2026-07-13-23-49
```

构建时间统一按 `Asia/Shanghai` 时区生成，避免 Linux 部署机使用 UTC、Windows 开发机使用本地时区而得到不同日期。需要复现某次构建或让多个独立命令共用同一标识时，可在构建前显式设置 `CODE_LITE_BUILD_ID`；该值必须符合上述格式。

`package.json`、`ui/package.json`、`ui/package-lock.json`、`ui-remote/package.json`、`ui-remote/package-lock.json`、Tauri、Cargo、Python backend 和相关锁文件中的发行版本都是派生值，由版本同步脚本统一更新。构建标识不写回 `VERSION`，也不提交生成文件。

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

查看当前构建元数据：

```powershell
node .\scripts\build-version.mjs
```

构建入口会使用以下内部环境变量在同一轮构建中传递元数据：

| 变量 | 示例 | 用途 |
|---|---|---|
| `CODE_LITE_VERSION` | `0.2.1` | 发行版本 |
| `CODE_LITE_BUILD_ID` | `build-2026-07-13-23-49` | 构建标识 |
| `CODE_LITE_DISPLAY_VERSION` | `0.2.1 build-2026-07-13-23-49` | 应用内展示版本 |
| `CODE_LITE_ANDROID_VERSION_CODE` | `3435830` | Android 单调递增整数版本 |

这些变量是构建过程的传递值，不应写入仓库配置或长期保存在部署环境中。

### 各端版本映射

| 端 | 平台版本字段 | 应用内版本信息 |
|---|---|---|
| Windows 桌面端 | Tauri/Cargo 保持 `0.2.1` | 关于页展示完整版本 |
| Python backend | Python 包版本保持 `0.2.1` | 关于接口返回完整版本 |
| Android APK | `versionName` 保持 `0.2.1`；`versionCode` 使用构建时间派生整数 | Remote 关于页展示完整版本 |
| PWA / Web | 无系统版本字段 | 编译期写入完整版本，并输出 `dist/build-info.json` |

Android 与 Tauri 的平台版本字段不追加带空格的构建标识，以兼容包管理器和 SemVer 约束。构建标识通过应用内版本信息保留。

## Remote PWA 构建

在任意平台直接构建：

```powershell
npm run build --prefix ui-remote
```

Vite 在构建开始时读取根目录 `VERSION` 并生成构建标识，随后把完整版本静态编入产物。Linux 部署建议使用统一脚本：

```bash
bash scripts/build-remote.sh
```

脚本会先生成一组构建元数据，再执行 Remote 构建，因此同一轮构建中的页面版本、Service Worker 缓存名和 `build-info.json` 保持一致，不需要编译后替换 JavaScript 文本。

## Android APK 构建

Android 启动器图标统一以 `src-tauri/icons/android/` 为源。更新图标后运行以下命令，将普通、圆形和自适应图标同步到 Capacitor Android 工程的全部分辨率目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-android-icons.ps1
```

首次在本机配置正式签名：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-android-signing.ps1
```

该脚本会在根目录 `env/` 下生成 `code-lite-remote-release.jks` 和 `android-signing.properties`。目录已被 Git 忽略，properties 保存随机生成的密码，仓库代码和构建日志都不包含密码。两份文件必须一起做加密备份；丢失 release keystore 后，直接分发的旧 App 将无法通过覆盖安装升级。

构建并自动验证正式签名 APK：

```powershell
.\build-apk.ps1 -NoProxy
```

正式产物命名为：

```text
code-lite-remote_<version>_<build-id>.apk
```

例如 `code-lite-remote_0.2.1_build-2026-07-14-09-30.apk`。release 构建使用本地 keystore，构建完成后调用 Android SDK 的 `apksigner` 验证证书；WebView 调试仅在 debug 构建启用。

`build-apk.ps1` 默认构建 release。需要调试 APK 时显式传入 `-Debug`：

```powershell
.\build-apk.ps1 -Debug -NoProxy
```

脚本会先生成一次构建元数据，再依次执行前端构建、Capacitor 同步和 Gradle 构建。Gradle 的 `versionName` 从根目录 `VERSION` 获取，`versionCode` 由构建分钟换算为单调递增整数；完整版本在 App 的关于页中展示。

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
