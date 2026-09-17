$ErrorActionPreference = "Stop"

$HostName = "com.hzy9738.sidechat"
$ExtensionId = "gjpmflfaadhcbbcckbmbccggfpbdjdel"
$BundleDir = $PSScriptRoot
$SourceHost = Join-Path $BundleDir "native\sidechat-host.exe"
$SourceConfig = Join-Path $BundleDir "native\anneng-config.json"
$InstallDir = Join-Path $env:LOCALAPPDATA "Anneng Assistant"
$HostPath = Join-Path $InstallDir "anneng-assistant-host.exe"
$ManifestPath = Join-Path $InstallDir "native-host.json"

if (-not (Test-Path $SourceHost)) {
  throw "安装包不完整：找不到 Native Host：$SourceHost"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $SourceHost $HostPath
if (Test-Path $SourceConfig) {
  Copy-Item -Force $SourceConfig (Join-Path $InstallDir "anneng-config.json")
}

$Manifest = @{
  name = $HostName
  description = "安能助手 Native Messaging Host"
  path = $HostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $Manifest, $Utf8NoBom)

$RegistryRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($RegistryPath in $RegistryRoots) {
  New-Item -Path $RegistryPath -Force | Out-Null
  Set-Item -Path $RegistryPath -Value $ManifestPath
}

Write-Host ""
Write-Host "安能助手 Host 已安装。" -ForegroundColor Green
Write-Host "1. 在 chrome://extensions 中加载本安装包内的 extension 文件夹。"
Write-Host "2. 完全退出 Chrome，再重新打开。"
Write-Host "3. 扩展 ID 应为：$ExtensionId"
