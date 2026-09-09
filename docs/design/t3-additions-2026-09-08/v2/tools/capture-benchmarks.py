"""Capture the static review renderer through agent-browser; no product writes."""
import json, pathlib, subprocess, sys, hashlib, datetime
from PIL import Image
import numpy as np

base=pathlib.Path(__file__).resolve().parents[1]
repo=base.parents[3]
cli=['agent-browser','--session','strata-v2-gallery','--json']
def call(*args):
    p=subprocess.run(cli+list(args),capture_output=True,text=True,check=True)
    r=json.loads(p.stdout)
    if not r['success']:raise RuntimeError(r)
    return r['data'].get('result',r['data'])
def load(flow,state,mode):
    call('open',f'http://127.0.0.1:43871/v2/screen.html?flow={flow}&state={state}&mode={mode}')
    call('wait','--fn','window.benchmark?.ready || window.benchmark?.error')
    result=call('eval','window.benchmark')
    if result.get('error'):raise RuntimeError(result['error'])
    return result
def rects(selectors):
    return call('eval','(()=>{const selectors='+json.dumps(selectors)+';return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].map(e=>({selector,...e.getBoundingClientRect().toJSON()}))).filter(r=>r.width&&r.height)})()')
def screenshot(path):call('screenshot',str(path))
def pixels(path):return np.array(Image.open(path).convert('RGB'))
def compare(a,b,regions=()):
    x,y=pixels(a),pixels(b)
    if x.shape!=y.shape:raise RuntimeError('Viewport mismatch')
    mask=np.ones(x.shape[:2],dtype=bool)
    for r in regions:
        pad=36
        mask[max(0,int(r['y'])-pad):min(1000,int(r['y']+r['height'])+pad+1),max(0,int(r['x'])-pad):min(1440,int(r['x']+r['width'])+pad+1)]=False
    delta=np.max(np.abs(x.astype(np.int16)-y.astype(np.int16)),axis=2)
    return {'comparedPixels':int(mask.sum()),'differentPixels':int(np.sum((delta>0)&mask)),'pixelsOverTolerance2':int(np.sum((delta>2)&mask)),'maxChannelDifference':int(delta[mask].max()) if mask.any() else 0}

data=json.loads(subprocess.run(['node','-e',"global.window={};eval(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(window.DESIGN))",str(base.parent/'data.js')],capture_output=True,text=True,check=True).stdout)
flow_filter=set(sys.argv[1:])
(base/'captures').mkdir(exist_ok=True);(base/'specifications').mkdir(exist_ok=True)
call('set','viewport','1440','1000')
sources={}
owner_review_path=base/'owner-review.json'
owner_review=json.loads(owner_review_path.read_text()).get('review',{}) if owner_review_path.exists() else {}
components={
 'questions':['Conversation.tsx','ConversationComposer.tsx','SetupDialog.tsx'], 'files':['Conversation.tsx','ConversationComposer.tsx','PreviewWindow.tsx'],
 'usage':['AccountsDialog.tsx'], 'compact':['Conversation.tsx','ConversationComposer.tsx'], 'skills':['ConversationComposer.tsx'],
 'drafts':['ProjectsPanel.tsx','ConversationComposer.tsx'], 'defaults':['SettingsDialog.tsx','SetupDialog.tsx'], 'import':['SetupDialog.tsx','ProjectsPanel.tsx'],
 'evidence':['ConversationMessage.tsx','PreviewWindow.tsx'], 'capture':['VisualSession.tsx','ConversationComposer.tsx','SetupDialog.tsx'],
 'recovery':['EngineDialog.tsx','Conversation.tsx'], 'models':['ProviderModels.tsx','ProviderSetup.tsx']}
checks={
 'questions':['Hold keeps answers and answer files private until Send.','Dismiss appears only for optional questions.','Question file errors name the file and preserve the answer.'],
 'files':['Binary attachments retain their original bytes.','Preview is read only; HTML source and preview refer to the same file.','A send failure retains the message and files.'],
 'usage':['Unknown usage never appears as zero usage.','Stale reports show their age and retry action.','Reset confirmation appears only when the provider reports support and a credit.'],
 'compact':['Manual compact is disabled when unsupported.','Visible history and unsent content survive compaction.','Report token counts only when the engine provides them.'],
 'skills':['Selecting a skill changes the draft without sending.','Search handles an empty result.','Immediate commands are distinct from draft insertions.'],
 'drafts':['Draft marker coexists with Working and Needs input.','Reopening restores the draft and its files.','Discard removes only the message draft, not held answers or comments.'],
 'defaults':['Effective value and source appear together.','Project overrides affect only new conversations.','Conflicting saves require reloading the current settings.'],
 'import':['Import copies history without starting an agent.','Selected histories are grouped by project.','Retry skips successful imports and names unreadable sources.'],
 'evidence':['Open displays the saved media, not a dead remote path.','Transfers show progress only while transferring.','Retry preserves the source evidence and names the failed destination.'],
 'capture':['System-owned pickers and permissions remain native.','Captured window name and target conversation appear in review.','Hold precedes Send; text extraction is optional.'],
 'recovery':['Continuation defaults off.','Resume is announced only after engine confirmation.','History and drafts remain available through reconnect.','Feature 4 is internal performance work and adds no visual control.'],
 'models':['Display name does not replace the provider model ID.','Only reported supported options are editable.','Unknown existing options survive saving.','Invalid values prevent saving.']}

for flow in data['flows']:
    if flow_filter and flow['id'] not in flow_filter:continue
    for state,label in flow['states']:
        key=f"{flow['id']}-{state}"
        base_info=load(flow['id'],state,'baseline');source=base_info['source']
        if source not in sources:
            screenshot(base/'captures'/f'baseline-{source}.png')
            native=rects(['.preview-hole']) if source=='preview' else []
            sources[source]=compare(base/'reference'/f'{source}-electron.png',base/'captures'/f'baseline-{source}.png',native)
            if native:
                sources[source]['scope']='Strata chrome; CDP parent capture omits native WebContentsView. Content verified separately.'
                call('screenshot','.preview-hole',str(base/'reference'/'preview-iframe.png'))
                a,b=pixels(base/'reference'/'inspection-capture.png'),pixels(base/'reference'/'preview-iframe.png')
                delta=np.max(np.abs(a.astype(np.int16)-b.astype(np.int16)),axis=2)
                sources[source]['nativeContentComparison']={'size':[a.shape[1],a.shape[0]],'interiorDifferentPixels':int(np.sum(delta[:-24]>0)),'excluded':'Bottom 24px where the Strata preview clips rounded corners.'}
        if flow['id'] in ['usage','defaults','import','models'] or (flow['id']=='recovery' and state=='setting') or (flow['id']=='capture' and source=='settings'):
            affected=['.modal']
        elif source=='preview':affected=['.preview-window']
        elif source=='image-annotation':affected=['.visual-card']
        elif flow['id']=='drafts':affected=['.project-thread[data-lifecycle="active"]','.chat-composer']+(['.conversation-messages'] if state=='opened' else [])
        else:affected=['.conversation-messages','.chat-composer']
        if flow['id']=='questions' and state in ['asking','blocking','upload-error']:affected+=['.modal-backdrop']
        if flow['id']=='recovery' and state=='reconnecting':affected+=['[aria-label="Engine status"]']
        baseline_rects=rects(affected)
        info=load(flow['id'],state,'proposed')
        after_rects=rects(affected+['.proposal-menu'])
        screenshot(base/'captures'/f'{key}-proposed.png')
        invariance=compare(base/'captures'/f'baseline-{source}.png',base/'captures'/f'{key}-proposed.png',baseline_rects+after_rects)
        health=call('eval','''(()=>{const visible=e=>!!e.getBoundingClientRect().width;return {brokenImages:[...document.images].filter(e=>visible(e)&&(!e.complete||!e.naturalWidth)).map(e=>e.src),offscreenChanges:window.benchmark.changes.filter(r=>r.width&&r.height&&(r.x<0||r.y<0||r.x+r.width>innerWidth+1||r.y+r.height>innerHeight+1)),bodyOverflow:document.body.scrollWidth>innerWidth}})()''')
        load(flow['id'],state,'annotated');screenshot(base/'captures'/f'{key}-annotated.png')
        prior_spec=base/'specifications'/f'{key}.json'
        source_commit=json.loads(prior_spec.read_text())['sourceCommit'] if prior_spec.exists() else subprocess.run(['git','rev-parse','HEAD'],cwd=repo,capture_output=True,text=True,check=True).stdout.strip()
        review=owner_review.get(flow['id'],{})
        spec={**info,'title':label,'features':flow['features'],'approval':review.get('status','pending'),'ownerReviewNotes':review.get('notes',''),'sourceCommit':source_commit,
              'sourceComponents':[f'src/renderer/components/{c}' for c in components[flow['id']]],'behaviorChecks':checks[flow['id']],
              'baseline':f'captures/baseline-{source}.png','proposed':f'captures/{key}-proposed.png','annotated':f'captures/{key}-annotated.png',
              'layoutImpactSelectors':affected,'layoutImpactBounds':baseline_rects+after_rects,'invarianceOutsideLayoutImpact':invariance,'renderHealth':health}
        (base/'specifications'/f'{key}.json').write_text(json.dumps(spec,indent=2))
        print(key, 'outside pixels > 2:',invariance['pixelsOverTolerance2'],'health:',health,flush=True)

previous={}
record=base/'verification.json'
if record.exists():previous=json.loads(record.read_text()).get('baselineFidelity',{})
previous.update(sources)
specs=[json.loads(p.read_text()) for p in sorted((base/'specifications').glob('*.json')) if p.name!='engine-efficiency.json']
inputs={str(p.relative_to(base)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [base/'screen.html',base/'screen.js',base/'proposals.js',base/'proposals.css',*sorted((base/'reference').glob('*.json')),*sorted((base/'reference/assets').glob('*'))]}
inputs['../data.js']=hashlib.sha256((base.parent/'data.js').read_bytes()).hexdigest()
record.write_text(json.dumps({'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'viewport':[1440,1000],'deviceScaleFactor':1,'theme':'Strata','themeStorageId':'strata-night','states':len(specs),'features':15,'baselineFidelity':previous,'inputHashes':inputs,'outsideImpactFailures':[f"{s['flow']}-{s['state']}" for s in specs if s['invarianceOutsideLayoutImpact']['pixelsOverTolerance2']],'renderFailures':[f"{s['flow']}-{s['state']}" for s in specs if s['renderHealth']['brokenImages'] or s['renderHealth']['offscreenChanges'] or s['renderHealth']['bodyOverflow']]},indent=2))
print('Verification written:',len(specs),'states',flush=True)
