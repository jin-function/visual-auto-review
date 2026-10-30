"""Actual Chromium + authenticated API integration test against a test-only store."""
import base64
import io
import json
import time
import tempfile
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ready = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else str(Path(tempfile.gettempdir()) / 'visualqa-v3-ready.json')).read_text())
url = urllib.parse.urlparse(ready['url'])
origin = f'{url.scheme}://{url.netloc}'
token = urllib.parse.parse_qs(url.query)['token'][0]


def request(route, value=None, token_value=token, origin_value=origin):
    payload = json.dumps(value).encode() if value is not None else None
    headers = {'X-VisualQA': token_value, 'Origin': origin_value}
    if payload:
        headers['Content-Type'] = 'application/json'
    return urllib.request.urlopen(urllib.request.Request(origin + route, data=payload, headers=headers), timeout=15)


def api(route, value=None):
    return json.load(request(route, value))


def wait(run_id, revision=None):
    deadline = time.monotonic() + 110
    while time.monotonic() < deadline:
        run = api('/api/run?id=' + run_id)
        target = run['targets']['mobile']
        if revision:
            if target.get('current_revision') != revision and target['status'] == 'complete':
                return run
        elif run['status'] not in {'queued', 'running'}:
            return run
        if target.get('error'):
            raise AssertionError(target['error'])
        time.sleep(.25)
    raise AssertionError('Integration run timed out')


for auth, source in [('', origin), (token, 'https://example.invalid')]:
    try:
        request('/api/state', token_value=auth, origin_value=source)
        raise AssertionError('Unauthorized request accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 403

image = Image.new('RGB', (390, 1060), 'white')
stream = io.BytesIO(); image.save(stream, 'PNG')
asset = api('/api/assets', {'name':'회귀검증 시안.png', 'content':base64.b64encode(stream.getvalue()).decode()})
fixture_url = sys.argv[2] if len(sys.argv) > 2 else (Path(__file__).parent / 'fixture.html').resolve().as_uri()
project = api('/api/projects', {'name':'회귀 검증 프로젝트', 'url':fixture_url,
    'targets':[{'id':'mobile','name':'모바일','enabled':True,'asset_id':asset['id'],'asset_name':asset['name'],'asset_width':asset['width'],'asset_height':asset['height'],'width':390,'viewport_height':844,'normalize':True}]})
run = api('/api/start', {'project_id':project['id']})
run = wait(run['id'])
assert run['status'] == 'complete', run
result = api(f"/api/result?run={run['id']}&target=mobile")
assert result['capture']['toggleCount'] == result['capture']['openedToggleCount'] == 1
assert not result['capture']['brokenImages']
assert result['findings']
assert sum(s['changed_pixels'] for s in result['strips']) == result['metrics']['changed_pixels']
finding = result['findings'][0]
api('/api/review', {'run_id':run['id'],'target_id':'mobile','revision_id':result['id'],'finding_id':finding['id'],'status':'fix','severity':'high','note':'API 검증 메모'})
old_id = result['id']
api('/api/recalculate', {'run_id':run['id'],'target_id':'mobile','y_offset':3,'reason':'통합 검증 보정'})
run = wait(run['id'], old_id)
current = api(f"/api/result?run={run['id']}&target=mobile")
assert current['id'] != old_id and current['metrics']['y_offset'] == 3
assert sum(s['changed_pixels'] for s in current['strips']) == current['metrics']['changed_pixels']
old = api(f"/api/result?run={run['id']}&target=mobile&revision={old_id}")
assert old['reviews'][finding['id']]['note'] == 'API 검증 메모'
response = request(f"/api/export?run={run['id']}")
assert response.headers['Content-Type'] == 'application/zip'
assert response.read(2) == b'PK'
for filename in ('reference.png','actual.png','diff.png','overlay.png'):
    response = request(f"/files/{run['id']}/mobile/{current['id']}/{filename}")
    assert response.headers['Content-Type'] == 'image/png'
    response.close()
(Path(__file__).resolve().parents[1] / 'verification/app-integration.json').write_text(json.dumps({'project_id':project['id'],'run_id':run['id'],'revision_id':current['id'],'capture':current['capture']['browser'],'findings':len(current['findings']),'metrics':current['metrics']},ensure_ascii=False,indent=2))
print(json.dumps({'integration':'PASS','run_id':run['id'],'findings':len(current['findings']),'accordion':'1/1 opened','browser':current['capture']['browser']['product']},ensure_ascii=False))
