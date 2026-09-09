import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { seededScenario, startEngine } from '../../../../../test/e2e/cockpit-engine-harness'
import { DEFAULT_THEME_ID } from '../../../../../src/shared/bundled-themes'
const root=resolve('docs/design/t3-additions-2026-09-08/v2')
const evidence='/tmp/strata-t3-design-v2-evidence'
await mkdir(evidence,{recursive:true})
const engine=await startEngine({pendingRequests:true,projectsParity:true})
engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after a homeowner requests an inspection.\n')
const info={config:{workers:1},parallelIndex:0,outputPath:(...parts:string[])=>join(evidence,...parts)} as any
const scenario=await seededScenario(info,engine.origin,'# Inspection page\n\nReview the offer and the steps after booking.\n','inspection-page.md')
await scenario.writeSettings({theme:DEFAULT_THEME_ID})
const app=await electron.launch({args:['--ozone-platform=x11','--remote-debugging-port=43213','/tmp/strata-t3-design-v2-app/out/main/index.js',scenario.file],cwd:process.cwd(),env:scenario.env})
app.process().stderr?.on('data',chunk=>process.stderr.write(chunk))
await app.firstWindow()
await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0]!.setContentSize(1440,1000)})
await writeFile(join(root,'reference','session.json'),JSON.stringify({appPid:app.process().pid,cdpPort:43213,scenario:scenario.root,build:'/tmp/strata-t3-design-v2-app/out',themeId:DEFAULT_THEME_ID,viewport:[1440,1000]},null,2))
console.log('Isolated Strata ready on CDP 43213; theme',DEFAULT_THEME_ID)
async function close(){await app.close();await engine.close();process.exit(0)}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close())
await new Promise(()=>{})
