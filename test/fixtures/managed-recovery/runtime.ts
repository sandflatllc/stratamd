import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
export async function recoveryFixture(root: string){
 const bundle=join(root,'bundle');await mkdir(join(bundle,'bin'),{recursive:true});
 await symlink(process.execPath,join(bundle,'bin/node'));
 const manifest={version:'fixture-v1',nodeVersion:process.version,platform:process.platform,arch:process.arch,executable:'bin/node',entry:'server.mjs'};
 await writeFile(join(bundle,'runtime.json'),JSON.stringify(manifest));await writeFile(join(bundle,'package.json'),'{}');
 for(const name of ['node-pty','msgpackr-extract','@ff-labs/fff-node']){const directory=join(bundle,'node_modules',name);await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({name,main:'index.js'}));await writeFile(join(directory,'index.js'),'module.exports = {};');}
 await writeFile(join(bundle,'server.mjs'),`import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';import{join}from'node:path';const args=process.argv;const root=args[args.indexOf('--base-dir')+1];const port=args[args.indexOf('--port')+1];readFileSync(3,'utf8');mkdirSync(join(root,'userdata'),{recursive:true});writeFileSync(join(root,'userdata/environment-id'),'fixture-environment');writeFileSync(join(root,'userdata/server-runtime.json'),JSON.stringify({pid:process.pid,origin:'http://127.0.0.1:'+port}));setInterval(()=>{},1000);`);
 return bundle;
}
