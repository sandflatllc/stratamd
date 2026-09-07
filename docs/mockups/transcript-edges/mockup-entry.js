import { createSkyRenderer } from '../../../src/renderer/ambient/skyRenderer.ts';
import { createCanvasSkyRenderer } from '../../../src/renderer/ambient/canvasSkyRenderer.ts';

const presets = [
  {id:'hard',name:'Hard edge',hint:'Current boundary',effect:'hard',width:8,strength:55,description:'The original crisp panel boundary, for comparison.'},
  {id:'narrow',name:'Narrow feather',hint:'A small, soft transition',effect:'feather',width:8,strength:100,description:'An 8 px fade softens the cut into the background. The transcript stays opaque and the text stays sharp. My starting choice.'},
  {id:'soft',name:'Wider feather',hint:'More dissolved into the sky',effect:'feather',width:20,strength:100,description:'The same fade across a wider strip. Compare the lower corners to see when the panel starts to feel too soft.'},
  {id:'glass',name:'Dark glass rim',hint:'Blurred color at the edge',effect:'glass',width:16,strength:55,description:'A narrow band of blurred nebula and a faint rim give the panel a glass edge. Its center stays opaque.'},
  {id:'shadow',name:'Soft shadow',hint:'Defined, with gentler separation',effect:'shadow',width:24,strength:65,description:'A diffuse dark shadow quiets the background immediately outside the panel. The edge itself stays defined.'},
  {id:'blend',name:'Feather + shadow',hint:'Soft edge, grounded panel',effect:'blend',width:12,strength:50,description:'A narrow feather and a restrained shadow soften both sides of the boundary. A useful middle ground between fading and floating.'},
];
const $ = id => document.getElementById(id);
const scene=$('scene'), viewport=$('viewport');
let selected=presets[1], comparing=false, paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
for(const preset of presets){
  const button=document.createElement('button');button.dataset.preset=preset.id;
  button.innerHTML=`${preset.name}<small>${preset.hint}</small>`;
  button.onclick=()=>select(preset);$('presets').append(button);
}
function select(preset){selected=preset;comparing=false;$('width').value=preset.width;$('strength').value=preset.strength;update()}
function update(){
  const width=Number($('width').value),power=Number($('strength').value)/100;
  scene.dataset.effect=comparing?'hard':selected.effect;
  scene.style.setProperty('--edge',`${width}px`);scene.style.setProperty('--power',power);
  scene.style.setProperty('--fade',`${selected.effect==='glass'?width:width*power}px`);
  $('width-value').textContent=`${width} px`;$('strength-value').textContent=`${Math.round(power*100)}%`;
  $('width').disabled=$('strength').disabled=selected.id==='hard';
  document.querySelectorAll('[data-preset]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.preset===selected.id)));
  $('compare').setAttribute('aria-pressed',String(comparing));$('compare').textContent=comparing?'Return to treatment':'Compare with hard edge';
  $('badge').textContent=comparing?'Hard edge · comparison':selected.name;
  $('title').textContent=selected.name;$('description').textContent=selected.description;
}
function layout(){
  const width=viewport.clientWidth,height=viewport.clientHeight,mode=$('view').value,scale=Math.min(width/1932,height/966);
  const zoom=mode==='full'?1:2;
  const origin=mode==='left'?[115,733]:mode==='right'?[1785,733]:[966,733];
  let x=(width-1932*scale)/2,y=(height-966*scale)/2;
  if(zoom>1){x=width*(mode==='left'?.12:mode==='right'?.88:.5)-origin[0]*scale*zoom;y=height*.64-origin[1]*scale*zoom}
  scene.style.transform=`translate(${x}px,${y}px) scale(${scale*zoom})`;
}
$('width').oninput=$('strength').oninput=update;$('view').onchange=layout;
$('compare').onclick=()=>{comparing=!comparing;update()};
function motionLabel(){$('motion').textContent=paused?'Play sky':'Pause sky';$('motion').setAttribute('aria-pressed',String(paused))}
$('motion').onclick=()=>{paused=!paused;motionLabel()};motionLabel();
new ResizeObserver(layout).observe(viewport);select(selected);layout();
let canvas=$('sky'),renderer=createSkyRenderer(canvas);
if(!renderer){const replacement=canvas.cloneNode();canvas.replaceWith(replacement);canvas=replacement;renderer=createCanvasSkyRenderer(canvas)}
const frame={width:1932,height:966,dpr:1,time:0,intensity:1,palette:['#ac8ec2','#83baca','#cf7eab','#c5a174','#7bbaa5'].map(hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)),occlusion:[0,0,0,0],highlight:-1};
let last=0,ready=false;
const workerUrl=URL.createObjectURL(new Blob([CLOUD_WORKER_SOURCE],{type:'text/javascript'}));
const worker=new Worker(workerUrl);
worker.onmessage=event=>{renderer.cloud(event.data);worker.terminate();URL.revokeObjectURL(workerUrl);ready=true;renderer.draw(frame);$('loading').hidden=true;document.body.dataset.ready='true'};
worker.onerror=()=>{worker.terminate();URL.revokeObjectURL(workerUrl);$('loading').textContent='The nebula could not load. Reload this page to try again.'};
function tick(now){if(!paused&&!document.hidden&&now-last>1000/30){frame.time+=last?Math.min((now-last)/1000,.1):0;last=now;if(ready)renderer.draw(frame)}else if(paused||document.hidden)last=now;requestAnimationFrame(tick)}requestAnimationFrame(tick);
window.addEventListener('pagehide',()=>{worker.terminate();URL.revokeObjectURL(workerUrl);renderer.dispose()});
