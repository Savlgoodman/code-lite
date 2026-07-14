param(
  [string]$DistinguishedName = "CN=Code Lite Remote, OU=Mobile, O=Code Lite, C=CN"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$signingDir = Join-Path $repoRoot "env"
$keystorePath = Join-Path $signingDir "code-lite-remote-release.jks"
$propertiesPath = Join-Path $signingDir "android-signing.properties"
$keyAlias = "code-lite-remote-release"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function New-RandomHexSecret {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

foreach ($relativePath in @("env/code-lite-remote-release.jks", "env/android-signing.properties")) {
  & git -C $repoRoot check-ignore --quiet -- $relativePath
  if ($LASTEXITCODE -ne 0) {
    throw "Refusing to create signing material that is not ignored by Git: $relativePath"
  }
}

if ((Test-Path -LiteralPath $keystorePath) -or (Test-Path -LiteralPath $propertiesPath)) {
  throw "Android signing material already exists in $signingDir. Existing release keys are never overwritten."
}

$keytool = (Get-Command keytool -ErrorAction Stop).Source
$storePassword = New-RandomHexSecret
$keyPassword = New-RandomHexSecret

New-Item -ItemType Directory -Force -Path $signingDir | Out-Null

$env:CODE_LITE_KEYTOOL_STORE_PASSWORD = $storePassword
$env:CODE_LITE_KEYTOOL_KEY_PASSWORD = $keyPassword
try {
  & $keytool `
    -genkeypair `
    -noprompt `
    -keystore $keystorePath `
    -storetype JKS `
    -storepass:env CODE_LITE_KEYTOOL_STORE_PASSWORD `
    -keypass:env CODE_LITE_KEYTOOL_KEY_PASSWORD `
    -alias $keyAlias `
    -keyalg RSA `
    -keysize 4096 `
    -validity 36500 `
    -dname $DistinguishedName
  if ($LASTEXITCODE -ne 0) {
    throw "keytool failed with exit code $LASTEXITCODE"
  }

  $propertiesContent = @(
    "storeFile=$($keystorePath.Replace('\', '/'))"
    "storePassword=$storePassword"
    "keyAlias=$keyAlias"
    "keyPassword=$keyPassword"
  ) -join "`n"
  [System.IO.File]::WriteAllText($propertiesPath, "$propertiesContent`n", $utf8NoBom)
} catch {
  Remove-Item -LiteralPath $keystorePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $propertiesPath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  Remove-Item Env:CODE_LITE_KEYTOOL_STORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CODE_LITE_KEYTOOL_KEY_PASSWORD -ErrorAction SilentlyContinue
  $storePassword = $null
  $keyPassword = $null
}

Write-Host "Android release signing material created."
Write-Host "  Keystore:   $keystorePath"
Write-Host "  Properties: $propertiesPath"
Write-Host "  Alias:      $keyAlias"
Write-Host "Back up both files and keep them outside Git. Passwords are stored only in the ignored properties file."
