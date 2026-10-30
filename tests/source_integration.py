"""Actual capture → source resolution → edit → recapture → undo, on disposable files."""
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[1]
data_root = Path(tempfile.mkdtemp(prefix='visualqa-v31-test-'))
ready_file = data_root / 'ready.json'
log = (data_root / 'server.log').open('w')
process = subprocess.Popen([sys.executable, str(root/'app/visual_qa.py'), '--serve', '--data-root', str(data_root/'data'), '--ready-file', str(ready_file)],
                           env=os.environ.copy(), stdout=log, stderr=log, start_new_session=True)
deadline = time.monotonic()+15
while not ready_file.exists() and time.monotonic()<deadline:
    if process.poll() is not None:
        raise RuntimeError((data_root/'server.log').read_text())
    time.sleep(.1)
ready = json.loads(ready_file.read_text())
parsed = urllib.parse.urlparse(ready['url'])
origin = f'{parsed.scheme}://{parsed.netloc}'
token = urllib.parse.parse_qs(parsed.query)['token'][0]


def raw(route, value=None):
    return urllib.request.urlopen(urllib.request.Request(origin+route,
        data=json.dumps(value).encode() if value is not None else None,
        headers={'X-VisualQA':token,'Content-Type':'application/json','Origin':origin}),timeout=130)


def api(route,value=None):
    with raw(route,value) as response:return json.load(response)


def execute(project_id):
    run=api('/api/start',{'project_id':project_id})
    deadline=time.monotonic()+110
    while time.monotonic()<deadline:
        run=api('/api/run?id='+run['id'])
        if run['status'] not in {'queued','running'}:break
        time.sleep(.2)
    assert run['status']=='complete',run
    return run,api(f"/api/result?run={run['id']}&target=mobile")


files=data_root/'source';(files/'html').mkdir(parents=True);(files/'css').mkdir()
text=(root/'tests/fixture.html').read_text().replace('        <style>','        <link rel="stylesheet" href="../css/style.css">\n        <style>')
(files/'html/page.html').write_text(text)
css='#hero {\n    border-top: 4px solid #087f74;\n}\n#hero h1 {\n    font-size: 30px;\n}\n'
(files/'css/style.css').write_text(css)
image=Image.new('RGB',(390,1060),'white');stream=io.BytesIO();image.save(stream,'PNG')
asset=api('/api/assets',{'name':'소스 검증 시안.png','content':base64.b64encode(stream.getvalue()).decode()})
project=api('/api/projects',{'name':'요소 소스 편집 검증','url':(files/'html/page.html').as_uri(),
    'source':{'root':str(files),'html':'html/page.html'},'targets':[{'id':'mobile','name':'모바일','width':390,'viewport_height':844,'enabled':True,'normalize':True,'asset_id':asset['id']}]})
run,result=execute(project['id'])
with raw(f"/files/{run['id']}/mobile/{result['id']}/actual.png") as response:reference=response.read()
asset=api('/api/assets',{'name':'검증 기준.png','content':base64.b64encode(reference).decode()})
project['targets'][0].update(asset_id=asset['id'],asset_name=asset['name'],asset_width=asset['width'],asset_height=asset['height'])
project=api('/api/projects',project)
run,result=execute(project['id'])
assert result['metrics']['verdict']=='PASS',result['metrics']
links=api('/api/source/resolve',{'run_id':run['id'],'target_id':'mobile','revision_id':result['id'],'selector':'#hero'})
assert links['links'][0]['exact'],links
assert any(link['path']=='css/style.css' and link['line']==1 for link in links['links']),links
doc=api('/api/source/file?project='+project['id']+'&path=css/style.css&line=1')
saved=api('/api/source/save',{'project_id':project['id'],'path':doc['path'],'sha256':doc['sha256'],'connection_id':doc['connection_id'],'content':doc['content'].replace('4px solid','8px solid')})
assert saved['changed'] and saved['backup_id']
changed_run,changed=execute(project['id'])
assert changed['metrics']['changed_pixels']>0 and changed['metrics']['verdict']!='PASS',changed['metrics']
restored=api('/api/source/restore',{'project_id':project['id'],'backup_id':saved['backup_id'],'sha256':saved['sha256'],'connection_id':saved['connection_id']})
assert restored['content']==css
restored_run,restored_result=execute(project['id'])
assert restored_result['metrics']['verdict']=='PASS',restored_result['metrics']
stale=api('/api/source/file?project='+project['id']+'&path=css/style.css')
(files/'css/style.css').write_text(css+'\n/* 외부 편집 */\n')
try:
    api('/api/source/save',{'project_id':project['id'],'path':stale['path'],'sha256':stale['sha256'],'connection_id':stale['connection_id'],'content':'덮어쓰기 금지'})
    raise AssertionError('Conflict was not rejected')
except urllib.error.HTTPError as error:assert error.code==400
assert '외부 편집' in (files/'css/style.css').read_text()
(files/'css/style.css').write_text(css)
receipt={'status':'PASS','ready_file':str(ready_file),'project_id':project['id'],'run_id':restored_run['id'],
         'data_root':str(data_root/'data'),'source_root':str(files),'links':links['links'],'warnings':links['warnings'],
         'changed_pixels_after_edit':changed['metrics']['changed_pixels'],'verdict_after_undo':restored_result['metrics']['verdict']}
(root/'verification/source-integration.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
print(json.dumps({'status':'PASS','ready_file':str(ready_file),'links':len(links['links']),'changed_pixels':changed['metrics']['changed_pixels'],'undo':'PASS'},ensure_ascii=False),flush=True)
