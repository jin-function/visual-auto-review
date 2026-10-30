"""Verify the real HTTP download route and unchanged origin authentication."""
import base64
import hashlib
import io
import json
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image
from qa.server import Server
from qa.service import Service
from qa.storage import Store, atomic_json

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='visualqa-chrome-api-') as directory:
    service = Service(Store(Path(directory)))
    server = Server(('127.0.0.1', 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        def capture(url, target, profile, output):
            output.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (390, 80), 'black').save(output / 'actual.png')
            metadata = {'url': url, 'innerWidth': 390, 'clip': {'x': 8, 'y': 250, 'width': 390, 'height': 80}, 'domElements': [], 'textRects': []}
            atomic_json(output / 'actual.png.json', metadata)
            return metadata
        service.capture.run = capture
        stream = io.BytesIO(); Image.new('RGB', (390, 80), 'white').save(stream, 'PNG')
        asset = service.store.import_asset(stream.getvalue(), '검수.png')
        project = service.save_project({'name': 'Chrome 전달 검증', 'url': 'http://127.0.0.1:5500/page.html',
            'targets': [{'id': 'mobile', 'name': '모바일', 'width': 390, 'enabled': True, 'asset_id': asset['id']}]})
        run = service.start(project['id']); service.executor.submit(lambda: None).result(timeout=10)
        result = service.store.result(run['id'], 'mobile')
        route = '/api/chrome-review?' + urllib.parse.urlencode({'run': run['id'], 'target': 'mobile', 'revision': result['id']})
        def request(token, origin=None):
            headers = {'X-VisualQA': token}
            if origin: headers['Origin'] = origin
            return urllib.request.urlopen(urllib.request.Request(server.origin + route, headers=headers), timeout=10)
        for token, origin in [('', None), (server.token, 'https://foreign.invalid'), (server.token, 'chrome-extension://foreign')]:
            try:
                request(token, origin)
                raise AssertionError('foreign or unauthenticated download accepted')
            except urllib.error.HTTPError as error: assert error.code == 403
        with request(server.token, server.origin) as response:
            assert response.headers['Content-Type'] == 'application/octet-stream'
            assert 'visualqa-review.json' in response.headers['Content-Disposition']
            package = json.load(response)
        assert package['placement'] == {'x': 8, 'y': 250}
        assert package['revisionId'] == result['id'] and package['findings']
        assert package['version'] == 2 and package['imageRole'] == 'reference-original'
        assert base64.b64decode(package['image']['base64']) == service.store.asset_path(asset['id']).read_bytes()
        assert package['display'] == {'width': 390, 'height': 80}
        digest = hashlib.sha256((root / 'app/page_state.js').read_bytes()).hexdigest()
        receipt = {'status': 'PASS', 'checks': ['selected revision download', 'stored original image bytes', 'original display dimensions', 'placement coordinates', 'no token accepted', 'foreign website rejected', 'extension origin rejected'],
            'accordion_module_sha256': digest}
        (root / 'verification/chrome-handoff.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
        print(json.dumps(receipt, ensure_ascii=False))
    finally:
        server.shutdown(); server.server_close(); service.close(); thread.join(timeout=5)
