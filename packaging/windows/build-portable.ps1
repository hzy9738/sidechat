param(
  [string]$AppVersion = "",
  [string]$HostBinary = "",
  [string]$HostConfig = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $AppVersion) {
  $Manifest = Get-Content (Join-Path $Root "extension\manifest.json") -Raw | ConvertFrom-Json
  $AppVersion = $Manifest.version
}
if (-not $HostBinary) {
  $HostBinary = Join-Path $Root "host-rs\target\release\sidechat-host.exe"
}
if (-not $HostConfig) {
  $HostConfig = Join-Path $Root ".secrets\host-config.json"
}
if (-not (Test-Path $HostBinary)) {
  throw "Host binary not found: $HostBinary"
}

$OutputDir = Join-Path $Root "dist"
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("anneng-portable-windows-" + [guid]::NewGuid())
$BundleDir = Join-Path $WorkDir "Anneng-Assistant-$AppVersion-Windows-x64"
try {
  New-Item -ItemType Directory -Force (Join-Path $BundleDir "extension"), (Join-Path $BundleDir "native") | Out-Null
  $ExtensionItems = @("background.js", "content.css", "content.js", "manifest.json", "quick-card.js", "sidepanel.css", "sidepanel.html", "sidepanel.js", "icons", "lib")
  foreach ($Item in $ExtensionItems) {
    Copy-Item -Recurse -Force (Join-Path $Root "extension\$Item") (Join-Path $BundleDir "extension")
  }
  Copy-Item -Force $HostBinary (Join-Path $BundleDir "native\sidechat-host.exe")
  if (Test-Path $HostConfig) {
    Copy-Item -Force $HostConfig (Join-Path $BundleDir "native\anneng-config.json")
  } else {
    Write-Warning "Host config not found: $HostConfig; users must fill API settings themselves."
  }
  Copy-Item -Force (Join-Path $PSScriptRoot "..\portable\windows\install-host.ps1") $BundleDir
  Copy-Item -Force (Join-Path $PSScriptRoot "..\portable\windows\install-host.cmd") $BundleDir
  @"
安能助手 $AppVersion（Windows x64，加载已解压版）

1. 双击 install-host.cmd。
2. 完全退出并重新打开 Chrome。
3. 打开 chrome://extensions，启用“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本目录中的 extension 文件夹。
5. 确认扩展 ID 是 gjpmflfaadhcbbcckbmbccggfpbdjdel。

仅复制 extension 文件夹不会安装 Native Messaging Host，扩展无法发送请求。
"@ | Set-Content -Encoding UTF8 (Join-Path $BundleDir "使用说明.txt")

  New-Item -ItemType Directory -Force $OutputDir | Out-Null
  $Output = Join-Path $OutputDir "Anneng-Assistant-$AppVersion-Windows-x64-portable.zip"
  if (Test-Path $Output) { Remove-Item -Force $Output }
  Compress-Archive -Path $BundleDir -DestinationPath $Output
  Write-Host "Built portable bundle: $Output"
} finally {
  if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
}

