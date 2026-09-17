#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
background = (EXTENSION / "background.js").read_text(encoding="utf-8")
sidepanel = (EXTENSION / "sidepanel.js").read_text(encoding="utf-8")

assert manifest["version"] >= "0.7.0"
assert "nativeMessaging" not in manifest["permissions"]
assert "connectNative" not in background
assert "assistant-send" in background
assert "streamChat" in background
assert "vendor/pdf.mjs" in sidepanel
assert (EXTENSION / "vendor/pdf.mjs").is_file()
assert (EXTENSION / "vendor/pdf.worker.mjs").is_file()

gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
assert ".secrets/" in gitignore
assert "extension/node_modules/" in gitignore

with tempfile.TemporaryDirectory(prefix="anneng-package-test-") as temp:
    temp_root = Path(temp)
    output = temp_root / "dist"
    runtime_config = temp_root / "runtime.json"
    expected = {
        "apiBase": "https://model.example/v1",
        "apiKey": "package-test-key",
        "model": "deepseek-v4",
        "visionModel": "qwen-vl",
    }
    runtime_config.write_text(json.dumps(expected), encoding="utf-8")
    env = os.environ.copy()
    env.update({
        "OUTPUT_DIR": str(output),
        "APP_VERSION": manifest["version"],
        "ANNENG_RUNTIME_CONFIG": str(runtime_config),
    })
    subprocess.run([str(ROOT / "packaging/build-unpacked-extension.sh")], env=env, check=True)
    unpacked = output / f"Anneng-Assistant-{manifest['version']}-unpacked"
    bundled_config = json.loads(
        (unpacked / "extension/runtime-config.json").read_text(encoding="utf-8")
    )
    assert bundled_config == expected
    assert (unpacked / "extension/vendor/pdf.mjs").is_file()
    assert "不需要 Native Messaging Host" in (unpacked / "README.txt").read_text(encoding="utf-8")
    assert (output / f"Anneng-Assistant-{manifest['version']}-unpacked.zip").is_file()

    subprocess.run([str(ROOT / "packaging/build-extension-zip.sh")], env=env, check=True)
    store_zip = output / f"Anneng-Assistant-{manifest['version']}-Chrome-Web-Store.zip"
    with zipfile.ZipFile(store_zip) as archive:
        store_manifest = json.loads(archive.read("manifest.json"))
        store_config = json.loads(archive.read("runtime-config.json"))
        assert "key" not in store_manifest
        assert store_config["apiKey"] == ""
        assert "vendor/pdf.mjs" in archive.namelist()

print("packaging configuration ok")

