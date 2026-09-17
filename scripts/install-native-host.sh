#!/usr/bin/env bash
# Install the 安能助手 Chrome Native Messaging host manifest (macOS / Linux).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_DIR="$ROOT/host-rs"
BIN="${HOST_BIN:-$HOST_DIR/target/release/grok-sidechat-host}"
# Chrome Web Store 分配的正式 ID（安装器、浏览器策略与白名单统一使用）。
DEFAULT_EXT_ID="hkifhagmdbdpaihdmllddcingebfpjmm"
# 本地开发 ID：extension/manifest.json 的 key 固定，加载已解压扩展时使用。
DEV_EXT_ID="gjpmflfaadhcbbcckbmbccggfpbdjdel"
EXT_ID="${EXTENSION_ID:-}"

detect_extension_id() {
  python3 - <<'PY'
import json, pathlib, os
chrome = pathlib.Path.home() / "Library/Application Support/Google/Chrome"
roots = [chrome]
# Linux
roots.append(pathlib.Path.home() / ".config/google-chrome")
roots.append(pathlib.Path.home() / ".config/chromium")
found = []
for root in roots:
    if not root.exists():
        continue
    for prefs in root.glob("*/Preferences"):
        try:
            data = json.loads(prefs.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        settings = data.get("extensions", {}).get("settings", {}) or {}
        for eid, meta in settings.items():
            path = str(meta.get("path") or "")
            manifest = meta.get("manifest") if isinstance(meta.get("manifest"), dict) else {}
            name = str(manifest.get("name") or "")
            if "sidechat" in path:
                found.append(eid)
# Prefer key-stable default if present, else first found
print(found[0] if found else "")
PY
}

if [[ -z "$EXT_ID" ]]; then
  DETECTED="$(detect_extension_id || true)"
  if [[ -n "${DETECTED:-}" ]]; then
    EXT_ID="$DETECTED"
    echo "Detected loaded extension ID: $EXT_ID"
  else
    EXT_ID="$DEFAULT_EXT_ID"
    echo "Using Chrome Web Store extension ID: $EXT_ID"
    echo "(Dev ID $DEV_EXT_ID is also whitelisted for unpacked development loads.)"
  fi
fi

echo "Building Rust host…"
if ! command -v cargo >/dev/null 2>&1; then
  echo "需要安装 Rust（cargo）。见 https://rustup.rs" >&2
  exit 2
fi
(cd "$HOST_DIR" && cargo build --release --bin sidechat-host)
chmod +x "$BIN"

# Ensure absolute path
if command -v realpath >/dev/null 2>&1; then
  BIN="$(realpath "$BIN")"
else
  BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"
fi

# 本地接口配置（不提交）：随二进制放置，Host 默认读取 exe 同目录的 anneng-config.json。
HOST_CONFIG="${ANNENG_HOST_CONFIG:-$ROOT/.secrets/host-config.json}"
if [[ -f "$HOST_CONFIG" ]]; then
  cp "$HOST_CONFIG" "$(dirname "$BIN")/anneng-config.json"
  echo "Installed host config: $(dirname "$BIN")/anneng-config.json"
else
  echo "提示: 未找到 $HOST_CONFIG，Host 将只使用扩展设置或 SIDECHAT_* 环境变量。"
fi

MANIFEST_NAME="com.hzy9738.sidechat.json"
TMP="$(mktemp)"

python3 - "$TMP" "$BIN" "$EXT_ID" "$DEV_EXT_ID" <<'PY'
import json, sys
out, binary, ext_id, dev_id = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
origins = []
for eid in (ext_id, dev_id):
    origin = f"chrome-extension://{eid}/"
    if eid and origin not in origins:
        origins.append(origin)
data = {
    "name": "com.hzy9738.sidechat",
    "description": "安能助手 native host — OpenAI-compatible APIs",
    "path": binary,
    "type": "stdio",
    "allowed_origins": origins,
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(json.dumps(data, indent=2))
PY

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  DEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  EXTRA=(
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts"
  )
elif [[ "$OS" == "Linux" ]]; then
  DEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  EXTRA=(
    "$HOME/.config/chromium/NativeMessagingHosts"
  )
else
  echo "Unsupported OS: $OS (on Windows, place the JSON under the registry path — see docs/install.md)" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$TMP" "$DEST_DIR/$MANIFEST_NAME"
echo "Installed: $DEST_DIR/$MANIFEST_NAME"
for d in "${EXTRA[@]:-}"; do
  if [[ -d "$(dirname "$d")" ]]; then
    mkdir -p "$d"
    cp "$TMP" "$d/$MANIFEST_NAME"
    echo "Installed: $d/$MANIFEST_NAME"
  fi
done

# Do not overwrite the in-repo template (HOST_BINARY_PATH / EXTENSION_ID placeholders).
rm -f "$TMP"
echo "Host binary: $BIN"
echo "Native host name: com.hzy9738.sidechat"
echo "allowed_origins: chrome-extension://$EXT_ID/ chrome-extension://$DEV_EXT_ID/"
echo "Reload the extension and open the Side Panel (Cmd/Ctrl+Shift+.)."
