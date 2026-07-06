param(
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$vsDevCmd = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"

if (-not (Test-Path $vsDevCmd)) {
  throw "Visual Studio Build Tools not found: $vsDevCmd"
}

$env:HTTP_PROXY = $Proxy
$env:HTTPS_PROXY = $Proxy
$env:ALL_PROXY = $Proxy
$env:CODE_LITE_ENV = "DEV"

$cmd = @(
  "call `"$vsDevCmd`" -arch=x64 -host_arch=x64",
  "set `"PATH=%USERPROFILE%\.cargo\bin;%PATH%`"",
  "cd /d `"$repoRoot`"",
  "npm run ui:deps",
  "npm run tauri:dev --ignore-scripts"
) -join " && "

if ($SkipBackend) {
  $env:PC_AGENT_SKIP_BACKEND_AUTOSTART = "1"
}

cmd.exe /d /c $cmd
