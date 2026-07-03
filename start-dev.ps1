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
  "uv run --project backend python -m code_lite_backend.main --host 127.0.0.1 --port $BackendPort"
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
