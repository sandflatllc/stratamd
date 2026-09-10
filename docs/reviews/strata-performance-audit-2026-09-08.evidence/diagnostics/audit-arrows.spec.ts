import {test,expect} from '../e2e/test'
import {seededScenario,startEngine} from '../e2e/cockpit-engine-harness'
import {openThread} from '../e2e/cockpit-agent'
import {writeFile} from 'node:fs/promises'
test('arrow repeat during a long transcript and active server updates',async({},info)=>{
 test.setTimeout(60_000)
 const engine=await startEngine({longHistory:true,pendingRequests:false,titles:{t1:'Arrow audit'}})
 const s=await seededScenario(info,engine.origin)
 const rows=[];let timer:any
 try{
  const p=await s.launch(s.file,['--remote-debugging-port=19589']);await openThread(p,'Arrow audit');
  const input=p.locator('.chat-composer textarea').first();await expect(input).toBeVisible();await input.fill('A long reply with several words. '.repeat(1000));await input.press('End')
  await p.evaluate(()=>{const w=window as any;w.__arrows={frames:[],tasks:[]};document.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft')return;const r=w.__arrows;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>r.frames.push(performance.now()-t)))},true);new PerformanceObserver(list=>w.__arrows.tasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']})})
  const cdp=await p.context().newCDPSession(p)
  for(const active of [false,true]){
   await p.evaluate(()=>{(window as any).__arrows={frames:[],tasks:[]}})
   let n=0;if(active)timer=setInterval(()=>engine.setMessage('Streaming update '+(++n)+' '+ 'Working on this response. '.repeat(100)),80)
   const before=await input.evaluate((e:any)=>e.selectionStart)
   for(let i=0;i<60;i++){
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37,autoRepeat:i>0});await p.evaluate(()=>new Promise(r=>requestAnimationFrame(r)))
   }
   await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37})
   clearInterval(timer);timer=null;await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
   const after=await input.evaluate((e:any)=>e.selectionStart);expect(before-after).toBe(60)
   rows.push({activeUpdates:active,pushes:n,before,after,...await p.evaluate(()=>(window as any).__arrows)});console.log('ARROWS '+JSON.stringify(rows.at(-1)))
  }
  await writeFile(info.outputPath('arrows.json'),JSON.stringify(rows,null,2))
 }finally{clearInterval(timer);await s.dispose();await engine.close()}
})
