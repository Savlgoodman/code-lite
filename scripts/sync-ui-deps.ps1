param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$uiRoot = Join-Path $repoRoot "ui"
$packageJsonPath = Join-Path $uiRoot "package.json"
$packageLockPath = Join-Path $uiRoot "package-lock.json"
$nodeModulesPath = Join-Path $uiRoot "node_modules"
$statePath = Join-Path $nodeModulesPath ".code-lite-deps-state"

function Get-FileStateHash {
  $hashLines = @(
    "package.json=$((Get-FileHash -LiteralPath $packageJsonPath -Algorithm SHA256).Hash)"
    "package-lock.json=$((Get-FileHash -LiteralPath $packageLockPath -Algorithm SHA256).Hash)"
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($hashLines -join "`n"))
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($bytes)
  } finally {
    $sha256.Dispose()
  }

  return ([System.BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
}

function Get-UiDependencyNames {
  $packageJson = Get-Content -Encoding UTF8 -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
  $names = New-Object System.Collections.Generic.List[string]

  foreach ($sectionName in @("dependencies", "devDependencies")) {
    $section = $packageJson.$sectionName
    if ($null -eq $section) {
      continue
    }

    foreach ($property in $section.PSObject.Properties) {
      $names.Add($property.Name)
    }
  }

  return $names
}

function Test-DirectDependenciesInstalled {
  if (-not (Test-Path -LiteralPath $nodeModulesPath)) {
    return $false
  }

  foreach ($dependencyName in Get-UiDependencyNames) {
    $dependencyPackagePath = Join-Path (Join-Path $nodeModulesPath $dependencyName) "package.json"
    if (-not (Test-Path -LiteralPath $dependencyPackagePath)) {
      return $false
    }
  }

  return $true
}

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  throw "UI package.json not found: $packageJsonPath"
}

if (-not (Test-Path -LiteralPath $packageLockPath)) {
  throw "UI package-lock.json not found: $packageLockPath"
}

$expectedState = Get-FileStateHash
$currentState = $null
if (Test-Path -LiteralPath $statePath) {
  $currentState = (Get-Content -Encoding UTF8 -Raw -LiteralPath $statePath).Trim()
}

$requiresSync = $Force -or
  ($currentState -ne $expectedState) -or
  (-not (Test-DirectDependenciesInstalled))

if (-not $requiresSync) {
  Write-Host "UI dependencies are up to date."
  exit 0
}

Write-Host "Synchronizing UI dependencies from package-lock.json..."
npm ci --prefix $uiRoot

if (-not (Test-Path -LiteralPath $nodeModulesPath)) {
  throw "npm ci completed but node_modules was not created: $nodeModulesPath"
}

[System.IO.File]::WriteAllText($statePath, "$expectedState`n", [System.Text.Encoding]::UTF8)
Write-Host "UI dependencies synchronized."
