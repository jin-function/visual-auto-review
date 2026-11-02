"""Download an isolated Chrome for Testing from Google's published JSON manifest."""
import argparse
import json
import os
import platform
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--destination', type=Path, required=True)
parser.add_argument('--env-file', type=Path)
args = parser.parse_args()
manifest_url = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
with urllib.request.urlopen(manifest_url, timeout=30) as response:
    manifest = json.load(response)
system = platform.system()
platform_id = 'win64' if system == 'Windows' else ('mac-arm64' if platform.machine() == 'arm64' else 'mac-x64') if system == 'Darwin' else 'linux64'
url = next(item['url'] for item in manifest['channels']['Stable']['downloads']['chrome'] if item['platform'] == platform_id)
if not url.startswith('https://storage.googleapis.com/chrome-for-testing-public/'):
    raise RuntimeError('공식 Chrome for Testing 다운로드 주소가 아닙니다.')
args.destination.mkdir(parents=True, exist_ok=True)
root = args.destination.resolve()
with tempfile.TemporaryDirectory() as directory:
    archive = Path(directory) / 'chrome.zip'
    with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as stream:
        import shutil
        shutil.copyfileobj(response, stream)
    with zipfile.ZipFile(archive) as source:
        links = []
        for entry in source.infolist():
            target = (root / entry.filename).resolve()
            if not target.is_relative_to(root):
                raise RuntimeError('다운로드 파일의 경로가 올바르지 않습니다.')
            if stat.S_ISLNK(entry.external_attr >> 16):
                links.append((target, source.read(entry).decode("utf-8")))
                continue
            source.extract(entry, root)
            if os.name != 'nt' and (entry.external_attr >> 16) & stat.S_IXUSR:
                target.chmod((entry.external_attr >> 16) & 0o777)
        for target, link in links:
            if not (target.parent / link).resolve().is_relative_to(root):
                raise RuntimeError('다운로드 링크의 경로가 올바르지 않습니다.')
            target.symlink_to(link)
relative = 'chrome.exe' if system == 'Windows' else 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' if system == 'Darwin' else 'chrome'
executable = root / ('chrome-' + platform_id) / relative
if not executable.is_file():
    raise RuntimeError('Chrome for Testing 실행 파일을 찾지 못했습니다.')
if args.env_file:
    with args.env_file.open('a', encoding='utf-8') as stream:
        stream.write(f'VISUAL_QA_TEST_CHROME={executable}\nVISUAL_QA_CHROME={executable}\n')
print(executable)
