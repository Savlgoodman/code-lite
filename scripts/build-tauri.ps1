$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildVersionScript = Join-Path $repoRoot "scripts\build-version.mjs"
$tauriConfig = Join-Path $repoRoot "src-tauri\tauri.release.conf.json"

$buildInfoOutput = & node $buildVersionScript
if ($LASTEXITCODE -ne 0) {
  throw "Build version generation failed with exit code $LASTEXITCODE"
}
$buildInfo = ($buildInfoOutput -join [Environment]::NewLine) | ConvertFrom-Json
$env:CODE_LITE_VERSION = [string]$buildInfo.version
$env:CODE_LITE_BUILD_ID = [string]$buildInfo.buildId
$env:CODE_LITE_DISPLAY_VERSION = [string]$buildInfo.displayVersion
$env:CODE_LITE_ANDROID_VERSION_CODE = [string]$buildInfo.androidVersionCode

Write-Host "Building Code Lite $($buildInfo.displayVersion)"

Push-Location $repoRoot
try {
  & npm exec --prefix (Join-Path $repoRoot "ui") -- tauri build --config $tauriConfig
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
