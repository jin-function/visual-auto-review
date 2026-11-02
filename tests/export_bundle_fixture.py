"""Export a real app HTTP handoff into the disposable Chrome integration test."""
import argparse
import io
import json
import tempfile
import sys
import threading
import urllib.request
from pathlib import Path
from PIL import Image
from qa.chrome_review import chrome_bundle
from qa.server import Server
from qa.service import Service
from qa.storage import Store, atomic_json

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--destination', type=Path, required=True)
parser.add_argument('--serve', action='store_true')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='visualqa-bundle-fixture-') as directory:
    service = Service(Store(Path(directory)))
    server = Server(('127.0.0.1', 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def capture(url, target, profile, output):
            output.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (target['width'], 160), 'white').save(output / 'actual.png')
            metadata = {'url': url, 'innerWidth': target['width'], 'clip': {'x': 0, 'y': 0, 'width': target['width'], 'height': 160},
                        'domElements': [{'selector': '#hero', 'rect': {'x': 0, 'y': 0, 'width': target['width'], 'height': 160}}], 'textRects': []}
            atomic_json(output / 'actual.png.json', metadata)
            return metadata
        service.capture.run = capture
        targets = []
        for device, width, color in [('pc', 1920, (230, 55, 75)), ('mo', 390, (35, 100, 230))]:
            stream = io.BytesIO()
            Image.new('RGB', (width, 160), color).save(stream, 'PNG')
            asset = service.store.import_asset(stream.getvalue(), device + '.png')
            targets.append({'id': device, 'device': device, 'name': device.upper(), 'width': width, 'enabled': True, 'asset_id': asset['id']})
        project = service.save_project({'name': '앱에서 내보낸 통합 검수', 'url': args.url, 'targets': targets, 'responsive': {'breakpoint': 1024}})
        run = service.start(project['id'])
        service.executor.submit(lambda: None).result(timeout=20)
        for device in ['pc', 'mo']:
            result = service.store.result(run['id'], device)
            service.store.review(run['id'], device, result['id'], result['findings'][0]['id'], 'fix', 'high', '앱에 기록한 수정 메모')
        request = urllib.request.Request(server.origin + '/api/chrome-review?run=' + run['id'], headers={'X-VisualQA': server.token, 'Origin': server.origin})
        with urllib.request.urlopen(request, timeout=15) as response:
            content = response.read()
        package = json.loads(content)
        assert package['version'] == 3 and len(package['targets']) == 2
        assert 'token' not in package and 'source' not in package
        args.destination.write_bytes(content)
        print(json.dumps({'version': package['version'], 'targets': [t['device'] for t in package['targets']]}), flush=True)
        if args.serve:
            print(json.dumps({'url': server.origin + '/?token=' + server.token}), flush=True)
            sys.stdin.read()
    finally:
        server.shutdown(); server.server_close(); service.close(); thread.join(timeout=5)
