#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${APP_VERSION:-$(/usr/bin/sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json" | /usr/bin/head -1)}"
HOST_SOURCE="${HOST_BINARY:-$ROOT/host-rs/target/x86_64-pc-windows-msvc/release/sidechat-host.exe}"
HOST_CONFIG="${ANNENG_HOST_CONFIG:-$ROOT/.secrets/host-config.json}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/dist}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anneng-portable-windows.XXXXXX")"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

if [[ ! -f "$HOST_SOURCE" ]]; then
  printf 'Windows Host binary not found: %s\n' "$HOST_SOURCE" >&2
  printf 'Cross-build with cargo-xwin, or run packaging/windows/build-portable.ps1 on Windows.\n' >&2
  exit 2
fi

BUNDLE="$WORK_DIR/Anneng-Assistant-${VERSION}-Windows-x64"
mkdir -p "$BUNDLE/extension" "$BUNDLE/native" "$OUTPUT_DIR"
for item in background.js content.css content.js manifest.json quick-card.js sidepanel.css sidepanel.html sidepanel.js icons lib; do
  cp -R "$ROOT/extension/$item" "$BUNDLE/extension/"
done
install -m 0644 "$HOST_SOURCE" "$BUNDLE/native/sidechat-host.exe"
if [[ -f "$HOST_CONFIG" ]]; then
  install -m 0600 "$HOST_CONFIG" "$BUNDLE/native/anneng-config.json"
else
  printf 'Warning: host config not found (%s); users must fill API settings themselves.\n' "$HOST_CONFIG" >&2
fi
install -m 0644 "$ROOT/packaging/portable/windows/install-host.ps1" "$BUNDLE/install-host.ps1"
install -m 0644 "$ROOT/packaging/portable/windows/install-host.cmd" "$BUNDLE/install-host.cmd"

cat >"$BUNDLE/README-zh-CN.txt" <<EOF
安能助手 ${VERSION}（Windows x64，加载已解压版）

1. 解压整个 ZIP，不能直接在压缩包预览中运行。
2. 双击 install-host.cmd，等待窗口显示“Host 已安装”。
3. 完全退出并重新打开 Chrome。
4. 打开 chrome://extensions，启用“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择本目录中的 extension 文件夹。
6. 确认扩展 ID 是 gjpmflfaadhcbbcckbmbccggfpbdjdel。

仅复制 extension 文件夹不会安装 Native Messaging Host，扩展无法发送请求。
EOF

OUTPUT="$OUTPUT_DIR/Anneng-Assistant-${VERSION}-Windows-x64-portable.zip"
rm -f "$OUTPUT"
(
  cd "$WORK_DIR"
  COPYFILE_DISABLE=1 /usr/bin/zip -X -q -r "$OUTPUT" "$(basename "$BUNDLE")"
)
printf 'Built portable bundle: %s\n' "$OUTPUT"

