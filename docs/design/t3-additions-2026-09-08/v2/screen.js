const params = new URLSearchParams(location.search);
const flow = DESIGN.flows.find(f => f.id === params.get('flow')) || DESIGN.flows[0];
const state = flow.states.find(s => s[0] === params.get('state'))?.[0] || flow.states[0][0];
const mode = params.get('mode') || 'proposed';
window.benchmark = {ready:false, flow:flow.id, state, mode, viewport:[1440,1000], theme:'Strata', changes:[]};
const source = window.Proposals.source(flow.id,state);
window.benchmark.source = source;
async function start() {
  const response = await fetch(`reference/${source}.json`);
  if(!response.ok) throw Error(`Reference ${source} could not load (${response.status})`);
  const data = await response.json();
  for(const [key,value] of data.htmlAttrs) document.documentElement.setAttribute(key,value);
  for(const [key,value] of data.bodyAttrs) document.body.setAttribute(key,value);
  document.body.innerHTML = data.html.replaceAll('app://stratamd/assets/','reference/assets/').replaceAll('strata-visual://evidence/e_1198b109-0b77-4fb5-b003-4f9e3a84411c','reference/inspection-capture.png').replace(/strata-visual:\/\/staged\/[^"\s]+/g,'reference/inspection-capture.png');
  const hole = document.querySelector('.preview-hole');
  // Electron paints its browser in a separate WebContentsView. The export uses
  // the same fixture URL in an iframe occupying that exact native view slot.
  if(hole && source === 'preview') {
    const frame = document.createElement('iframe'); frame.src='reference/inspection-page.html'; frame.title='Inspection page';
    frame.style.cssText='width:100%;height:100%;border:0;display:block;background:white;color-scheme:light';hole.append(frame);
  }
  await Promise.all([...document.querySelectorAll('canvas')].map((canvas,i)=>new Promise((resolve,reject)=>{
    const img=new Image();img.onload=()=>{canvas.getContext('2d').drawImage(img,0,0);resolve()};img.onerror=reject;img.src=(data.fullCanvasImages||data.canvasImages)[i];
  })));
  // Force layout before awaiting font loads. A DOM export can otherwise report
  // fonts.ready before the browser has discovered weights used by the sidebar.
  document.body.getBoundingClientRect();
  await Promise.all([...new Set([...document.querySelectorAll('*')].map(el=>{
    const s=getComputedStyle(el);return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  }))].map(font=>document.fonts.load(font).catch(()=>[])));
  await document.fonts.ready;
  await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve})));
  if(mode!=='baseline') await Proposals.render(flow.id,state);
  document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',e=>e.preventDefault()));
  document.addEventListener('click',event=>{
    const action=event.target.closest('[data-go]'); if(!action)return;
    const [nextFlow,nextState]=action.dataset.go.includes('/')?action.dataset.go.split('/'):[flow.id,action.dataset.go];
    parent.postMessage({type:'strata-mockup-state',flow:nextFlow,state:nextState},location.origin);
    if(parent===window)location.search=`?flow=${nextFlow}&state=${nextState}&mode=${mode}`;
  });
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const changes = [...document.querySelectorAll('[data-change]')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height}).map((el,i)=>{
    const r=el.getBoundingClientRect();el.dataset.changeId=String(i+1);
    return {number:i+1,label:el.dataset.change,selector:`[data-change-id="${i+1}"]`,x:r.x,y:r.y,width:r.width,height:r.height};
  });
  window.benchmark.changes=changes;
  window.benchmark.scrollPositions=[...document.querySelectorAll('*')].filter(e=>e.scrollTop>0).map(e=>({className:e.className,scrollTop:e.scrollTop}));
  if(mode==='annotated') {
    const overlay=document.createElement('div');overlay.className='benchmark-overlay';overlay.setAttribute('aria-hidden','true');
    changes.forEach(c=>{const box=document.createElement('div');box.className='benchmark-highlight';box.style.cssText=`left:${c.x-3}px;top:${c.y-3}px;width:${c.width+6}px;height:${c.height+6}px`;box.innerHTML=`<b>${c.number}</b>`;overlay.append(box)});
    document.body.append(overlay);
  }
  window.benchmark.ready=true;
  parent.postMessage({type:'strata-mockup-ready',...window.benchmark},location.origin);
}
start().catch(error=>{document.body.innerHTML='<p style="padding:30px;color:white">This benchmark could not load. Reload the gallery.</p>';window.benchmark.error=String(error);parent.postMessage({type:'strata-mockup-error',error:String(error)},location.origin);console.error(error)});
