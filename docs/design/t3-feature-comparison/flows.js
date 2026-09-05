const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const screen = params.get('screen') || 'worktrees';
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const paths = {folder:'M3 6h6l2 2h10v12H3Z',plus:'M12 5v14M5 12h14',branch:'M6 3v18m0-9c10 0 12-3 12-9M3 3h6M15 3h6M3 21h6',terminal:'m4 6 6 6-6 6m9 0h7',close:'m6 6 12 12M6 18 18 6',check:'m4 12 5 5L20 6',person:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 22v-3a8 8 0 0 1 16 0v3',chart:'M4 19V9m7 10V4m7 15v-7',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',search:'m15 15 6 6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',history:'M4 8a9 9 0 1 1-1 7M3 3v6h6M12 7v5l4 3',arrow:'M12 20V4m-6 6 6-6 6 6',file:'M5 2h9l5 5v15H5Zm9 0v6h5',device:'M3 3h18v13H3Zm5 18h8m-4-5v5'};
const icon = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.file}"/></svg>`;
const button = (text,action,cls='',attrs='') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
const field = (label,id,value,hint='',type='text') => `<label class="field"><span>${label}</span><input id="${id}" data-bind="${id}" type="${type}" value="${esc(value)}">${hint?`<small>${hint}</small>`:''}</label>`;
const rootPath = '/home/dillonc/Projects';
const st = {menu:null,modal:null,workspace:'local',base:'master',origin:true,branchSearch:'',message:'',repoStep:'sources',repoSource:'url',repoInput:'',destination:rootPath+'/t3code',folder:rootPath,selectedFolder:'',repoName:'',added:null,repoError:'',accountStep:'overview',account:0,accountTab:'Configuration',provider:'Codex',newName:'',accountName:'Codex primary',binary:'codex',accountHome:'',launchArgs:'',enabled:true,parked:[],hiddenModels:[],favModels:[],terminalDefaults:{},instanceId:'',terminal:false,terminalLines:[],engine:'connected',pairExpanded:false,pairLink:'',host:'',code:''};
const accounts = [
 {name:'Claude primary',driver:'Claude',plan:'Max',session:3,weekly:14,auto:true},
 {name:'Claude secondary',driver:'Claude',plan:'Max',session:0,weekly:2},
 {name:'Codex primary',driver:'Codex',plan:'Pro 20x',session:0,weekly:65,auto:true},
 {name:'Codex secondary',driver:'Codex',plan:'Pro 20x',session:0,weekly:75}
];
let stage = params.get('stage') || (screen==='terminal'?'launch':screen==='repositories'?'sources':screen==='accounts'?'overview':screen==='connections'?'details':'start');
function seedStage(value){
 if(screen==='worktrees'&&!['start','workspace','new','base','local-refs'].includes(value))value='start';
 stage=value; st.menu=null;
 if(screen==='terminal'){st.terminal=value==='drawer';if(value==='launch')st.menu='logo';}
 if(screen==='worktrees'){
   st.workspace=['new','base'].includes(value)?'worktree':'local';
   st.menu=value==='workspace'?'workspace':value==='base'?'branches':value==='local-refs'?'branches':null;
   if(['new','base'].includes(value))st.message='Add a usage view to Strata.';
 }
 if(screen==='repositories'){
   st.modal='project';st.repoStep=value==='github'?'repository':value==='url'?'repository':value==='created'?'sources':value;
   st.repoSource=value==='github'?'github':'url';
   if(['url','destination'].includes(value))st.repoInput='https://github.com/t3-oss/t3code.git';
   if(value==='github')st.repoInput='t3-oss/t3code';
   if(value==='created'){st.added='t3code';st.modal=null;}
   if(value==='local')st.selectedFolder='';
 }
 if(screen==='accounts'){st.modal='accounts';st.accountStep=value==='config'||value==='models'?'manage':value==='add'?'provider-pick':value==='identity'?'provider-identity':value==='provider-config'?'provider-form':'overview';st.account=2;st.accountTab=value==='models'?'Models':'Configuration';if(['identity','provider-config'].includes(value)){st.newName='Codex new';st.instanceId='codex_new';}}
 if(screen==='connections'){st.modal='engine';st.pairExpanded=value==='pair';st.engine=value==='disconnected'?'disconnected':'connected';}
}
seedStage(stage);
function announce(value){stage=value;if(parent!==window)parent.postMessage({reviewStage:value,feature:screen},location.origin==='null'?'*':location.origin);}
function gotoFeature(feature){if(parent!==window)parent.postMessage({feature},location.origin==='null'?'*':location.origin);else location.href=feature==='usage'?'mockup.html?screen=usage':'flows.html?screen='+feature;}
function topbar(){return `<header class="bar">${button('<img src="assets/strata.svg" alt="">StrataMD ⌄','logo','logo','aria-label="StrataMD menu" aria-expanded="'+(st.menu==='logo')+'"')}${button('Docs <span class="tag">1</span> ⌄','docs','doc-menu')}<div class="tab">${screen==='worktrees'?'New thread':'Working notes.md'} &nbsp; ×</div><div class="spacer"></div>${button('<span class="dot"></span> &nbsp; Connected','engine-open','quiet connection-trigger','aria-label="Engine status"')}<div class="window"><span>−</span><span>□</span><span>×</span></div></header>`;}
function sidebar(){return `<aside class="rail"><div class="rail-tab">Projects</div><div class="rail-body"><div class="search-threads">${icon('search')} Search threads <kbd>Ctrl K</kbd></div><div class="rail-label">Projects <small>Recent ⌄</small>${button('+','project-open','quiet icon','aria-label="Add project"')}</div>${button('New thread','new-thread','new-thread')}<div class="folder-row">${button('⌄ ▱ &nbsp; StrataMD','project-menu','quiet','aria-label="StrataMD project menu"')}${button('+','new-thread','icon quiet','aria-label="New thread in StrataMD"')}</div><div class="thread-row selected">☆ <span class="dot"></span> T3 additions <small>now</small></div><div class="thread-row">☆ &nbsp; Conversation navigation</div><div class="thread-row">☆ &nbsp; Working notes</div><div class="folder-row">${button('⌄ ▱ &nbsp; Outcrop','other-project','quiet')}${button('+','other-project','icon quiet')}</div><div class="thread-row">☆ &nbsp; Review preparation</div><div class="folder-row">${button('⌄ ▱ &nbsp; Mesa','other-project','quiet')}${button('+','other-project','icon quiet')}</div><div class="thread-row">☆ &nbsp; Resume prior work</div>${st.added?`<div class="folder-row">${button('⌄ ▱ &nbsp; '+esc(st.added),'new-thread','quiet')}${button('+','new-thread','icon quiet')}</div><div class="thread-row">No active threads.</div>`:''}</div><div class="shelves">› &nbsp; Snoozed &nbsp; 2<br><br>› &nbsp; Settled &nbsp; 14</div></aside>`;}
function globalMenu(){return `<div class="dropdown ${st.menu==='logo'?'global-menu':'project-menu'}" role="menu">${st.menu==='logo'?button(icon('file')+' Open file <span class="spacer"></span><kbd>Ctrl O</kbd>','docs','', 'role="menuitem"')+button(icon('person')+' Accounts','accounts-open','','role="menuitem"')+button(icon('chart')+' Usage','usage-open','','role="menuitem"')+'<div class="separator"></div>':''}${button(icon('terminal')+(st.terminal?' Hide terminal':' Terminal')+'<span class="spacer"></span><kbd>Ctrl `</kbd>','terminal-toggle','','role="menuitem"')}${st.menu==='project'?button(icon('folder')+' Add project','project-open','','role="menuitem"')+button(icon('globe')+' Publish to GitHub…','publish-open','','role="menuitem"'):button('Theme','theme','','role="menuitem"')}</div>`;}
function composer(){return `<div class="composer"><textarea data-bind="message" id="message" aria-label="First message" placeholder="Ask for changes, send follow-ups, or attach a file">${esc(st.message)}</textarea><div class="composer-tools">${button('GPT-6 Astra <small>Codex primary</small> ⌄','model-info','quiet')}${button('High · 1M ⌄','model-info','quiet')}${button('Full access ⌄','model-info','quiet')}<div class="spacer"></div>${button('+','attach-info','quiet icon')}${button(icon('arrow'),'send','send','aria-label="Send first message" '+(!st.message.trim()?'disabled':''))}</div></div>`;}
function workspaceStrip(){const label=st.workspace==='worktree'?'New worktree':st.workspace==='previous'?'Previous worktree':'Current checkout';return `<div class="workspace-strip">${button(icon(st.workspace==='local'?'folder':'branch')+' '+label+' ⌄','workspace-menu','quiet','aria-label="Workspace" aria-expanded="'+(st.menu==='workspace')+'"')}<span class="path">${st.workspace==='local'?rootPath+'/StrataMD':st.workspace==='previous'?'Existing worktree · usage-layout':'Created when you send'}</span><span class="spacer"></span>${button(icon('branch')+' '+(st.workspace==='worktree'?'From '+(st.origin?'origin/':''):'')+(st.workspace==='previous'?'usage-layout':esc(st.base))+' ⌄','branch-menu','quiet','aria-label="Branch"')}${st.menu==='workspace'?workspaceMenu():st.menu==='branches'?branchMenu():''}</div>`;}
function workspaceMenu(){return `<div class="dropdown workspace-menu" role="menu" aria-label="Choose workspace"><h3>Workspace</h3>${button(icon('folder')+'<div><strong>Current checkout</strong><small>Use this project folder.</small></div>','workspace-local',st.workspace==='local'?'chosen':'','role="menuitem"')}${button(icon('branch')+'<div><strong>New worktree</strong><small>Start in a separate working folder.</small></div>','workspace-new',st.workspace==='worktree'?'chosen':'','role="menuitem"')}${button(icon('history')+'<div><strong>Previous worktree</strong><small>usage-layout · used 2 hours ago</small></div>','workspace-previous',st.workspace==='previous'?'chosen':'','role="menuitem"')}<p class="explanation">The previous-worktree option appears when the project has one available.</p></div>`;}
function branchMenu(){const isBase=st.workspace==='worktree';const refs=['master','feature/navigation','usage-layout'].filter(n=>n.includes(st.branchSearch));return `<div class="dropdown branch-menu" role="dialog" aria-label="${isBase?'Choose starting branch':'Choose branch'}"><input type="search" id="branchSearch" data-bind="branchSearch" placeholder="Search refs…" aria-label="Search refs" value="${esc(st.branchSearch)}"><h3>${isBase?'Start the worktree from':'Project branches'}</h3><div id="branch-results">${refs.map(n=>button(icon('branch')+esc(n)+`<span class="spacer"></span><small>${n==='master'?'current':n==='usage-layout'?'worktree':''}</small>`,'branch-'+n,n===st.base?'chosen':'')).join('')}${refs.length?'':isBase?'<p class="explanation">No matching refs.</p>':button('+ Create new ref '+esc(st.branchSearch),'create-ref')}</div>${isBase?`<label>Start from origin <input type="checkbox" id="origin" ${st.origin?'checked':''}></label><p class="explanation">Use the latest matching branch on origin.</p>`:`<p class="explanation">Choosing a local branch would switch this checkout. A worktree uses its own folder.</p>`}</div>`;}
function newThread(){return `<section class="canvas"><div class="project-select"><label>Project &nbsp; <select aria-label="Conversation project"><option>StrataMD</option></select></label>${button('Add project','project-open','quiet')}</div><div class="new-body"><h1>What would you like to work on in <span>StrataMD</span>?</h1>${composer()}${workspaceStrip()}</div></section>`;}

function documentView(){return `<section class="canvas"><div class="document-head"><strong>Working notes.md</strong><div class="spacer"></div><span>Visual &nbsp; · &nbsp; Saved</span></div><article class="document"><small>STRATA / WORKING NOTES</small><h1>Tools where you need them.</h1><p>Usage can have its own tab. Project setup and account controls open over the work already on screen.</p><h2>What we’re bringing into Strata</h2><ul><li>A usage dashboard.</li><li>An optional terminal drawer.</li><li>Workspace choices in a new conversation.</li></ul><p class="muted">Outcrop integration is being worked out separately.</p></article></section>`;}
function terminalDrawer(){return `<section class="terminal-drawer" aria-label="Terminal"><header class="terminal-header">${icon('terminal')}<strong>Terminal</strong><span class="tag">Shell 1</span><code>~/Projects/StrataMD</code><span class="spacer"></span>${button('×','terminal-toggle','quiet icon','aria-label="Close terminal"')}</header><div class="terminal-output" id="terminal-output"><div><span class="prompt">dillon@workstation</span> ~/Projects/StrataMD</div><div class="muted">Simulated shell · pwd, git status, help, clear</div>${st.terminalLines.map(x=>`<pre>${esc(x)}</pre>`).join('')}<form id="terminal-form"><span class="prompt">❯</span><input aria-label="Simulated terminal command" autocomplete="off" spellcheck="false"></form></div></section>`;}
function modalFrame(title,subtitle,body,footer,cls='',back=null,tools=''){return `<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1"><header class="modal-head"><div>${back?button('← '+back[0],back[1],'back-link'):''}<h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div>${tools}<span class="spacer"></span>${button('×','modal-close','quiet icon close','aria-label="Close dialog"')}</header><div class="modal-body">${body}</div><footer class="modal-footer">${footer}</footer></section></div>`;}
function sourceRow(name,desc,action,glyph){return button(`<span class="source-icon">${icon(glyph)}</span><div><strong>${name}</strong><small>${desc}</small></div><span class="chev">›</span>`,action,'source-row');}
function projectModal(){
 let title='Add project',subtitle='Choose a source on your workstation.',body='',footer='';
 const cancel=button('Cancel','modal-close','quiet');
 if(st.repoStep==='sources'){
  body=sourceRow('Local folder','Browse an existing folder, or create a new one.','repo-local','folder')+sourceRow('Git URL','Clone a repository from its URL.','repo-url','globe')+sourceRow('GitHub repository','Look up a repository by owner and name.','repo-github','branch')+`<p class="row-note">Other hosts work through Git URL. Provider-specific shortcuts appear when configured in t3.</p>`;
  footer=`<small>Opened from Projects +</small>${cancel}`;
 }else if(st.repoStep==='local'||st.repoStep==='browse-destination'){
  const destinationBrowse=st.repoStep==='browse-destination';title=destinationBrowse?'Choose destination folder':'Add a local folder';subtitle='Browse folders on the paired workstation.';
  const inProject=st.folder.split('/').length>4;
  const folders=inProject?[]:['Example app','StrataMD','Outcrop','Mesa'];
  body=`<div class="browser-crumb">${button('↑','folder-up','quiet icon','aria-label="Parent folder"')}<span>Home</span><span>/</span>${button('Projects','folder-home','quiet')}<span>${inProject?'/ '+esc(st.folder.split('/').at(-1)):''}</span></div>`+field('Folder path','folder',st.folder)+`<div class="folder-browser">${folders.length?folders.map(n=>button(icon('folder')+n+'<span>Open ›</span>','folder-'+n,st.selectedFolder===n?'selected':'')).join(''):'<p class="row-note" style="padding:20px;margin:0">No subfolders in this example.</p>'}</div><div class="dialog-actions-inline" style="margin-top:13px">${button('+ New folder','folder-create','quiet')}<span class="spacer"></span><small>${st.selectedFolder?'Selected: '+esc(st.selectedFolder):'Use the current folder, or browse into one.'}</small></div>`;
  footer=button('← Back',destinationBrowse?'repo-destination':'repo-sources','quiet back')+cancel+button(destinationBrowse?'Use this folder':'Add folder',destinationBrowse?'destination-selected':'project-added','primary');
 }else if(st.repoStep==='new-folder'){
  title='Create a project folder';subtitle='The folder will be created inside '+esc(st.folder)+'.';body=field('Folder name','repoName',st.repoName,'A folder and project will be created when you confirm.');
  footer=button('← Back','repo-local','quiet back')+cancel+button('Create & add','folder-created','primary',!st.repoName.trim()?'disabled':'');
 }else if(st.repoStep==='repository'){
  title=st.repoSource==='github'?'Clone from GitHub':'Clone a repository';subtitle=st.repoSource==='github'?'Find the repository before choosing its local folder.':'Enter the Git clone URL.';
  body=field(st.repoSource==='github'?'GitHub repository':'Repository URL','repoInput',st.repoInput,st.repoSource==='github'?'For example, t3-oss/t3code. Uses the GitHub login already configured in t3.':'HTTPS and SSH URLs are supported.')+`<p class="row-note">${st.repoSource==='github'?'GitHub is configured on this example workstation.':'No files are downloaded until the destination is confirmed.'}</p>`+(st.repoError?`<p class="inline-error" role="alert">${esc(st.repoError)}</p>`:'');
  footer=button('← Back','repo-sources','quiet back')+cancel+button(st.repoSource==='github'?'Look up repository':'Continue','repo-lookup','primary',!st.repoInput.trim()?'disabled':'');
 }else if(st.repoStep==='destination'){
  title='Choose the working folder';subtitle='Clone this repository and add it to Projects.';
  const name=st.repoInput.replace(/\.git$/,'').split('/').filter(Boolean).slice(-2).join('/');
  body=`<div class="result-card">${icon('branch')}<div><strong>${esc(name)}</strong><small>${st.repoSource==='github'?'GitHub repository · example lookup result':esc(st.repoInput)}</small></div><span class="tag">${st.repoSource==='github'?'Public':'Git URL'}</span></div><label class="field"><span>Destination on the workstation</span><div class="input-row"><input id="destination" data-bind="destination" value="${esc(st.destination)}" aria-label="Clone destination">${button('Browse…','destination-browse')}</div><small>A new folder will be created here.</small></label>`+(st.repoError?`<p class="inline-error" role="alert">${esc(st.repoError)}</p>`:'');
  footer=button('← Back','repo-repository','quiet back')+cancel+button('Create & clone','repo-clone','primary');
 }
 return modalFrame(title,subtitle,body,footer);
}
function usageWindow(label,amount){return `<div class="usage-window"><span>${label}</span><div class="track"><i style="width:${amount}%;${amount>60?'background:#cdab54':''}"></i></div><b>${amount}%<small>${label==='Session'?'1:10 PM':'Mon 9 PM'}</small></b></div>`;}
function accountsOverview(){return [...new Set(accounts.map(a=>a.driver))].map(driver=>`<section class="accounts-group"><div class="group-head"><h3>${driver}</h3><small>${accounts.filter((a,i)=>a.driver===driver&&!st.parked.includes(i)).length} of ${accounts.filter(a=>a.driver===driver).length} ready</small><label class="terminal-default">Terminal <select data-terminal-default="${driver}" aria-label="${driver} terminal default">${["System default","Auto",...accounts.filter(a=>a.driver===driver).map(a=>a.name)].map(n=>`<option ${st.terminalDefaults[driver]===n?"selected":""}>${esc(n)}</option>`).join("")}</select></label></div><div class="account-list">${accounts.map((a,i)=>a.driver!==driver?'':`<div class="account ${st.parked.includes(i)?'parked':''}"><span class="dot"></span><div class="identity"><strong>${esc(a.name)}</strong>${a.auto?'<span class="tag">Auto</span>':''}<small>${st.parked.includes(i)?'Parked':a.plan+' · Signed in'} &nbsp; <span class="tag">own home</span></small></div><div class="usage-windows">${usageWindow('Session',a.session)}${usageWindow('Weekly',a.weekly)}</div>${button('<span class="toggle"></span> Park','park-'+i,'park','aria-label="Park '+esc(a.name)+'" aria-pressed="'+st.parked.includes(i)+'"')}${button('⋯','manage-'+i,'more','aria-label="Manage '+esc(a.name)+'"')}</div>`).join('')}</div></section>`).join('')+`<section class="accounts-group"><div class="group-head"><h3>Not set up</h3><small>no logins on this engine</small></div><div class="account-list"><div class="model-row" style="padding:13px 16px"><span>Cursor · Grok · OpenCode</span><small>Disabled</small></div></div></section>`;}
function accountsModal(){
 let title='Accounts',subtitle='Provider logins on 127.0.0.1:3774. Auto picks the least loaded usable account.',body='',footer='',tools='',back=null;
 if(st.accountStep==='overview'){
  body=accountsOverview();tools=`<div class="accounts-tools">${button('+ Add provider','account-add','quiet')}</div>`;
  footer=button('Engine','engine-open','quiet')+button(icon('chart')+' Usage','usage-open','quiet')+'<span class="spacer"></span>'+button('Close','modal-close','primary');
 }else if(st.accountStep==='manage'){
  const a=accounts[st.account];title=a.name;subtitle=a.driver+' · Signed in · '+a.plan;back=['Accounts','accounts-back'];
  body=`<div class="modal-tabs">${['Configuration','Models'].map(t=>button(t,'account-tab-'+t,st.accountTab===t?'active':'')).join('')}</div>`;
  if(st.accountTab==='Configuration')body+=field('Display name','accountName',st.accountName)+`<div class="detail-status"><span class="dot"></span>Authenticated <span class="spacer"></span><label>Enabled &nbsp; <input id="enabled" type="checkbox" ${st.enabled?'checked':''}></label></div><p class="row-note">Enabled makes this provider available. Park excludes this login from automatic account selection.</p><details class="details-toggle"><summary>Advanced configuration</summary>${field('Binary path','binary',st.binary)}${field(a.driver==='Codex'?'Shadow home path':'Account home path','accountHome',st.accountHome,'Uses the existing provider configuration on the workstation.')}${field('Launch arguments','launchArgs',st.launchArgs)}</details>`;
  else body+=`${(accounts[st.account].driver==='Claude'?['Claude Fable 5.1','Claude Mythos','Claude Haiku']:['GPT-6 Astra','GPT-5.6 Sol','GPT-5.6 Terra']).map((m,i)=>`<div class="model-row"><span style="${st.hiddenModels.includes(i)?'opacity:.4':''}">${m}</span>${button(st.favModels.includes(i)?'★':'☆','favorite-'+i,'quiet','aria-label="Favorite '+m+'"')}${button(st.hiddenModels.includes(i)?'Show':'Hide','hide-'+i,'quiet')}</div>`).join('')}<p class="row-note">Favorites and visibility control this provider’s model picker. Model names here are examples.</p>`;
  footer=button('Cancel','accounts-back','quiet back')+button('Save changes','account-save','primary');
 }else if(st.accountStep==='provider-pick'){
  title='Add a provider';subtitle='Choose the provider to configure on this workstation.';back=['Accounts','accounts-back'];
  body=['Codex','Claude','Cursor','Grok','OpenCode'].map(n=>sourceRow(n,'Configure an additional provider instance.','provider-'+n,'person')).join('');footer=button('Cancel','accounts-back','quiet');
 }else if(st.accountStep==='provider-identity'){
  title='Name this '+st.provider+' account';subtitle='Give the instance a recognizable name.';back=['Choose provider','account-add'];
  body=field('Display name','newName',st.newName)+`<details class="details-toggle"><summary>Instance identifier</summary>${field('Instance ID','instanceId',st.instanceId,'Generated from the name. Letters, digits, hyphens, and underscores.')}</details>`;
  footer=button('Cancel','accounts-back','quiet back')+button('Continue','provider-continue','primary');
 }else{
  title='Configure '+st.provider;subtitle='Use the provider installed on your workstation.';back=['Account name','provider-back'];
  body=field('Binary path','binary',st.binary)+field('Account home path','accountHome',st.accountHome,'Optional. Uses the provider default when empty.')+field('Launch arguments','launchArgs',st.launchArgs);footer=button('Cancel','accounts-back','quiet back')+button('Add provider','provider-save','primary');
 }
 return modalFrame(title,subtitle,body,footer,'accounts-modal',back,tools);
}
function engineModal(){const disconnected=st.engine==='disconnected';return modalFrame('Engine','The T3 server that runs your agents.',`<dl class="facts"><div><dt>Server</dt><dd><code>127.0.0.1:3774</code></dd></div><div><dt>Status</dt><dd>${disconnected?'Disconnected':'<span class="dot"></span> Connected'}</dd></div><div><dt>Session</dt><dd>Renews itself</dd></div></dl>${disconnected?`<p class="inline-error">The server could not be reached.</p>${button('Reconnect','reconnect','primary')}`:`<div class="dialog-actions-inline">${button('Reconnect','reconnect','quiet')}${button('Open t3 connection settings ↗','t3-settings','quiet')}</div>`}<details class="pairing" ${st.pairExpanded?'open':''}><summary>Pair again</summary><p>Pairing again replaces the saved connection.</p>${field('Pairing link','pairLink',st.pairLink)}<small>or</small>${field('Host','host',st.host)}${field('Code','code',st.code)}${button('Pair again','pair','primary',!(st.pairLink.trim()||(st.host.trim()&&st.code.trim()))?'disabled':'')}</details>`,button('Accounts','accounts-open','quiet')+'<span class="spacer"></span>'+button('Close','modal-close','primary'),'engine-modal');}
function publishModal(){return modalFrame('Publish to GitHub','Create a remote repository for this local project.',field('Repository name','repoName',st.repoName||'StrataMD')+`<label class="field"><span>Visibility</span><select><option>Private</option><option>Public</option></select></label><p class="row-note">This is an optional action in the project menu.</p>`,button('Cancel','modal-close','quiet back')+button('Publish','publish','primary'));}
function render(){
 const content=screen==='worktrees'?newThread():documentView();
 $('#app').innerHTML=topbar()+`<div class="shell ${st.terminal?'':'terminal-closed'}">${sidebar()}<main class="center">${content}${st.terminal?terminalDrawer():''}</main></div>`+(['logo','project'].includes(st.menu)?globalMenu():'')+(st.modal==='project'?projectModal():st.modal==='accounts'?accountsModal():st.modal==='engine'?engineModal():st.modal==='publish'?publishModal():'')+'<div class="simulated-label">Interactive design prototype · example data</div>';
 $('.modal')?.focus({preventScroll:true});
 if(st.terminal){$('#terminal-form').onsubmit=e=>{e.preventDefault();const cmd=e.currentTarget.querySelector('input').value.trim();if(!cmd)return;if(cmd==='clear')st.terminalLines=[];else st.terminalLines.push('❯ '+cmd,cmd==='pwd'?rootPath+'/StrataMD':cmd==='git status'?'On branch master\nWorking tree clean.':cmd==='help'?'Simulated commands: pwd, git status, clear. No real command is executed.':'This prototype does not execute commands. Try pwd or help.');render();$('#terminal-form input').focus();$('#terminal-output').scrollTop=$('#terminal-output').scrollHeight;};}
}
let toastTimer;function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);}
function closeModal(){st.modal=null;st.menu=null;render();}
function openProject(){st.menu=null;st.modal='project';st.repoStep='sources';st.repoError='';render();if(screen==='repositories')announce('sources');}
function nextRepo(value){st.repoStep=value;st.repoError='';render();if(screen==='repositories')announce(value==='repository'?(st.repoSource==='github'?'github':'url'):value);}
function saveMockProject(name){st.added=name;st.modal=null;render();announce('created');toast('Prototype: '+name+' added to the sidebar. No files, repository, or real project were created.');}
document.addEventListener('click',e=>{
 if(e.target.classList.contains('modal-backdrop')){closeModal();return;}
 const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action;
 if(a==='logo'||a==='project-menu'){st.menu=st.menu===(a==='logo'?'logo':'project')?null:a==='logo'?'logo':'project';render();if(screen==='terminal'&&a==='logo')announce('launch');return;}
 if(a==='modal-close'){closeModal();return;}
 if(a==='project-open'){openProject();return;}
 if(a==='accounts-open'){st.modal='accounts';st.accountStep='overview';st.menu=null;render();return;}
 if(a==='engine-open'){st.modal='engine';st.menu=null;render();return;}
 if(a==='usage-open'){gotoFeature('usage');return;}
 if(a==='terminal-toggle'){st.terminal=!st.terminal;st.menu=null;render();if(screen==='terminal')announce(st.terminal?'drawer':'closed');if(st.terminal)$('#terminal-form input').focus();return;}
 if(a==='new-thread'){if(screen!=='worktrees'){gotoFeature('worktrees');return;}st.modal=null;st.menu=null;render();announce('start');return;}
 if(a==='workspace-menu'){st.menu=st.menu==='workspace'?null:'workspace';render();announce('workspace');return;}
 if(a==='branch-menu'){st.menu=st.menu==='branches'?null:'branches';st.branchSearch='';render();announce(st.workspace==='worktree'?'base':'local-refs');return;}
 if(a.startsWith('workspace-')){st.workspace=a==='workspace-new'?'worktree':a==='workspace-previous'?'previous':'local';st.menu=null;render();announce(st.workspace==='worktree'?'new':st.workspace==='previous'?'workspace':'start');return;}
 if(a==='create-ref'){st.base=st.branchSearch;st.menu=null;render();toast('Example branch selected. The real checkout was not changed.');return;}
 if(a.startsWith('branch-')){const b=a.slice(7);if(b==='usage-layout'&&st.workspace!=='worktree')st.workspace='previous';st.base=b;st.menu=null;render();announce(st.workspace==='worktree'?'new':'start');return;}
 if(a==='send'&&st.message.trim()){st.menu=null;render();toast('Prototype only. Sending starts the normal conversation in the selected workspace.');return;}
 if(a==='repo-sources'){nextRepo('sources');return;}
 if(a==='repo-local'){st.folder=rootPath;st.selectedFolder='';nextRepo('local');return;}
 if(a==='repo-url'||a==='repo-github'){st.repoSource=a==='repo-github'?'github':'url';st.repoInput='';nextRepo('repository');return;}
 if(a==='repo-repository'){nextRepo('repository');return;}
 if(a==='repo-lookup'){
  const valid=st.repoSource==='github'?/^[\w.-]+\/[\w.-]+$/.test(st.repoInput.trim()):/^(https?:\/\/|ssh:\/\/|git@)/.test(st.repoInput.trim());
  if(!valid){st.repoError=st.repoSource==='github'?'Enter owner/repository, such as t3-oss/t3code.':'Enter an HTTPS or SSH Git URL.';render();return;}
  st.destination=rootPath+'/'+st.repoInput.trim().replace(/\.git$/,'').split('/').at(-1);nextRepo('destination');return;
 }
 if(a==='repo-destination'){nextRepo('destination');return;}
 if(a==='destination-browse'){st.folder=rootPath;st.selectedFolder='';nextRepo('browse-destination');return;}
 if(a==='destination-selected'){st.destination=st.folder+'/'+st.repoInput.trim().replace(/\.git$/,'').split('/').at(-1);nextRepo('destination');return;}
 if(a==='repo-clone'){if(!st.destination.startsWith('/')){st.repoError='Enter an absolute destination path.';render();return;}if(st.destination===rootPath+'/StrataMD'){st.repoError='That folder already contains a project. Choose a new folder.';render();return;}saveMockProject(st.destination.split('/').filter(Boolean).at(-1));return;}
 if(a==='folder-up'){st.folder=st.folder.split('/').slice(0,-1).join('/')||'/';st.selectedFolder='';render();return;}
 if(a==='folder-home'){st.folder=rootPath;st.selectedFolder='';render();return;}
 if(a==='folder-create'){nextRepo('new-folder');return;}
 if(a==='folder-created'){if(!st.repoName.trim())return;saveMockProject(st.repoName);return;}
 if(a.startsWith('folder-')){st.selectedFolder=a.slice(7);st.folder=st.folder+'/'+st.selectedFolder;render();return;}
 if(a==='project-added'){saveMockProject(st.folder.split('/').filter(Boolean).at(-1)||'Project');return;}
 if(a==='accounts-back'){st.accountStep='overview';render();if(screen==='accounts')announce('overview');return;}
 if(a.startsWith('manage-')){st.account=Number(a.slice(7));st.accountStep='manage';st.accountTab='Configuration';st.accountName=accounts[st.account].name;st.binary=accounts[st.account].driver==='Codex'?'codex':'claude';render();if(screen==='accounts')announce('config');return;}
 if(a.startsWith('park-')){const i=Number(a.slice(5));st.parked=st.parked.includes(i)?st.parked.filter(x=>x!==i):[...st.parked,i];render();return;}
 if(a.startsWith('account-tab-')){st.accountTab=a.slice(12);render();if(screen==='accounts')announce(st.accountTab==='Models'?'models':'config');return;}
 if(a==='account-add'){st.accountStep='provider-pick';render();if(screen==='accounts')announce('add');return;}
 if(a==='account-save'){accounts[st.account].name=st.accountName;st.accountStep='overview';render();toast('Example settings saved in this preview only.');return;}
 if(a==='provider-continue'){if(!st.newName.trim()){toast('Enter an account name.');return;}st.accountStep='provider-form';render();if(screen==='accounts')announce('provider-config');return;}
 if(a==='provider-back'){st.accountStep='provider-identity';render();if(screen==='accounts')announce('identity');return;}
 if(a==='provider-save'){accounts.push({name:st.newName||st.provider+' new',driver:st.provider,plan:'Example account',session:0,weekly:0});st.accountStep='overview';render();toast('Example provider added in the mockup. The workstation is unchanged.');return;}
 if(a.startsWith('provider-')){st.provider=a.slice(9);st.binary=st.provider==='Claude'?'claude':st.provider.toLowerCase();st.newName=st.provider+' new';st.instanceId=st.newName.toLowerCase().replaceAll(' ','_');st.accountStep='provider-identity';render();if(screen==='accounts')announce('identity');return;}
 if(a.startsWith('hide-')||a.startsWith('favorite-')){const i=Number(a.split('-')[1]),key=a.startsWith('hide-')?'hiddenModels':'favModels';st[key]=st[key].includes(i)?st[key].filter(x=>x!==i):[...st[key],i];render();return;}
 if(a==='reconnect'){st.engine='connected';render();toast('Prototype connected state. No real reconnect request was sent.');return;}
 if(a==='pair'){toast('Pairing preview only. Your real engine connection was not changed.');return;}
 if(a==='publish-open'){st.menu=null;st.modal='publish';render();return;}
 if(a==='publish'){closeModal();toast('Publishing preview only. No remote repository was created.');return;}
 if(a==='t3-settings'){window.open('http://127.0.0.1:3774/settings/connections','_blank','noopener');return;}
 const messages={'docs':'The existing document controls remain here.','theme':'The existing theme controls remain here.','model-info':'Existing model, thinking, and access controls.','attach-info':'The existing file attachment picker remains here.','other-project':'Other projects remain available in the sidebar.'};
 toast(messages[a]||'This control is part of the design preview.');
});
document.addEventListener('input',e=>{
 const id=e.target.dataset.bind;if(!id)return;st[id]=e.target.value;
 if(id==='newName'){st.instanceId=st.newName.toLowerCase().replace(/[^a-z0-9_-]+/g,'_');const el=$('#instanceId');if(el)el.value=st.instanceId;}
 if(id==='message'){const b=$('[data-action="send"]');if(b)b.disabled=!st.message.trim();}
 if(id==='repoInput'){const b=$('[data-action="repo-lookup"]');if(b)b.disabled=!st.repoInput.trim();}
 if(id==='repoName'){const b=$('[data-action="folder-created"]');if(b)b.disabled=!st.repoName.trim();}
 if(['pairLink','host','code'].includes(id)){const b=$('[data-action="pair"]');if(b)b.disabled=!(st.pairLink.trim()||(st.host.trim()&&st.code.trim()));}
 if(id==='branchSearch'){const pos=e.target.selectionStart;render();$('#branchSearch').focus();if(pos!==null&&$('#branchSearch').type!=='search')$('#branchSearch').setSelectionRange(pos,pos);}
});
document.addEventListener('change',e=>{if(e.target.dataset.terminalDefault)st.terminalDefaults[e.target.dataset.terminalDefault]=e.target.value;if(e.target.id==='origin'){st.origin=e.target.checked;render();}if(e.target.id==='enabled')st.enabled=e.target.checked;});
document.addEventListener('toggle',e=>{if(e.target.matches?.('.pairing')){st.pairExpanded=e.target.open;if(st.pairExpanded&&screen==='connections')announce('pair');}},true);
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){if(st.menu){st.menu=null;render();}else if(st.modal)closeModal();return;}
 if((e.ctrlKey||e.metaKey)&&e.code==='Backquote'){e.preventDefault();st.terminal=!st.terminal;st.menu=null;render();if(screen==='terminal')announce(st.terminal?'drawer':'closed');}
 if(e.key==='Tab'&&st.modal){const modal=$('.modal'),focusable=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select,summary,a[href]')].filter(x=>x.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
window.addEventListener('message',e=>{if(e.source!==parent)return;if(e.origin!==location.origin&&e.origin!=='null')return;if(e.data?.setReviewStage){seedStage(e.data.setReviewStage);render();}});
render();
window.reviewState=st;
