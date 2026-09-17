param(
  [string]$AppVersion = "0.6.3",
  [string]$ExtensionId = "hkifhagmdbdpaihdmllddcingebfpjmm",
  [string]$ExtensionUpdateUrl = "https://clients2.google.com/service/update2/crx",
  [string]$HostBinary = "",
  [string]$HostConfig = "",
  [switch]$SkipExtensionSourceCheck
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $HostBinary) {
  $HostBinary = Join-Path $Root "host-rs\target\x86_64-pc-windows-msvc\release\sidechat-host.exe"
}
if (-not $HostConfig) {
  $HostConfig = Join-Path $Root ".secrets\host-config.json"
}
if (-not (Test-Path $HostConfig)) {
  Write-Warning "Host config not found: $HostConfig; installer ships without default API config."
}
if (-not (Test-Path $HostBinary)) {
  throw "Host binary not found: $HostBinary"
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId must be a 32-character Chrome extension ID"
}
if (-not $SkipExtensionSourceCheck) {
  $ProbeUrl = $ExtensionUpdateUrl
  if ($ExtensionUpdateUrl -eq "https://clients2.google.com/service/update2/crx") {
    $ProbeUrl = "$ExtensionUpdateUrl`?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D$ExtensionId%26uc"
  }
  try {
    Invoke-WebRequest -Uri $ProbeUrl -MaximumRedirection 5 -TimeoutSec 20 -ErrorAction Stop | Out-Null
  } catch {
    throw "Extension $ExtensionId is not downloadable from $ExtensionUpdateUrl. Publish it first, or use -SkipExtensionSourceCheck only for installer UI development."
  }
}

$Iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $Iscc) {
  $Candidates = @(
    "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  )
  $Iscc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Iscc) {
  throw "Inno Setup 6 is required: https://jrsoftware.org/isinfo.php"
}

$OutputDir = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& $Iscc `
  "/DAppVersion=$AppVersion" `
  "/DExtensionId=$ExtensionId" `
  "/DExtensionUpdateUrl=$ExtensionUpdateUrl" `
  "/DHostBinary=$HostBinary" `
  "/DHostConfig=$HostConfig" `
  "/O$OutputDir" `
  (Join-Path $PSScriptRoot "AnnengAssistant.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
