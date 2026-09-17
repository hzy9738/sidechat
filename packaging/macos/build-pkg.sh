#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${APP_VERSION:-0.6.3}"
EXTENSION_ID="${EXTENSION_ID:-hkifhagmdbdpaihdmllddcingebfpjmm}"
UPDATE_URL="${EXTENSION_UPDATE_URL:-https://clients2.google.com/service/update2/crx}"
HOST_SOURCE="${HOST_BINARY:-$ROOT/host-rs/target/release/grok-sidechat-host}"
HOST_CONFIG="${ANNENG_HOST_CONFIG:-$ROOT/.secrets/host-config.json}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/dist}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anneng-pkg.XXXXXX")"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

if [[ ! -x "$HOST_SOURCE" ]]; then
  printf 'Host binary not found: %s\n' "$HOST_SOURCE" >&2
  printf 'Run: cargo build --release --manifest-path host-rs/Cargo.toml --bin sidechat-host\n' >&2
  exit 2
fi
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  printf 'EXTENSION_ID must be a 32-character Chrome extension ID.\n' >&2
  exit 2
fi

verify_extension_source() {
  local probe_url
  probe_url="$UPDATE_URL"
  if [[ "$UPDATE_URL" == "https://clients2.google.com/service/update2/crx" ]]; then
    probe_url="$UPDATE_URL?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D$EXTENSION_ID%26uc"
  fi
  if /usr/bin/curl --fail --silent --show-error --location --max-time 20 --output /dev/null "$probe_url"; then
    return
  fi
  cat >&2 <<EOF
Extension $EXTENSION_ID is not downloadable from:
  $UPDATE_URL

Refusing to build an installer that cannot install the browser extension.
Publish the extension first, or set SKIP_EXTENSION_SOURCE_CHECK=1 only for
installer UI development.
EOF
  exit 3
}

if [[ "${SKIP_EXTENSION_SOURCE_CHECK:-0}" != "1" ]]; then
  verify_extension_source
fi

PAYLOAD="$WORK_DIR/payload"
PACKAGES="$WORK_DIR/packages"
RESOURCES="$WORK_DIR/resources"
mkdir -p "$PAYLOAD/Library/Application Support/Anneng Assistant" "$PACKAGES" "$RESOURCES" "$OUTPUT_DIR"
install -m 0755 "$HOST_SOURCE" "$PAYLOAD/Library/Application Support/Anneng Assistant/anneng-assistant-host"
if [[ -f "$HOST_CONFIG" ]]; then
  install -m 0644 "$HOST_CONFIG" "$PAYLOAD/Library/Application Support/Anneng Assistant/anneng-config.json"
else
  printf 'Warning: host config not found (%s); package ships without default API config.\n' "$HOST_CONFIG" >&2
fi

pkgbuild --root "$PAYLOAD" \
  --identifier "com.chint.anneng-assistant.core" \
  --version "$VERSION" --install-location "/" "$PACKAGES/core.pkg"

build_browser_package() {
  local browser="$1"
  local identifier="$2"
  local scripts="$WORK_DIR/scripts-$browser"
  local browser_payload="$WORK_DIR/payload-$browser"
  local marker_dir="$browser_payload/Library/Application Support/Anneng Assistant/Browser Components"
  mkdir -p "$scripts" "$marker_dir"
  install -m 0755 "$ROOT/packaging/macos/scripts/postinstall" "$scripts/postinstall"
  cat >"$marker_dir/$browser.json" <<EOF
{
  "browser": "$browser",
  "extensionId": "$EXTENSION_ID",
  "updateUrl": "$UPDATE_URL",
  "installedBy": "安能助手安装器"
}
EOF
  cat >"$scripts/config" <<EOF
EXTENSION_ID='$EXTENSION_ID'
EXTENSION_UPDATE_URL='$UPDATE_URL'
BROWSER='$browser'
EOF
  pkgbuild --root "$browser_payload" --scripts "$scripts" \
    --identifier "$identifier" --version "$VERSION" --install-location "/" "$PACKAGES/$browser.pkg"
}

build_browser_package "chrome" "com.chint.anneng-assistant.chrome"
build_browser_package "edge" "com.chint.anneng-assistant.edge"
build_browser_package "brave" "com.chint.anneng-assistant.brave"
build_browser_package "ego" "com.chint.anneng-assistant.ego"
build_browser_package "chromium" "com.chint.anneng-assistant.chromium"

install -m 0644 "$ROOT/extension/icons/logo.png" "$RESOURCES/logo.png"

cat >"$RESOURCES/welcome.html" <<'EOF'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{color-scheme:light}html,body{background:#f7faff!important;color:#17324d!important}body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;line-height:1.6;margin:0;padding:22px}.hero{display:flex;align-items:center;gap:16px}.hero img{width:58px;height:58px;border-radius:15px;box-shadow:0 8px 20px #1f6feb26}h1{color:#1167d8!important;font-size:24px;margin:0}.sub{color:#52708f!important;margin:3px 0 0}.card{margin-top:20px;padding:16px 18px;border:1px solid #cfe1ff;border-radius:14px;background:#fff!important;box-shadow:0 6px 18px #1f6feb12}.card strong{color:#174ea6!important}.card p{color:#355675!important;margin:5px 0}
</style></head><body><div class="hero"><img src="logo.png"><div><h1>安装安能助手</h1><p class="sub">让 AI 在浏览器侧栏随时可用</p></div></div>
<div class="card"><strong>选择你的浏览器</strong><p>下一步只显示这台 Mac 上已安装且受支持的浏览器，可以同时选择多个。</p><p>支持 Chrome、Edge、Brave、Chromium 和 ego lite。安装完成后重新启动所选浏览器。</p></div>
</body></html>
EOF

cat >"$RESOURCES/conclusion.html" <<'EOF'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{color-scheme:light}html,body{background:#f7faff!important;color:#17324d!important}body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;line-height:1.6;margin:0;padding:22px}.hero{display:flex;align-items:center;gap:16px}.hero img{width:58px;height:58px;border-radius:15px}h1{color:#1167d8!important;font-size:24px;margin:0}.ok{color:#17834b!important;margin:3px 0 0}.card{margin-top:18px;padding:14px 17px;border:1px solid #cfe1ff;border-radius:14px;background:#fff!important}.card p{color:#355675!important;margin:5px 0}code{display:inline-block;background:#edf5ff!important;color:#174ea6!important;padding:3px 7px;border-radius:6px}
</style></head><body><div class="hero"><img src="logo.png"><div><h1>安装完成</h1><p class="ok">安能助手已经准备好了</p></div></div>
<div class="card"><p>已安装本地服务和所选浏览器的通信配置。请完全退出并重新打开浏览器，浏览器将从已配置的更新源下载扩展。</p><p><strong>Host：</strong><br><code>/Library/Application Support/Anneng Assistant/anneng-assistant-host</code></p><p>如果浏览器中没有出现扩展，请联系安装包提供方确认扩展已经发布。</p></div>
</body></html>
EOF

cat >"$WORK_DIR/Distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>安能助手</title>
  <organization>com.chint</organization>
  <domains enable_localSystem="true"/>
  <options customize="always" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <welcome file="welcome.html"/>
  <conclusion file="conclusion.html"/>
  <choices-outline>
    <line choice="core"/>
    <line choice="chrome"/>
    <line choice="edge"/>
    <line choice="brave"/>
    <line choice="ego"/>
    <line choice="chromium"/>
  </choices-outline>
  <choice id="core" start_visible="false" start_selected="true"><pkg-ref id="com.chint.anneng-assistant.core"/></choice>
  <choice id="chrome" title="Google Chrome" description="为 Google Chrome 安装扩展和本地通信配置。" start_selected="system.files.fileExistsAtPath('/Applications/Google Chrome.app')" start_visible="system.files.fileExistsAtPath('/Applications/Google Chrome.app')"><pkg-ref id="com.chint.anneng-assistant.chrome"/></choice>
  <choice id="edge" title="Microsoft Edge" description="为 Microsoft Edge 安装扩展和本地通信配置。" start_selected="system.files.fileExistsAtPath('/Applications/Microsoft Edge.app')" start_visible="system.files.fileExistsAtPath('/Applications/Microsoft Edge.app')"><pkg-ref id="com.chint.anneng-assistant.edge"/></choice>
  <choice id="brave" title="Brave Browser" description="为 Brave Browser 安装扩展和本地通信配置。" start_selected="system.files.fileExistsAtPath('/Applications/Brave Browser.app')" start_visible="system.files.fileExistsAtPath('/Applications/Brave Browser.app')"><pkg-ref id="com.chint.anneng-assistant.brave"/></choice>
  <choice id="ego" title="ego lite" description="为 ego lite 安装扩展和本地通信配置。" start_selected="system.files.fileExistsAtPath('/Applications/ego lite.app')" start_visible="system.files.fileExistsAtPath('/Applications/ego lite.app')"><pkg-ref id="com.chint.anneng-assistant.ego"/></choice>
  <choice id="chromium" title="Chromium" description="为 Chromium 安装扩展和本地通信配置。" start_selected="system.files.fileExistsAtPath('/Applications/Chromium.app')" start_visible="system.files.fileExistsAtPath('/Applications/Chromium.app')"><pkg-ref id="com.chint.anneng-assistant.chromium"/></choice>
  <pkg-ref id="com.chint.anneng-assistant.core" version="$VERSION" onConclusion="none">core.pkg</pkg-ref>
  <pkg-ref id="com.chint.anneng-assistant.chrome" version="$VERSION" onConclusion="none">chrome.pkg</pkg-ref>
  <pkg-ref id="com.chint.anneng-assistant.edge" version="$VERSION" onConclusion="none">edge.pkg</pkg-ref>
  <pkg-ref id="com.chint.anneng-assistant.brave" version="$VERSION" onConclusion="none">brave.pkg</pkg-ref>
  <pkg-ref id="com.chint.anneng-assistant.ego" version="$VERSION" onConclusion="none">ego.pkg</pkg-ref>
  <pkg-ref id="com.chint.anneng-assistant.chromium" version="$VERSION" onConclusion="none">chromium.pkg</pkg-ref>
</installer-gui-script>
EOF

OUTPUT_SUFFIX=""
if [[ "${SKIP_EXTENSION_SOURCE_CHECK:-0}" == "1" ]]; then
  OUTPUT_SUFFIX="-DEV-UNPUBLISHED"
fi
OUTPUT="$OUTPUT_DIR/Anneng-Assistant-${VERSION}-macOS${OUTPUT_SUFFIX}.pkg"
PRODUCT_ARGS=(--distribution "$WORK_DIR/Distribution.xml" --resources "$RESOURCES" --package-path "$PACKAGES")
if [[ -n "${MAC_INSTALLER_IDENTITY:-}" ]]; then PRODUCT_ARGS+=(--sign "$MAC_INSTALLER_IDENTITY"); fi
productbuild "${PRODUCT_ARGS[@]}" "$OUTPUT"
printf 'Built interactive installer: %s\n' "$OUTPUT"
