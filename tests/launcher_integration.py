"""Exercise the shared launcher and a real capture in a disposable data store."""
import json
import functools
import http.server
import threading
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='visualqa-launcher-') as directory:
    temporary = Path(directory)
    ready = temporary / 'ready.json'
    fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root / 'tests')))
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    fixture_url = f'http://127.0.0.1:{fixture.server_port}/fixture.html'
    with (temporary / 'server.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([sys.executable, str(root / 'start.py'), '--no-open',
            '--data-root', str(temporary / 'data'), '--ready-file', str(ready)],
            env=os.environ.copy(), stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 15
            while not ready.exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError((temporary / 'server.log').read_text(encoding='utf-8'))
                time.sleep(.1)
            assert ready.exists(), 'Launcher did not become ready'
            launched = json.loads(ready.read_text(encoding='utf-8'))
            parsed = urllib.parse.urlparse(launched['url'])
            origin = f'{parsed.scheme}://{parsed.netloc}'
            token = urllib.parse.parse_qs(parsed.query)['token'][0]
            def api(route):
                with urllib.request.urlopen(urllib.request.Request(origin + route,
                    headers={'X-VisualQA': token, 'Origin': origin}), timeout=15) as response:
                    return json.load(response)
            state = api('/api/state')
            assert state['version'] == '3.4.0' and not state['projects'] and not state['runs']
            completed = subprocess.run([sys.executable, str(root / 'tests/integration.py'), str(ready), fixture_url],
                env=os.environ.copy(), capture_output=True, text=True, encoding='utf-8', timeout=150)
            assert completed.returncode == 0, completed.stdout + completed.stderr
            state = api('/api/state')
            run = state['runs'][0]
            package = api('/api/chrome-review?' + urllib.parse.urlencode({'run': run['id'], 'target': 'mobile'}))
            assert package['device'] == 'mo' and package['targetId'] == 'mobile'
            assert package['imageRole'] == 'reference-original'
            print(json.dumps({'status': 'PASS', 'checks': ['shared launcher', 'empty isolated store',
                'actual browser capture', 'API authentication', 'full comparison and recalculation',
                'review history and report export', 'original Chrome review with device metadata']}, ensure_ascii=False))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
            fixture.shutdown(); fixture.server_close()
