import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('.', import.meta.url))
const runtime = join(root, 'runtime/0.0.38')
const require = createRequire(join(runtime, 'package.json'))
const native = {}
for (const name of ['node-pty', '@ff-labs/fff-node', 'msgpackr-extract']) {
  try { name === '@ff-labs/fff-node' ? await import(pathToFileURL(join(runtime,'node_modules/@ff-labs/fff-node/dist/src/index.js'))) : require(name); native[name] = 'loaded' } catch(e) { native[name] = e.message }
}
const base = join(root, 'data/t3')
await mkdir(base, {recursive:true,mode:0o700})
const token = randomBytes(32).toString('base64url')
const node = join(runtime, 'node_modules/node/bin/node')
const entry = join(runtime, 'node_modules/t3/dist/bin.mjs')
const reservation = createServer()
await new Promise(r => reservation.listen(0,'127.0.0.1',r))
const port=reservation.address().port
await new Promise(r => reservation.close(r))
const child = spawn(node, [entry, '--base-dir', base, '--host','127.0.0.1','--port',String(port),'--no-browser','--bootstrap-fd','3'], {
  cwd:root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('T3CODE_'))), stdio:['ignore','pipe','pipe','pipe']
})
let logs = ''
const sanitize = text => text.replaceAll(token,'[bootstrap omitted]').replace(/([#?]token=)[^\s]+/g,'$1[omitted]')
child.stdout.on('data', chunk => { logs += sanitize(String(chunk)) })
child.stderr.on('data', chunk => { logs += sanitize(String(chunk)) })
child.stdio[3].on('error', e => { logs += e.message })
child.stdio[3].end(JSON.stringify({mode:'desktop',noBrowser:true,port,t3Home:base,host:'127.0.0.1',desktopBootstrapToken:token,tailscaleServeEnabled:false,tailscaleServePort:443}))
let state
const deadline=Date.now()+45000
while(Date.now()<deadline && child.exitCode===null) {
  try { state=JSON.parse(await readFile(join(base,'userdata/server-runtime.json'),'utf8')); if(state.pid===child.pid) break } catch {}
  await new Promise(r=>setTimeout(r,100))
}
const result = {native,pid:child.pid,exitCode:child.exitCode,runtime:state}
try {
 if(!state) throw new Error('No runtime record within 45 seconds')
 const response=await fetch(state.origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',subject_token:token,subject_token_type:'urn:t3:params:oauth:token-type:environment-bootstrap',requested_token_type:'urn:ietf:params:oauth:token-type:access_token',client_label:'Strata phase 1',client_device_type:'desktop',client_os:'linux'})})
 const auth=await response.json(); result.exchange={status:response.status,scope:auth.scope}
 if(!response.ok) throw new Error(JSON.stringify(auth))
 const headers={authorization:`Bearer ${auth.access_token}`}
 const shell=await fetch(state.origin+'/api/orchestration/shell',{headers}); result.shell={status:shell.status,body:await shell.json()}
 const ticketResponse=await fetch(state.origin+'/api/auth/websocket-ticket',{method:'POST',headers}); const ticket=await ticketResponse.json()
 const url=new URL('/ws',state.origin); url.protocol='ws:'; url.searchParams.set('wsTicket',ticket.ticket)
 const socket=new WebSocket(url)
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
 const rpc=tag=>new Promise((resolve,reject)=>{
   const id=randomBytes(8).toString('hex');const timer=setTimeout(()=>reject(new Error(tag+' timed out')),15000)
   const listener=event=>{const f=JSON.parse(String(event.data));if(f._tag==='Ping')socket.send(JSON.stringify({_tag:'Pong'}));if(f.requestId===id&&f._tag==='Exit'){clearTimeout(timer);socket.removeEventListener('message',listener);f.exit._tag==='Success'?resolve(f.exit.value):reject(new Error(JSON.stringify(f.exit)))}}
   socket.addEventListener('message',listener);socket.send(JSON.stringify({_tag:'Request',id,tag,payload:{},headers:[]}))
 })
 await rpc('server.refreshProviders'); const config=await rpc('server.getConfig'); result.providers=config.providers?.map(p=>({instanceId:p.instanceId,driver:p.driver,installed:p.installed,status:p.status,message:p.message,authStatus:p.auth?.status,version:p.version,models:p.models?.length}))
 result.configKeys=Object.keys(config)
 const settings=await rpc('server.getSettings'); result.settingKeys=Object.keys(settings)
 await writeFile(join(root,'settings-schema-sample.json'),JSON.stringify(settings,null,2),{mode:0o600})
 socket.close()
 if(process.argv.includes('--packaged')) {
 const {T3EngineClient}=await import('../../../../../src/main/engine/client.ts')
 const data=join(root,'packaged-profile/data/stratamd')
 await mkdir(data,{recursive:true,mode:0o700})
 const client=new T3EngineClient({dataDirectory:data,terminalShimDirectory:null})
 await client.initialize();await client.pair(state.origin,token)
 result.existingClient=client.view().state
 const projectId=await client.createProject({title:'Bundled engine proof',workspaceRoot:root})
 const threadId=await client.createThread({projectId,title:'Stock server proof',model:'gpt-5.6-luna',effort:'low',access:'approval-required',instanceId:'codex'})
 await client.startTurn(threadId,{text:'Reply with exactly STRATA_BUNDLED_OK. Do not use tools or change files.',model:'gpt-5.6-luna',effort:'low',access:'approval-required',instanceId:'codex'})
 await client.openThread(threadId)
 const turnDeadline=Date.now()+90000
 while(Date.now()<turnDeadline){const thread=client.view().projects.flatMap(p=>p.threads).find(t=>t.id===threadId);if(JSON.stringify(thread).includes('STRATA_BUNDLED_OK') && thread?.status!=='running'){result.turn=thread;break}await new Promise(r=>setTimeout(r,200))}
 await client.shutdown()
 const app=spawn('xvfb-run',['-a',join(root,'package/linux-unpacked/stratamd-app'),'--no-sandbox','--remote-debugging-port=19385'],{cwd:root,env:{...process.env,XDG_CONFIG_HOME:join(root,'packaged-profile/config'),XDG_DATA_HOME:join(root,'packaged-profile/data'),XDG_CACHE_HOME:join(root,'packaged-profile/cache'),XDG_RUNTIME_DIR:join(root,'packaged-profile/run'),STRATAMD_USER_DATA:join(root,'packaged-profile/electron')},stdio:['ignore','ignore','ignore']})
 console.log('Packaged app launched for inspection on CDP 19385')
 await new Promise(r=>{app.once('exit',r);process.once('SIGTERM',()=>{app.kill('SIGTERM');r()})})
 }
 result.environmentId=await readFile(join(base,'userdata/environment-id'),'utf8')
} catch(e) { result.error=e.message }
finally {
 child.kill('SIGTERM')
 await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))])
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
 await writeFile(join(root,'bootstrap.log'),logs,{mode:0o600})
 await writeFile(join(root,'bootstrap-result.json'),JSON.stringify(result,null,2),{mode:0o600})
 console.log(JSON.stringify(result,null,2))
}
