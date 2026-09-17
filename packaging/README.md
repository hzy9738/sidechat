# 扩展打包

当前版本是纯浏览器扩展，不再安装或连接 Native Messaging Host。

## 开发者模式分发包

```bash
cd extension
npm ci
cd ..
./packaging/build-unpacked-extension.sh
```

输出：

- `dist/Anneng-Assistant-<version>-unpacked/extension/`
- `dist/Anneng-Assistant-<version>-unpacked.zip`

构建脚本会在存在 `.secrets/runtime-config.json` 时，将其中的 `apiBase`、`apiKey`、`model` 和 `visionModel` 写入产物的 `runtime-config.json`。它不会修改仓库中的占位配置，也不会在日志中打印密钥。

用户只需解压，在 `chrome://extensions` 开启开发者模式，然后加载包内的 `extension` 目录。Windows、macOS 和 Linux 使用同一份包；不需要额外安装步骤。

## Chrome Web Store 包

```bash
./packaging/build-extension-zip.sh
```

该包使用仓库中的空白 `runtime-config.json`，不会注入本地密钥，并会删除 manifest 中仅用于固定开发扩展 ID 的 `key`。商店版本应让用户填写自己的 API 配置，或改用服务端短期凭证。

## 安全说明

“共享密钥、无后端、装完即用”三者同时存在时，密钥一定能被本机用户提取。纯扩展方案以安装简单为优先，风险控制必须放在接口网关侧。
