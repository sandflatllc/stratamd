import { acquireLock } from '/home/dillonc/Projects/StrataMD/scripts/verification/lock.mjs';
import { runProcess } from '/home/dillonc/Projects/StrataMD/scripts/verification/process.mjs';
const cwd='/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T15-24-29-815Z-a07fbe7e/candidate', output='/tmp/strata-performance-audit-20260908';
const controller=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>controller.abort());
const unlock=await acquireLock('/home/dillonc/.cache/stratamd-verification',{mode:'performance-audit-corrected',source:cwd,output},controller.signal);
try {for(const [profile,config,args,extra] of [
 ['input','playwright.audit.config.ts',['--grep','conversation draft'],{}],
 ['tabs','playwright.performance.config.ts',[],{STRATAMD_PERF_TAB_RUNGS:'1,5,10'}],
 ['smoke','playwright.performance.config.ts',[],{STRATAMD_PERF_SIZES:'100000',STRATAMD_PERF_SHAPES:'rich,table-heavy'}]
]){console.log('START '+profile);try{await runProcess('xvfb-run',['-a','./node_modules/.bin/playwright','test','-c',config,...args,'--output','test-results/performance/'+profile+'-corrected'],{cwd,env:{...process.env,STRATAMD_PERF_PROFILE:profile,STRATAMD_PERF_RUN_ID:'corrected',STRATAMD_PERF_DISPLAY_MODE:'xvfb',...extra},log:output+'/'+profile+'-corrected.log',signal:controller.signal,streamOutput:true})}catch(e){console.error(String(e))}}}finally{await unlock()}
