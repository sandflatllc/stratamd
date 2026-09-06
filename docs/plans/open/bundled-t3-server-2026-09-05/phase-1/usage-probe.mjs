import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root=fileURLToPath(new URL('.',import.meta.url))
const output={measuredAt:new Date().toISOString()}
const child=spawn('codex',['app-server'],{cwd:root,stdio:['pipe','pipe','pipe']})
let sequence=0,buffer=''; const pending=new Map()
child.stdout.on('data',chunk=>{buffer+=chunk;let nl;while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);try{const response=JSON.parse(line);const p=pending.get(response.id);if(p){pending.delete(response.id);clearTimeout(p.timer);response.error?p.reject(new Error(JSON.stringify(response.error))):p.resolve(response.result)}}catch{}}})
child.stderr.resume()
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(new Error(method+' timed out')),20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n')})
try {await request('initialize',{clientInfo:{name:'strata_usage_probe',version:'0.1.0'}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n'); output.codex=await request('account/rateLimits/read',{}); const account=await request('account/read',{refreshToken:false});output.codexPlan=account.account?.planType;output.codexAccountType=account.account?.type} catch(e){output.codexError=e.message} finally {child.kill('SIGTERM')}
try {
 const {query}=await import('./runtime/0.0.38/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
 let release
 const prompt={async *[Symbol.asyncIterator](){await new Promise(r=>{release=r})}}
 const q=query({prompt,options:{cwd:root,persistSession:false,settingSources:[],tools:[],pathToClaudeCodeExecutable:'/home/dillonc/.local/bin/claude'}})
 try {output.claude=await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Claude usage timed out')),25000))])} finally {q.close();release?.()}
}catch(e){output.claudeError=e.message}
await writeFile(join(root,'usage-result.json'),JSON.stringify(output,null,2),{mode:0o600})
console.log(JSON.stringify(output,null,2))
process.exit(0)
