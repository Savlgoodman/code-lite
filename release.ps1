param(
  [string]$Version,
  [string]$Proxy = "http://127.0.0.1:7899",
  [switch]$NoProxy,
  [switch]$SkipBuild,
  [switch]$SkipDependencySync,
  [switch]$SkipBackendBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$distDir = Join-Path $repoRoot "dist"
$distFullPath = [System.IO.Path]::GetFullPath($distDir)
$repoFullPath = [System.IO.Path]::GetFullPath($repoRoot)

$versionArgs = @{}
if (-not [string]::IsNullOrWhiteSpace($Version)) {
  $versionArgs["Version"] = $Version
}
& (Join-Path $repoRoot "scripts\set-version.ps1") @versionArgs

if (-not $distFullPath.StartsWith($repoFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside repo root: $distFullPath"
}

if (Test-Path -LiteralPath $distFullPath) {
  $distItem = Get-Item -LiteralPath $distFullPath
  if (($distItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to clean reparse point dist directory: $distFullPath"
  }
} else {
  New-Item -ItemType Directory -Force -Path $distFullPath | Out-Null
}

if (-not $SkipBuild) {
  $packageArgs = @{}
  if ($NoProxy) {
    $packageArgs["NoProxy"] = $true
  } else {
    $packageArgs["Proxy"] = $Proxy
  }
  if ($SkipDependencySync) {
    $packageArgs["SkipDependencySync"] = $true
  }
  if ($SkipBackendBuild) {
    $packageArgs["SkipBackendBuild"] = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $packageArgs["Version"] = $Version
  }

  & (Join-Path $repoRoot "scripts\package-windows.ps1") @packageArgs
}

$packageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$version = [string]$packageJson.version

$artifacts = @(
  @{
    Label = "NSIS installer"
    Path = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis\Code Lite_$($version)_x64-setup.exe"
  },
  @{
    Label = "MSI installer"
    Path = Join-Path $repoRoot "src-tauri\target\release\bundle\msi\Code Lite_$($version)_x64_en-US.msi"
  },
  @{
    Label = "Tauri app executable"
    Path = Join-Path $repoRoot "src-tauri\target\release\code-lite.exe"
  },
  @{
    Label = "Backend sidecar executable"
    Path = Join-Path $repoRoot "src-tauri\target\release\code-lite-backend.exe"
  }
)

foreach ($artifact in $artifacts) {
  if (-not (Test-Path -LiteralPath $artifact.Path)) {
    throw "$($artifact.Label) not found: $($artifact.Path)"
  }
}

$children = Get-ChildItem -LiteralPath $distFullPath -Force -ErrorAction SilentlyContinue
foreach ($child in $children) {
  $childFullPath = [System.IO.Path]::GetFullPath($child.FullName)
  if (-not $childFullPath.StartsWith($distFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected dist child: $childFullPath"
  }
  Remove-Item -LiteralPath $child.FullName -Recurse -Force
}

foreach ($artifact in $artifacts) {
  Copy-Item -LiteralPath $artifact.Path -Destination $distFullPath -Force
}

Write-Host "Release artifacts copied to $distFullPath"
Get-ChildItem -LiteralPath $distFullPath | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
