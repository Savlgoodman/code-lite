param(
  [string]$Proxy = "http://127.0.0.1:7899",
  [int]$BackendPort = 18765,
  [switch]$NoProxy
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$backendUrl = "http://127.0.0.1:$BackendPort"
$tempDir = Join-Path $repoRoot ".cache\dev-launch"
$backendCmd = Join-Path $tempDir "backend.cmd"
$tauriCmd = Join-Path $tempDir "tauri.cmd"

if (-not (Get-Command "wt.exe" -ErrorAction SilentlyContinue)) {
  throw "Windows Terminal not found: wt.exe. Install Windows Terminal or run backend and Tauri commands separately."
}

if (-not (Get-Command "uv.exe" -ErrorAction SilentlyContinue)) {
  throw "uv.exe not found. Install uv or add uv to PATH."
}

# ── 清理残留 backend 进程 ──────────────────────────────────────────────
# 查找占用目标端口的进程并终止，避免 "端口已被占用" 的问题
$portOwnerPid = $null
try {
  $conn = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $portOwnerPid = $conn.OwningProcess
  }
} catch { }

if ($portOwnerPid) {
  Write-Host "发现残留的 backend 进程 (PID: $portOwnerPid)，正在终止..." -ForegroundColor Yellow
  try {
    # 先尝试正常终止（让 uvicorn 执行 graceful shutdown）
    Stop-Process -Id $portOwnerPid -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    # 检查是否还在运行
    $stillRunning = Get-Process -Id $portOwnerPid -ErrorAction SilentlyContinue
    if ($stillRunning) {
      Write-Host "进程未响应，强制终止..." -ForegroundColor Yellow
      Stop-Process -Id $portOwnerPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  } catch {
    # 进程可能已退出
  }
  Write-Host "残留进程已清理。" -ForegroundColor Green
}

# 同样清理可能的 codex-acp 子进程残留（通过命令行特征匹配）
$orphanedBackends = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%code_lite_backend.main%--port $BackendPort%'" -ErrorAction SilentlyContinue
if ($orphanedBackends) {
  foreach ($proc in $orphanedBackends) {
    Write-Host "发现残留 backend 子进程 (PID: $($proc.ProcessId))，终止..." -ForegroundColor Yellow
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$proxyLines = @()
if (-not $NoProxy) {
  $proxyLines = @(
    "set `"HTTP_PROXY=$Proxy`"",
    "set `"HTTPS_PROXY=$Proxy`"",
    "set `"ALL_PROXY=$Proxy`""
  )
}

$backendLines = @(
  "@echo off",
  "chcp 65001 > nul",
  "set `"CODE_LITE_ENV=DEV`""
) + $proxyLines + @(
  "cd /d `"$repoRoot`"",
  "echo Code Lite Backend - $backendUrl",
  "echo Press Ctrl+C to stop the backend.",
  "uv run --project backend python -m code_lite_backend.main --host 127.0.0.1 --port $BackendPort",
  "echo Backend stopped.",
  "pause"
)

$tauriLines = @(
  "@echo off",
  "chcp 65001 > nul",
  "set `"CODE_LITE_ENV=DEV`""
) + $proxyLines + @(
  "cd /d `"$repoRoot`"",
  "echo Code Lite Tauri Desktop",
  "powershell.exe -ExecutionPolicy Bypass -File .\scripts\dev-tauri.ps1 -Proxy `"$Proxy`" -SkipBackend"
)

Set-Content -Encoding UTF8 -Path $backendCmd -Value ($backendLines -join "`r`n")
Set-Content -Encoding UTF8 -Path $tauriCmd -Value ($tauriLines -join "`r`n")

& wt.exe -w 0 new-tab --title "backend" cmd.exe /k "`"$backendCmd`"" `; new-tab --title "tauri" cmd.exe /k "`"$tauriCmd`""
