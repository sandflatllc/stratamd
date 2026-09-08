import { app, BrowserWindow, nativeImage, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { PreviewHost } from '../../src/main/preview/host'
const root = process.env.STRATA_COMPOSITION_OUTPUT!
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
 await mkdir(root, {recursive:true})
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<body style="margin:0;background:${req.url==='/red'?'rgb(238,17,17)':'rgb(17,204,17)'};height:3000px"><input id="note"><div id="clock"></div></body>`)})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const host=new PreviewHost({dataDirectory:root,resolveProject:()=>({workspaceRoot:root,title:'Probe'}),resolveThread:()=>({projectId:'p',workingFolder:root})})
 let win:BrowserWindow
 const makeWindow=async()=>{win=new BrowserWindow({x:0,y:0,width:800,height:600,frame:false,show:true,webPreferences:{sandbox:true}});await win.loadURL('data:text/html,<body style="background:%230044ee;margin:0;color:white"><h1>STRATA SHELL</h1></body>');host.attachWindow(win)}
 await makeWindow()
 const localPage=join(root,'local-preview.html')
 await writeFile(localPage,'<body style="margin:0;background:rgb(238,17,17);height:3000px"><input id="note"></body>')
 const owner=await host.openOwnerTab({projectId:'p',url:pathToFileURL(localPage).href})
 await host.query(owner,'new Promise(r=>document.readyState==="complete"?r(true):window.addEventListener("load",()=>r(true)))')
 host.reportBounds({tabId:owner,bounds:{x:200,y:120,width:500,height:400}})
 await host.query(owner,'document.querySelector("#note").value="kept form";window.scrollTo(0,350);true')
 const result=await host.handle({requestId:'open',threadId:'t',operation:'open',input:{url:address+'/green'},timeoutMs:5000})
 assert(result.ok)
 const agent=(result.result as {tabId:string}).tabId
 const neverShown=await host.capture(agent);assert(neverShown.width>0)
 const states: Array<{name:string;shellVisible:boolean;pageVisible:boolean;freshCapture:boolean;formAndScrollKept:boolean;size:string}>=[]
 async function check(name:string, shown:string|null) {
   await host.query(owner,'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   const desktop=join(root,name+'-desktop.png')
   const shownView=shown?win!.contentView.children.find(view=>(view as WebContentsView).webContents===host.contentsOf(shown)):null
   if(shown)assert(shownView,`Selected page has no native view during ${name}`)
   const bounds=shownView?.getBounds()
   const expectedPage=shown?await host.query(shown,'getComputedStyle(document.body).backgroundColor') as string:null
   const rgb=expectedPage?.match(/\d+/g)?.map(Number)
   const deadline=Date.now()+5000
   while(true){
     execFileSync('import',['-window','root',desktop])
     const image=nativeImage.createFromPath(desktop), bytes=image.toBitmap(),offset=(80*image.getSize().width+80)*4
     const shellVisible=bytes[offset]===238&&bytes[offset+1]===68&&bytes[offset+2]===0
     // A guest capture can succeed while its native view stays blank. Read the
     // actual composed desktop inside the page as well as outside it.
     const pageOffset=((bounds?bounds.y+Math.floor(bounds.height/2):250)*image.getSize().width+(bounds?bounds.x+Math.floor(bounds.width/2):350))*4
     const expected=rgb?[rgb[2],rgb[1],rgb[0]]:[238,68,0]
     const pageVisible=expected.every((value,index)=>bytes[pageOffset+index]===value)
     if(shellVisible&&pageVisible)break
     if(Date.now()>deadline)throw new Error(`Wrong native composition during ${name}: shell=${shellVisible}, page=${pageVisible}`)
     await new Promise(resolve=>setImmediate(resolve))
   }
   const expected=shown?host.contentsOf(shown):null
   for(const view of win!.contentView.children){const bounds=view.getBounds();if((view as any).webContents!==expected)assert(bounds.x+bounds.width<0)}
   await host.query(owner,'document.body.style.background="rgb(255,0,255)";new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   const frame=await host.capture(owner)
   await writeFile(join(root,name+'-guest.png'),frame.bytes)
   const image=nativeImage.createFromBuffer(Buffer.from(frame.bytes)), bytes=image.toBitmap(), offset=(100*image.getSize().width+100)*4
   assert.deepEqual([...bytes.subarray(offset,offset+3)],[255,0,255])
   assert.equal(await host.query(owner,'document.querySelector("#note").value'),'kept form')
   assert.equal(await host.query(owner,'window.scrollY'),350)
   states.push({name,shellVisible:true,pageVisible:true,freshCapture:true,formAndScrollKept:true,size:frame.width+'x'+frame.height})
 }
 await check('local-page-open',owner)
 host.reportBounds({tabId:agent,bounds:{x:200,y:120,width:500,height:400}});await check('two-tabs',agent)
 host.reportBounds({tabId:null,bounds:null});await check('document',null)
 host.reportBounds({tabId:agent,bounds:{x:200,y:120,width:500,height:400}});host.setOverlay(true);await check('annotation-menu',null);host.setOverlay(false)
 await check('overlay-dismissed',agent)
 host.reportBounds({tabId:owner,bounds:{x:200,y:120,width:500,height:400}});await check('local-page-return',owner)
 host.resize(agent,{mode:'freeform',width:390,height:844});win!.setSize(1024,700);host.reportBounds({tabId:agent,bounds:{x:300,y:100,width:390,height:550}});await check('device-resize',agent)
 win!.hide()
 const hiddenFrame=await host.capture(agent)
 assert(hiddenFrame.width>0)
 await writeFile(join(root,'tray-hidden-guest.png'),hiddenFrame.bytes)
 win!.show();await check('tray-reopen',agent)
 win!.destroy();await makeWindow();host.reportBounds({tabId:agent,bounds:{x:200,y:120,width:390,height:400}});await check('reattached',agent)
 await host.withScratchView({workingFolder:root,url:address+'/red',viewport:{width:500,height:400}},async()=>{await check('scratch-comparison',agent)})
 // Actual host results and screenshot pixels exercise the stock boundary.
 await host.query(agent, `const style=document.createElement('style');style.dataset.strataVisual='override';style.textContent='body { background: rgb(255,255,0) !important }';document.head.appendChild(style);true`)
 const snapshot=await host.handle({requestId:'snapshot',threadId:'t',operation:'snapshot',input:{},timeoutMs:5000})
 assert(snapshot.ok);assert.equal(typeof (snapshot.result as any).loading,'boolean')
 await writeFile(join(root,'snapshot.json'),JSON.stringify(snapshot))
 const snapImage=nativeImage.createFromBuffer(Buffer.from((snapshot.result as any).screenshot.data,'base64'))
 const pixels=snapImage.toBitmap(), offset=(200*snapImage.getSize().width+150)*4
 assert.deepEqual([...pixels.subarray(offset,offset+3)],[17,204,17])
 assert.equal(await host.query(agent,'getComputedStyle(document.body).backgroundColor'),'rgb(255, 255, 0)')
 const requested=await host.captureFrame(agent)
 const requestedImage=nativeImage.createFromBuffer(Buffer.from(requested.bytes)), requestedPixels=requestedImage.toBitmap()
 const requestedOffset=(200*requestedImage.getSize().width+150)*4
 assert.deepEqual([...requestedPixels.subarray(requestedOffset,requestedOffset+3)],[0,255,255])
 // Failed comparisons restore the untouched owner's scroll and adjustments.
 await host.query(agent,'window.scrollTo(0,300);true')
 await assert.rejects(host.compareInPlace(agent, async contents => {
   await contents.executeJavaScript('window.scrollTo(0,50);true')
   throw new Error('comparison failed')
 }), /comparison failed/)
 assert.equal(await host.query(agent,'window.scrollY'),300)
 assert.equal(await host.query(agent,'getComputedStyle(document.body).backgroundColor'),'rgb(255, 255, 0)')
 // Owner takeover prevents a comparison from restoring stale scroll.
 await assert.rejects(host.compareInPlace(agent, async contents => {
   host.takeControl(agent)
   await contents.executeJavaScript('window.scrollTo(0,400);true')
 }), /page changed during comparison/)
 assert.equal(await host.query(agent,'window.scrollY'),400)
 host.resume(agent)
 await host.query(agent,'window.scrollTo(0,0);true')
 const pending=host.handle({requestId:'pending',threadId:'t',operation:'evaluate',input:{expression:'new Promise(resolve => { window.releaseProbe=()=>resolve(42) })'},timeoutMs:5000})
 while(!await host.query(agent,'typeof window.releaseProbe === "function"'))await new Promise(resolve=>setImmediate(resolve))
 host.takeControl(agent);await host.query(agent,'window.releaseProbe();true')
 assert.equal((await pending).ok,false)
 assert.equal((await host.handle({requestId:'paused',threadId:'t',operation:'snapshot',input:{},timeoutMs:5000})).ok,false)
 host.resume(agent)
 const popupReady=new Promise<BrowserWindow>(resolve=>host.contentsOf(agent).once('did-create-window',resolve))
 await host.query(agent, `window.open('${address}/red','auth','width=300,height=200');true`)
 const popup=await popupReady
 assert(popup.webContents.listenerCount('will-navigate')>0)
 assert.equal(host.contentsOf(agent).session.listenerCount('will-download'),1)
 host.closeTab(agent);assert(popup.isDestroyed())
 assert.equal((await host.handle({requestId:'explicit',threadId:'t',tabId:agent,tabIdExplicit:true,operation:'open',input:{url:address+'/green'},timeoutMs:5000})).ok,false)
 const replacement=await host.handle({requestId:'implicit',threadId:'t',tabId:agent,tabIdExplicit:false,operation:'open',input:{url:address+'/green'},timeoutMs:5000})
 assert(replacement.ok)
 const newTab=await host.handle({requestId:'new-tab',threadId:'t',tabId:(replacement.result as any).tabId,tabIdExplicit:false,operation:'open',input:{url:address+'/green',reuseExistingTab:false},timeoutMs:5000})
 assert(newTab.ok);assert.notEqual((newTab.result as any).tabId,(replacement.result as any).tabId)
 await writeFile(join(root,'report.json'),JSON.stringify({electron:process.versions.electron,states},null,2))
 await host.shutdown();server.close();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
