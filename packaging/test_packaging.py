#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))


def extension_id(public_key: str) -> str:
    digest = hashlib.sha256(base64.b64decode(public_key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest)


development_id = extension_id(manifest["key"])
assert development_id == "gjpmflfaadhcbbcckbmbccggfpbdjdel", development_id
store_id = "hkifhagmdbdpaihdmllddcingebfpjmm"

background = (ROOT / "extension/background.js").read_text(encoding="utf-8")
mac_script = (ROOT / "packaging/macos/scripts/postinstall").read_text(encoding="utf-8")
mac_builder = (ROOT / "packaging/macos/build-pkg.sh").read_text(encoding="utf-8")
windows_iss = (ROOT / "packaging/windows/AnnengAssistant.iss").read_text(encoding="utf-8")
workflow = (ROOT / ".github/workflows/build-installers.yml").read_text(encoding="utf-8")

host_name = "com.hzy9738.sidechat"
for source in (background, mac_script, windows_iss):
    assert host_name in source
for source in (mac_builder, windows_iss, workflow):
    assert store_id in source

# 本地密钥配置：打包时注入 anneng-config.json，且密钥文件必须被 gitignore 覆盖。
assert "anneng-config.json" in mac_builder
assert "host-config.json" in mac_builder
assert "anneng-config.json" in windows_iss
assert "skipifsourcedoesntexist" in windows_iss
assert "HOST_CONFIG_JSON" in workflow
gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
assert ".secrets/" in gitignore
assert "anneng-config.json" in gitignore

for browser in ("Chrome", "Edge", "Brave"):
    assert browser in mac_script
    assert browser in windows_iss
for browser in ("ego", "chromium"):
    assert browser in mac_builder.lower()
    assert browser in mac_script.lower()
for browser in ("360safe", "360speed", "qqbrowser"):
    assert browser in windows_iss

assert "ExtensionInstallForcelist" in mac_script
assert "ExtensionInstallForcelist" in windows_iss
assert "NativeMessagingHosts" in mac_script
assert "NativeMessagingHosts" in windows_iss
assert 'customize="always"' in mac_builder
assert "productbuild" in mac_builder
assert "BROWSER='$browser'" in mac_builder
assert "Browser Components" in mac_builder
assert '<choice id="browsers"' not in mac_builder
assert "color-scheme:light" in mac_builder
assert "verify_extension_source" in mac_builder
assert "DEV-UNPUBLISHED" in mac_builder
assert "start_selected=\"system.files.fileExistsAtPath('/Applications/Google Chrome.app')\"" in mac_builder
assert "start_visible=\"system.files.fileExistsAtPath('/Applications/Google Chrome.app')\"" in mac_builder
assert "SkipExtensionSourceCheck" in (ROOT / "packaging/windows/build-installer.ps1").read_text(encoding="utf-8")

if os.uname().sysname == "Darwin":
    with tempfile.TemporaryDirectory(prefix="anneng-installer-test-") as temp:
        root = Path(temp)
        script_dir = root / "package-scripts"
        script_dir.mkdir()
        shutil.copy2(ROOT / "packaging/macos/scripts/postinstall", script_dir / "postinstall")
        for app in (
            "Google Chrome.app",
            "Microsoft Edge.app",
            "Brave Browser.app",
            "ego lite.app",
            "Chromium.app",
        ):
            (root / "Applications" / app).mkdir(parents=True)
        host = root / "Library/Application Support/Anneng Assistant/anneng-assistant-host"
        host.parent.mkdir(parents=True)
        host.write_bytes(b"test host")
        env = os.environ.copy()
        env["ANNENG_INSTALL_ROOT"] = str(root)
        for browser in ("chrome", "edge", "brave", "ego", "chromium"):
            (script_dir / "config").write_text(
                f"EXTENSION_ID='{store_id}'\n"
                "EXTENSION_UPDATE_URL='https://clients2.google.com/service/update2/crx'\n"
                f"BROWSER='{browser}'\n",
                encoding="utf-8",
            )
            subprocess.run(["bash", str(script_dir / "postinstall")], env=env, check=True)

        manifests = list((root / "Library").rglob("com.hzy9738.sidechat.json"))
        assert len(manifests) == 5, manifests
        for path in manifests:
            data = json.loads(path.read_text(encoding="utf-8"))
            assert data["path"] == str(host)
            assert data["allowed_origins"] == [f"chrome-extension://{store_id}/"]
        policies = list((root / "Library/Managed Preferences").glob("*.plist"))
        assert len(policies) == 5, policies
        for path in policies:
            data = plistlib.loads(path.read_bytes())
            assert data["ExtensionInstallForcelist"] == [
                f"{store_id};https://clients2.google.com/service/update2/crx"
            ]
print("packaging configuration ok")
