import { acquireLock } from '/home/dillonc/Projects/StrataMD/scripts/verification/lock.mjs';
import { runProcess } from '/home/dillonc/Projects/StrataMD/scripts/verification/process.mjs';
const cwd='/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T15-24-29-815Z-a07fbe7e/candidate', output='/tmp/strata-performance-audit-20260908';
const controller=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>controller.abort());
const unlock=await acquireLock('/home/dillonc/.cache/stratamd-verification',{mode:'performance-audit-extra',source:cwd,output},controller.signal);
try {await runProcess('node',['/tmp/strata-audit-bench.cjs'],{cwd,env:process.env,log:output+'/micro.log',signal:controller.signal,streamOutput:true});await runProcess('xvfb-run',['-a','./node_modules/.bin/playwright','test','-c','playwright.audit.config.ts'],{cwd,env:{...process.env,STRATAMD_PERF_PROFILE:'audit',STRATAMD_PERF_DISPLAY_MODE:'xvfb'},log:output+'/input.log',signal:controller.signal,streamOutput:true});}finally{await unlock()}
