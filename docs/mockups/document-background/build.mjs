import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const here=fileURLToPath(new URL('.',import.meta.url));
const root=path.resolve(here,'../../..');
const worker=await build({entryPoints:[root+'/src/renderer/ambient/cloud.worker.ts'],bundle:true,format:'iife',write:false});
const bundle=await build({entryPoints:[here+'mockup.jsx'],bundle:true,format:'iife',write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',CLOUD_WORKER_SOURCE:JSON.stringify(worker.outputFiles[0].text)},plugins:[{name:'inline-svg',setup(b){b.onResolve({filter:/\.svg\?url$/},a=>({path:path.resolve(a.resolveDir,a.path.replace('?url','')),namespace:'inline-svg'}));b.onLoad({filter:/.*/,namespace:'inline-svg'},async a=>({contents:`export default ${JSON.stringify('data:image/svg+xml;base64,'+(await readFile(a.path)).toString('base64'))}`,loader:'js'}));}}]});
let fonts='';
for(const weight of [500,600,700,800]){const data=await readFile(root+`/node_modules/@fontsource/baloo-2/files/baloo-2-latin-${weight}-normal.woff2`);fonts+=`@font-face{font-family:'Baloo 2';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');}`;}
const mono=await readFile(root+'/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2');
fonts+=`@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${mono.toString('base64')}) format('woff2');}`;
const productCss=(await readFile(root+'/src/renderer/styles.css','utf8')).replace('@import "tailwindcss";','');
const css=await readFile(here+'mockup.css','utf8');
await writeFile(here+'index.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Strata · Document background mockup</title><style>*,::before,::after{box-sizing:border-box}h1,h2,h3,p{margin:0}button,input,select{font:inherit}button{cursor:pointer}button,select{text-transform:none}svg{display:block;vertical-align:middle}img{display:block;max-width:100%}${fonts}${productCss}${css}</style><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`);
console.log('Built self-contained document background mockup');
