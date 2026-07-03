param(
  [string]$Version,
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$NoProxy,
  [switch]$SkipDependencySync,
  [switch]$SkipBackendBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$vsDevCmd = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
$backendBinaryName = "code-lite-backend-x86_64-pc-windows-msvc"
$backendBinaryDir = Join-Path $repoRoot "src-tauri\binaries"

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
New-Item -ItemType Directory -Force -Path $backendBinaryDir | Out-Null

$versionArgs = @{}
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $versionArgs["Version"] = $Version
}
& (Join-Path $repoRoot "scripts\set-version.ps1") @versionArgs

if (-not $SkipDependencySync) {
  npm install --prefix (Join-Path $repoRoot "ui")
  uv sync --project (Join-Path $repoRoot "backend")
}

if (-not $SkipBackendBuild) {
  $nanobotTemplatesPath = & uv run --project (Join-Path $repoRoot "backend") python -c "from pathlib import Path; import nanobot; print(Path(nanobot.__file__).resolve().parent / 'templates')"
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
    "run",
    "--project",
    (Join-Path $repoRoot "backend"),
    "--with",
    "pyinstaller",
    "pyinstaller",
    "--clean",
    "--noconfirm",
    "--onefile",
    "--noconsole",
    "--name",
    $backendBinaryName,
    "--hidden-import",
    "nanobot.nanobot",
    "--add-data",
    "$nanobotTemplatesPath;nanobot/templates",
    "--distpath",
    $backendBinaryDir,
    "--workpath",
    (Join-Path $repoRoot "backend\build\pyinstaller"),
    "--specpath",
    (Join-Path $repoRoot "backend\build\spec"),
    (Join-Path $repoRoot "backend\code_lite_backend\main.py")
  )
  uv @pyinstallerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller backend build failed with exit code $LASTEXITCODE"
  }
}

$backendBinaryPath = Join-Path $backendBinaryDir "$backendBinaryName.exe"
if (-not (Test-Path $backendBinaryPath)) {
  throw "Backend sidecar binary not found: $backendBinaryPath"
}

$cmd = @(
  "call `"$vsDevCmd`" -arch=x64 -host_arch=x64",
  "set `"PATH=%USERPROFILE%\.cargo\bin;%PATH%`"",
  "cd /d `"$repoRoot`"",
  "npm run tauri:build"
) -join " && "

cmd.exe /d /c $cmd
if ($LASTEXITCODE -ne 0) {
  throw "Tauri build failed with exit code $LASTEXITCODE"
}
