# 安装安能助手

本扩展通过 **Chrome Native Messaging** 连接本机 **Rust Host**，由 Host 调用 OpenAI 兼容的 `POST <base>/chat/completions`（`stream=true`）。接口地址与密钥来自侧栏设置或 `SIDECHAT_*` 环境变量。

Chrome Web Store 分配的正式扩展 ID 为 `hkifhagmdbdpaihdmllddcingebfpjmm`（安装器、浏览器策略与 Native Host 白名单使用）。本地开发加载已解压扩展时，ID 由 `extension/manifest.json` 的 `key` 固定为：

`gjpmflfaadhcbbcckbmbccggfpbdjdel`

因此未加载扩展时也可以先注册 Native Host（脚本会把两个 ID 都写入白名单）。

## 前置条件

1. 任意 OpenAI 兼容服务的 Base URL + 模型名。云端通常还要 API Key。
2. Rust / cargo（构建 Host）
3. Google Chrome（或 Chromium）

## 1. 构建 Host

```bash
cd sidechat/host-rs
cargo test
cargo build --release --bin sidechat-host
```

## 2. 加载扩展（开发者模式）

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择 `sidechat/extension`
4. 确认扩展 ID：加载已解压扩展为 `gjpmflfaadhcbbcckbmbccggfpbdjdel`（由 manifest `key` 固定）；从商店安装则为 `hkifhagmdbdpaihdmllddcingebfpjmm`

## 3. 注册 Native Messaging Host

在仓库根目录执行（可省略 `EXTENSION_ID`，默认使用商店正式 ID）：

```bash
cd sidechat
./scripts/install-native-host.sh
```

脚本会：

- `cargo build --release` 得到 `host-rs/target/release/sidechat-host`（绝对路径写入 manifest）
- 写入 `com.hzy9738.sidechat.json` 到：
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - 以及已存在的 Chromium / Chrome Canary 目录
- `allowed_origins` 为 `chrome-extension://<ID>/`

### 「Specified native messaging host not found」

按顺序检查：

1. 已运行 `./scripts/install-native-host.sh`
2. 文件存在：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hzy9738.sidechat.json`
3. JSON 内 `name` 为 `com.hzy9738.sidechat`，`path` 为**绝对路径**且该二进制可执行
4. `allowed_origins` 与扩展 ID 一致（含尾部 `/`）
5. 在 `chrome://extensions` **重新加载**扩展；必要时完全退出 Chrome 再开

## 4. 接口配置

在侧栏设置中填写 API 地址、密钥和模型（视觉识别默认 `qwen-vl`）；或用环境变量 `SIDECHAT_API_BASE` / `SIDECHAT_API_KEY` / `SIDECHAT_MODEL` / `SIDECHAT_VISION_MODEL`；安装包会在 Host 同目录附带 `anneng-config.json` 作为默认配置（打包时从本地 `.secrets/host-config.json` 注入，不进仓库）。

优先级：请求 > 环境变量 > 随包配置。地址与凭据同源：自填地址时只使用自填凭据，留空即无凭据，不会回退到其他来源的密钥。

会话落在 `~/.sidechat/sessions/<id>/session.json`。`SIDECHAT_HOME` 可改根目录。

## 5. 使用安能助手

1. 点击工具栏图标，或快捷键 **⌘⇧.** / **Ctrl+Shift+.** 打开 Side Panel
2. 划词后点浮层「问安能助手」，或右键选中文字 / 图片 / 链接 / 整页
3. 打开任意网页；用 `@page` / `@selection` / `@tabs` / `@body` 芯片附加上下文
4. **工作目录**只记在会话元数据上，不会传给模型当项目绑定
5. 输入问题 → **发送**；**停止** 取消当前 HTTP 流；**新对话** 清空 session
6. 思考过程（若网关返回 `reasoning_content` / `reasoning`）会实时显示

### Dry-run（不打真实 API）

侧栏勾选 **dry-run** 只验证协议与 prompt 组装。

## 6. 离线自检

```bash
cd host-rs
cargo test
cargo build --release --bin sidechat-host
./target/release/sidechat-host --mode once --dry-run
```

扩展纯逻辑：

```bash
node extension/test/run-tests.mjs
```

可选真实网关检查：

```bash
# 侧栏设置留空即可打公司私有化接口；不要把明文密钥写进文档
```

改完 host 后重新执行 `./scripts/install-native-host.sh`，再在 `chrome://extensions` 重载扩展。

## 故障排查

| 现象 | 处理 |
|------|------|
| Specified native messaging host not found | 见上文第三节；重跑 install 脚本并 reload 扩展 |
| 需要 API 地址 | 确认已用 0.5+ Rust Host；旧 Go Host 没有加密内置包 |
| 401 / 403 | 检查 Key 与 Base URL 是否属于同一家网关 |
| 无法读 chrome:// 页 | 正常限制；换普通 https 页 |
| 会话不能续 | 确认 event 里出现 `session`；看 `~/.sidechat/sessions` 是否写入 |
