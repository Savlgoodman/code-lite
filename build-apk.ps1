param(
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$NoProxy,
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$uiRemoteDir = Join-Path $repoRoot "ui-remote"
$androidDir = Join-Path $uiRemoteDir "android"
$distDir = Join-Path $repoRoot "dist"

# Proxy setup
if ($NoProxy) {
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
} else {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:ALL_PROXY = $Proxy
}

$buildType = if ($Release) { "assembleRelease" } else { "assembleDebug" }
$apkSubDir = if ($Release) { "release" } else { "debug" }
$apkName = if ($Release) { "app-release-unsigned.apk" } else { "app-debug.apk" }

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Code-Lite Remote Android APK Builder" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Build frontend
Write-Host "[1/4] Building frontend..." -ForegroundColor Yellow
Push-Location $uiRemoteDir
try {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend build failed with exit code $LASTEXITCODE"
  }
  Write-Host "  Frontend build OK" -ForegroundColor Green
} finally {
  Pop-Location
}

# 2. Sync to Android
Write-Host "[2/4] Syncing Capacitor Android..." -ForegroundColor Yellow
Push-Location $uiRemoteDir
try {
  npx cap sync android
  if ($LASTEXITCODE -ne 0) {
    throw "Capacitor sync failed with exit code $LASTEXITCODE"
  }
  Write-Host "  Capacitor sync OK" -ForegroundColor Green
} finally {
  Pop-Location
}

# 3. Build APK
Write-Host "[3/4] Building APK ($buildType)..." -ForegroundColor Yellow
Push-Location $androidDir
try {
  & .\gradlew.bat $buildType
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle build failed with exit code $LASTEXITCODE"
  }
  Write-Host "  APK build OK" -ForegroundColor Green
} finally {
  Pop-Location
}

# 4. Copy to dist
$apkPath = Join-Path $androidDir "app\build\outputs\apk\$apkSubDir\$apkName"
if (-not (Test-Path $apkPath)) {
  throw "APK not found: $apkPath"
}

if (-not (Test-Path $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

Copy-Item -LiteralPath $apkPath -Destination (Join-Path $distDir $apkName) -Force

$distApk = Join-Path $distDir $apkName
$sizeMB = [math]::Round((Get-Item $distApk).Length / 1MB, 2)

Write-Host ""
Write-Host "[4/4] Copied to dist/" -ForegroundColor Green
Write-Host ""
Write-Host "  Output: $distApk" -ForegroundColor White
Write-Host "  Size:   $sizeMB MB" -ForegroundColor White
Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
