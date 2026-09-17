# 安能助手

安能助手是一个纯 Chrome MV3 扩展。加载已解压的扩展后即可使用，不需要 Native Messaging Host、系统安装器、注册表或本地守护进程。

## 工作方式

```text
侧栏 / 页面内小卡片
        │
        ▼
Chrome 扩展 Service Worker
        ├─ 直接调用 OpenAI 兼容接口
        ├─ 在 chrome.storage.local 保存会话
        ├─ 通过 chrome.debugger 采集并脱敏 Network / Console
        └─ 在扩展内使用 PDF.js 提取 PDF 文字
```

当用户直接问“这个页面有哪些接口”“看一下 Network / Console”等问题时，扩展会自动申请并使用已有的 `debugger` 权限完成一次采集；不需要输入 `@`，也没有“开始采集”前置步骤。

## 加载即用的分发包

构建机可把本地 `.secrets/runtime-config.json` 注入扩展包：

```bash
cd extension
npm ci
cd ..
./packaging/build-unpacked-extension.sh
```

然后把 `dist/Anneng-Assistant-<version>-unpacked.zip` 发给用户。用户解压后：

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择解压目录中的 `extension` 文件夹

无需运行任何 `.cmd`、`.ps1`、`.exe` 或 macOS 安装器。

## 本地开发

```bash
cd extension
npm install
npm test
```

之后可直接加载仓库中的 `extension/`。源码里的 `runtime-config.json` 不含密钥，因此开发模式需要在侧栏设置中填写 API 地址和 Key，或者使用上面的构建脚本生成已注入配置的分发目录。

## 配置格式

构建脚本默认读取已被 Git 忽略的 `.secrets/runtime-config.json`：

```json
{
  "apiBase": "https://example.internal/v1",
  "apiKey": "replace-me",
  "model": "deepseek-v4",
  "visionModel": "qwen-vl"
}
```

纯扩展模式无法向本机用户隐藏共享密钥：用户可以查看扩展文件或调试 Service Worker。请在网关侧配合额度限制、异常告警、密钥轮换和必要的 IP 限制。不要把真实密钥提交到 Git。

## 目录

- `extension/`：完整浏览器扩展
- `extension/lib/api-client.js`：OpenAI 兼容接口与流式响应
- `extension/lib/browser-sessions.js`：浏览器本地会话存储
- `extension/vendor/`：随扩展分发的 PDF.js
- `packaging/build-unpacked-extension.sh`：开发者模式分发包
- `packaging/build-extension-zip.sh`：Chrome Web Store 上传包
