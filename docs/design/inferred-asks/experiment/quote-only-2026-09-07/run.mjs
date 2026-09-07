import { readFile, writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { askArguments, askPrompt, askSource, ASK_JSON_SCHEMA, anchorAsks, parseStrataBlock } from '../../../../../out/ask-eval/bundle/entry.js'
const root = resolve('docs/design/inferred-asks/experiment/quote-only-2026-09-07')
const registry=process.env.ASK_EVAL_REGISTRY === '1'
const followup=registry || process.env.ASK_EVAL_FOLLOWUP === '1'
const latestPrompt=(await readFile(join(root,'quote-v2.txt'),'utf8')).trim()
const firstPrompt=(await readFile(join(root,'quote-v1.txt'),'utf8')).trim()
const outputFile=registry?'registry.jsonl':followup?'follow-up.jsonl':'runs.jsonl'
const previous = resolve(root, '../review-2026-09-07')
const cases = JSON.parse(await readFile(join(previous,'cases.json')))
for (const item of JSON.parse(await readFile(join(previous,'follow-up/cases.json')))) if (!cases.some(c=>c.id===item.id)) cases.push(item)
await writeFile(join(root,'cases.json'),JSON.stringify(cases,null,2))
const baseline = await readFile(join(previous,'follow-up/revised.txt'),'utf8')
const schema = JSON.parse(await readFile(join(previous,'schema.json')))
let n=0
const completed = await readFile(join(root,outputFile),'utf8').then(text=>new Set(text.trim().split('\n').map(line=>{const r=JSON.parse(line);return `${r.case}:${r.repeat}:${r.variant}`}))).catch(()=>new Set())
for (let repeat=0;repeat<2;repeat++) for (const [index,item] of cases.entries()) for (const variant of (followup?['quote-v2']:(index+repeat)%2?['quote','baseline']:['baseline','quote'])) {
 if(registry && item.id !== 'mixed-explicit')continue
 if(completed.has(`${item.id}:${repeat}:${variant}`))continue
 const directory=await mkdtemp(join(tmpdir(),'strata-ask-eval-'))
 const prose=askSource({text:item.text}), parsed=parseStrataBlock(item.text)
 const registered=(parsed?.results??[]).flatMap(result=>result.entry && ['question','decision'].includes(result.entry.verb)?[result.entry.text]:[])
 const prompt=variant==='quote-v2'?latestPrompt+'\n\n'+JSON.stringify({registeredRequests:registered,reply:prose}):variant==='quote'?firstPrompt+'\n\n'+JSON.stringify({registeredRequests:registered,reply:prose}):baseline+'\n'+item.text
 await writeFile(join(directory,'schema.json'),JSON.stringify(variant.startsWith('quote')?ASK_JSON_SCHEMA:schema))
 const args=askArguments('gpt-5.6-luna',directory)
 const started=performance.now()
 let stdout='',stderr='',timeout=false
 const exit=await new Promise(resolveExit=>{ const child=spawn('codex',args,{cwd:directory,env:{...process.env,CODEX_HOME:process.env.ASK_EVAL_HOME ?? process.env.CODEX_HOME},detached:true,stdio:['pipe','pipe','pipe']}); child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c); const timer=setTimeout(()=>{timeout=true;process.kill(-child.pid,'SIGKILL')},60000); child.once('error',e=>{clearTimeout(timer);stderr+=e;resolveExit(-1)});child.once('close',code=>{clearTimeout(timer);resolveExit(code)});child.stdin.end(prompt) })
 const seconds=(performance.now()-started)/1000
 let output=null;try{output=JSON.parse(await readFile(join(directory,'answer.json'),'utf8'))}catch{}
 const tools=stdout.split('\n').flatMap(line=>{try{const e=JSON.parse(line);return e.item?.type&&!['agent_message','reasoning','plan','error'].includes(e.item.type)?[e.item.type]:[]}catch{return[]}})
 const record={case:item.id,repeat,variant,seconds,exit,timeout,tools,prompt,output,stdout,anchors:output?.asks?anchorAsks(item.id,prose,output.asks,registered):[],stderr}
 await appendFile(join(root,outputFile),JSON.stringify(record)+'\n'); await rm(directory,{recursive:true,force:true})
 console.log(++n,item.id,variant,seconds.toFixed(2),exit,tools)
 if(exit!==0||!output||tools.length)process.exit(1)
}
