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

# ── Clean up orphaned backend processes ───────────────────────────────
# Find and kill any process occupying the target port to avoid "address already in use"
$portOwnerPid = $null
try {
  $conn = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $portOwnerPid = $conn.OwningProcess
  }
} catch { }

if ($portOwnerPid) {
  Write-Host "Found orphaned backend process (PID: $portOwnerPid), terminating..." -ForegroundColor Yellow
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
  Write-Host "Orphaned process cleaned up." -ForegroundColor Green
}

# Also clean up backend processes matched by command line pattern
$orphanedBackends = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%code_lite_backend.main%'" -ErrorAction SilentlyContinue
if ($orphanedBackends) {
  foreach ($proc in $orphanedBackends) {
    Write-Host "Found orphaned backend (PID: $($proc.ProcessId)), terminating..." -ForegroundColor Yellow
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
uv run --project backend python -m code_lite_backend.main --host 127.0.0.1 --port $BackendPort
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
