const $ = s=>document.querySelector(s);
const query = new URLSearchParams(location.search);
let flow = DESIGN.flows.find(f=>f.id===query.get('flow')) || DESIGN.flows[0];
let state = flow.states.find(s=>s[0]===query.get('state'))?.[0] || flow.states[0][0];
let mode = ['baseline','proposed','annotated'].includes(query.get('mode')) ? query.get('mode') : 'annotated';
let saved = {};try{saved=JSON.parse(localStorage.getItem('strata-t3-review-v2')||'{}')}catch{}
const components={questions:['Conversation.tsx','ConversationComposer.tsx'],files:['Conversation.tsx','PreviewWindow.tsx'],usage:['AccountsDialog.tsx'],compact:['Conversation.tsx','ConversationComposer.tsx'],skills:['ConversationComposer.tsx'],drafts:['ProjectsPanel.tsx','ConversationComposer.tsx'],defaults:['SettingsDialog.tsx','SetupDialog.tsx'],import:['SetupDialog.tsx','ProjectsPanel.tsx'],evidence:['Conversation.tsx','PreviewWindow.tsx'],capture:['PreviewWindow.tsx','VisualSession.tsx','SetupDialog.tsx'],recovery:['EngineDialog.tsx','Conversation.tsx'],models:['ProviderModels.tsx','ProviderSetup.tsx']};
function scale(){const width=$('.viewport-scroll').clientWidth;const value=$('#actual-size').checked?1:Math.min(1,width/1440);$('#screen').style.transform=`scale(${value})`;$('.viewport-size').style.width=1440*value+'px';$('.viewport-size').style.height=1000*value+'px';$('#scale').textContent=Math.round(value*100)+'%';}
function navigate(nextFlow,nextState,nextMode=mode){flow=DESIGN.flows.find(f=>f.id===nextFlow)||flow;state=flow.states.find(s=>s[0]===nextState)?.[0]||flow.states[0][0];mode=nextMode;history.replaceState(null,'',`?flow=${flow.id}&state=${state}&mode=${mode}`);render();}
function approval(){const s=saved[flow.id]?.status||'pending';$('#approval-status').textContent={pending:'Pending review',approved:'Marked approved',changes:'Needs changes'}[s];$('#approval-status').dataset.status=s;}
function render(){
  $('#flows').innerHTML=DESIGN.flows.map(f=>`<button data-flow="${f.id}" ${flow.id===f.id?'aria-current="page"':''}><span>${f.number}</span>${f.short}</button>`).join('');
  $('#feature-numbers').textContent=flow.features.map(n=>`Feature ${n}`).join(' + ');
  $('#title').textContent=flow.title;$('#intro').textContent=flow.intro;$('#decision').textContent=flow.decision;$('#reuse').textContent=flow.reuse;
  $('#states').innerHTML=flow.states.map(([id,name])=>`<button role="tab" aria-selected="${id===state}" data-state="${id}">${name}</button>`).join('');
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  const url=`screen.html?flow=${flow.id}&state=${state}&mode=${mode}`;$('#screen').src=url;$('#open-screen').href=url;
  $('#clean-png').href=`captures/${flow.id}-${state}-proposed.png`;$('#annotated-png').href=`captures/${flow.id}-${state}-annotated.png`;$('#state-spec').href=`specifications/${flow.id}-${state}.json`;
  $('#load-status').hidden=false;$('#load-status').textContent='Loading current Strata components…';$('#changes').innerHTML='';$('#baseline-note').hidden=mode!=='baseline';
  $('#component-links').innerHTML=(components[flow.id]||[]).map(c=>`<span>${c}</span>`).join('');
  $('#feedback').value=saved[flow.id]?.notes||'';$('#review-save').textContent='';approval();scale();
}
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.flow)navigate(b.dataset.flow);if(b.dataset.state)navigate(flow.id,b.dataset.state);if(b.dataset.mode)navigate(flow.id,state,b.dataset.mode)});
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==$('#screen').contentWindow)return;
  if(event.data.type==='strata-mockup-state'){navigate(event.data.flow,event.data.state);return;}
  if(event.data.type==='strata-mockup-error'){$('#load-status').textContent=event.data.error;return;}
  if(event.data.type==='strata-mockup-ready'){
    $('#load-status').hidden=true;$('#baseline-png').href=`captures/baseline-${event.data.source}.png`;
    $('#changes').innerHTML=event.data.changes.map(c=>`<li>${c.label}</li>`).join('');
    if(mode!=='baseline'&&!event.data.changes.length)$('#changes').innerHTML='<li>No visible control changes in this state.</li>';
  }
});
function save(status){saved[flow.id]={status:status||saved[flow.id]?.status||'pending',notes:$('#feedback').value};localStorage.setItem('strata-t3-review-v2',JSON.stringify(saved));$('#review-save').textContent='Saved in this browser';approval();}
$('#feedback').addEventListener('input',()=>save());$('#approve').addEventListener('click',()=>save('approved'));$('#needs-changes').addEventListener('click',()=>save('changes'));
$('#copy-review').addEventListener('click',async()=>{const text='Strata T3 mockup review · revision 2\n\n'+DESIGN.flows.map(f=>`${f.number}. ${f.short}: ${saved[f.id]?.status||'pending'}\n${saved[f.id]?.notes||'No notes yet.'}`).join('\n\n');try{await navigator.clipboard.writeText(text);$('#review-save').textContent='Review notes copied'}catch{$('#review-save').textContent='Clipboard unavailable. Select and copy the notes.';$('#feedback').value=text}});
$('#actual-size').addEventListener('change',scale);new ResizeObserver(scale).observe($('.viewport-scroll'));render();
