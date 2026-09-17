# 安能助手

通用型 Chrome MV3 侧栏助手 + **Rust Native Messaging Host**。默认接入公司私有化 OpenAI 兼容接口，文本模型 `deepseek-v4`，识图与 OCR 走 `qwen-vl`。

Chrome 扩展本身必须是 JS；关键密钥和接口配置封在 Rust Host 的加密资源里，不写进扩展源码。

```text
划词 / 右键选图 / 侧栏
        │  native messaging
        ▼
sidechat-host（Rust）
        │  读取接口配置（环境变量 / anneng-config.json）
        ▼
POST https://ai-model.chint.com/api/chat/completions
```

## 能力

- 侧栏对话，附带当前页 / 选区 / 标签
- 划词浮层「问安能助手」
- 右键：选中文字、图片、链接、整页
- 选图自动改走视觉模型
- 麦克风录音转文字（OpenAI 兼容 `/audio/transcriptions`）
- 图片 OCR 与 PDF 文本提取
- 回复朗读（浏览器系统语音）
- 思考模式（`thinking: enabled`）
- 本机会话 `~/.sidechat/sessions/`

## 目录

| 路径 | 说明 |
|---|---|
| `extension/` | MV3 扩展（侧栏、右键、划词） |
| `host-rs/` | Rust Host（Native Messaging） |
| `host/` | 旧 Go Host（不再安装） |
| `scripts/install-native-host.sh` | 编译 Rust 并注册 Native Messaging |

## 安装

```bash
cd host-rs && cargo test && cargo build --release --bin sidechat-host
cd .. && ./scripts/install-native-host.sh
node extension/test/run-tests.mjs
```

Chrome 加载解压扩展：`extension/`。商店正式 ID：`hkifhagmdbdpaihdmllddcingebfpjmm`（安装器、策略与 Native Host 白名单使用）；本地开发加载已解压扩展时由 manifest `key` 固定为 `gjpmflfaadhcbbcckbmbccggfpbdjdel`。

面向普通员工分发时，使用 [packaging/README.md](packaging/README.md) 中的 macOS `.pkg` 或 Windows `.exe`。管理员先将扩展上传到对应浏览器的扩展分发平台；之后安装器会列出本机已检测到的 Chrome、Edge、Brave、Chromium、ego lite，以及 Windows 上的 360、QQ 浏览器兼容选项，并注册 Host。终端用户不需要打开开发者模式。

接口地址、密钥和模型来自侧栏设置、环境变量（`SIDECHAT_API_BASE` / `SIDECHAT_API_KEY` / `SIDECHAT_MODEL`，视觉模型 `SIDECHAT_VISION_MODEL`），或安装包随 Host 附带的 `anneng-config.json`（打包时从本地 `.secrets/host-config.json` 注入，不进仓库，见 [packaging/README.md](packaging/README.md)）。优先级：请求 > 环境变量 > 随包配置。地址与凭据同源：自填地址时只使用自填凭据，不会把密钥发给其他网关。

不要把明文密钥写进 README 或扩展代码。

## 协议

对话使用 `send` / `event` / `cancel` / `ping`；语音与 PDF 使用一次性 RPC `transcribe_audio` / `extract_pdf`。`browser.images` 为待识别图片（`src` / `dataUrl`）。
