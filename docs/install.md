# 安装与使用

当前版本是纯 Chrome MV3 扩展，不需要 Native Messaging Host 或系统安装器。

## 加载分发包

1. 解压 `Anneng-Assistant-<version>-unpacked.zip`
2. 在 Chrome 打开 `chrome://extensions`
3. 开启右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择解压目录中的 `extension` 文件夹
6. 把“安能助手”固定到工具栏

Windows、macOS 和 Linux 的步骤相同。不要运行旧版包里的 `install-host.cmd`；0.7.0 起已经没有该组件。

## 使用

- 点击扩展图标：打开侧栏
- 快捷键：有选区时携带选区，无选区时直接提问
- 选中文字：使用页面内胶囊执行解释、翻译或自定义提问
- 右键图片：打开带图片预览的提问卡片
- 直接问接口、Network 或 Console：扩展会自动采集当前页面的调试快照并附给模型，不需要输入 `@`

首次调试采集时 Chrome 会显示正在调试当前标签页，这是 `chrome.debugger` 权限的正常提示。采集完成后扩展会主动断开。

## 开发构建

```bash
cd extension
npm install
npm test
cd ..
./packaging/build-unpacked-extension.sh
```

生成后的可加载目录为：

```text
dist/Anneng-Assistant-0.7.0-unpacked/extension
```

如未注入配置，可在侧栏设置中填写 OpenAI 兼容 API 地址、Key 和模型名。

