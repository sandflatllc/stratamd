import json,subprocess,pathlib,sys,shutil
base=pathlib.Path(__file__).resolve().parents[1]
cli=['agent-browser','--session','strata-v2-capture','--cdp','43213','--json']
def call(*args):
 p=subprocess.run(cli+list(args),capture_output=True,text=True,check=True)
 r=json.loads(p.stdout)
 if not r['success']:raise RuntimeError(r)
 return r['data'].get('result',r['data'])
call('eval','''(()=>{if(!document.querySelector('#benchmark-freeze')){const s=document.createElement('style');s.id='benchmark-freeze';s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.head.append(s)}return true})()''')
call('eval',"document.documentElement.dataset.typing='true'")
call('eval','new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
call('eval','''(async()=>{document.activeElement?.blur();document.body.getBoundingClientRect();await Promise.all([...new Set([...document.querySelectorAll('*')].map(e=>{const s=getComputedStyle(e);return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`}))].map(f=>document.fonts.load(f).catch(()=>[])));await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()''')
data=call('eval','''(async()=>{await document.fonts.ready;const clone=document.body.cloneNode(true);clone.querySelectorAll('script').forEach(e=>e.remove());const sourceInputs=[...document.querySelectorAll('input,textarea,select')];clone.querySelectorAll('input,textarea,select').forEach((e,i)=>{const o=sourceInputs[i];if(e.tagName==='TEXTAREA')e.textContent=o.value;else if(e.tagName==='SELECT'){[...e.options].forEach((v,j)=>v.toggleAttribute('selected',j===o.selectedIndex))}else{e.setAttribute('value',o.value);e.toggleAttribute('checked',o.checked)}});return {html:clone.innerHTML,htmlAttrs:[...document.documentElement.attributes].map(a=>[a.name,a.value]),bodyAttrs:[...document.body.attributes].map(a=>[a.name,a.value]),canvasImages:[...document.querySelectorAll('canvas')].map(c=>c.toDataURL('image/png')),css:[...document.styleSheets].map(s=>s.href).filter(Boolean),theme:(await window.strata.getState()).settings.theme.active,viewport:[innerWidth,innerHeight],canvases:document.querySelectorAll('canvas').length,scrolled:[...document.querySelectorAll('*')].filter(e=>e.scrollTop>0).map(e=>({className:e.className,scrollTop:e.scrollTop}))}})()''')
name=sys.argv[1]
data['fullCanvasImages']=call('eval','''(async()=>{const shell=document.querySelector('.app-shell');const previous=shell.dataset.transcriptStyle;shell.dataset.transcriptStyle='benchmark-full-sky';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const images=[...document.querySelectorAll('canvas')].map(c=>c.toDataURL('image/png'));shell.dataset.transcriptStyle=previous;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return images})()''')
(base/'reference'/f'{name}.json').write_text(json.dumps(data,indent=2))
call('screenshot',str(base/'reference'/f'{name}-electron.png'))
assetdir=base/'reference'/'assets';assetdir.mkdir(exist_ok=True)
for p in pathlib.Path('/tmp/strata-t3-design-v2-app/out/renderer/assets').iterdir():
 if p.suffix in ['.css','.woff2','.woff','.png','.svg','.jpg']:shutil.copy2(p,assetdir/p.name)
print(name,{'htmlBytes':len(data['html']),'theme':data['theme']['name'],'canvases':data['canvases'],'scrolled':data['scrolled']})
