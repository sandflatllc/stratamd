import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {TopBar} from '../../../src/renderer/components/TopBar';
import {Toolbar} from '../../../src/renderer/components/Toolbar';
import {Contents} from '../../../src/renderer/components/Contents';
import {RailTabs} from '../../../src/renderer/components/RailTabs';
import {rendererThemeStyle} from '../../../src/renderer/model';
import {DEFAULT_THEME_VALUES} from '../../../src/shared/bundled-themes';
import {createSkyRenderer} from '../../../src/renderer/ambient/skyRenderer';
import {createCanvasSkyRenderer} from '../../../src/renderer/ambient/canvasSkyRenderer';
const noop=()=>{};
const sections=['A local home for your Markdown','Read with structure','Work alongside an agent','Keep the document yours'];
const headings=sections.map((text,i)=>({id:'section-'+i,level:i===0?1:2,text,position:i*200,sourceFrom:i*200,atx:true}));
const theme=rendererThemeStyle({active:{values:DEFAULT_THEME_VALUES}});
function Sky({paused}){
 const host=useRef(null), pause=useRef(paused);pause.current=paused;
 useEffect(()=>{let canvas=host.current, renderer=createSkyRenderer(canvas);if(!renderer){const replacement=canvas.cloneNode();canvas.replaceWith(replacement);canvas=replacement;renderer=createCanvasSkyRenderer(canvas)}
 const frame={width:1400,height:900,dpr:1,time:24,intensity:1,palette:['#ac8ec2','#83baca','#cf7eab','#c5a174','#7bbaa5'].map(hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)),occlusion:[0,0,0,0],highlight:-1};
 const resize=()=>{frame.width=canvas.clientWidth;frame.height=canvas.clientHeight;if(ready)renderer.draw(frame)};let ready=false,last=0,raf;
 const observer=new ResizeObserver(resize);observer.observe(canvas);
 const url=URL.createObjectURL(new Blob([CLOUD_WORKER_SOURCE],{type:'text/javascript'}));const worker=new Worker(url);
 worker.onmessage=e=>{renderer.cloud(e.data);ready=true;resize();document.body.dataset.ready='true';worker.terminate();URL.revokeObjectURL(url)};
 const tick=now=>{if(!pause.current&&!document.hidden&&now-last>1000/30){frame.time+=last?Math.min((now-last)/1000,.1):0;last=now;if(ready)renderer.draw(frame)}else if(pause.current||document.hidden)last=now;raf=requestAnimationFrame(tick)};raf=requestAnimationFrame(tick);
 return()=>{cancelAnimationFrame(raf);observer.disconnect();worker.terminate();URL.revokeObjectURL(url);renderer.dispose()};
 },[]);return <canvas ref={host} className="mock-sky" aria-label="Strata Stars + smoke background"/>;
}
function App(){
 const [layout,setLayout]=useState('panel'),[background,setBackground]=useState('#15141a'),[border,setBorder]=useState('#463c6e'),[shadow,setShadow]=useState('drop-shadow'),[strength,setStrength]=useState(100),[shadowColor,setShadowColor]=useState('#000000'),[width,setWidth]=useState(690),[paused,setPaused]=useState(true),[active,setActive]=useState('section-0'),[showSettings,setShowSettings]=useState(true);
 const jump=id=>{setActive(id);document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'})};
 const style={...theme,'--reading-background':background,'--reading-border':border,'--reading-shadow':shadowColor,'--reading-strength':strength/100,'--reading-width':`${width}px`};
 const reset=()=>{setLayout('panel');setBackground('#15141a');setBorder('#463c6e');setShadow('drop-shadow');setStrength(100);setShadowColor('#000000');setWidth(690)};
 return <div className="mockup-root" style={style}>
 <div className="app-shell" data-motion="false" data-layout={layout} data-shadow={shadow}>
 <Sky paused={paused}/>
 <TopBar windowState={null} onWindowAction={noop} tabs={[{path:'/StrataMD/reading-in-strata.md',name:'Reading in Strata',active:true,dirty:false,pending:0}]} canSend={false} hasAgents={false} pending={0} pendingUnsaved={false} onOpenTab={noop} onCloseTab={noop} onCopyPath={noop} onOpenFile={noop} onSend={noop} zoomed={false} onResetZoom={noop} onOpenTheme={()=>setShowSettings(!showSettings)}/>
 <div className="workspace">
 <aside className="island navigation-rail mock-navigation"><div className="navigation-header"><RailTabs label="Document navigation" idPrefix="navigation" selected="contents" onSelect={noop} tabs={[{id:'projects',label:'Projects'},{id:'conversation',label:'Conversation'},{id:'contents',label:'Contents'}]}/></div><Contents headings={headings} drafts={[]} activeId={active} walkthrough={{active:false,marks:[]}} content="" onJump={jump} onWalkthrough={noop}/><div className="nav-note">reading-in-strata.md<span>Document view</span></div></aside>
 <div className="resizer resizer-vertical"><span/></div>
 <main className="center-column">
 <div className="mock-editor editor-island island"><Toolbar source={false} sourceOnly={false} readOnly={false} dirty={false} onCommand={noop} onToggleSource={noop} onSave={noop}/>
 <div className="mock-reading-viewport"><div className="reading-panel"><div className="prosemirror-host"><article className="ProseMirror">
 <h1 id="section-0">A local home for your Markdown</h1>
 <p>Strata brings your document, conversation, and review into one place. Read the work, leave a comment on the passage that matters, and keep moving.</p>
 <p>The file stays on your computer. <strong>Your words stay yours.</strong></p>
 <h2 id="section-1">Read with structure</h2>
 <p>Use Contents to move between sections. Headings, links, and emphasis keep their own colors, so you can scan a long document without losing your place.</p>
 <blockquote><p>A quieter background gives the document room to breathe while the sky stays visible around it.</p></blockquote>
 <h2 id="section-2">Work alongside an agent</h2>
 <p>Keep the conversation beside the document. Anchor feedback to an exact passage, review proposed changes, and decide what belongs in the final version.</p>
 <ul><li><strong>Comments</strong> keep the discussion attached to the text.</li><li><strong>Suggestions</strong> let you accept or reject a proposed edit.</li><li><strong>Decisions</strong> make the next choice explicit.</li></ul>
 <h2 id="section-3">Keep the document yours</h2>
 <p>Adjust the reading width to suit the work. Choose an opaque background for long reading sessions, or an open layout to see the ambient background behind the document.</p>
 <p>This mockup keeps those choices separate from the conversation's appearance.</p>
 </article></div></div></div>
 </div>
 </main>
 </div>
 <div className="mock-caption"><span>Document background · interactive mockup</span><button onClick={()=>setShowSettings(!showSettings)}>{showSettings?'Hide controls':'Show controls'}</button><button onClick={()=>setPaused(!paused)}>{paused?'Play background':'Pause background'}</button></div>
 </div>
 {showSettings&&<aside className="design-controls" aria-label="Document background controls"><div className="control-heading"><span>Theme / Surfaces</span><h1>Document</h1><p>A reading panel sized to your document.</p></div>
 <div className="control-block"><label>Document layout</label><div className="layout-options">{[['panel','Opaque panel'],['open','Open']].map(([id,name])=><button key={id} aria-pressed={layout===id} onClick={()=>setLayout(id)}><span className={`layout-preview ${id}`}><i/><i/><i/></span>{name}</button>)}</div></div>
 <fieldset disabled={layout==='open'}><label className="color-row">Background<input aria-label="Document background" type="color" value={background} onChange={e=>setBackground(e.target.value)}/></label><label className="color-row">Border<input aria-label="Document border" type="color" value={border} onChange={e=>setBorder(e.target.value)}/></label>
 <label className="select-row">Shadow<select aria-label="Document shadow" value={shadow} onChange={e=>setShadow(e.target.value)}><option value="none">None</option><option value="drop-shadow">Drop shadow</option></select></label>
 {shadow==='drop-shadow'&&<><label className="color-row">Shadow color<input aria-label="Document shadow color" type="color" value={shadowColor} onChange={e=>setShadowColor(e.target.value)}/></label><label className="slider-label">Shadow strength<output>{strength}%</output><input aria-label="Document shadow strength" type="range" min="0" max="300" value={strength} onChange={e=>setStrength(Number(e.target.value))}/></label></>}
 </fieldset>
 <div className="control-block measure-control"><label className="slider-label">Reading width<output>{width} px</output><input aria-label="Document reading width" type="range" min="480" max="850" step="10" value={width} onChange={e=>setWidth(Number(e.target.value))}/></label></div>
 <div className="control-explainer"><h2>{layout==='panel'?'A quiet place to read':'Open to the background'}</h2><p>{layout==='panel'?'The panel follows the reading width. A small gap below the existing toolbar separates it from the scrolling area, with all four corners rounded.':'The reading panel disappears. The document keeps its position and width over the ambient background.'}</p></div>
 <button className="reset-mockup" onClick={reset}>Reset mockup</button><p className="prototype-note">Preview only. These controls don't change your saved theme.</p>
 </aside>}
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
