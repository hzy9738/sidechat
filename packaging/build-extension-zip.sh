#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${APP_VERSION:-$(/usr/bin/sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json" | /usr/bin/head -1)}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/dist}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anneng-extension.XXXXXX")"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

mkdir -p "$WORK_DIR/extension" "$OUTPUT_DIR"
for item in background.js content.css content.js manifest.json quick-card.js sidepanel.css sidepanel.html sidepanel.js icons lib; do
  cp -R "$ROOT/extension/$item" "$WORK_DIR/extension/"
done

# Chrome Web Store 不允许 manifest 带 key；仓库内的 key 仅用于本地开发固定 ID。
python3 - "$WORK_DIR/extension/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
data.pop("key", None)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

OUTPUT="$OUTPUT_DIR/Anneng-Assistant-${VERSION}-Chrome-Web-Store.zip"
(
  cd "$WORK_DIR/extension"
  COPYFILE_DISABLE=1 /usr/bin/zip -X -q -r "$OUTPUT" .
)
printf 'Built Chrome Web Store upload: %s\n' "$OUTPUT"
