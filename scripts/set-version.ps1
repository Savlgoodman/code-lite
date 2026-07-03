param(
  [Parameter(Position = 0)]
  [string]$Version
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$versionFile = Join-Path $repoRoot "VERSION"

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, $script:utf8NoBom)
}

function Update-RegexVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Pattern,
    [Parameter(Mandatory = $true)]
    [string]$Replacement,
    [int]$Count = 1
  )

  $content = Get-Content -Raw -Encoding UTF8 $Path
  if ($Count -lt 0) {
    $content = [regex]::Replace($content, $Pattern, $Replacement)
  } else {
    $content = [regex]::Replace($content, $Pattern, $Replacement, $Count)
  }
  Write-Utf8NoBom -Path $Path -Content $content
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  if (-not (Test-Path -LiteralPath $versionFile)) {
    throw "VERSION file not found: $versionFile"
  }
  $Version = (Get-Content -Raw -Encoding UTF8 $versionFile).Trim()
} else {
  $Version = $Version.Trim()
}

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Invalid version '$Version'. Expected SemVer like 0.1.2 or 0.1.2-beta.1"
}

Write-Utf8NoBom -Path $versionFile -Content "$Version`n"

Update-RegexVersion `
  -Path (Join-Path $repoRoot "package.json") `
  -Pattern '("version"\s*:\s*)".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "ui\package.json") `
  -Pattern '("version"\s*:\s*)".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "ui\package-lock.json") `
  -Pattern '(?s)^(\{\s*"name"\s*:\s*"code-lite-ui",\s*"version"\s*:\s*)".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "ui\package-lock.json") `
  -Pattern '(?s)(\s*""\s*:\s*\{\s*"name"\s*:\s*"code-lite-ui",\s*"version"\s*:\s*)".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "src-tauri\tauri.conf.json") `
  -Pattern '("version"\s*:\s*)".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "src-tauri\Cargo.toml") `
  -Pattern '(?m)^version = ".+?"' `
  -Replacement "version = `"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "src-tauri\Cargo.lock") `
  -Pattern '(?ms)(\[\[package\]\]\s+name = "code-lite"\s+version = )".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "backend\pyproject.toml") `
  -Pattern '(?m)^version = ".+?"' `
  -Replacement "version = `"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "backend\uv.lock") `
  -Pattern '(?ms)(\[\[package\]\]\s+name = "code-lite-backend"\s+version = )".+?"' `
  -Replacement "`${1}`"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "backend\code_lite_backend\version.py") `
  -Pattern '(?m)^APP_VERSION = ".+?"' `
  -Replacement "APP_VERSION = `"$Version`""

Update-RegexVersion `
  -Path (Join-Path $repoRoot "backend\code_lite_backend\version.py") `
  -Pattern '(?m)^BACKEND_VERSION = ".+?"' `
  -Replacement "BACKEND_VERSION = `"$Version`""

Write-Host "Version synchronized to $Version"
