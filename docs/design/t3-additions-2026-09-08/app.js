/* Standalone review prototype. All people, files, limits, and actions are sample data. */
const D = window.DESIGN;
const $ = (s, root = document) => root.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 message:'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2 1.5-6A8.5 8.5 0 1 1 21 11.5Z M7 9h9 M7 13h6',
 file:'M14 2H5v20h14V7l-5-5Z M14 2v6h5 M8 12h8 M8 16h6',
 gauge:'M4 18a10 10 0 1 1 16 0 M12 12l5-5 M5 13h1 M7 6l1 1 M12 3v2 M18 12h2',
 compress:'M8 3v5H3 M8 8 2 2 M16 3v5h5 M16 8l6-6 M3 16h5v5 M8 16l-6 6 M16 21v-5h5 M16 16l6 6',
 spark:'m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z',
 pen:'m16 3 5 5-12 12-6 1 1-6L16 3Z M13 6l5 5',
 sliders:'M4 3v6 M4 15v6 M12 3v11 M12 20v1 M20 3v1 M20 10v11 M1 9h6v6H1V9Z M9 14h6v6H9v-6Z M17 4h6v6h-6V4Z',
 import:'M3 4h6 M3 4v17h18V4h-6 M12 2v12 M7 9l5 5 5-5',
 image:'M3 3h18v18H3V3Z m0 14 6-6 7 7 3-3 2 2 M16 7h.01',
 capture:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M7 7h10v10H7V7Z',
 refresh:'M20 7a9 9 0 0 0-16-1 M3 2v5h5 M4 17a9 9 0 0 0 16 1 M21 22v-5h-5',
 bot:'M5 8h14v12H5V8Z M9 12v2 M15 12v2 M9 17h6 M12 8V3 M10 3h4 M2 11v6 M22 11v6',
 search:'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
 chevron:'m9 5 7 7-7 7', down:'m6 9 6 6 6-6', back:'m15 5-7 7 7 7',
 check:'m5 12 4 4L19 6', x:'m6 6 12 12 M18 6 6 18', plus:'M12 4v16 M4 12h16',
 folder:'M3 5h7l2 3h9v12H3V5Z', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
 arrow:'M12 20V4 M5 11l7-7 7 7', link:'M10 8l3-3a4 4 0 0 1 6 6l-3 3 M14 16l-3 3a4 4 0 0 1-6-6l3-3 M8 16l8-8',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 7v5l3 2',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 11v6 M12 7h.01',
 alert:'m12 3 10 18H2L12 3Z M12 9v5 M12 17h.01',
 paperclip:'m9 13 7-7a3 3 0 0 1 4 4L10 20a5 5 0 0 1-7-7L13 3 M6 15l10-10',
 play:'m8 4 12 8-12 8V4Z', stop:'M5 5h14v14H5V5Z', eye:'M2 12c5-10 15-10 20 0-5 10-15 10-20 0Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
 monitor:'M2 3h20v14H2V3Z M8 22h8 M12 17v5', lock:'M6 10h12v11H6V10Z M8 10V6a4 4 0 0 1 8 0v4',
 star:'m12 2 3 7 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1 3-7Z', more:'M5 12h.01 M12 12h.01 M19 12h.01',
 download:'M12 3v12 M7 10l5 5 5-5 M3 16v5h18v-5', terminal:'m4 5 6 6-6 6 M13 18h7', copy:'M8 8h13v13H8V8Z M16 5V2H2v14h3',
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
let params, flow, state;
let theme = localStorage.getItem('t3-design-theme') || 'vivid';
let notesOpen = false;
let answers = {choice:'Free roof inspection', text:'Keep the CTA direct. Use this example for the tone.'};
let skillsQuery = '';
let modelName = 'Deep review';
let importSelected = new Set(['landing','roof','theme','draft']);
let sourceSelected = new Set(['codex','claude']);
let captureText = 'Make the inspection button more prominent. Keep the headline as it is.';
let continuation = false;
let captureEnabled = false;
let toastTimer;
const btn = (label, dest, style='', ico='') => `<button class="btn ${style}" ${dest ? `data-go="${dest}"` : 'data-demo="This existing control is outside this flow."'}>${ico ? icon(ico) : ''}${label}</button>`;
const action = (label, name, style='', ico='') => `<button class="btn ${style}" data-action="${name}">${ico ? icon(ico) : ''}${label}</button>`;
const badge = (label, type='', ico='') => `<span class="badge ${type}">${ico ? icon(ico) : ''}${label}</span>`;
const notice = (title, text, type='') => `<div class="notice ${type}">${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info')}<div><strong>${title}</strong>${text ? `<span>${text}</span>` : ''}</div></div>`;
function go(id, next) {
  const url = new URL(location.href);
  if (!id || id === 'home') { url.searchParams.delete('flow'); url.searchParams.delete('state'); }
  else { url.searchParams.set('flow',id); url.searchParams.set('state',next || D.flows.find(f=>f.id===id)?.states[0][0] || ''); }
  history.pushState({},'',url); render();
}
window.designGo = go;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('#toast').classList.remove('visible'),3400); }
function route() {
  params = new URLSearchParams(location.search);
  flow = D.flows.find(f => f.id === params.get('flow'));
  state = flow?.states.find(s=>s[0]===params.get('state'))?.[0] || flow?.states[0][0];
  document.body.dataset.theme = theme;
  document.body.classList.toggle('capture-mode',params.has('capture') && !!flow);
}
function reviewBar() {
  return `<header class="review-bar"><div class="review-brand"><img src="assets/stratamd-icon.svg" alt=""><div><strong>Strata design review</strong><small>Mockup · sample data · no agent calls</small></div></div><button class="review-home" data-go="home">Overview</button>${flow ? `<select aria-label="Choose design flow" id="flow-select">${D.flows.map(f=>`<option value="${f.id}" ${flow.id===f.id?'selected':''}>${f.number} · ${f.short}</option>`).join('')}</select><span class="flow-count">${Number(flow.number)} / 12</span><button data-action="previous" aria-label="Previous flow">${icon('back')}</button><button data-action="next" aria-label="Next flow">${icon('chevron')}</button>` : '<span class="flow-count">Review edition 01</span>'}<span class="spacer"></span><select id="theme-select" aria-label="Preview theme">${[['vivid','Strata Vivid'],['night','Strata Night'],['light','Strata Light']].map(([id,label])=>`<option value="${id}" ${theme===id?'selected':''}>${label}</option>`).join('')}</select>${flow?`<button data-action="notes">${icon('pen')} <span class="notes-label">Review notes</span></button>`:''}</header>${flow ? `<nav class="state-bar" aria-label="Mockup states"><span>States</span>${flow.states.map(([id,label])=>`<button data-go="${flow.id}/${id}" aria-pressed="${state===id}">${label}</button>`).join('')}</nav>`:''}`;
}
function gallery() {
 return `<section class="gallery"><div class="gallery-intro"><p class="eyebrow">T3 additions · proposed Strata experience</p><h1>Fifteen additions.<br>One familiar Strata.</h1><p>Review the new controls in the conversations, dialogs, and document tabs you already use. Each flow has a working mockup and selectable waiting, failure, and recovery states.</p></div><div class="gallery-summary"><span><strong>15</strong> additions covered</span><span><strong>12</strong> flows to review</span><span><strong>${D.flows.reduce((n,f)=>n+f.states.length,0)}</strong> screen states</span><span class="spacer"></span>${badge('Awaiting your review','amber')}</div><div class="gallery-grid">${D.flows.map(f=>`<button class="flow-card" data-go="${f.id}/${f.states[0][0]}"><div class="row between"><span class="card-icon">${icon(f.icon)}</span><span class="subtle">${f.number}</span></div><h3>${f.title}</h3><p>${f.intro}</p><div class="card-bottom"><span>Features ${f.features.join(' + ')} · ${f.states.length} states</span><span>Review ${icon('chevron')}</span></div></button>`).join('')}</div><div class="gallery-footer"><p>Start with Questions, Files, and Usage. These establish the shared patterns used in the remaining flows.</p><p><a href="ui-inventory.html" target="_blank">UI inventory and design decisions</a> · <a href="review-guide.html" target="_blank">Screenshot review guide</a></p><p>This gallery is a design artifact. Buttons simulate sample flows. Review notes stay in this browser until you copy them.</p></div></section>`;
}
function sidebar() {
 const draftFlow = flow.id==='drafts';
 const item = (title, selected=false, mark='', target='drafts/opened', time='') => `<button class="thread-row ${selected?'selected':''}" data-go="${target}" title="${esc(title)}${mark==='draft'?' · Unsent draft':''}">${mark==='working'?'<i class="dot purple" aria-label="Working"></i>':mark==='input'?'<i class="dot amber" aria-label="Needs input"></i>':''}<span class="thread-name">${title}</span>${mark==='draft'||(draftFlow && mark==='working')?`<span class="draft-dot" aria-label="Unsent draft">${icon('pen')}</span>`:''}${time?`<time>${time}</time>`:''}</button>`;
 return `<aside class="island projects"><div class="projects-title">Projects</div><div class="projects-inner"><button class="search-pill" data-demo="Project search uses Strata’s existing search.">${icon('search')} Search conversations <kbd>⌘ K</kbd></button><div class="project-head">${icon('down')}${icon('folder')} Sandflat Roofing<button aria-label="New conversation" data-demo="New conversations inherit the project defaults shown in flow 07.">+</button></div>${item('September landing page',!draftFlow || state==='markers','working','questions/asking','now')}${item('Review campaign copy',draftFlow&&state!=='markers','draft','drafts/opened')}${item('Fall service pages',false,'input','questions/blocking')}${item('Customer interview notes',false,'','files/attached','1d')}<div class="project-head">${icon('down')}${icon('folder')} StrataMD<button aria-label="New StrataMD conversation" data-go="defaults/project">+</button></div>${item('Theme adjustments',false,'draft','drafts/opened')}${item('Reading experience',false,'','compact/ready','2d')}<div class="project-head">${icon('chevron')}${icon('folder')} Research <span class="spacer"></span><small class="subtle">3</small></div><div class="shelf"><span>Archived</span><span>18</span></div></div><div class="projects-foot"><button class="text-button" data-go="import/sources">${icon('import')} Import existing work</button><button class="text-button" data-go="defaults/project">${icon('sliders')} Project settings</button><button class="text-button" data-go="usage/accounts">${icon('gauge')} Usage limits</button></div></aside>`;
}
function shell(center, options={}) {
 const viewer = options.viewer;
 return `<div class="app"><header class="topbar"><span class="brand-pill"><img src="assets/stratamd-icon.svg" alt="Strata">StrataMD</span><button class="top-tab" data-go="files/attached">Docs <span>2</span></button><button class="top-tab" data-go="questions/asking">Conversations <span>4</span></button><button class="top-tab active" data-go="${viewer?'files/attached':'questions/asking'}">${icon(viewer?'file':'message')} ${viewer || 'September landing page'}</button><span class="spacer"></span><button class="btn ghost engine-status" data-go="recovery/setting"><i class="dot ${flow.id==='recovery'&&state==='reconnecting'?'amber':''}"></i> ${flow.id==='recovery'&&state==='reconnecting'?'Reconnecting':'Local engine'}</button><button class="btn icon-only ghost" aria-label="Settings" data-go="defaults/computer">${icon('settings')}</button><span class="window-controls" aria-hidden="true">− <span>□</span> ×</span></header><div class="app-content">${sidebar()}${center}${options.rail||''}</div>${options.modal||''}</div>`;
}
function panelHeader(title='Review September landing page', kind='Conversation') {
 return `<header class="panel-header"><span class="crumb">${kind}</span><span class="title">${title}</span><div class="header-actions"><span class="bot-cluster">${icon('bot')}</span><button class="btn ghost" data-go="evidence/preview">Preview ${icon('eye')}</button><button class="btn icon-only ghost" aria-label="Conversation options" data-go="recovery/setting">${icon('more')}</button></div></header>`;
}
const assistantMeta = () => `<div class="message-meta"><span class="bot-cluster">${icon('bot')}</span><strong>Codex</strong><span>Deep review</span><span class="spacer"></span><span>11:42 AM</span></div>`;
function transcript(title='A clearer next step for the landing page', text='The page has a clear promise. I’m checking the headline, inspection offer, and mobile layout before proposing changes.') {
 return `<div class="owner-message">Review the September landing page. Keep the tone straightforward and show me what you’d change.</div>${assistantMeta()}<div class="assistant-prose"><h2>${title}</h2><p>${text}</p></div>`;
}
function attachment(name, meta, opts={}) {
 const ext = name.split('.').pop().toUpperCase();
 return `<div class="attachment-card ${opts.error?'error':''} ${opts.go?'file-preview-link':''}" ${opts.go?`role="button" tabindex="0" data-go="${opts.go}" aria-label="Preview ${esc(name)}"`:''}><span class="file-icon">${ext}</span><div class="file-info"><strong>${esc(name)}</strong><small>${meta}</small></div>${opts.remove?`<button data-action="remove-file" aria-label="Remove ${esc(name)}">${icon('x')}</button>`:opts.go?icon('eye'):''}</div>`;
}
function composer({text='',tray='',popover='',held='',send='demo-send',disabled=false,placeholder='Write a message or type / for commands…',context='38%'}={}) {
 return `<div class="composer-wrap"><div class="composer">${popover}${held?`<div class="held-chip">${icon('lock')}${held}</div>`:''}${tray?`<div class="composer-tray">${tray}</div>`:''}<textarea id="composer-text" aria-label="Message draft" placeholder="${placeholder}">${esc(text)}</textarea><div class="composer-footer"><button class="btn ghost" aria-label="Attach files" data-go="files/attached">${icon('plus')}</button><button class="btn ghost" data-go="models/list">${icon('bot')} Deep review ${icon('down')}</button><button class="btn ghost" data-demo="Sample conversation is using high reasoning effort.">High ${icon('down')}</button><button class="btn ghost" data-demo="Sample conversation allows workspace edits.">Workspace ${icon('down')}</button><span class="spacer"></span><button class="context-ring" data-go="compact/ready" aria-label="Context ${context}">${context}</button><button class="send-button" data-action="${send}" aria-label="Send message" ${disabled?'disabled':''}>${icon('arrow')}</button></div></div><div class="workspace-line">${icon('folder')} Sandflat Roofing <code>~/Projects/Sandflat</code><span class="spacer"></span>${icon('lock')} Held until Send</div></div>`;
}
function conversation(content, opts={}) {
 return shell(`<section class="island main-panel">${panelHeader(opts.title)}${opts.banner||''}<div class="conversation-body"><div class="conversation-copy">${content}</div></div>${composer(opts.composer)}</section>`,{modal:opts.modal});
}
function dialog(title, subtitle, body, footer='', size='') {
 const [backLabel,backTo]=title.startsWith('Import')?['Projects','questions/asking']:title==='Custom model'?['Provider models','models/list']:title==='Review window capture'?['Choose a window','capture/choose']:title.includes('capture')?['Window capture','capture/setup']:title==='Use a reset credit?'?['Usage limits','usage/accounts']:['Settings','defaults/computer'];
 return `<div class="modal-layer"><section class="dialog ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="dialog-header"><button class="btn icon-only ghost close" aria-label="Close dialog" data-go="questions/asking">${icon('x')}</button><button class="back-link" data-go="${backTo}">${icon('back')} ${backLabel}</button><h2>${title}</h2>${subtitle?`<p class="subtitle">${subtitle}</p>`:''}</header><div class="dialog-body">${body}</div><footer class="dialog-footer">${footer}</footer></section></div>`;
}
function dialogScreen(title, subtitle, body, footer='', size='') {
 return conversation(transcript(),{modal:dialog(title,subtitle,body,footer,size)});
}
function website({mini=false,marked=false}={}) {
 return `<div class="website ${mini?'mini':''}"><div class="webnav"><span class="webbrand">SANDFLAT<br><small>ROOFING</small></span><span>Our work</span><span>About us</span><span>Get in touch ↗</span></div><div class="webhero"><div><h1>A roof you can<br>stop thinking about.</h1><p>Honest advice. Careful work.<br>Roofing for the place you call home.</p><span class="webbutton">Book a free inspection ↗${marked?'<span class="annotation-ring"></span>':''}</span></div><div class="webart"></div></div><div class="webtrust"><span>Local crews</span><span>Clear estimates</span><span>Work that holds up</span></div></div>`;
}
function questions() {
 const done = ['held','sent','dismissed'].includes(state);
 const blocking = state==='blocking';
 let card;
 if(done) {
   const heading = state==='held'?'Answer held for your next Send':state==='sent'?'Answer sent':'Question dismissed';
   card = `<section class="question-card question-done"><div class="question-heading"><span>${icon(state==='held'?'lock':'check')} ${heading}</span>${badge(state==='held'?'Only you can see this':'11:44 AM',state==='held'?'':'green')}</div><h3>Which offer should lead the page?</h3>${state==='dismissed'?'<p class="muted">You dismissed this optional question. The agent can continue without an answer.</p>':`<p><strong>${esc(answers.choice)}</strong></p><p class="muted">${esc(answers.text)}</p><div class="attachment-tray">${attachment('cta-reference.png','Screenshot · attached to this answer')}</div>`}${state==='held'?`<div class="question-actions"><small>You can keep working before sending.</small>${btn('Edit answer','questions/asking','outline')}</div>`:''}</section>`;
 } else {
   card = `<section class="question-card"><div class="question-heading"><span>${icon('message')} A question for you</span>${badge(blocking?'Agent is waiting':'Agent is still working',blocking?'amber':'green')}</div><h3>Which offer should lead the page?</h3><div class="choices">${['Free roof inspection','Seasonal maintenance','No offer yet'].map(c=>`<button class="choice ${answers.choice===c?'selected':''}" data-choice="${c}">${c}</button>`).join('')}</div><label class="field"><span class="sr-only">Your answer</span><textarea id="answer-text" placeholder="Add a detail or write your own answer…">${esc(answers.text)}</textarea></label><div class="attachment-tray">${attachment('cta-reference.png',state==='upload-error'?'Could not prepare this image · retry':'128 KB · only you can see this',{error:state==='upload-error',remove:true})}${action('Attach file','question-attach','ghost','paperclip')}</div>${state==='upload-error'?notice('The image could not be attached.','Your written answer is saved. Retry the image or remove it to send.','error'):''}<div class="question-actions"><small>${blocking?'Send your answer to let the agent continue.':'This answer stays private until Send.'}</small>${!blocking?btn('Dismiss','questions/dismissed','ghost'):''}${action(state==='upload-error'?'Retry attachment':'Hold answer',state==='upload-error'?'retry-answer':'hold-answer','primary')}</div></section>`;
 }
 return conversation(transcript('One choice will help focus the page',blocking?'I need your choice before I can continue the revision. Hold your answer, then use Send when you’re ready.':'I can keep checking the layout while you decide which offer should lead.')+card+`<div class="work-line">${icon(blocking?'clock':state==='sent'?'check':'terminal')}${blocking?'Waiting for your answer':state==='sent'?'Applying your choice to the inspection section':'Checking the mobile spacing and page structure'}<code>2 files reviewed</code></div>`,{composer:{held:state==='held'?`<strong>1 answer held</strong> · 1 image ${btn('Review','questions/held','ghost')}`:'',send:state==='held'?'send-answer':'demo-send',text:state==='held'?'Use this direction for the first revision.':''}});
}
function files() {
 if(['pdf','html','source','file-error'].includes(state)) return fileViewer();
 const failed = state==='upload-error';
 return conversation(transcript('Send the source material with your direction','I’ll compare the inspection offer with the September results and keep the existing brand language.'),{composer:{text:'Use the September results and the site export to guide the revision.',tray:attachment('september-results.pdf',failed?'Send failed · local copy kept':'1.8 MB · local draft',{go:'files/pdf',error:failed,remove:true})+attachment('site-export.zip','4.2 MB · local draft',{remove:true})+attachment('landing-preview.html','38 KB · local draft',{go:'files/html',remove:true}),held:failed?`<strong>Files were not sent.</strong> Your draft is saved. ${action('Retry','retry-files','ghost')}`:`${icon('paperclip')} 3 files ready · 6.0 MB`,send:failed?'retry-files':'send-files'}});
}
function fileViewer() {
 const pdf = state==='pdf';
 const error = state==='file-error';
 const name = pdf||error?'september-results.pdf':'landing-preview.html';
 const canvas = error?`<div class="empty-box">${icon('file')}<h3>This file is no longer at its saved path.</h3><p>Strata could not open september-results.pdf in this conversation’s files folder.</p>${btn('Choose replacement','files/attached','primary','folder')}<p style="margin-top:15px;font-size:12px">Your conversation and other attachments are still available.</p></div>`:pdf?`<article class="pdf-page"><div class="pdf-brand">SANDFLAT ROOFING · MONTHLY REPORT</div><h1>More inspections.<br>Better conversations.</h1><div class="pdf-date">September 2026 · Marketing performance</div><div class="pdf-metrics"><div><strong>48</strong>inspection requests</div><div><strong>+24%</strong>qualified leads</div><div><strong>3.8%</strong>page conversion</div></div><h3>The inspection offer is working.</h3><p>Homeowners are responding to a clear next step. The free inspection offer generated more qualified conversations than the general contact form.</p><div class="pdf-chart">${[35,41,53,48,68,94].map(n=>`<i style="--height:${n}%"></i>`).join('')}</div><div class="row between" style="font-size:11px;color:#7c7e71"><span>April</span><span>September</span></div><h3>What to carry into October</h3><p>Keep the inspection offer visible near the top of the page. Support it with a short explanation of what happens after someone books.</p><p style="font-size:11px;margin-top:25px;color:#99998b">1 / 8 · Prepared for the Sandflat team</p></article>`:state==='source'?`<pre class="source-code"><span>&lt;!doctype html&gt;</span>
&lt;html lang="en"&gt;
  &lt;head&gt;
    &lt;title&gt;Sandflat Roofing&lt;/title&gt;
    &lt;meta name="viewport"
          content="width=device-width, initial-scale=1"&gt;
  &lt;/head&gt;
  &lt;body&gt;
    &lt;main&gt;
      &lt;h1&gt;A roof you can stop thinking about.&lt;/h1&gt;
      &lt;p&gt;Honest advice. Careful work.&lt;/p&gt;
      &lt;a href="/inspection"&gt;
        Book a free inspection
      &lt;/a&gt;
    &lt;/main&gt;
  &lt;/body&gt;
&lt;/html&gt;</pre>`:website();
 const controls = pdf?`${btn(icon('back'),'files/pdf','ghost')}<label>Page <input aria-label="PDF page" value="1" data-demo-input="page" inputmode="numeric"></label><span>of 8</span>${action(icon('chevron'),'pdf-next','ghost')}<span class="spacer"></span>${action('Fit width','pdf-fit','outline')}${action('100%','pdf-zoom','outline')}`:`<button class="btn ${state==='html'?'outline':'ghost'}" data-go="files/html">Preview</button><button class="btn ${state==='source'?'outline':'ghost'}" data-go="files/source">Source</button><span class="spacer"></span><span>Scripts disabled · external requests blocked</span>`;
 return shell(`<section class="island main-panel">${panelHeader(name,'Document')}<div class="viewer-toolbar">${error?'File unavailable':controls}<span class="badge">Read-only</span></div><div class="viewer-canvas">${canvas}</div><div class="viewer-foot">${icon('lock')} ${error?'Local attachment missing':pdf?'PDF · local draft · 1.8 MB':'HTML · static preview · 38 KB'}</div></section>`,{viewer:name,rail:`<aside class="island preview-rail"><h3>Attachment</h3><p>This file is held with your draft in <strong>September landing page</strong>.</p><p style="margin-top:13px">Return to the conversation to send it with your message.</p>${btn('Back to draft','files/attached','outline','back')}<div class="rail-meta"><strong>${name}</strong>${pdf?'8 pages · PDF document':'Local file preview'}<br>Only you can see this draft.</div></aside>`});
}
function quota(label, remaining, reset, pace=60) {
 return `<div class="quota-row"><span>${label}</span><div><div class="quota-label"><strong>${remaining}% remaining</strong><span>${100-remaining}% used</span></div><div class="quota-track ${remaining<25?'warning':''}" style="--pace:${pace}%"><div class="quota-fill" style="--value:${remaining}%"></div><i class="pace-line" title="Remaining time in this window"></i></div></div><div class="quota-reset">${reset}<span>${remaining<pace?'Above steady pace':'Below steady pace'}</span></div></div>`;
}
function usage() {
 if(state==='reset') return dialogScreen('Use a reset credit?','Codex · Personal account',`<div class="stack">${notice('Reset the current usage window','This account has 1 reset credit available. Using it restores this window’s quota and consumes the credit.')}<div class="account-box"><div class="row between"><h3>Current window</h3>${badge('18% remaining','amber')}</div><p class="muted">Scheduled reset in 42 minutes.</p></div><p class="muted">The provider confirms whether the credit can be used. Other account windows stay as reported.</p></div>`,`<small>Personal account</small>${btn('Cancel','usage/accounts','outline')}${action('Use 1 credit','use-credit','primary')}`,'narrow');
 const pool = state==='pooled';
 const stale = state==='stale';
 const unavailable=state==='unavailable';
 const body = `<div class="inline-tabs"><button aria-selected="${!pool}" data-go="usage/accounts">Accounts</button><button aria-selected="${pool}" data-go="usage/pooled">Combined</button></div>${stale?notice('Could not refresh usage.','Last reported 18 minutes ago. These limits may have changed. Your account selection is still available.','error'):''}${pool?`<div class="account-box"><div class="row between"><h3>Codex · 2 active accounts</h3>${badge('Combined view')}</div><div class="pool"><span style="--value:18%"></span><span style="--value:76%"></span></div><div class="row between"><span>Personal · 18%</span><strong>47% average remaining</strong><span>Work · 76%</span></div><p class="scope-note">This is the average of the reported percentages. It is not a shared token budget. Each account has its own window and reset time.</p>${btn('View account limits','usage/accounts','ghost','chevron')}</div>`:`<div class="section-label"><h3>Codex</h3><span>2 accounts connected</span></div><div class="account-box"><div class="account-identity"><span class="provider-mark">${icon('bot')}</span><div><h3>Personal <small>· ChatGPT Pro</small></h3><small>Selected for this conversation</small></div><span class="spacer"></span>${badge('In use','green')}${action('Park','park-account','outline')}</div>${unavailable?notice('Usage was not reported for this account.','You can still use it. Strata will show limits when the engine reports them.'):quota('5 hours',18,'Resets in 42m',14)+quota('Weekly',62,'Resets Fri, 9:00 AM',53)}<div class="row between" style="margin-top:14px"><small class="muted">${unavailable?'No usage data available':'1 reset credit available'}</small>${!unavailable?btn('Use reset credit…','usage/reset','ghost'):''}</div></div><div class="account-box"><div class="account-identity"><span class="provider-mark">${icon('bot')}</span><div><h3>Work <small>· ChatGPT Pro</small></h3><small>Available for automatic selection</small></div><span class="spacer"></span>${action('Use this account','choose-account','outline')}</div>${quota('5 hours',76,'Resets in 3h 20m',67)}</div>`}<div class="section-label"><h3>Claude</h3><span>1 account connected</span></div><div class="account-box"><div class="account-identity"><span class="provider-mark claude">✳</span><div><h3>Personal <small>· Max</small></h3><small>Available</small></div></div>${quota('5 hours',84,'Resets in 4h 10m',83)}</div><div class="row between"><small class="muted">A tick on each bar marks the share of time remaining.</small><label class="switch"><input type="checkbox" checked><span style="font-size:13px">Choose accounts automatically</span></label></div>`;
 return dialogScreen('Usage limits','Quota reported by your connected engine. Limits belong to each account.',body,`<small>${stale?'Last updated 18 minutes ago':'Updated just now'}</small>${btn('Refresh','usage/accounts','outline','refresh')}${btn('Done','questions/asking','primary')}`);
}
function compact() {
 const working=state==='working', done=state==='done', failed=state==='failed', unsupported=state==='unsupported';
 const pop = done?'':`<div class="context-popover"><div class="row between"><h3>${unsupported?'Context management':'Conversation context'}</h3>${badge(unsupported?'Unavailable':working?'Compacting':'84%',working?'':'amber')}</div><p>${unsupported?'This agent does not support manual compaction. It may manage context automatically.':working?'The agent is making a summary for its next turn. Your visible conversation stays here.':'This conversation is using most of the model’s context. Compact it to make room for more work.'}</p>${failed?`<div style="margin-top:12px">${notice('Could not compact context.','Your conversation is unchanged. Try again.','error')}</div>`:''}${working?'<div class="progress" style="--value:58%"><i></i></div><small class="muted">Waiting for the agent to finish</small>':unsupported?'<button class="btn outline" disabled>Compact context</button>':btn(failed?'Retry compaction':'Compact context','compact/working','primary','compress')}<p style="margin-top:12px;font-size:12px">Your messages and files remain in the transcript.</p></div>`;
 let content = transcript('The revised offer is ready to review','We’ve worked through the campaign, the page structure, and the inspection flow. I have the decisions I need for the next revision.');
 content += `<div class="assistant-prose"><h3>Keep the promise specific</h3><p>Use “Book a free inspection” as the main action. Put the explanation of what happens next directly underneath it.</p></div><div class="work-line">${icon('check')} Reviewed 18 files across this conversation <code>4 revisions</code></div>`;
 if(done) content += `<div class="context-result">${icon('compress')}<span><strong>Context compacted</strong><br>The agent’s working context was summarized. Earlier messages are still here.</span><code>84% → 29%</code></div>`;
 if(working) content += `<div class="work-line">${icon('refresh')} Compacting conversation context…</div>`;
 return conversation(content,{composer:{popover:pop,context:done?'29%':'84%',disabled:working,text:working?'When you’re ready, apply the changes to the hero.':''}});
}
const skills = [
 {name:'brand',description:'Keep copy and visuals consistent with your brand.',category:'Project skill'},
 {name:'customer-research',description:'Find the language customers use and what they need.',category:'Installed skill'},
 {name:'design',description:'Work on layout, typography, and visual direction.',category:'Installed skill'},
 {name:'ad-creative',description:'Draft and compare advertising copy.',category:'Installed skill'},
];
function commandMenu(query) {
 const clean=query.replace(/^\//,'').toLowerCase();
 const results=skills.filter(s=>(s.name+' '+s.description).includes(clean));
 return `<div class="command-popover" role="listbox" aria-label="Commands and skills">${!clean?`<h4>COMMANDS · OPEN ACTIONS</h4><button class="command-row" data-go="compact/ready">${icon('compress')}<span><strong>/compact</strong><small>Make room in the current conversation.</small></span>${badge('Opens context controls')}</button>`:''}<h4>SKILLS · INSERT INTO YOUR MESSAGE</h4>${results.length?results.map((s,i)=>`<button class="command-row ${i===0?'active':''}" role="option" aria-selected="${i===0}" data-skill="${s.name}">${icon('spark')}<span><strong>/${s.name}</strong><small>${s.description}</small></span>${badge(s.category)}</button>`).join(''):`<div class="empty-box" style="border:0;padding:18px"><h3>No matching skill</h3><p>Try another name. You can also send your message as written.</p></div>`}<div class="command-foot"><kbd>↑</kbd> <kbd>↓</kbd> to choose · <kbd>Enter</kbd> to insert · <kbd>Esc</kbd> to close · Skills run after Send</div></div>`;
}
function skillScreen() {
 const query=state==='empty'?'/invoice':state==='filtered'?'/brand':state==='inserted'?'':skillsQuery||'/';
 return conversation(transcript('Ready for the next revision','The inspection offer and page structure are in place. Choose a skill if you want a particular kind of help with the next pass.'),{composer:{text:state==='inserted'?`/${sessionStorage.getItem('t3-selected-skill')||'brand'} Review the inspection section and keep the tone direct.`:query,popover:state!=='inserted'?commandMenu(query):'',held:state==='inserted'?`${icon('spark')} Skill added to your draft. It runs when you Send.`:''}});
}
function drafts() {
 const opened=state!=='markers';
 const discard=state==='discard'?dialog('Discard this message draft?','Review campaign copy',`<div class="draft-callout"><p>Lead with the free inspection. Keep the warranty language lower on the page.</p><div class="row">${badge('1 attached file')}${badge('Saved 12 minutes ago')}</div></div><p class="muted">This removes the unsent message and its file from the composer. Your 2 held comments and the conversation history stay.</p>`,`${btn('Keep draft','drafts/opened','outline')}${action('Discard message','discard-draft','danger')}`,'narrow'):'';
 const content=transcript(opened?'The campaign copy is ready for another pass':'The inspection offer is ready to review',opened?'The revised copy puts the free inspection first. The warranty section now supports the offer without competing with it.':'The headline and main action now point to the free inspection. I’m checking the mobile layout before the next pass.');
 return conversation(content+(opened?'':`<div class="assistant-prose"><h3>Keep the next step clear</h3><p>Lead with the inspection, then explain what happens when a homeowner books. The details can follow lower on the page.</p></div><div class="work-line">${icon('terminal')} Checking the mobile layout</div>`),{title:opened?'Review campaign copy':undefined,modal:discard,composer:{text:opened?'Lead with the free inspection. Keep the warranty language lower on the page.':'Keep the main inspection offer above the fold.',held:opened?`<strong>2 comments held</strong><span class="spacer"></span>${btn('Discard message…','drafts/discard','ghost')}`:'',tray:opened?attachment('campaign-notes.pdf','84 KB · local draft',{go:'files/pdf',remove:true}):''}});
}
function settingRow(title,description,control){return `<div class="setting-row"><div class="setting-text"><h3>${title}</h3><p>${description}</p></div><div class="setting-control">${control}</div></div>`;}
function selectField(label,values,selected,attrs=''){return `<label class="field"><span class="sr-only">${label}</span><select aria-label="${label}" ${attrs}>${values.map(([v,l])=>`<option value="${v}" ${v===selected?'selected':''}>${l}</option>`).join('')}</select></label>`;}
function defaults() {
 const computer=state==='computer',override=['override','conflict'].includes(state),conflict=state==='conflict';
 const origin=(val,over=false)=>!computer?`<div class="inherited">${icon(over?'pen':'link')}${over?'Project override':`From Computer defaults · ${val}`}</div>`:'';
 const control=(label,values,value,over=false)=>selectField(label,values,value,`data-default-setting="${label}"`)+origin(values.find(v=>v[0]===value)?.[1],over);
 let body=`<div class="scope-row"><label for="scope-select">Apply to</label><select id="scope-select"><option value="computer" ${computer?'selected':''}>Computer defaults</option><option value="project" ${!computer?'selected':''}>Project · Sandflat Roofing</option></select>${badge(computer?'All projects':'Project settings')}</div>${conflict?notice('These settings changed in another window.','Your changes have been kept here. Review the current values before saving.','error'):''}`;
 body+=settingRow('Agent and model','Used when you create a new conversation in this scope.',control('Default model',[['deep','Codex · Deep review'],['claude','Claude · Sonnet'],['standard','Codex · Standard']],override?'claude':'deep',override));
 body+=settingRow('Reasoning effort','Use a supported level for the selected model.',control('Reasoning effort',[['high','High'],['medium','Medium'],['low','Low']],'high'));
 body+=settingRow('Working copy','Choose whether a new conversation uses the project folder or its own working copy.',control('Working copy',[['project','Use project folder'],['separate','Create separate working copy']],'project'));
 body+=settingRow('Permissions','The initial permission choice for a new conversation.',control('Permissions',[['workspace','Allow workspace edits'],['ask','Ask before changes']],'workspace'));
 body+=`<div class="scope-note">${computer?'Projects inherit these settings until you set an override.':'Change a value to create a project override. Resetting an override restores the current computer default.'} Existing conversations keep their settings.</div>${override?`<div class="row" style="margin-top:16px">${btn('Reset model to computer default','defaults/project','outline','refresh')}<small class="muted">1 project override</small></div>`:''}`;
 return dialogScreen('Conversation defaults','Set the starting choices for new work.',body,`<small>${computer?'Stored on this computer':override?'1 project override · other values inherited':'All values inherited'}</small>${btn('Cancel','questions/asking','outline')}${conflict?btn('Review current settings','defaults/project','primary'):action('Save defaults','save-defaults','primary')}`);
}
const importRows=[{id:'landing',title:'September landing page',provider:'Codex',date:'Today',project:'Sandflat Roofing'},{id:'roof',title:'Roof inspection offer',provider:'Claude',date:'Yesterday',project:'Sandflat Roofing'},{id:'theme',title:'Theme adjustments',provider:'Codex',date:'Sep 6',project:'StrataMD'},{id:'draft',title:'Draft persistence review',provider:'Claude',date:'Sep 5',project:'StrataMD'}];
function stepper(step) { return `<div class="stepper">${['Sources','Conversations','Import'].map((label,i)=>`${i?'<i class="step-sep"></i>':''}<span class="step ${i<step?'done':i===step?'active':''}" data-n="${i+1}">${label}</span>`).join('')}</div>`; }
function imports() {
 const stage=state==='sources'?0:state==='select'?1:2;
 let body=stepper(stage),footer;
 if(state==='sources') {
  body+=`<p class="muted" style="margin-bottom:18px">Choose the local accounts to look through. You’ll select conversations before anything is imported.</p>${[['codex','Codex · Personal','~/.codex','2 conversations in 2 projects'],['claude','Claude · Personal','~/.claude','2 conversations in 2 projects']].map(([id,name,path,count])=>`<label class="selection-card"><input type="checkbox" data-source="${id}" ${sourceSelected.has(id)?'checked':''}><span><strong>${name}</strong><code>${path}</code><small>${count}</small></span><span class="spacer"></span>${badge('Found locally','green')}</label>`).join('')}${notice('Import a copy of your history','The original conversations stay in their agent app. Importing does not start an agent or keep future messages in sync.')}`;
  footer=`<small id="source-count">${sourceSelected.size} sources selected</small>${btn('Cancel','questions/asking','outline')}${action('Find conversations','import-find','primary')}`;
 } else if(state==='select') {
  const rows=importRows.filter(r=>sourceSelected.has(r.provider.toLowerCase()));
  body+=`<div class="row between" style="margin-bottom:15px"><p class="muted">Choose the conversations to copy into Strata.</p>${action('Select all','import-select-all','ghost')}</div>${['Sandflat Roofing','StrataMD'].map(project=>`<div class="import-project"><label><input type="checkbox" data-project-select="${project}" ${rows.filter(r=>r.project===project).every(r=>importSelected.has(r.id))?'checked':''}><span>${icon('folder')} ${project}</span><small>${project==='StrataMD'?'Existing Strata project':'Match by folder'}</small></label>${rows.filter(r=>r.project===project).map(r=>`<label class="import-thread"><input type="checkbox" data-import-row="${r.id}" ${importSelected.has(r.id)?'checked':''}><span>${r.title}</span>${badge(r.provider)}<small>${r.date}</small></label>`).join('')}</div>`).join('')}<p class="scope-note">Conversations already imported are skipped. Project folders are matched before a new project is created.</p>`;
  footer=`<small id="import-count">${importSelected.size} conversations selected</small>${btn('Back','import/sources','outline')}${action('Review import','import-review','primary')}`;
 } else if(state==='confirm') {
  body+=`<div class="stack"><h3>Ready to import ${importSelected.size} conversations</h3><div class="account-box">${['Sandflat Roofing','StrataMD'].map(p=>`<div class="import-result">${icon('folder')} ${p}<small>${importRows.filter(r=>r.project===p&&importSelected.has(r.id)).length} conversations</small></div>`).join('')}</div>${notice('History will be copied into Strata','Existing project folders stay where they are. No agent work begins during import.')}<p class="muted">You can open an imported conversation and choose to continue it afterward. The original app will keep its own history.</p></div>`;
  footer=`${btn('Back','import/select','outline')}${btn(`Import ${importSelected.size} conversations`,'import/progress','primary','import')}`;
 } else if(state==='progress') {
  body+=`<div class="stack"><h3>Copying conversation history</h3><p class="muted">${Math.max(0,importSelected.size-1)} of ${importSelected.size} conversations imported</p><div class="progress" style="--value:75%"><i></i></div><div class="status-list"><div class="status-row">${icon('check')} Sandflat Roofing<small>History copied</small></div><div class="status-row">${icon('refresh')} StrataMD<small>Copying Draft persistence review…</small></div></div><p class="muted">You can keep using Strata while the import finishes.</p></div>`;
  footer=`<small>Importing in the background</small>${btn('Keep working','questions/asking','outline')}`;
 } else {
  const partial=state==='partial';
  body+=`<div class="stack">${notice(partial?'3 conversations imported. 1 needs another try.':'Your conversations are in Strata.',partial?'Draft persistence review could not be read from the selected Claude home. The other conversations are ready to open.':`${importSelected.size} conversations imported into 2 projects. No agent has been started.`,partial?'error':'success')}<div>${importRows.filter(r=>importSelected.has(r.id)).map(r=>`<div class="import-result">${icon(partial&&r.id==='draft'?'alert':'check')}<span>${r.title}</span><small>${partial&&r.id==='draft'?'Could not read history':'Imported'}</small></div>`).join('')}</div>${partial?`<small class="muted">Source · Claude Personal, ~/.claude<br>Retry only processes the conversation that failed. Successful imports are not duplicated.</small>`:`<p class="muted">Open a conversation to read the history. Choose an agent when you’re ready to continue the work.</p>`}</div>`;
  footer=`<small>Original history preserved</small>${partial?btn('Done for now','questions/asking','outline')+btn('Retry 1 conversation','import/done','primary','refresh'):btn('Open September landing page','questions/asking','primary')}`;
 }
 return dialogScreen('Import existing work','Bring conversations from your local agent apps into Strata.',body,footer);
}
function evidence() {
 if(state==='preview') return shell(`<section class="island main-panel">${panelHeader('Landing page · desktop','Evidence')}<div class="viewer-toolbar">${badge('Screenshot')}<span>Browser · localhost:5173</span><span class="spacer"></span>${action('Fit','evidence-fit','outline')}${btn('Mark up','capture/review','outline','pen')}</div><div class="viewer-canvas">${website()}</div><div class="viewer-foot">Saved in this conversation · captured today at 11:43 AM</div></section>`,{viewer:'Landing page · desktop',rail:`<aside class="island preview-rail"><h3>Evidence</h3><p>The agent captured this page while checking the inspection flow.</p><label class="field">Your note<textarea placeholder="Add a note about this screenshot…"></textarea></label>${action('Hold comment','evidence-comment','primary')}<div class="rail-meta"><strong>landing-desktop.png</strong>1440 × 1000 · 428 KB<br>${btn('Back to conversation','evidence/saved','ghost','back')}</div></aside>`});
 const transfer=state==='transfer',failed=state==='failed';
 const card=`<div class="evidence-card">${!transfer&&!failed?website({mini:true}):`<div class="empty-box" style="border:0;border-radius:0">${icon(failed?'alert':'play')}<h3>${failed?'Recording could not be copied':'Copying browser recording'}</h3><p>${failed?'The remote file is still available. Strata could not save the local copy.':'The recording is being saved to this conversation before you open it.'}</p>${transfer?'<div class="progress" style="--value:64%"><i></i></div><small>6.4 MB of 10 MB</small>':''}</div>`}<div class="evidence-info">${icon(transfer||failed?'play':'image')}<span><strong>${transfer||failed?'inspection-flow.webm':'Landing page · desktop'}</strong><small>${failed?'Not saved locally':transfer?'Remote engine → this conversation':'Screenshot · 428 KB · saved'}</small></span><span class="spacer"></span>${failed?btn('Retry copy','evidence/transfer','outline','refresh'):!transfer?btn('Open','evidence/preview','outline','eye'):''}</div></div>`;
 return conversation(transcript('Here’s the page I checked','I captured the inspection flow so you can review the same state I saw.')+card+(failed?notice('Destination unavailable','Could not save inspection-flow.webm in Sandflat Roofing / September landing page / files. Retry the copy or download the remote file.','error'):'')+(!transfer&&!failed?`<div class="assistant-prose"><p>The main action is visible without scrolling. The next step is to tighten the explanation below it.</p></div>`:''),{});
}
function capture() {
 if(state==='held') return conversation(transcript('I can use your capture for the next pass','Send your marked screenshot with a short instruction when you’re ready.'),{composer:{held:`<strong>1 capture held</strong> · 1 markup note ${btn('Review','capture/review','ghost')}`,tray:attachment('sandflat-browser.png','Chrome · 11:47 AM · only you can see this',{go:'capture/review'}),text:'Apply the change I marked on the inspection button.',send:'send-capture'}});
 if(['review','screenshot-only'].includes(state)) return dialogScreen('Review window capture','Chrome · Sandflat Roofing · captured just now',`<div class="mark-toolbar">${badge('Screenshot')}<span class="spacer"></span>${action('Box','mark-box','outline','capture')}${action('Clear marks','clear-marks','ghost')}<span class="muted">1 note</span></div>${state==='screenshot-only'?`<div style="margin:12px 0">${notice('Screenshot captured. App text was unavailable.','You can send the image as it is. Add a note to explain what the agent should notice.')}</div>`:''}<div class="mark-layout" style="margin-top:15px"><div id="capture-image">${website({marked:true})}</div><aside class="mark-notes"><h3>Mark 1</h3><label class="field">What should change?<textarea id="capture-note">${esc(captureText)}</textarea></label><p>${icon('lock')} This capture and your note are private until Send.</p><div class="spacer"></div><small class="muted">Destination</small><strong style="font-size:14px">September landing page</strong></aside></div>`,`<small>${state==='screenshot-only'?'Screenshot only':'Image captured · optional app text not requested'}</small>${btn('Retake','capture/choose','outline')}${action('Hold capture','hold-capture','primary','lock')}`,'wide');
 if(state==='choose') return dialogScreen('Choose a window to capture','Send the capture to September landing page.',`<div class="system-handoff">Choose one window. You can review the image before sending it to the agent.</div><div class="capture-window-grid"><button class="window-choice selected" data-window="chrome">${website({mini:true})}<div class="window-title">${icon('monitor')} Chrome · Sandflat Roofing ${icon('check')}</div></button><button class="window-choice" data-window="notes"><div class="native-fake"><small>NOTES</small><h3>September campaign</h3><div class="fake-row">Free inspection offer</div><div class="fake-row">Follow up within one business day</div><div class="fake-row">Keep warranty copy lower on page</div></div><div class="window-title">${icon('file')} Notes · September campaign</div></button></div><p class="permitted-note">Only the selected window is captured. You’ll review the result before sending it.</p>`,`${btn('Cancel','questions/asking','outline')}${btn('Capture selected window','capture/review','primary','capture')}`);
 if(state==='mac-permission') return dialogScreen('Allow window capture on macOS','Strata needs screen recording access to capture another app.',`<div class="stack"><div class="status-list"><div class="status-row">${icon('monitor')} Screen Recording<small class="warning">Permission needed</small></div><div class="status-row">${icon('file')} Accessibility for app text<small>Optional · off</small></div></div>${notice('Allow Strata in System Settings','Open Privacy & Security → Screen Recording and turn on Strata. If macOS asks you to reopen Strata, save your work first.')}<p class="muted">Capturing an image does not require app text access. You can add that separately if you need it.</p></div>`,`${btn('Back','capture/setup','outline')}${action('Open System Settings','system-settings','primary')}`,'narrow');
 return dialogScreen('Window capture','Bring an image from another app into the current conversation.',`${settingRow('Enable window capture','Choose a window, mark the image, and hold it until Send.',`<label class="switch"><input id="capture-toggle" type="checkbox" ${captureEnabled?'checked':''}><span>${captureEnabled?'On':'Off'}</span></label>`)}${settingRow('Include text from the app','Where supported, include available app text with the screenshot. Additional permission may be required.',`<label class="switch"><input type="checkbox"><span>Off</span></label>`)}${settingRow('Keyboard shortcut','Start capture from another app. Shortcut availability depends on your desktop.',`<button class="btn outline" data-demo="Mockup: press a shortcut to assign it. This does not register a system shortcut.">Set shortcut…</button>`)}${settingRow('Destination','Capture into the conversation you are currently viewing.',selectField('Capture destination',[['current','Current conversation']],'current'))}<div class="scope-note">The system chooses which windows can be captured. You review every capture before the agent receives it.</div>`,`<small>Off until you enable it</small>${btn('Done','questions/asking','outline')}<button class="btn primary" id="choose-capture" data-go="capture/choose" ${captureEnabled?'':'disabled'}>${icon('capture')} Choose a window</button>`);
}
function recovery() {
 if(state==='setting') return dialogScreen('Engine connection','Control how Strata returns to interrupted work.',`${settingRow('Continue active work after engine restart','When the engine reconnects, try to resume work that was active before the restart. This can continue using your provider quota.',`<label class="switch"><input id="continue-toggle" type="checkbox" ${continuation?'checked':''}><span>${continuation?'On':'Off'}</span></label>`)}<div class="stack" style="margin-top:20px">${notice('Off by default','With this off, Strata reconnects and reloads your history. You choose when to continue agent work.')}<div class="settings-card"><h3>If you turn it on</h3><p>Strata first tries to resume the native session. If the provider needs a new message, Strata shows that a continuation message was sent.</p><p>Connection status stays visible until the engine confirms the result.</p></div></div>`,`${btn('Cancel','questions/asking','outline')}${action('Save preference','save-recovery','primary')}`);
 const waiting=state==='reconnecting',failed=state==='failed',continued=state==='continued';
 const message=waiting?'Reconnecting to the local engine…':failed?'Connected, but this conversation could not resume.':continued?'A continuation message was sent after the restart.':'Session resumed after the engine restart.';
 const detail=waiting?'Your history and draft stay here.':failed?'Your history is loaded. Choose when to continue.':continued?'The provider started a new turn with your existing conversation.':'The engine confirmed the original session is working again.';
 const banner=`<div class="recovery-banner ${waiting?'':failed?'error':'success'}">${icon(waiting?'refresh':failed?'alert':'check')}<div><strong>${message}</strong><br>${detail}</div><span class="spacer"></span>${failed?btn('Continue conversation','recovery/continued','outline'):!waiting?btn('Details','recovery/setting','ghost'):''}</div>`;
 let content=transcript('The page revision is underway','I’ve updated the inspection offer and am checking the layout against your notes.');
 if(continued)content+=`<div class="owner-message" style="margin-top:20px"><div class="message-meta">${icon('refresh')} Sent by Strata after engine restart</div>Continue the work that was active before the restart.</div>`;
 content+=`<div class="work-line">${icon(waiting?'clock':failed?'alert':'terminal')}${waiting?'Waiting for connection':failed?'Agent work is paused':'Checking the mobile layout'}<code>History loaded · 42 messages</code></div>`;
 return conversation(content,{banner,composer:{text:'Please also check the spacing around the warranty note.',disabled:waiting,held:'<strong>2 comments held</strong> · saved before the restart'}});
}
function models() {
 if(state==='list') return dialogScreen('Provider models','Choose what appears in the composer and give custom models readable names.',`<div class="inline-tabs"><button aria-selected="true">Codex</button><button data-demo="The same custom-model controls apply when the provider reports support.">Claude</button></div><div class="section-label"><h3>Models in your composer</h3>${btn('Add custom model','models/edit','outline','plus')}</div>${[[modelName,'Custom model · gpt-5.4','star'],['GPT-5.4','Provider model','bot'],['Fast edits','Custom model · gpt-5.4-mini','star']].map(([name,meta,ico],i)=>`<div class="model-row">${icon(ico)}<div class="model-info"><strong>${esc(name)}</strong><small>${meta}</small></div>${badge(i===0?'High reasoning':i===1?'Provider default':'Medium reasoning')}${btn('Edit','models/edit','ghost','pen')}<label class="switch" title="Show in composer"><input type="checkbox" checked aria-label="Show ${esc(name)}"></label></div>`).join('')}<p class="scope-note">Custom models keep their provider ID. Display names help you tell your presets apart.</p>`,`<small>Models from your connected provider</small>${btn('Done','questions/asking','primary')}`);
 const options=state==='options'||state==='invalid',invalid=state==='invalid';
 let body=`<div class="inline-tabs"><button aria-selected="${!options}" data-go="models/edit">Model details</button><button aria-selected="${options}" data-go="models/options">Supported options</button></div>`;
 body+= options?`<div class="stack">${notice('Options reported by this provider','Strata only offers controls this model can use. Unknown settings from another client stay preserved.')}<div class="two-columns"><label class="field">Reasoning effort<select><option>High</option><option>Medium</option><option>Low</option></select><small>Provider-reported choices</small></label><label class="field">Output detail<select><option>Standard</option><option>Concise</option><option>Detailed</option></select><small>Provider-reported choices</small></label></div><label class="field ${invalid?'invalid':''}">Context window override<input id="context-override" inputmode="numeric" value="${invalid?'many':'272000'}"><small>${invalid?'Enter a whole number greater than zero.':'Optional. Leave empty to use the value reported by the provider.'}</small></label><div class="settings-card"><h3>Preserved settings</h3><p>1 additional setting was saved by another client. It will be kept when you save this model.</p><button class="text-button" data-action="preserved-options">Show setting details</button></div></div>`:`<div class="two-columns"><div class="stack"><label class="field">Name in Strata<input id="model-name" value="${esc(modelName)}"><small>Shown in the model chooser and conversation header.</small></label><label class="field">Provider model ID<input value="gpt-5.4" id="model-id"><small>The exact model name your provider accepts.</small></label><label class="field">Description<input value="Careful review and longer planning work."></label><label class="switch"><input type="checkbox" checked><span>Show in the composer</span></label></div><div class="model-preview"><h4>COMPOSER PREVIEW</h4><span class="model-chip">${icon('bot')}<span id="model-name-preview">${esc(modelName)}</span>${icon('down')}</span><p class="scope-note">High reasoning · Standard output</p><hr class="rule"><small class="muted">Display names do not change which provider model runs.</small></div></div>`;
 return dialogScreen('Custom model','Codex · local engine',body,`<small>${invalid?'Fix the context window value to save.':'Other saved options will be preserved.'}</small>${btn('Cancel','models/list','outline')}${action('Save model','save-model','primary')}`);
}
function notePanel() {
 const saved=JSON.parse(localStorage.getItem('t3-design-notes')||'{}');
 const entry=saved[flow.id]||{};
 return `<aside class="review-note" aria-label="Design review notes"><button class="close-note" data-action="notes" aria-label="Close notes">${icon('x')}</button><h3>${flow.number} · ${flow.short}</h3><p>${flow.decision}</p><div class="feedback-row">${['Not reviewed','Looks right','Needs changes'].map(s=>`<button class="${(entry.status||'Not reviewed')===s?'selected':''}" data-feedback="${s}">${s}</button>`).join('')}</div><textarea id="review-feedback" aria-label="Your design feedback" placeholder="What would you change or keep?">${esc(entry.note||'')}</textarea><p>Saved in this browser only. Copy feedback to share it in chat. These notes do not start implementation.</p><button data-action="copy-feedback">Copy all feedback</button></aside>`;
}
function render() {
 route(); window.__mockReady=false; const renderPath=location.search; clearTimeout(toastTimer); $('#toast').classList.remove('visible');
 $('#review').innerHTML=reviewBar();
 const screens={questions,files,usage,compact,skills:skillScreen,drafts,defaults,import:imports,evidence,capture,recovery,models};
 $('#root').innerHTML=flow?screens[flow.id]()+`<footer class="design-caption"><span class="feature-tag">Features ${flow.features.join(' + ')}</span><span><strong>Design decision</strong> · ${flow.decision}</span></footer>`:gallery();
 $('#review-notes').innerHTML=flow&&notesOpen?notePanel():'';
 document.title=flow?`${flow.short} · Strata design review`:'Strata · T3 additions design review';
 document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(location.search===renderPath)window.__mockReady=true;})));
 if(flow?.id==='skills'&&state!=='inserted') skillsQuery=state==='filtered'?'/brand':state==='empty'?'/invoice':'/';
}
function saveFeedback(status) {
 const saved=JSON.parse(localStorage.getItem('t3-design-notes')||'{}');
 saved[flow.id]={status:status||saved[flow.id]?.status||'Not reviewed',note:$('#review-feedback')?.value||'',updated:new Date().toISOString()};
 localStorage.setItem('t3-design-notes',JSON.stringify(saved));
}
function retainAnswer(){answers.text=$('#answer-text')?.value??answers.text;}
function runAction(name, button) {
 switch(name) {
  case 'previous':case 'next': { const index=D.flows.indexOf(flow); go(D.flows[(index+(name==='next'?1:-1)+D.flows.length)%D.flows.length].id); break; }
  case 'notes': notesOpen=!notesOpen; $('#review-notes').innerHTML=notesOpen?notePanel():''; break;
  case 'copy-feedback': {
   saveFeedback(); const saved=JSON.parse(localStorage.getItem('t3-design-notes')||'{}');
   const text='Strata T3 additions · design review 01\n\n'+D.flows.map(f=>`${f.number}. ${f.short}: ${saved[f.id]?.status||'Not reviewed'}${saved[f.id]?.note?'\n'+saved[f.id].note:''}`).join('\n\n');
   navigator.clipboard.writeText(text).then(()=>toast('Review feedback copied. Paste it into our conversation.')).catch(()=>{const box=$('#review-feedback');box.value=text;box.select();toast('Select and copy the feedback shown in the notes box.');});break;
  }
  case 'hold-answer': retainAnswer();go('questions','held');break;
  case 'send-answer':go('questions','sent');toast('Mockup: answer, image, and message sent together.');break;
  case 'retry-answer':go('questions','asking');toast('Mockup: attachment is ready.');break;
  case 'question-attach':retainAnswer();toast('Mockup: cta-reference.png is staged with this answer.');break;
  case 'remove-file':{const card=button.closest('.attachment-card');card?.remove();toast('Removed from this sample draft.');break;}
  case 'send-files':toast('Mockup: message and 3 files sent together.');$('.composer-tray')?.remove();$('#composer-text').value='';break;
  case 'retry-files':go('files','attached');toast('Mockup: files are ready to retry.');break;
  case 'pdf-next':$('.viewer-toolbar input').value='2';$('.pdf-page h1').innerHTML='The next step<br>is an inspection.';$('.pdf-page .pdf-date').textContent='September 2026 · Page 2 of 8';break;
  case 'pdf-fit':$('.pdf-page').style.width='100%';button.textContent='Fit width';break;
  case 'pdf-zoom': {const page=$('.pdf-page');page.style.zoom=page.style.zoom==='1.1'?'1':'1.1';button.textContent=page.style.zoom==='1.1'?'110%':'100%';break;}
  case 'use-credit':go('usage','accounts');toast('Mockup: the provider confirmed the reset. No real credit was used.');$('.quota-fill').style.width='100%';$('.quota-label strong').textContent='100% remaining';$('.quota-label span').textContent='0% used';break;
  case 'park-account':button.textContent=button.textContent==='Park'?'Unpark':'Park';toast('Mockup: account selection updated.');break;
  case 'choose-account':button.textContent='Selected';toast('Mockup: Work selected for this conversation.');break;
  case 'discard-draft':go('drafts','opened');$('#composer-text').value='';$('.composer-tray')?.remove();toast('Message draft discarded. The 2 held comments remain.');break;
  case 'save-defaults':toast('Mockup: defaults saved for new conversations.');break;
  case 'import-find':if(!sourceSelected.size){toast('Choose at least one source.');break;}importSelected=new Set(importRows.filter(r=>sourceSelected.has(r.provider.toLowerCase())).map(r=>r.id));go('import','select');break;
  case 'import-select-all':importSelected=new Set(importRows.filter(r=>sourceSelected.has(r.provider.toLowerCase())).map(r=>r.id));render();break;
  case 'import-review':if(!importSelected.size){toast('Select at least one conversation.');break;}go('import','confirm');break;
  case 'evidence-fit':$('.website').style.maxWidth='100%';toast('Screenshot fitted to the available width.');break;
  case 'evidence-comment':toast('Mockup: your comment is held until Send.');button.textContent='Comment held';break;
  case 'mark-box':if(!$('.annotation-ring'))$('#capture-image .webbutton').insertAdjacentHTML('beforeend','<span class="annotation-ring"></span>');toast('Mockup: one box marks the inspection button.');break;
  case 'clear-marks':$('.annotation-ring')?.remove();toast('Markup cleared from this sample.');break;
  case 'hold-capture':captureText=$('#capture-note')?.value||captureText;go('capture','held');break;
  case 'send-capture':toast('Mockup: capture, markup note, and message sent.');$('.composer-tray')?.remove();$('.held-chip')?.remove();$('#composer-text').value='';break;
  case 'system-settings':toast('Mockup: macOS System Settings would open. No permissions were changed.');break;
  case 'save-recovery':toast(`Mockup: continuation after restart is ${continuation?'on':'off'}.`);break;
  case 'preserved-options':button.outerHTML='<small class="muted">Extra provider setting · priority: standard<br>Preserved as saved by the other client.</small>';break;
  case 'save-model':{
   const context=$('#context-override');if(context && context.value && (!/^\d+$/.test(context.value)||Number(context.value)<1)){go('models','invalid');break;}
   const name=$('#model-name')?.value.trim();if($('#model-name')&&!name){toast('Give this model a name.');$('#model-name').focus();break;}
   if(name)modelName=name;go('models','list');toast('Mockup: model settings saved.');break;
  }
  case 'demo-send':toast('Mockup: message sent. No agent was called.');$('#composer-text').value='';break;
  default:toast('This action is represented by the selectable states above.');
 }
}
document.addEventListener('click',e=>{
 const target=e.target.closest('button,[data-go],[data-demo]');if(!target)return;
 if(target.dataset.go){if(e.target.closest('[data-action="remove-file"]'))return;const[id,next]=target.dataset.go.split('/');go(id,next);return;}
 if(target.dataset.action){runAction(target.dataset.action,target);return;}
 if(target.dataset.choice){retainAnswer();answers.choice=target.dataset.choice;document.querySelectorAll('[data-choice]').forEach(el=>el.classList.toggle('selected',el===target));return;}
 if(target.dataset.skill){sessionStorage.setItem('t3-selected-skill',target.dataset.skill);go('skills','inserted');return;}
 if(target.dataset.feedback){saveFeedback(target.dataset.feedback);$('#review-notes').innerHTML=notePanel();return;}
 if(target.dataset.window){document.querySelectorAll('[data-window]').forEach(el=>el.classList.toggle('selected',el===target));toast(`Mockup: ${target.dataset.window==='chrome'?'Chrome':'Notes'} selected. The capture review uses the Chrome sample.`);return;}
 if(target.dataset.demo)toast(target.dataset.demo);
});
document.addEventListener('change',e=>{
 const el=e.target;
 if(el.id==='flow-select')go(el.value);
 if(el.id==='theme-select'){theme=el.value;localStorage.setItem('t3-design-theme',theme);document.body.dataset.theme=theme;}
 if(el.id==='scope-select')go('defaults',el.value);
 if(el.dataset.defaultSetting&&state==='project')go('defaults','override');
 if(el.dataset.source){el.checked?sourceSelected.add(el.dataset.source):sourceSelected.delete(el.dataset.source);$('#source-count').textContent=`${sourceSelected.size} sources selected`;}
 if(el.dataset.importRow){el.checked?importSelected.add(el.dataset.importRow):importSelected.delete(el.dataset.importRow);$('#import-count').textContent=`${importSelected.size} conversations selected`;}
 if(el.dataset.projectSelect){importRows.filter(r=>r.project===el.dataset.projectSelect&&sourceSelected.has(r.provider.toLowerCase())).forEach(r=>el.checked?importSelected.add(r.id):importSelected.delete(r.id));render();}
 if(el.id==='continue-toggle'){continuation=el.checked;el.nextElementSibling.textContent=continuation?'On':'Off';}
 if(el.id==='capture-toggle'){captureEnabled=el.checked;el.nextElementSibling.textContent=captureEnabled?'On':'Off';$('#choose-capture').disabled=!captureEnabled;}
});
document.addEventListener('input',e=>{
 const el=e.target;
 if(el.id==='answer-text')answers.text=el.value;
 if(el.id==='review-feedback')saveFeedback();
 if(el.id==='model-name'){modelName=el.value;$('#model-name-preview').textContent=el.value||'Model name';}
 if(el.id==='composer-text'&&flow?.id==='skills'&&state!=='inserted'){
  skillsQuery=el.value;const menu=$('.command-popover');
  if(el.value.startsWith('/')){if(menu)menu.outerHTML=commandMenu(el.value);else $('.composer').insertAdjacentHTML('afterbegin',commandMenu(el.value));}else menu?.remove();
 }
});
document.addEventListener('keydown',e=>{
 const menu=$('.command-popover');
 if(menu&&['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)&&e.target.id==='composer-text'){
  e.preventDefault();if(e.key==='Escape'){menu.remove();return;}
  const rows=[...menu.querySelectorAll('.command-row')];if(!rows.length)return;
  let index=rows.findIndex(r=>r.classList.contains('active'));if(e.key==='Enter'){rows[Math.max(0,index)].click();return;}
  index=(index+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length;
  rows.forEach((r,i)=>{r.classList.toggle('active',i===index);r.setAttribute('aria-selected',String(i===index));});rows[index].scrollIntoView({block:'nearest'});
 }
 if(e.key==='Enter'&&e.target.matches('[role="button"][data-go]'))e.target.click();
 if(e.key==='Escape'&&notesOpen){notesOpen=false;$('#review-notes').innerHTML='';}
});
window.addEventListener('popstate',render);
render();
