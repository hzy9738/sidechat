# 安能助手安装包

安装包面向公司受管设备。用户不需要打开扩展商店或开发者模式：安装器把 Rust Host 安装到系统目录，并为已安装的 Chrome、Edge、Brave、Chromium、ego lite 写入扩展策略与 Native Messaging 注册信息。

## 发布前必须完成

浏览器仍要求可信更新源。安装器不能绕过浏览器的扩展签名与分发限制，发布前必须完成以下二选一的步骤，否则只会装上 Host 和策略，浏览器无法下载扩展：

1. 将扩展以“不公开”方式发布到 Chrome Web Store。用户不需要访问商店；企业策略会从官方更新服务静默安装和更新。
2. 使用固定私钥签名 CRX，将 CRX 与更新 XML 放在公司 HTTPS 地址，并把 `EXTENSION_UPDATE_URL` 指向该 XML。私钥不能进入仓库或安装包。

Chrome Web Store 条目的正式扩展 ID 为 `hkifhagmdbdpaihdmllddcingebfpjmm`。安装包、浏览器策略和 Native Host 白名单必须使用这个 ID。`manifest.json` 中的 `key` 只用于让本地“加载已解压扩展”保持开发 ID，不代表商店 ID。

生成可上传到 Chrome Web Store 的 ZIP：

```bash
packaging/build-extension-zip.sh
```

扩展通过审核后即可重新构建 macOS 和 Windows 安装器。扩展可以设为“不公开”；员工无需访问商店页面，安装策略会直接下载。

## 接口配置注入

默认接口地址与密钥不提交进仓库，只存在构建机的 `.secrets/host-config.json`（已被 `.gitignore` 忽略）：

```json
{
  "apiBase": "https://ai-model.chint.com/api",
  "apiKey": "sk-...",
  "model": "deepseek-v4",
  "visionModel": "qwen-vl"
}
```

macOS 与 Windows 打包脚本会自动把它复制为 `anneng-config.json`，与 Host 二进制放在同一目录，随安装包分发；Host 启动后按「请求 > 环境变量 > 同目录 anneng-config.json」的顺序解析配置，地址与凭据始终同源。文件缺失时构建只告警，产出的包需要用户手动填写接口设置。

注意：`anneng-config.json` 会随安装包下发到用户机器，具备本机读取权限的人可以查看它；这里防的是密钥进入公开仓库，不是防本机逆向。轮换密钥只需更新 `.secrets/host-config.json` 后重新打包。

安全目标（已接受的风险）：共享密钥 + 无后端 + 装完即用，三者叠加下不存在「不可提取」的方案——Host 发送请求时必须能取到原始密钥，因此本方案只防明文泄露和低成本提取，**不保证抵抗有经验的本机攻击者**。限制提取后损失依赖客户端之外的手段：网关侧用量上限与异常告警、定期轮换（建议每次发版换 key，本仓库换 key 只需更新 `.secrets/host-config.json` 重新打包）、必要时按部门/批次拆分密钥以便单独吊销、出口 IP 白名单（会切断居家/外网使用，需权衡）。

CI 构建从仓库 Secret `HOST_CONFIG_JSON` 注入同样内容（Settings → Secrets and variables → Actions），未配置时产出不含默认配置的安装包。

## macOS

```bash
cargo build --release --manifest-path host-rs/Cargo.toml --bin sidechat-host
APP_VERSION=0.6.3 \
EXTENSION_ID=hkifhagmdbdpaihdmllddcingebfpjmm \
EXTENSION_UPDATE_URL=https://clients2.google.com/service/update2/crx \
packaging/macos/build-pkg.sh
```

输出为 `dist/Anneng-Assistant-0.6.3-macOS.pkg`。构建会先确认扩展能够从更新源下载，失败时不会生成正式安装包。安装向导会强制显示浏览器选择步骤，将已检测到的 Chrome、Edge、Brave、Chromium、ego lite 直接列成并列复选项，并允许同时勾选多个浏览器。

只检查安装界面时可设置 `SKIP_EXTENSION_SOURCE_CHECK=1`；此时输出文件名带有 `DEV-UNPUBLISHED`，该包不能交付用户。

安装位置：

- Host：`/Library/Application Support/Anneng Assistant/anneng-assistant-host`
- 接口配置（随包注入时）：`/Library/Application Support/Anneng Assistant/anneng-config.json`
- Chrome 通信配置：`/Library/Google/Chrome/NativeMessagingHosts/`
- Edge 通信配置：`/Library/Microsoft/Edge/NativeMessagingHosts/`
- Brave 通信配置：`/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- ego lite 通信配置：`/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts/`
- Chromium 通信配置：`/Library/Application Support/Chromium/NativeMessagingHosts/`
- 强制安装策略：`/Library/Managed Preferences/` 下对应浏览器的 plist

正式发布应设置 `MAC_INSTALLER_IDENTITY` 进行 Developer ID Installer 签名，并完成 Apple notarization。

## Windows

Windows 构建机需要 Rust MSVC 工具链与 Inno Setup 6：

```powershell
cargo build --release --manifest-path host-rs/Cargo.toml --bin sidechat-host
./packaging/windows/build-installer.ps1 -AppVersion 0.6.3
```

输出为 `dist/Anneng-Assistant-0.6.3-Windows.exe`。构建同样会先验证扩展更新源；仅调试安装界面时可传入 `-SkipExtensionSourceCheck`。安装向导只显示检测到的浏览器并默认勾选。Chrome、Edge、Brave 使用各自正式策略和 Native Host 注册；360 安全浏览器、360 极速浏览器、QQ 浏览器使用 Chromium/Chrome 通用 Native Host 兼容注册，扩展本身仍需通过浏览器自己的扩展中心或企业管理平台分发。正式发布应使用公司代码签名证书签署 EXE。

## 自动构建

GitHub Actions 的 `Build installers` 工作流会生成 macOS 通用包和 Windows x64 安装包。Host 更新时重新发布安装器；扩展 JS/CSS 更新由浏览器更新源自动完成。
