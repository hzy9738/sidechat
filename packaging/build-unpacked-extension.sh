#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${APP_VERSION:-$(/usr/bin/sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json" | /usr/bin/head -1)}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/dist}"
BUNDLE="$OUTPUT_DIR/Anneng-Assistant-${VERSION}-unpacked"
CONFIG_SOURCE="${ANNENG_RUNTIME_CONFIG:-$ROOT/.secrets/runtime-config.json}"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/extension" "$OUTPUT_DIR"
for item in background.js content.css content.js manifest.json quick-card.js sidepanel.css sidepanel.html sidepanel.js runtime-config.json icons lib vendor; do
  cp -R "$ROOT/extension/$item" "$BUNDLE/extension/"
done

if [[ -f "$CONFIG_SOURCE" ]]; then
  python3 - "$CONFIG_SOURCE" "$BUNDLE/extension/runtime-config.json" <<'PY'
import json, sys
source, target = sys.argv[1:]
data = json.load(open(source, encoding="utf-8"))
allowed = {key: str(data.get(key, "")) for key in ("apiBase", "apiKey", "model", "visionModel")}
with open(target, "w", encoding="utf-8") as handle:
    json.dump(allowed, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
  printf 'Injected runtime API configuration (values hidden).\n'
else
  printf 'Warning: runtime config not found; users must fill API settings in the extension.\n' >&2
fi

cat > "$BUNDLE/README.txt" <<'TXT'
安能助手（纯浏览器扩展）

1. 打开 chrome://extensions
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本目录中的 extension 文件夹

不需要运行安装器，不需要 Native Messaging Host。
TXT

ZIP="$OUTPUT_DIR/Anneng-Assistant-${VERSION}-unpacked.zip"
rm -f "$ZIP"
(
  cd "$OUTPUT_DIR"
  COPYFILE_DISABLE=1 /usr/bin/zip -X -q -r "$ZIP" "$(basename "$BUNDLE")"
)
printf 'Built unpacked extension: %s\n' "$BUNDLE/extension"
printf 'Built distributable zip: %s\n' "$ZIP"
