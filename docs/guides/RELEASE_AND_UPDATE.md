# 发布与版本更新

本文记录 code-lite 当前 Windows 原型阶段的版本号、打包和更新策略。

完整编译和发布步骤见 `docs/guides/BUILD_AND_RELEASE.md`。

## 版本号

项目使用 SemVer，例如 `0.1.2`：

1. `0.1.x`：原型期修复和小功能。
2. `0.x.0`：较大功能阶段，例如新增自动更新或执行网关。
3. `x.0.0`：稳定发布后再使用。

根目录 `VERSION` 是版本号的唯一手工维护入口。各工具链仍需要静态版本字段，所以 `package.json`、Tauri、Cargo、Python backend 和锁文件中的版本由脚本派生同步。

设置新版本：

```powershell
npm run version:set -- 0.1.2
```

也可以发布时直接传入版本号：

```powershell
npm run release:win -- -Version 0.1.2
```

如果只修改了 `VERSION` 文件，执行：

```powershell
npm run version:sync
```

`release.ps1` 和 `scripts/package-windows.ps1` 会在打包前自动同步版本。

## 打包

Windows 安装包使用：

```powershell
npm run package:win
```

如只改了 Tauri/UI，没有改 Python backend 依赖和打包内容，可复用已有 sidecar：

```powershell
npm run package:win -- -SkipDependencySync -SkipBackendBuild
```

产物位于：

```text
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

## 手动更新流程

当前阶段推荐手动更新：

1. 更新版本号，例如 `npm run version:set -- 0.1.2`，或修改 `VERSION` 后运行 `npm run version:sync`。
2. 运行验证命令。
3. 执行 `npm run package:win`。
4. 发布新的 `.exe` 或 `.msi`。
5. 用户运行新安装包覆盖安装。

安装包会保留用户运行时数据，例如：

```text
%USERPROFILE%\.code-lite\config
%USERPROFILE%\.code-lite\conversations
%USERPROFILE%\.code-lite\events
%USERPROFILE%\.code-lite\logs
%USERPROFILE%\.code-lite\cache
```

兼容期需要继续读取旧 `%USERPROFILE%\.repair-agent` 数据，并在迁移完成前避免删除旧数据。

## 自动更新规划

后续接入自动更新时，建议使用 Tauri updater：

1. 新增 `tauri-plugin-updater`。
2. 生成并保护 updater 私钥，不提交仓库。
3. 每个版本发布安装包、签名文件和更新 manifest。
4. manifest 放在稳定 HTTPS 地址，例如 GitHub Releases、对象存储或自建更新服务。
5. UI 在设置页或启动时检查更新，下载后提示用户重启安装。

自动更新上线前，需要先确定发布渠道、签名密钥保存方式和回滚策略。
