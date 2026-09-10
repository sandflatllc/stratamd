import { acquireLock } from '/home/dillonc/Projects/StrataMD/scripts/verification/lock.mjs';
import { runProcess } from '/home/dillonc/Projects/StrataMD/scripts/verification/process.mjs';
const cwd='/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T15-24-29-815Z-a07fbe7e/candidate',output='/tmp/strata-performance-audit-20260908';
const c=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>c.abort());
const unlock=await acquireLock('/home/dillonc/.cache/stratamd-verification',{mode:'performance-audit-experiment',source:cwd,output},c.signal);
try{
 await runProcess('./node_modules/.bin/electron-vite',['build'],{cwd,env:process.env,log:output+'/experiment-build.log',signal:c.signal});
 for(const [profile,config,args,extra] of [
 ['input','playwright.audit.config.ts',['--grep','document discussion'],{}],
 ['keystroke','playwright.performance.config.ts',['--grep','default presentation'],{}],
 ['smoke','playwright.performance.config.ts',[],{STRATAMD_PERF_SIZES:'100000',STRATAMD_PERF_SHAPES:'rich,table-heavy'}]
 ]){console.log('START EXPERIMENT '+profile);try{await runProcess('xvfb-run',['-a','./node_modules/.bin/playwright','test','-c',config,...args,'--output','test-results/performance/'+profile+'-experiment'],{cwd,env:{...process.env,STRATAMD_PERF_PROFILE:profile,STRATAMD_PERF_RUN_ID:'experiment',STRATAMD_PERF_DISPLAY_MODE:'xvfb',...extra},log:output+'/'+profile+'-experiment.log',signal:c.signal,streamOutput:true})}catch(e){console.error(String(e))}}
}finally{await unlock()}
