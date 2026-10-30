import json
import resource
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw
from qa.engine import compare

reference = Image.new('RGB', (1920, 12000), 'white')
draw = ImageDraw.Draw(reference)
rects = []
for y in range(100, 12000, 100):
    draw.rectangle((100, y, 1700, y + 16), fill='#173f4b')
    rects.append({'x':100,'y':y,'width':1600,'height':20})
actual = reference.copy()
ImageDraw.Draw(actual).rectangle((20, 11000, 27, 11007), fill='black')
start = time.perf_counter()
with tempfile.TemporaryDirectory(prefix='visualqa-benchmark-') as temp:
    result = compare(reference, actual, {'textRects':rects}, {}, Path(temp))
elapsed = time.perf_counter() - start
metrics = {'size':'1920x12000', 'pixels':23040000, 'seconds':round(elapsed,2),
           'peak_memory_mb':round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024,1),
           'changed_pixels':result['metrics']['changed_pixels'],'verdict':result['metrics']['verdict']}
assert metrics['changed_pixels'] == 64 and metrics['verdict'] == 'REVIEW'
destination = Path(__file__).parents[1] / 'verification/benchmark.json'
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps(metrics))
