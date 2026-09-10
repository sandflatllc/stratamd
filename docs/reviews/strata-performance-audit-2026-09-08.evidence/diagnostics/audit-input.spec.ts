import { test, expect } from '../e2e/test'
import { Scenario } from '../e2e/harness'
import { seededScenario, startEngine } from '../e2e/cockpit-engine-harness'
import { openThread } from '../e2e/cockpit-agent'
import { writeFile } from 'node:fs/promises'
async function measure(page:any, input:any, name:string) {
 await input.focus()
 await page.evaluate(()=>{
  const w=window as any;w.__audit={latencies:[],writes:[],longTasks:[]};
  if(!w.__auditInstalled){
   w.__auditInstalled=true;
   document.addEventListener('input',()=>{const target=w.__audit;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>target.latencies.push(performance.now()-t)))},true);
   const setter=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const t=performance.now();try{return setter.call(this,k,v)}finally{w.__audit.writes.push({bytes:v.length,ms:performance.now()-t})}}
   new PerformanceObserver(list=>w.__audit.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']})
  }
 })
 for(let i=0;i<25;i++){await page.keyboard.type('x');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
 const result=await page.evaluate(()=>{const w=window as any;const x=w.__audit;return {...x,typingPause:document.documentElement.dataset.typing??null,nodes:document.querySelectorAll('*').length}})
 result.name=name; console.log('INPUT '+JSON.stringify(result));return result
}
test('audit document discussion input scales with existing replies',async({},info)=>{
 test.setTimeout(60_000)
 const s=await Scenario.create(info,'# Audit\n\nReply target sentence.\n','audit.md')
 const out=[]
 try{
  const p=await s.launch();const id=await p.evaluate(path=>window.strata.addAnnotation(path,{kind:'comment',quote:'Reply target sentence.',from:9,to:31,text:'Performance discussion'}),s.file)
  await p.getByRole('tablist',{name:'Document review'}).getByRole('tab',{name:/^Items/}).click()
  await p.locator('.annotations-panel').getByRole('button').filter({hasText:'Reply target sentence.'}).click()
  const input=p.getByRole('region',{name:/comment thread/i}).getByRole('textbox',{name:'Reply',exact:true});await expect(input).toBeVisible()
  let prior=0
  for(const count of [0,20,80]){
   await p.evaluate(async({path,id,from,count})=>{for(let i=from;i<count;i++)await window.strata.reply(path,id,('Earlier **reply** with a [link](https://example.com) and `code`. ').repeat(30)+i)},{path:s.file,id,from:prior,count});prior=count
   await input.fill(('Long draft sentence with details. ').repeat(400));
   out.push(await measure(p,input,`${count} existing replies`))
  }
  await writeFile(info.outputPath('audit-input.json'),JSON.stringify(out,null,2))
 }finally{await s.dispose()}
})
test('audit conversation draft typing and storage',async({},info)=>{
 test.setTimeout(60_000)
 const engine=await startEngine({longHistory:true,pendingRequests:false,titles:{t1:'First thread'}});engine.complete()
 const s=await seededScenario(info,engine.origin)
 try{
  const p=await s.launch(s.file,['--remote-debugging-port=19589']);await openThread(p,'First thread')
  const input=p.locator('.chat-composer textarea').first();await expect(input).toBeVisible()
  const out=[]
  for(const size of [100,20000,100000]){await input.fill('x'.repeat(size));out.push(await measure(p,input,`${size} draft characters`))}
  await writeFile(info.outputPath('audit-composer.json'),JSON.stringify(out,null,2))
 }finally{await s.dispose();await engine.close()}
})
test('audit actual managed server first launch and relaunch',async({},info)=>{
 test.setTimeout(60_000)
 const s=await Scenario.create(info,'# Startup audit\n','startup.md')
 s.env.STRATAMD_ENGINE_MODE='managed';s.env.STRATAMD_ENGINE_BUNDLE='/home/dillonc/Projects/StrataMD/release/conversation-adjustments-2026-09-08/linux-unpacked/resources/engine'
 const rows=[]
 try{for(let i=0;i<2;i++){
  const started=performance.now();const page=await s.launch();const readyMs=performance.now()-started;
  await expect.poll(async()=>(await page.evaluate(()=>window.strata.getState())).engine.managed?.state,{timeout:25000}).toBe('running');
  const connectedMs=performance.now()-started;const engine=await page.evaluate(async()=>{const e=(await window.strata.getState()).engine;return {state:e.state,managed:e.managed?.state}})
  rows.push({launch:i,readyMs,connectedMs,...engine});console.log('STARTUP '+JSON.stringify(rows.at(-1)));await s.stop()
 }await writeFile(info.outputPath('audit-startup.json'),JSON.stringify(rows,null,2))}finally{await s.dispose()}
})
