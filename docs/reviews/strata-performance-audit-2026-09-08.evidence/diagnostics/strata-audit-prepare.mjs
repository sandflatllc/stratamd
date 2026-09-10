import { copyDependencies } from '/home/dillonc/Projects/StrataMD/scripts/verification/inputs.mjs';
import { acquireLock } from '/home/dillonc/Projects/StrataMD/scripts/verification/lock.mjs';
const root='/home/dillonc/.cache/stratamd-verification/runs/2026-09-08T15-24-29-815Z-a07fbe7e/candidate';
const unlock=await acquireLock('/home/dillonc/.cache/stratamd-verification',{mode:'performance-audit-prepare',source:root},new AbortController().signal);
try { await copyDependencies('/home/dillonc/Projects/StrataMD/node_modules',root+'/node_modules'); console.log(root); } finally { await unlock(); }
