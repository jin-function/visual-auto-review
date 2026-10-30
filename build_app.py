"""Build a recoverable macOS universal app using the existing bundled runtimes."""
import argparse
import os
import plistlib
import runpy
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--source-app", type=Path, required=True)
parser.add_argument("--destination", type=Path, required=True)
args = parser.parse_args()
destination = args.destination.resolve()
if destination.exists():
    raise SystemExit("출력 앱이 이미 있습니다. 기존 앱을 덮어쓰지 않도록 다른 경로를 지정하세요.")
binaries = []
for architecture in ("x86_64", "arm64"):
    output = root / "native" / f"launcher-{architecture}"
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-target", f"{architecture}-apple-macosx13.0",
                    "-module-cache-path", "/private/tmp/visualqa-swift-cache", str(root / "native/VisualQALauncher.swift"),
                    "-o", str(output)], check=True)
    binaries.append(str(output))
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(args.source_app, destination, symlinks=True)
resources = destination / "Contents/Resources"
for source in (root / "app").iterdir():
    target = resources / source.name
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    else:
        shutil.copy2(source, target)
launcher = destination / "Contents/MacOS/VisualQALauncher"
subprocess.run(["lipo", "-create", *binaries, "-output", str(launcher)], check=True)
launcher.chmod(0o755)
(resources / "run.sh").chmod(0o755)
info_path = destination / "Contents/Info.plist"
with info_path.open("rb") as stream:
    info = plistlib.load(stream)
version = runpy.run_path(str(root / "app/qa/__init__.py"))["VERSION"]
info.update(CFBundleShortVersionString=version, CFBundleVersion=version, LSMinimumSystemVersion="13.0")
info["NSAppTransportSecurity"] = {"NSAllowsLocalNetworking": True}
with info_path.open("wb") as stream:
    plistlib.dump(info, stream)
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(destination)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(destination)], check=True)
print(destination)
