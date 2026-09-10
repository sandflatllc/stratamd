import { performance } from 'node:perf_hooks'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inlineSegments } from './src/renderer/inlineMarkdown'
import { stableValue } from './src/main/view-stability'
import { encodeViewUpdate } from './src/shared/view-sync'
import { applyTerminalAttachStreamEvent, EMPTY_TERMINAL_BUFFER_STATE } from './src/renderer/terminal/buffer'
import { T3EngineClient } from './src/main/engine/client'
import { fakeEngineServer } from './test/unit/support/fake-engine-socket'
import { verifyRuntime } from './src/main/engine/managed-runtime'
async function main(){
const results:any={node:process.version,at:new Date().toISOString(),inline:[],terminal:[],engine:[],runtime:[]}
const summarize=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1)}}
function bench(fn:()=>unknown,n=40){for(let i=0;i<5;i++)fn();const times=[];for(let i=0;i<n;i++){const t=performance.now();fn();times.push(performance.now()-t)}return summarize(times)}
const reply=('A thoughtful **reply** with a [reference](https://example.com), some `code`, and a concrete explanation of what should change.\n\n').repeat(15)
for(const count of [1,10,50,100]) results.inline.push({replies:count,bytesEach:reply.length,parseMs:bench(()=>{for(let i=0;i<count;i++)inlineSegments(reply+i)},20)})
for(const initial of [0,512*1024]) {let state={...EMPTY_TERMINAL_BUFFER_STATE,buffer:'x'.repeat(initial)};results.terminal.push({initialBytes:initial,chunkBytes:1024,appendMs:bench(()=>{state=applyTerminalAttachStreamEvent(state,{type:'output',data:'y'.repeat(1024)} as any)},1000)})}
const at='2026-09-03T12:00:00.000Z'
for(const count of [20,200,1000]) {
 const thread={id:'t1',projectId:'p1',title:'Measured',modelSelection:{instanceId:'codex-main',model:'gpt-5.6',options:{effort:'medium'}},runtimeMode:'full-access',interactionMode:'default',branch:'master',worktreePath:null,latestTurn:null,createdAt:at,updatedAt:at,session:{threadId:'t1',status:'idle',providerName:'codex',providerInstanceId:'codex-main',runtimeMode:'full-access',activeTurnId:null,lastError:null,updatedAt:at},backgroundLiveness:null,latestUserMessageAt:at,hasPendingApprovals:false,hasPendingUserInput:false,hasActionableProposedPlan:false}
 const shell={snapshotSequence:4,projects:[{id:'p1',title:'Audit',workspaceRoot:'/tmp/strata-audit',defaultModelSelection:null,scripts:[],createdAt:at,updatedAt:at}],threads:[thread],updatedAt:at}
 const detail={snapshotSequence:5,thread:{...thread,deletedAt:null,messages:Array.from({length:count},(_,i)=>({id:`m${count}-${i}`,role:'assistant',text:reply+i,attachments:[],turnId:`turn-${i}`,streaming:false,createdAt:at,updatedAt:at})),activities:[],checkpoints:[]},page:{beforeCursor:null,hasMore:false,snapshotSequence:5,threadSequence:5}}
 const server=fakeEngineServer(tag=>tag.startsWith('orchestration.subscribe')?[{kind:'synchronized'}]:null)
 const fetch=async(input:any)=> {const url=String(input);if(url.endsWith('/oauth/token'))return Response.json({access_token:'diagnostic',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',token_type:'Bearer',expires_in:3600,scope:'orchestration:read orchestration:operate'});if(url.endsWith('/api/auth/websocket-ticket'))return Response.json({ticket:'diagnostic',expiresAt:at});if(url.endsWith('/api/orchestration/shell'))return Response.json(shell);return Response.json(detail)}
 const client=new T3EngineClient({dataDirectory:await mkdtemp(join(tmpdir(),'strata-audit-engine-')),fetch:fetch as any,webSocket:server.WebSocket})
 await client.pair('http://engine.test','diagnostic');await client.openThread('t1');
 let previous=client.view();const viewMs=bench(()=>client.view());const stableMs=bench(()=>stableValue(previous,client.view()));
 const base:any={tabs:[],explorer:[],settings:{},engine:previous,preview:{},activeDocument:null};const next:any={...base,engine:{...previous,state:'connecting'}};const patch=encodeViewUpdate({seq:1,view:base},2,next,false)
 results.engine.push({messages:count,viewMs,viewAndStabilizeMs:stableMs,payloadBytesForStatusOnly:Buffer.byteLength(JSON.stringify(patch)),cloneMs:bench(()=>structuredClone(patch))});await client.shutdown()
}
const directory='/home/dillonc/Projects/StrataMD/release/conversation-adjustments-2026-09-08/linux-unpacked/resources/engine'
const runtime=JSON.parse(await readFile(join(directory,'runtime.json'),'utf8'))
const integrity=JSON.parse(await readFile(join(directory,runtime.integrity),'utf8'))
results.runtimeFiles=Object.keys(integrity.files).length
for(let i=0;i<3;i++){const start=performance.now();await verifyRuntime({...runtime,directory});results.runtime.push(performance.now()-start)}
await writeFile('/tmp/strata-performance-audit-20260908/micro.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))

}
main().catch(e=>{console.error(e);process.exitCode=1})
