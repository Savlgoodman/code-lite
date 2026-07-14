[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot "src-tauri\icons\android"
$targetRoot = Join-Path $repoRoot "ui-remote\android\app\src\main\res"
$densityDirs = @(
  "mipmap-mdpi",
  "mipmap-hdpi",
  "mipmap-xhdpi",
  "mipmap-xxhdpi",
  "mipmap-xxxhdpi"
)
$iconNames = @(
  "ic_launcher.png",
  "ic_launcher_foreground.png",
  "ic_launcher_round.png"
)

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Android icon source directory not found: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
  throw "Android resource directory not found: $targetRoot"
}

foreach ($densityDir in $densityDirs) {
  $targetDir = Join-Path $targetRoot $densityDir
  if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
    throw "Android icon target directory not found: $targetDir"
  }

  foreach ($iconName in $iconNames) {
    $sourcePath = Join-Path (Join-Path $sourceRoot $densityDir) $iconName
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Android icon source file not found: $sourcePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $targetDir $iconName) -Force
  }
}

$adaptiveIconSource = Join-Path $sourceRoot "mipmap-anydpi-v26\ic_launcher.xml"
foreach ($targetName in @("ic_launcher.xml", "ic_launcher_round.xml")) {
  Copy-Item -LiteralPath $adaptiveIconSource `
    -Destination (Join-Path $targetRoot "mipmap-anydpi-v26\$targetName") `
    -Force
}

$backgroundSource = Join-Path $sourceRoot "values\ic_launcher_background.xml"
Copy-Item -LiteralPath $backgroundSource `
  -Destination (Join-Path $targetRoot "values\ic_launcher_background.xml") `
  -Force

Write-Host "Android launcher icons synchronized from src-tauri/icons/android." -ForegroundColor Green
