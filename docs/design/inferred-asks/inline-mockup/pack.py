"""Package the built preview as one local HTML file, including fonts and the sky worker."""
import base64
import json
import mimetypes
import re
from pathlib import Path

root = Path(__file__).resolve().parent
assets = root / 'preview/assets'
css = next(assets.glob('index-*.css')).read_text()
js = next(assets.glob('index-*.js')).read_text()

def data_url(name):
    path = assets / Path(name).name
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()

css = re.sub(r'url\(([^)]+)\)', lambda m: 'url("' + data_url(m[1].strip('\"\'')) + '")' if not m[1].startswith('data:') else m[0], css)
worker = next(assets.glob('cloud.worker-*.js'))
pattern = r'new Worker\(new URL\(""\+new URL\("' + re.escape(worker.name) + r'",import.meta.url\).href,import.meta.url\),\{type:"module"\}\)'
replacement = 'new Worker(URL.createObjectURL(new Blob([' + json.dumps(worker.read_text()) + '],{type:"text/javascript"})))'
js, count = re.subn(pattern, lambda m: replacement, js)
assert count == 1, 'Expected exactly one sky worker to embed'
js = re.sub(r'new URL\("([^"/]+)",import.meta.url\).href', lambda m: json.dumps(data_url(m[1])), js)
assert 'import.meta' not in js
js = js.replace('</script', '<\\/script')
(root/'mockup.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StrataMD · Questions in the passage</title><style>'+css+'</style></head><body><div id="root"></div><script>'+js+'</script></body></html>')
print('Saved portable mockup.html')
