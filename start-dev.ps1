param(
  [string]$Proxy = "http://127.0.0.1:7899",
  [int]$BackendPort = 0,
  [switch]$NoProxy
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot

# 在 50000-60000 内探测一个空闲端口（与 Tauri 壳保持一致的随机端口策略）。
function Find-FreePort {
  param([int]$Start = 50000, [int]$End = 60000)
  $span = $End - $Start
  $offset = Get-Random -Minimum 0 -Maximum $span
  for ($i = 0; $i -lt $span; $i++) {
    $port = $Start + (($offset + $i) % $span)
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
      $listener.Start()
      $listener.Stop()
      return $port
    } catch {
      if ($listener) { try { $listener.Stop() } catch {} }
    }
  }
  throw "No free port available in $Start-$End"
}

if ($BackendPort -le 0) {
  $BackendPort = Find-FreePort
}
Write-Host "Selected backend port: $BackendPort" -ForegroundColor Cyan

$backendUrl = "http://127.0.0.1:$BackendPort"
$tempDir = Join-Path $repoRoot ".cache\dev-launch"
$backendCmdFile = Join-Path $tempDir "backend.cmd"
$tauriCmdFile = Join-Path $tempDir "tauri.cmd"

if (-not (Get-Command "wt.exe" -ErrorAction SilentlyContinue)) {
  throw "Windows Terminal not found: wt.exe. Install Windows Terminal or run backend and Tauri commands separately."
}

if (-not (Get-Command "uv.exe" -ErrorAction SilentlyContinue)) {
  throw "uv.exe not found. Install uv or add uv to PATH."
}

# ── Clean up orphaned DEV backend processes ───────────────────────────
# 重要：只清理带 "--role dev" 标记的开发后端，绝不误伤已安装发行版后端（--role prod）
# 或任何其他占用该端口的进程。DEV/PROD 隔离靠该进程命令行标记实现。

# 判断某个 PID 的命令行是否为 DEV code-lite 后端（含 code_lite_backend.main 且带 --role dev）
function Test-DevBackendPid {
  param([int]$ProcessId)
  if (-not $ProcessId) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  } catch { return $false }
  if (-not $proc) { return $false }
  $cmd = [string]$proc.CommandLine
  return ($cmd -match 'code_lite_backend\.main' -and $cmd -match '--role\s+dev')
}

# Find and kill the process occupying the target port ONLY if it is a DEV backend
$portOwnerPid = $null
try {
  $conn = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $portOwnerPid = $conn.OwningProcess
  }
} catch { }

if ($portOwnerPid) {
  if (Test-DevBackendPid -ProcessId $portOwnerPid) {
    Write-Host "Found orphaned DEV backend on port $BackendPort (PID: $portOwnerPid), terminating..." -ForegroundColor Yellow
    try {
      Stop-Process -Id $portOwnerPid -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      $stillRunning = Get-Process -Id $portOwnerPid -ErrorAction SilentlyContinue
      if ($stillRunning) {
        Write-Host "Process did not exit, force killing..." -ForegroundColor Yellow
        Stop-Process -Id $portOwnerPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
    } catch { }
    Write-Host "Orphaned DEV backend cleaned up." -ForegroundColor Green
  } else {
    Write-Host "Port $BackendPort is held by a non-DEV process (PID: $portOwnerPid); leaving it untouched. If backend fails to bind, re-run without -BackendPort to auto-pick a free port." -ForegroundColor Yellow
  }
}

# Also clean up DEV backend processes matched by command line pattern (ONLY --role dev)
$orphanedBackends = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%code_lite_backend.main%'" -ErrorAction SilentlyContinue |
  Where-Object { [string]$_.CommandLine -match '--role\s+dev' }
if ($orphanedBackends) {
  foreach ($proc in $orphanedBackends) {
    Write-Host "Found orphaned DEV backend (PID: $($proc.ProcessId)), terminating..." -ForegroundColor Yellow
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

# ── Build .cmd launcher scripts ──────────────────────────────────────
# Use Here-Strings to avoid PowerShell escaping issues with cmd syntax

$backendScript = @"
@echo off
chcp 65001 > nul
set "CODE_LITE_ENV=DEV"
"@

if (-not $NoProxy) {
  $backendScript += "`r`n"
  $backendScript += @"
set "HTTP_PROXY=$Proxy"
set "HTTPS_PROXY=$Proxy"
set "ALL_PROXY=$Proxy"
"@
}

$backendScript += "`r`n"
$backendScript += @"
cd /d "$repoRoot"
echo Code Lite Backend - $backendUrl
echo Press Ctrl+C to stop the backend.
uv run --project backend python -m code_lite_backend.main --host 127.0.0.1 --port $BackendPort --role dev
echo Backend stopped.
pause
"@

$tauriScript = @"
@echo off
chcp 65001 > nul
set "CODE_LITE_ENV=DEV"
set "CODE_LITE_BACKEND_PORT=$BackendPort"
"@

if (-not $NoProxy) {
  $tauriScript += "`r`n"
  $tauriScript += @"
set "HTTP_PROXY=$Proxy"
set "HTTPS_PROXY=$Proxy"
set "ALL_PROXY=$Proxy"
"@
}

$tauriScript += "`r`n"
$tauriScript += @"
cd /d "$repoRoot"
echo Code Lite Tauri Desktop
powershell.exe -ExecutionPolicy Bypass -File .\scripts\dev-tauri.ps1 -Proxy "$Proxy" -SkipBackend
"@

# Write cmd files using .NET to control encoding precisely
[System.IO.File]::WriteAllText($backendCmdFile, $backendScript, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($tauriCmdFile, $tauriScript, [System.Text.Encoding]::UTF8)

& wt.exe -w 0 new-tab --title "backend" cmd.exe /k "`"$backendCmdFile`"" `; new-tab --title "tauri" cmd.exe /k "`"$tauriCmdFile`""
