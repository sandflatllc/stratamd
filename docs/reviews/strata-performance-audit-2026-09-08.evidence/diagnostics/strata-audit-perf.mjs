import { acquireLock } from '/home/dillonc/Projects/StrataMD/scripts/verification/lock.mjs';
import { runProcess } from '/home/dillonc/Projects/StrataMD/scripts/verification/process.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const cwd='/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T15-24-29-815Z-a07fbe7e/candidate';
const output='/tmp/strata-performance-audit-20260908'; await mkdir(output,{recursive:true});
const controller=new AbortController(); for(const s of ['SIGINT','SIGTERM']) process.on(s,()=>controller.abort());
const unlock=await acquireLock('/home/dillonc/.cache/stratamd-verification',{mode:'performance-audit',source:cwd,output},controller.signal);
const runs=[];
try { for(const [profile,args,extra] of [
 ['keystroke',['--grep','default presentation'],{}],
 ['idle',['--grep','default visual'],{STRATAMD_PERF_IDLE_MS:'15000',STRATAMD_PERF_IDLE_WARMUP_MS:'3000'}],
 ['tabs',[],{STRATAMD_PERF_TAB_RUNGS:'1,5,10'}],
 ['smoke',[],{STRATAMD_PERF_SIZES:'100000',STRATAMD_PERF_SHAPES:'rich,table-heavy'}]
]) { const started=Date.now(); console.log('START '+profile); try { await runProcess('xvfb-run',['-a','./node_modules/.bin/playwright','test','-c','playwright.performance.config.ts',...args],{cwd,env:{...process.env,STRATAMD_PERF_PROFILE:profile,STRATAMD_PERF_DISPLAY_MODE:'xvfb',STRATAMD_PERF_RUN_ID:'audit-20260908',...extra},log:output+'/'+profile+'.log',signal:controller.signal,streamOutput:true}); runs.push({profile,status:'passed',ms:Date.now()-started}); } catch(error) {runs.push({profile,status:'failed',error:String(error),ms:Date.now()-started});} await writeFile(output+'/runs.json',JSON.stringify(runs,null,2)); } } finally {await unlock();}
