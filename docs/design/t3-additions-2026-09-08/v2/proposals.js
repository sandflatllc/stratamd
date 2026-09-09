/* Design-only DOM changes applied to exported, current Strata components. */
window.Proposals = (() => {
  const q = s => document.querySelector(s);
  const all = s => [...document.querySelectorAll(s)];
  const node = html => { const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstElementChild; };
  const mark = (el,label) => { if(!el)throw Error(`Missing change target: ${label}`);el.dataset.change=label;return el; };
  const add = (el,html,label) => { const child=node(html);el.append(child);if(label)mark(child,label);return child; };
  const button = (text,go,primary=false,disabled=false) => `<button type="button" class="${primary?'primary-button':'quiet-button'}" ${go?`data-go="${go}"`:''} ${disabled?'disabled':''}>${text}</button>`;
  const note = text => `<p class="proposal-note">${text}</p>`;
  const status = (text,tone='',action='') => `<div class="proposal-status" ${tone?`data-tone="${tone}"`:''}><p>${text}</p>${action}</div>`;
  const field = (name,value,help='',attrs='') => `<label class="setup-field">${name}<input aria-label="${name}" value="${value}" ${attrs}>${help?`<small>${help}</small>`:''}</label>`;
  const select = (name,values,help='') => `<label class="setup-field">${name}<select aria-label="${name}">${values.map(v=>`<option>${v}</option>`).join('')}</select>${help?`<small>${help}</small>`:''}</label>`;
  const tabs = (name,items,active) => `<div class="setup-tabs" role="tablist" aria-label="${name}">${items.map(([id,label])=>`<button type="button" role="tab" aria-selected="${id===active}" data-go="${id}">${label}</button>`).join('')}</div>`;
  const pen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
  const attachment = (name,meta,go,kind='PDF') => `<div class="conversation-attachment-preview proposal-binary"><span>${kind}</span><button type="button" class="proposal-file-open" data-go="${go}"><strong>${name}</strong><small>${meta}</small></button><button type="button" aria-label="Remove ${name}" data-remove>×</button></div>`;
  const source = (flow,state) => {
    if(flow==='usage') return 'usage';
    if(flow==='models') return 'models';
    if(flow==='defaults'||flow==='import') return 'settings';
    if(flow==='recovery'&&state==='setting') return 'engine';
    if(flow==='files'&&['pdf','html','source','file-error'].includes(state))return 'preview';
    if(flow==='evidence'&&state==='preview')return 'preview';
    if(flow==='capture')return ['review','screenshot-only'].includes(state)?'image-annotation':state==='held'?'questions':'settings';
    return 'questions';
  };
  function composerDraft(text){const e=q('.chat-composer textarea');e.value=text;e.textContent=text;mark(e,'Draft text for this feature');}
  function sendButton(go){const e=q('.chat-send');e.classList.remove('chat-stop');e.setAttribute('aria-label','Send');e.title='Send message';e.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';e.dataset.go=go;mark(e,'Send delivers held content');}
  function heldSummary(text,go=''){const ctx=q('.conversation-context');add(ctx,`<div class="proposal-held">${text}${button('Review',go)}</div>`,'Held content in the existing composer');}
  function workNotice(text,tone='',action=''){const el=add(q('.conversation-turn'),status(text,tone,action),'Work status for this feature');el.style.margin='8px';return el;}
  function dialog(title,subtitle,body,footer,label){
    const modal=q('.setup-dialog');
    modal.setAttribute('aria-label',title);q('.setup-dialog-header h2').textContent=title;
    q('.setup-dialog-header .modal-subtitle').textContent=subtitle;
    q('.setup-back')?.remove();q('.setup-dialog-body').innerHTML=body;
    q('.parity-dialog-footer').innerHTML=footer;
    q('.utility-dialog-resize')?.setAttribute('aria-label',`Resize ${title}`);
    mark(modal,label);return modal;
  }
  function anchoredMenu(html,label,anchor='.chat-composer-box',width=360){
    const el=add(q('.app-shell'),`<div class="chat-menu proposal-menu" role="dialog" aria-label="${label}">${html}</div>`,label);
    const r=q(anchor).getBoundingClientRect();el.style.width=width+'px';el.style.left=Math.min(r.right-width,innerWidth-width-20)+'px';el.style.bottom=(innerHeight-r.top+10)+'px';return el;
  }
  function quota(name,value,reset,pace){return `<div class="proposal-quota"><div class="proposal-quota-line"><strong>${name} · ${value}% left</strong><span>${reset}</span></div><div class="proposal-bar" role="meter" aria-label="${name} remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${value}%"></i>${pace?`<b style="left:${pace}%" title="Time remaining in this window"></b>`:''}</div></div>`;}
  async function questions(state){
    const card=q('.conversation-request');mark(card,'Native question status, answer files, and dismissal');
    if(['held','sent','dismissed'].includes(state)){
      const text=state==='held'?'Answer held · Version one':state==='sent'?'Answer sent · Version one':'Question dismissed';
      card.innerHTML=`<div class="proposal-between"><strong>${text}</strong>${state==='held'?button('Edit answer','asking'):''}</div>${note(state==='held'?'inspection-report.pdf is attached to this answer. Send delivers both.':state==='sent'?'The agent received your answer and inspection-report.pdf.':'The agent can continue without an answer.')}`;
      if(state==='held'){heldSummary('1 answer · 1 file','held');sendButton('sent');}
      return;
    }
    const settings=await (await fetch('reference/settings.json')).json();
    const exported=document.createElement('template');exported.innerHTML=settings.html;
    const backdrop=exported.content.querySelector('.modal-backdrop');
    const modal=backdrop.querySelector('.setup-dialog');
    modal.className='modal setup-dialog proposal-question-modal';
    modal.setAttribute('aria-label','Answer question');
    const header=modal.querySelector('.setup-dialog-header');
    header.querySelector('h2').textContent='Answer question';
    header.querySelector('.modal-subtitle').textContent=state==='blocking'?'The agent is waiting for your answer.':'The agent can keep working while you answer.';
    header.querySelector('[aria-label="Close dialog"]').dataset.go='held';
    const body=modal.querySelector('.setup-dialog-body');body.replaceChildren(card);
    delete card.dataset.change;
    card.querySelector('form > button[type="submit"]')?.remove();
    card.querySelector('form button[type="submit"]')?.remove();
    const choice=card.querySelector('fieldset button');choice.setAttribute('aria-pressed','true');
    const input=card.querySelector('input');const answerLabel=node('<label class="setup-field">Or write an answer</label>');input.before(answerLabel);answerLabel.append(input);card.querySelector('fieldset').classList.add('setup-fields');
    add(card.querySelector('fieldset'),`<div class="proposal-question-files">${attachment('inspection-report.pdf',state==='upload-error'?'Could not stage this file':'PDF · 248 KB','files/pdf')}${button('Attach to answer','upload-error')}</div>`);
    if(state==='upload-error')add(card,status('Could not read inspection-report.pdf. Choose it again to attach it.','error',button('Choose file again','asking')));
    modal.querySelector('.parity-dialog-footer').innerHTML=`${note('Hold keeps this answer private until you press Send.')}${state==='blocking'?'':button('Dismiss','dismissed')}${button('Hold answer','held',true,state==='upload-error')}`;
    q('.app-shell').append(backdrop);mark(modal,'Answer in the existing Strata modal, with per-answer files and Hold');
    if(state==='blocking'){const row=q('.conversation-working-row');row.textContent='Waiting for your answer';mark(row,'Working status reflects a required answer');}
  }

  function files(state){
    if(['attached','upload-error'].includes(state)){
      const tray=node(`<div class="conversation-attachments proposal-file-tray">${attachment('inspection-report.pdf','PDF · 248 KB','pdf')}${attachment('inspection-export.zip','ZIP · 1.8 MB','attached','ZIP')}</div>`);
      q('.chat-composer-box').prepend(tray);mark(tray,'Binary attachments in the existing attachment tray');
      composerDraft('Use the report and export to check the inspection flow.');sendButton('files/upload-error');
      if(state==='upload-error')workNotice('inspection-export.zip could not be sent. Your message and both files are still held.','error',button('Retry send','attached'));
      return;
    }
    const isHtml=['html','source'].includes(state), name=isHtml?'inspection-page.html':'inspection-report.pdf';
    mark(q('.preview-tab'),'Read-only document tab');q('.preview-tab-name').textContent=name;
    const chrome=q('.preview-chrome');chrome.innerHTML=`<div class="proposal-readonly-toolbar" style="width:100%"><strong>${name}</strong><span>Read only</span>${isHtml?button(state==='source'?'Preview':'View source',state==='source'?'html':'source'):button('−','pdf')+'<span>100%</span>'+button('+','pdf')+'<span>1 of 3</span>'+button('Next page','pdf')}${button('Open externally','file-error')}</div>`;mark(chrome,'Document preview controls');
    const stage=q('.preview-stage');stage.innerHTML='<div class="proposal-readonly-stage"></div>';mark(stage,'Read-only file content or file error');
    const target=q('.proposal-readonly-stage');
    if(state==='file-error'){target.innerHTML=`<div class="proposal-stack" style="padding:32px"><h2>inspection-report.pdf is unavailable</h2><p>Strata could not read /tmp/cockpit/inspection-report.pdf.</p><div>${button('Locate file','pdf',true)} ${button('Close preview','attached')}</div></div>`;return;}
    if(state==='source'){target.innerHTML='<pre class="proposal-source"></pre>';q('.proposal-source').textContent='<!doctype html>\n<html lang="en">\n<head><title>Inspection page</title></head>\n<body>\n  <h1>Inspection page</h1>\n  <p>Review the offer and the steps after booking.</p>\n  <h2>Book an inspection</h2>\n  <p>Choose a date. We will confirm the visit\n     and explain what to expect.</p>\n  <button>Request an inspection</button>\n</body>\n</html>';return;}
    if(state==='html'){target.innerHTML='<iframe src="reference/inspection-page.html" title="Read-only inspection page" style="display:block;width:100%;height:100%;border:0;background:white;color-scheme:light"></iframe>';return;}
    target.innerHTML='<article class="proposal-paper"><small>INSPECTION REPORT · SEPTEMBER 2026</small><h1>Inspection page review</h1><p>The offer is clear. The next step needs to be easier to find.</p><h2>Recommended changes</h2><p>Keep the inspection button visible after the homeowner reads the offer.</p><p>Explain when the visit will be confirmed and what happens during the inspection.</p><hr><small>1 / 3</small></article>';
  }
  function usage(state){
    const body=q('.accounts-body');const groups=all('.accounts-group');
    const controls=node(`<div class="proposal-between proposal-usage-controls"><div class="proposal-row">${button('By account','accounts')}${button('Combined','pooled')}</div><span class="proposal-note">${state==='stale'?'Last updated 18 minutes ago':state==='unavailable'?'No usage report received':'Updated just now'}</span></div>`);
    groups[0].before(controls);mark(controls,'Account view and freshness');
    all('.account-windows').forEach((e,i)=>{mark(e,'Reported quota windows');if(state==='unavailable'){e.innerHTML=note('This provider has not reported usage. Limits are unknown.')+button('Refresh','accounts');return;}e.innerHTML=(i?quota('5 hours',68,'Resets in 2h 10m',43):'')+quota('Week',i?81:74,'Resets Fri',60);});
    if(state==='pooled'){
      groups.forEach(g=>{g.hidden=true});const combined=add(body,`<div class="proposal-stack">${quota('5 hours · Claude only',68,'Next reset in 2h 10m')}${quota('Week · 2 accounts',78,'Next reset Fri')}${note('Average of reported percentages for each window. Only accounts reporting that window are included. This is not a shared token balance.')}${button('Show accounts','accounts')}</div>`,'Combined account percentages');combined.style.padding='10px 0';
    }else if(state==='stale')add(body,status('Refresh failed. The bars show the last report, not current limits.','error',button('Retry refresh','accounts')),'Usage refresh failure');
    else if(state==='reset')add(body,status('Use one reset credit for Claude? This restores its 5-hour window. One credit remains afterward.','',button('Cancel','accounts')+' '+button('Use reset credit','accounts',true)),'Confirm a provider-reported reset credit');
    else if(state!=='unavailable')add(body,`<div class="proposal-between">${note('Bar = quota left. Tick = time left in that window.')}${button('Use reset credit…','reset')}</div>`,'Quota legend and supported reset action');
  }
  function compact(state){
    const meter=q('.chat-context-meter');meter.removeAttribute('data-unknown');meter.setAttribute('aria-label',state==='done'?'Context usage 24%':'Context usage 88%');mark(meter,'Reported context level and compact entry');meter.title='Context usage';meter.dataset.go='ready';
    const svg=meter.querySelector('svg');svg.innerHTML=`<circle class="chat-context-track" cx="12" cy="12" r="9"></circle><circle class="chat-context-fill" cx="12" cy="12" r="9" stroke-dasharray="${state==='done'?14:50} 57" transform="rotate(-90 12 12)"></circle>`;
    if(['ready','unsupported'].includes(state)){
      const unsupported=state==='unsupported';anchoredMenu(`<h3>Context · 88% used</h3>${note('Summary replaces older model context. Your visible conversation stays available.')}<div style="padding:6px">${button('Compact context','working',true,unsupported)}</div>${unsupported?note('This agent does not support manual compaction.'):note('Provider report · 176,000 of 200,000 tokens')}`,'Compact action beside the existing context meter','.chat-composer-box',320);
    }else if(state==='working')workNotice('Compacting context… Your draft is saved.','',button('View result','done'));
    else if(state==='done')workNotice('Context compacted · 88% → 24%. Conversation history is still available.','good');
    else workNotice('Could not compact context. Your conversation and draft are unchanged.','error',button('Retry compaction','working'));
  }
  function skills(state){
    composerDraft(state==='inserted'?'/agent-browser Review the inspection page.':state==='filtered'?'/browser':state==='empty'?'/roof-estimate':'/');
    if(state==='inserted')return;
    const item=(title,desc,go,selected=false)=>`<button class="proposal-menu-item" data-go="${go}" ${selected?'data-selected':''}><span><strong>${title}</strong><small>${desc}</small></span><kbd>↵</kbd></button>`;
    anchoredMenu(state==='empty'?'<h3>No matching command or skill</h3>'+note('No results for “roof-estimate”. Try another name.')+button('Clear search','menu'):(state==='menu'?'<h3>Commands</h3>'+item('/compact','Compacts context immediately','compact/ready'):'')+'<h3>Skills</h3>'+item('/agent-browser','Open pages, inspect UI, and capture evidence','inserted',true)+(state==='menu'?item('/design','Create and review UI proposals','inserted'):'')+note('Skills are inserted into your draft. Nothing is sent yet.'),'Searchable commands and skills in the composer');
    q('.chat-composer textarea').addEventListener('input',e=>{if(e.target.value.includes('browser'))parent.postMessage({type:'strata-mockup-state',flow:'skills',state:'filtered'},location.origin)});
  }
  function drafts(state){
    all('.project-thread[data-lifecycle="active"]').forEach((thread,i)=>{
      const marks=thread.querySelector('.project-thread-marks');add(marks,`<span class="proposal-draft-mark" role="img" aria-label="Unsent message draft" title="Unsent message draft">${pen}</span>`,'Draft marker beside the existing thread status');thread.querySelector('.project-thread-open').dataset.go='opened';
    });
    if(state==='markers')return;
    composerDraft('Keep the next step visible after the offer.');
    if(state==='opened'){const box=q('.chat-composer-box');add(box,`<div class="proposal-held">Message draft saved ${button('Discard message…','discard')}</div>`,'Draft details and discard entry');}
    if(state==='discard')anchoredMenu('<h3>Discard this message draft?</h3>'+note('Only the unsent message and its files will be removed. Held answers and comments stay available.')+`<div class="proposal-row" style="padding:6px">${button('Keep draft','opened')}${button('Discard message','markers',true)}</div>`,'Confirm discarding only the message draft');
  }
  function defaults(state){
    const body=q('.setup-dialog-body'), fieldset=q('.setup-fields');
    const scope=node(tabs('Defaults scope',[['computer','Computer'],['project','Cockpit project']],state==='computer'?'computer':'project'));body.prepend(scope);mark(scope,'Choose computer or project defaults');
    const group=node('<section class="proposal-stack proposal-default-fields"></section>');fieldset.querySelector('h3').after(group);mark(group,'Effective settings, inheritance, and explicit project overrides');
    if(state==='computer')group.innerHTML=select('Default account',['Codex work','Claude main'])+select('Default model',['GPT-5.6','Provider default'])+select('Thinking',['High','Medium','Low'])+select('Working copy',['Current checkout','New worktree'])+note('Applies to new conversations unless a project overrides it.');
    else {
      group.innerHTML='<div class="proposal-effective"><strong>Account and model</strong><span>Codex work · GPT-5.6</span><small>Inherited from computer</small>'+button('Override','override')+'</div>';
      if(state==='override')group.innerHTML+=select('Thinking for Cockpit project',['Medium','High','Low'],'Project override. Computer default is High.')+button('Use computer default','project');
      else group.innerHTML+='<div class="proposal-effective"><strong>Thinking</strong><span>High</span><small>Inherited from computer</small>'+button('Override','override')+'</div>';
      group.innerHTML+='<div class="proposal-effective"><strong>Working copy</strong><span>Current checkout</span><small>Inherited from computer</small>'+button('Override','override')+'</div>'+note('These choices apply only to new conversations in Cockpit project.');
    }
    const save=q('.parity-dialog-footer .primary-button');save.disabled=false;save.dataset.go='conflict';mark(save,'Save the selected settings scope');
    if(state==='conflict')add(group,status('Cockpit project settings changed elsewhere. Reload them before saving your changes.','error',button('Reload project settings','project')));
  }
  function importFlow(state){
    const row=(name,detail,checked=true)=>`<label class="proposal-import-row"><input type="checkbox" ${checked?'checked':''}><span>${name}<small>${detail}</small></span></label>`;
    let title='Import existing work',body='',footer=button('Cancel','sources');
    if(state==='sources'){body='<fieldset class="setup-fields"><h3>Choose local agent homes</h3>'+row('Codex work','~/.codex · Codex')+row('Claude main','~/.claude · Claude')+note('Strata reads the selected histories on the engine computer. Importing does not start an agent.')+'</fieldset>';footer+=button('Find conversations','select',true);}
    if(state==='select'){body='<fieldset class="setup-fields"><h3>Cockpit project</h3>'+note('/tmp/cockpit')+row('Inspection page review','Codex work · 24 messages · Sep 3')+row('Inspection copy changes','Claude main · 16 messages · Sep 2')+row('Earlier layout experiment','Codex work · 9 messages · Aug 30',false)+'</fieldset>';footer=button('Back','sources')+button('Review 2 conversations','confirm',true);}
    if(state==='confirm'){body='<div class="proposal-stack"><h3>2 conversations in Cockpit project</h3><p>Import 40 messages and their available attachments into a copy of the history.</p>'+note('Source histories stay where they are. Import does not create a live sync or resume either agent.')+status('The project already exists in Strata. Imported conversations will be added to it.')+'</div>';footer=button('Back','select')+button('Import conversations','progress',true);}
    if(state==='progress'){body='<div class="proposal-stack"><h3>Importing 2 conversations</h3>'+quota('Progress',50,'1 of 2 complete')+note('Reading Inspection copy changes… You can keep using Strata while import finishes.')+'</div>';footer=button('View completed result','done',true);}
    if(state==='partial'){body='<div class="proposal-stack"><h3>1 imported · 1 needs attention</h3>'+status('Inspection copy changes could not be read from ~/.claude/projects/cockpit. The imported conversation is ready to open.','error')+note('Retry skips conversations already imported.')+'</div>';footer=button('Open imported work','done')+button('Retry failed import','progress',true);}
    if(state==='done'){body='<div class="proposal-stack"><h3>2 conversations imported</h3>'+status('Inspection page review and Inspection copy changes are now in Cockpit project.','good')+note('No agent was started. Open a conversation to review its history before continuing it.')+'</div>';footer=button('Import more','sources')+button('Open Cockpit project','drafts/markers',true);}
    dialog(title,'Copy history from an existing agent home into Strata.',body,footer,'New import flow inside Strata’s existing setup dialog');
  }
  function evidence(state){
    if(state==='preview'){
      mark(q('.preview-tab'),'Saved evidence tab');q('.preview-tab-name').textContent='inspection-page.png';
      const chrome=q('.preview-chrome');chrome.innerHTML='<div class="proposal-readonly-toolbar" style="width:100%"><strong>inspection-page.png</strong><span>Saved screenshot</span>'+button('Annotate','capture/review')+'</div>';mark(chrome,'Saved evidence identity and annotation action');
      q('.preview-stage').innerHTML='<div class="proposal-readonly-stage"><img src="reference/inspection-capture.png" alt="Inspection page screenshot" style="display:block;max-width:100%;height:auto;margin:auto"></div>';mark(q('.preview-stage'),'Saved screenshot in the existing preview frame');return;
    }
    const text=state==='saved'?'Saved locally · PNG · 838 × 815':state==='transfer'?'Copying from the engine · 64%':'Could not copy to this computer';
    add(q('.conversation-message.assistant'),`<div class="proposal-evidence">${state==='saved'?'<img src="reference/inspection-capture.png" alt="Inspection page screenshot">':''}<div><strong>${state==='saved'?'inspection-page.png':'inspection-review.webm'}</strong><p class="proposal-note">${text}</p>${state==='transfer'?quota('Transfer',64,'4.1 of 6.4 MB'):''}${state==='failed'?note('Destination: /tmp/cockpit/evidence/inspection-review.webm. The saved recording is still on the engine.'):''}<div>${button(state==='saved'?'Open screenshot':state==='transfer'?'View completed copy':'Retry copy',state==='saved'?'preview':state==='transfer'?'saved':'transfer')}</div></div></div>`,'Evidence card with saved, transfer, or retry state');
  }
  function capture(state){
    if(state==='held'){
      heldSummary('1 window capture · 1 visual comment','capture/review');composerDraft('Use this screenshot as the reference for the inspection button.');
      const tray=node(`<div class="conversation-attachments proposal-file-tray">${attachment('Inspection page · Chrome','Window capture · comment held','capture/review','PNG')}</div>`);q('.chat-composer-box').prepend(tray);mark(tray,'Captured window held with the message');sendButton('questions/sent');return;
    }
    if(['review','screenshot-only'].includes(state)){
      const card=q('.visual-card');card.prepend(node('<div class="proposal-stack"><strong>Inspection page · Chrome</strong><span class="proposal-note">Window capture · 838 × 815</span></div>'));mark(card,'Window identity and destination in the existing image markup card');
      const context=q('.visual-context');context.textContent='Hold for Live engine thread';
      all('.visual-card button').find(b=>b.textContent==='Hold').dataset.go='held';all('.visual-card button').find(b=>b.textContent==='Cancel attachment').dataset.go='choose';
      if(state==='screenshot-only'){
        const notice=node('<p class="proposal-annotation-context">Screenshot only. This app did not provide readable text.</p>');q('.visual-card').prepend(notice);
      }
      return;
    }
    let body='',footer='';
    if(state==='setup'){body='<fieldset class="setup-fields"><label class="proposal-import-row"><input type="checkbox" checked><span>Enable window capture<small>Choose a window each time. Review the capture before sending.</small></span></label>'+select('Hold captures for',['Live engine thread','Choose a conversation each time'])+note('Shortcut: Ctrl+Shift+5 on Linux. The system picker opens when you capture.')+'</fieldset>';footer=button('Cancel','setup')+button('Capture a window','choose',true);}
    if(state==='mac-permission'){body='<div class="proposal-stack"><h3>Allow screen recording on your Mac</h3><p>Open System Settings → Privacy & Security → Screen Recording, then enable StrataMD.</p>'+note('If macOS asks you to reopen StrataMD, finish your work before doing so. Accessibility access is optional and only adds text from supported apps.')+'</div>';footer=button('Back','setup')+button('Open System Settings','choose',true);}
    if(state==='choose'){body='<div class="proposal-stack"><h3>Choose a window in the system picker</h3>'+note('Your operating system owns the picker. After you select a window, Strata opens the captured image for markup.')+'<div class="proposal-capture-window"><img src="reference/inspection-capture.png" alt="Selected inspection window"><div><strong>Inspection page · Chrome</strong><p class="proposal-note">Selected window · Live engine thread</p></div></div></div>';footer=button('Cancel','setup')+button('Review capture','review',true);}
    dialog('Window capture','Capture one window and hold it for your next message.',body,footer,'Window capture setup and native picker handoff using Strata dialog components');
  }
  function recovery(state){
    if(state==='setting'){
      add(q('.setup-dialog-body'),`<fieldset class="setup-fields"><label class="proposal-import-row"><input type="checkbox"><span>Continue interrupted work after restart<small>Off. When enabled, Strata asks the engine to resume interrupted conversations after reconnecting.</small></span></label>${note('If native resume is unavailable, Strata can send a continuation message. It will show which action succeeded.')}</fieldset>`,'Continuation preference in the existing Engine dialog');return;
    }
    if(state==='reconnecting'){
      const engine=q('[aria-label="Engine"]') || all('button').find(e=>e.textContent.trim()==='Connected');if(engine){engine.innerHTML=engine.innerHTML.replace('Connected','Reconnecting');mark(engine,'Engine reconnect status');}
      workNotice('Reconnecting to the engine… Conversation history and your draft are available.','',button('View successful resume','resumed'));
    }else if(state==='resumed')workNotice('Reconnected. The engine resumed this session.','good');
    else if(state==='continued')workNotice('Reconnected. Native resume was unavailable, so Strata sent a continuation message.','good');
    else workNotice('The engine reconnected, but could not resume Live engine thread. Your history and draft are still here.','error',button('Retry resume','resumed')+' '+button('Continue with a message','continued'));
  }
  function models(state){
    const fieldset=q('.setup-fields');
    const old=q('[aria-label="Custom model ID"]');old.value='gpt-5.6';old.setAttribute('value','gpt-5.6');mark(old.closest('label'),'Provider model ID remains explicit');
    if(state==='list'){
      const model=q('.provider-model-row');add(model,button('Edit','edit'),'Edit custom model details');
      const name=node(field('Display name','Inspection reviewer','Shown in Strata. The provider still receives gpt-5.6.'));old.closest('label').after(name);mark(name,'Readable custom model name');
      const addButton=all('.setup-fields > button').find(e=>e.textContent==='Add custom model');addButton.disabled=false;addButton.dataset.go='edit';return;
    }
    // Opening model details replaces the model list below its existing tab bar.
    // It does not append a second editor underneath the add-model form.
    [...fieldset.children].filter(e=>!e.matches('.setup-tabs')).forEach(e=>e.remove());
    const panel=add(fieldset,`<section class="proposal-stack proposal-model-editor"><h3>Inspection reviewer</h3>${tabs('Model editor',[['edit','Details'],['options','Options']],state==='edit'?'edit':'options')}${state==='edit'?field('Display name','Inspection reviewer','Shown in model lists and the composer.'):select('Reasoning effort',['High','Medium','Low'],'Reported as supported by this provider.')+field('Maximum output tokens',state==='invalid'?'lots':'16000','Provider limit: 1 to 32,768.',state==='invalid'?'aria-invalid="true"':'inputmode="numeric"')}${state==='invalid'?'<p class="proposal-invalid" role="alert">Enter a whole number between 1 and 32,768.</p>':''}${note(state==='edit'?'Provider ID: gpt-5.6. Renaming does not change the model sent to the engine.':'One option from another client is preserved. This provider has not reported an editor for it.')}${button('Save model',state==='edit'?'options':state==='invalid'?'options':'list',true,state==='invalid')}</section>`,'Custom model name, supported options, and validation');
    if(state==='options')panel.querySelector('input').addEventListener('input',e=>{if(!/^\d+$/.test(e.target.value))parent.postMessage({type:'strata-mockup-state',flow:'models',state:'invalid'},location.origin)});
  }
  const renderers={questions,files,usage,compact,skills,drafts,defaults,import:importFlow,evidence,capture,recovery,models};
  async function render(flow,state){
    await renderers[flow](state);
    document.querySelectorAll('[data-change]').forEach(el=>{
      for(let parent=el.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
        if(!['auto','scroll'].includes(getComputedStyle(parent).overflowY))continue;
        const r=el.getBoundingClientRect(),p=parent.getBoundingClientRect();
        if(r.height && r.height<parent.clientHeight-16){
          if(r.bottom>p.bottom-8)parent.scrollTop+=r.bottom-p.bottom+8;
          else if(r.top<p.top+8)parent.scrollTop+=r.top-p.top-8;
        }
        break;
      }
    });
    document.addEventListener('click',e=>{const remove=e.target.closest('[data-remove]');if(remove)remove.closest('.conversation-attachment-preview').remove()});
  }
  return {source,render};
})();
