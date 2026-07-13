param(
  [string]$Version,
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$NoProxy,
  [switch]$SkipDependencySync,
  [switch]$SkipBackendBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$uiDir = Join-Path $repoRoot "ui"
$backendDir = Join-Path $repoRoot "backend"
$srcTauriDir = Join-Path $repoRoot "src-tauri"
$distDir = Join-Path $repoRoot "dist"
$distFullPath = [System.IO.Path]::GetFullPath($distDir)
$repoFullPath = [System.IO.Path]::GetFullPath($repoRoot)

$vsDevCmd = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
$backendBinaryName = "code-lite-backend-x86_64-pc-windows-msvc"
$backendBinaryDir = Join-Path $srcTauriDir "binaries"

if (-not (Test-Path $vsDevCmd)) {
  throw "Visual Studio Build Tools not found: $vsDevCmd"
}

if ($NoProxy) {
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
} else {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:ALL_PROXY = $Proxy
}

$env:PYTHONUTF8 = "1"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Code-Lite Desktop Builder" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Sync version
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  & (Join-Path $repoRoot "scripts\set-version.ps1") -Version $Version
} else {
  & (Join-Path $repoRoot "scripts\set-version.ps1")
}

# 1. Dependency sync
if (-not $SkipDependencySync) {
  Write-Host "[1/5] Installing dependencies..." -ForegroundColor Yellow
  npm install --prefix $uiDir
  if ($LASTEXITCODE -ne 0) { throw "npm install failed for ui/ with exit code $LASTEXITCODE" }
  uv sync --project $backendDir
  if ($LASTEXITCODE -ne 0) { throw "uv sync failed for backend/ with exit code $LASTEXITCODE" }
  Write-Host "  Dependencies OK" -ForegroundColor Green
} else {
  Write-Host "[1/5] Skipping dependency sync..." -ForegroundColor Gray
}

# 2. Build backend sidecar
if (-not $SkipBackendBuild) {
  Write-Host "[2/5] Building backend sidecar..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $backendBinaryDir | Out-Null

  $nanobotTemplatesPath = & uv run --project $backendDir python -c "from pathlib import Path; import nanobot; print(Path(nanobot.__file__).resolve().parent / 'templates')"
  if (-not $nanobotTemplatesPath -or -not (Test-Path $nanobotTemplatesPath)) {
    throw "nanobot templates directory not found: $nanobotTemplatesPath"
  }

  $backendBinaryPath = Join-Path $backendBinaryDir "$backendBinaryName.exe"
  if (Test-Path $backendBinaryPath) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      try {
        Remove-Item -LiteralPath $backendBinaryPath -Force -ErrorAction Stop
        break
      } catch {
        if ($attempt -eq 5) {
          throw "Unable to replace backend sidecar binary. Close any running Code Lite/backend process and retry: $backendBinaryPath"
        }
        Start-Sleep -Seconds 1
      }
    }
  }

  $pyinstallerArgs = @(
    "run", "--project", $backendDir,
    "--with", "pyinstaller",
    "pyinstaller",
    "--clean", "--noconfirm", "--onefile", "--noconsole",
    "--name", $backendBinaryName,
    "--hidden-import", "nanobot.nanobot",
    "--add-data", "$nanobotTemplatesPath;nanobot/templates",
    "--distpath", $backendBinaryDir,
    "--workpath", (Join-Path $backendDir "build\pyinstaller"),
    "--specpath", (Join-Path $backendDir "build\spec"),
    (Join-Path $backendDir "code_lite_backend\main.py")
  )
  uv @pyinstallerArgs
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller backend build failed with exit code $LASTEXITCODE" }

  $backendBinaryPath = Join-Path $backendBinaryDir "$backendBinaryName.exe"
  if (-not (Test-Path $backendBinaryPath)) {
    throw "Backend sidecar binary not found after build: $backendBinaryPath"
  }
  Write-Host "  Backend sidecar OK" -ForegroundColor Green
} else {
  Write-Host "[2/5] Skipping backend build..." -ForegroundColor Gray
}

# 3. Tauri build (frontend + Rust)
Write-Host "[3/5] Building Tauri app..." -ForegroundColor Yellow
$cmd = @(
  "call `"$vsDevCmd`" -arch=x64 -host_arch=x64",
  "set `"PATH=%USERPROFILE%\.cargo\bin;%PATH%`"",
  "cd /d `"$repoRoot`"",
  "npm run tauri:build"
) -join " && "

cmd.exe /d /c $cmd
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
Write-Host "  Tauri build OK" -ForegroundColor Green

# 4. Collect artifacts
Write-Host "[4/5] Collecting artifacts..." -ForegroundColor Yellow

$packageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$version = [string]$packageJson.version

$artifacts = @(
  @{ Label = "NSIS installer";  Path = Join-Path $srcTauriDir "target\release\bundle\nsis\Code Lite_$($version)_x64-setup.exe" },
  @{ Label = "MSI installer";   Path = Join-Path $srcTauriDir "target\release\bundle\msi\Code Lite_$($version)_x64_en-US.msi" },
  @{ Label = "App executable";  Path = Join-Path $srcTauriDir "target\release\code-lite.exe" },
  @{ Label = "Backend sidecar"; Path = Join-Path $srcTauriDir "target\release\code-lite-backend.exe" }
)

foreach ($artifact in $artifacts) {
  if (-not (Test-Path -LiteralPath $artifact.Path)) {
    throw "$($artifact.Label) not found: $($artifact.Path)"
  }
}
Write-Host "  All artifacts found (v$version)" -ForegroundColor Green

# 5. Copy to dist/
Write-Host "[5/5] Copying to dist/..." -ForegroundColor Yellow

if ($distFullPath.StartsWith($repoFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  if (Test-Path -LiteralPath $distFullPath) {
    $children = Get-ChildItem -LiteralPath $distFullPath -Force -ErrorAction SilentlyContinue
    foreach ($child in $children) {
      $childFullPath = [System.IO.Path]::GetFullPath($child.FullName)
      if (-not $childFullPath.StartsWith($distFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean unexpected dist child: $childFullPath"
      }
      Remove-Item -LiteralPath $child.FullName -Recurse -Force
    }
  } else {
    New-Item -ItemType Directory -Force -Path $distFullPath | Out-Null
  }

  foreach ($artifact in $artifacts) {
    Copy-Item -LiteralPath $artifact.Path -Destination $distFullPath -Force
  }
} else {
  throw "Refusing to write outside repo root: $distFullPath"
}

Write-Host ""
Write-Host "  Release artifacts in $distFullPath:" -ForegroundColor Green
Get-ChildItem -LiteralPath $distFullPath |
  Select-Object Name, @{N = 'Size(MB)'; E = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
  Format-Table -AutoSize

Write-Host "Done." -ForegroundColor Cyan
