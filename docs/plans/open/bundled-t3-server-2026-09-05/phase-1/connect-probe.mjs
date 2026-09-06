import {spawn} from 'node:child_process'
import {writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const root=fileURLToPath(new URL('.',import.meta.url)),base=join(root,'connect-data')
await mkdir(base,{recursive:true,mode:0o700})
const node=join(root,'runtime/0.0.38/node_modules/node/bin/node'),entry=join(root,'runtime/0.0.38/node_modules/t3/dist/bin.mjs')
const results=[]
for(const args of [['status','--json'],['login','--headless'],['link','--headless'],['publish'],['status','--json'],['unlink'],['logout'],['status','--json']]){
 const child=spawn(node,[entry,'connect',...args,'--base-dir',base],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,BROWSER:'false'}})
 let output='',cancelled=false
 const record=chunk=>{output+=String(chunk); if(args[0]==='login' && /https:\/\//.test(output)){cancelled=true;child.kill('SIGTERM')} if(args[0]==='link' && /[Ii]nstall|[Dd]ownload/.test(output)){child.stdin.end('n\n')}}
 child.stdout.on('data',record);child.stderr.on('data',record)
 const timer=setTimeout(()=>{cancelled=true;child.kill('SIGTERM')},15000)
 await new Promise(r=>child.on('exit',r));clearTimeout(timer)
 output=output.replace(/https:\/\/[^\s]+/g,raw=>{try{const u=new URL(raw);return u.origin+u.pathname+' [authorization parameters omitted]'}catch{return '[URL omitted]'}})
 results.push({command:args.join(' '),exitCode:child.exitCode,signal:child.signalCode,cancelled,output})
}
await writeFile(join(root,'connect-result.json'),JSON.stringify(results,null,2),{mode:0o600})
console.log(JSON.stringify(results,null,2))
