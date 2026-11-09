"""Exercise the macOS WKWebView download policy with the actual app UI and API."""
import json
import os
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path

if platform.system() != 'Darwin':
    raise SystemExit('This check requires macOS WebKit.')
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='visualqa-webkit-') as directory:
    temporary = Path(directory)
    # Keep the production policy/delegate unchanged and replace only the entry point.
    source = (root / 'native/VisualQALauncher.swift').read_text(encoding='utf-8')
    source = source.split('\nlet application = NSApplication.shared\n')[0]
    source += '\n' + (root / 'tests/NativeDownloadProbe.swift').read_text(encoding='utf-8')
    swift = temporary / 'DownloadProbe.swift'
    swift.write_text(source, encoding='utf-8')
    executable = temporary / 'probe'
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(temporary / 'swift-cache'), str(swift), '-o', str(executable)], check=True)
    env = dict(os.environ, PYTHONPATH=str(root / 'app'), PYTHONDONTWRITEBYTECODE='1')
    with (temporary / 'server.log').open('w+', encoding='utf-8') as log:
        server = subprocess.Popen([sys.executable, str(root / 'tests/export_bundle_fixture.py'), '--url', 'https://example.test/review',
            '--destination', str(temporary / 'api.json'), '--serve'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8')
        messages = queue.Queue()
        def collect():
            for line in server.stdout:
                messages.put(json.loads(line))
            messages.put(None)
        threading.Thread(target=collect, daemon=True).start()
        try:
            address = None
            while not address:
                value = messages.get(timeout=60)
                if value is None:
                    log.seek(0)
                    raise RuntimeError('Fixture failed: ' + log.read())
                address = value.get('url')
            destination = temporary / 'visualqa-review.json'
            config = temporary / 'config.json'
            config.write_text(json.dumps({'url': address, 'destination': str(destination), 'checks': str(root / 'tests/app_view_checks.js')}), encoding='utf-8')
            completed = subprocess.run([str(executable), str(config)], capture_output=True, text=True, encoding='utf-8', timeout=60)
            assert completed.returncode == 0, completed.stdout + completed.stderr
            package = json.loads(destination.read_text(encoding='utf-8'))
            assert package['version'] == 3
            assert {target['device'] for target in package['targets']} == {'pc', 'mo'}
            assert package['captureOptions'] == {'removeHidden': False}
            parsed = urllib.parse.urlsplit(address)
            origin = f'{parsed.scheme}://{parsed.netloc}'
            token = urllib.parse.parse_qs(parsed.query)['token'][0]
            request = urllib.request.Request(origin + '/api/chrome-review?run=' + package['runId'], headers={'X-VisualQA': token, 'Origin': origin})
            with urllib.request.urlopen(request, timeout=15) as response:
                assert destination.read_bytes() == response.read()
            print(json.dumps({'status': 'PASS', 'checks': ['production WKWebView navigation policy', 'actual app export button',
                'external navigation blocked', 'blob navigation without download blocked', 'native JSON download completes',
                'original filename', 'PC and MO in saved JSON', 'downloaded bytes match API',
                'exclusive image tabs and keyboard navigation', 'hidden tools and parked source editing', 'finding navigation and judgment persistence',
                'missing MO warning and navigation to latest paired history']}))
        finally:
            server.stdin.close()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait(timeout=5)
