import {createAnnotation,createAnnotationLog,mapAnnotationsThroughEdit,relocateAnnotation} from './src/core/annotations'
import {conversationParse} from './src/renderer/conversationReading'
import {parseMarkdownForEditor} from './src/editor/markdown'
import {writeFileSync} from 'node:fs'
const results:any={annotations:[],parseCache:[]}
const document=Array.from({length:1000},(_,i)=>`Paragraph-${String(i).padStart(4,'0')}: `+'An ordinary sentence with supporting detail. '.repeat(2)+'\n\n').join('')
for(const count of [20,100,500,1000]){
 let log=createAnnotationLog();for(let i=0;i<count;i++)log=createAnnotation(log,document,{id:'a'+i,kind:'comment',author:'user',quote:`Paragraph-${String(i).padStart(4,'0')}`,text:'Review this'}).log
 const times=[];for(let trial=0;trial<10;trial++){const t=performance.now();let next=mapAnnotationsThroughEdit(log,{start:document.length,deleteCount:0,insertText:'x'});for(const a of Object.values(next.annotations))next=relocateAnnotation(next,a.id,document+'x').log;times.push(performance.now()-t)}
 times.sort((a,b)=>a-b);results.annotations.push({count,documentBytes:document.length,medianMs:times[5],p95Ms:times[9]})
}
const text=('A **rich** sentence with a [reference](https://example.com) and some `code`.\n\n').repeat(25)
for(let i=0;i<50;i++)parseMarkdownForEditor(text+i)
global.gc?.();const base=process.memoryUsage().heapUsed
for(const count of [0,50,200,500]){for(let i=0;i<count;i++)conversationParse('audit-message-'+i,text+i);global.gc?.();results.parseCache.push({messages:count,bytesPerMessage:text.length,retainedHeapDeltaMB:(process.memoryUsage().heapUsed-base)/1024/1024})}
writeFileSync('/tmp/strata-performance-audit-20260908/growth.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))
