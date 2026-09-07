import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalEngineManager } from '../../../src/main/engine/manager.ts'
const [root, phase] = process.argv.slice(2)
const manager = new LocalEngineManager({directory:join(root,'engine'),bundle:join(root,'bundle'),connect:async()=>{
  if(phase==='credential-saved')await writeFile(join(root,'credential-saved'),'yes')
  process.send({phase})
  await new Promise(()=>{})
},authenticate:async()=>true,reconnect:async()=>{},changed:()=>{}})
await manager.start()
