param(
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$NoProxy,
  [switch]$Debug
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$uiRemoteDir = Join-Path $repoRoot "ui-remote"
$androidDir = Join-Path $uiRemoteDir "android"
$distDir = Join-Path $repoRoot "dist"
$buildVersionScript = Join-Path $repoRoot "scripts\build-version.mjs"
$signingPropertiesPath = Join-Path $repoRoot "env\android-signing.properties"

$buildInfoOutput = & node $buildVersionScript
if ($LASTEXITCODE -ne 0) {
  throw "Build version generation failed with exit code $LASTEXITCODE"
}
$buildInfo = ($buildInfoOutput -join [Environment]::NewLine) | ConvertFrom-Json
$env:CODE_LITE_VERSION = [string]$buildInfo.version
$env:CODE_LITE_BUILD_ID = [string]$buildInfo.buildId
$env:CODE_LITE_DISPLAY_VERSION = [string]$buildInfo.displayVersion
$env:CODE_LITE_ANDROID_VERSION_CODE = [string]$buildInfo.androidVersionCode

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

$isRelease = -not $Debug.IsPresent
$buildType = if ($isRelease) { "assembleRelease" } else { "assembleDebug" }
$apkSubDir = if ($isRelease) { "release" } else { "debug" }
$apkName = if ($isRelease) { "app-release.apk" } else { "app-debug.apk" }
$distApkName = if ($isRelease) {
  "code-lite-remote_$($buildInfo.version)_$($buildInfo.buildId).apk"
} else {
  $apkName
}

if ($isRelease -and -not (Test-Path -LiteralPath $signingPropertiesPath)) {
  throw "Android release signing is not configured. Run scripts\setup-android-signing.ps1 first."
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Code-Lite Remote Android APK Builder" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Version: $($buildInfo.displayVersion)" -ForegroundColor White
Write-Host "  Android versionCode: $($buildInfo.androidVersionCode)" -ForegroundColor White
Write-Host "  Variant: $(if ($isRelease) { 'release' } else { 'debug' })" -ForegroundColor White
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

if ($isRelease) {
  $androidSdk = $env:ANDROID_HOME
  if ([string]::IsNullOrWhiteSpace($androidSdk)) {
    $androidSdk = $env:ANDROID_SDK_ROOT
  }
  if ([string]::IsNullOrWhiteSpace($androidSdk)) {
    throw "ANDROID_HOME or ANDROID_SDK_ROOT is required to verify the release APK signature."
  }
  $apkSigner = Get-ChildItem -Path (Join-Path $androidSdk "build-tools") -Recurse -File -Filter "apksigner.bat" |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $apkSigner) {
    throw "apksigner.bat was not found under $androidSdk\build-tools"
  }

  & $apkSigner.FullName verify --verbose --print-certs $apkPath
  if ($LASTEXITCODE -ne 0) {
    throw "APK signature verification failed with exit code $LASTEXITCODE"
  }
  Write-Host "  Release signature verified" -ForegroundColor Green
}

if (-not (Test-Path $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

Copy-Item -LiteralPath $apkPath -Destination (Join-Path $distDir $distApkName) -Force

$distApk = Join-Path $distDir $distApkName
$sizeMB = [math]::Round((Get-Item $distApk).Length / 1MB, 2)

Write-Host ""
Write-Host "[4/4] Copied to dist/" -ForegroundColor Green
Write-Host ""
Write-Host "  Output: $distApk" -ForegroundColor White
Write-Host "  Size:   $sizeMB MB" -ForegroundColor White
Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
