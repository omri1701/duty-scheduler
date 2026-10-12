export type HoldDragOptions={enabled:boolean;holdMs?:number;onStart:(key:string)=>void;onMove:(key:string)=>void;onEnd:(key:string|null)=>void;onCancel?:()=>void};
export function attachHoldDrag(root:HTMLDivElement,getOptions:()=>HoldDragOptions,ignoreUntil:{current:number}){
  let timer:ReturnType<typeof setTimeout>|undefined;
  let g:{key:string;x:number;y:number;active:boolean;touch:boolean;last:string|null;id:number}|null=null;
  function at(x:number,y:number){const el=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-gesture-key]');return el&&root!.contains(el)?el.dataset.gestureKey??null:null;}
  function clear(){if(timer)clearTimeout(timer);timer=undefined;root!.classList.remove('gesture-active');}
  function cancel(){if(g?.active){ignoreUntil.current=Date.now()+700;getOptions().onCancel?.();}clear();g=null;}
  function activate(){if(!g||!getOptions().enabled)return;g.active=true;root!.classList.add('gesture-active');ignoreUntil.current=Date.now()+700;getOptions().onStart(g.key);}
  function start(x:number,y:number,touch:boolean,id:number){if(!getOptions().enabled)return;const key=at(x,y);if(!key)return;g={key,x,y,active:false,touch,last:key,id};if(touch)timer=setTimeout(activate,getOptions().holdMs??360);}
  function move(x:number,y:number,e:Event){if(!g)return;const moved=Math.hypot(x-g.x,y-g.y);if(!g.active){if(g.touch&&moved>10){cancel();return}if(!g.touch&&moved>6)activate();}if(g?.active){if(e.cancelable)e.preventDefault();const key=at(x,y);if(key&&key!==g.last)getOptions().onMove(key);g.last=key;}}
  function end(x:number,y:number,e:Event){if(!g)return;const active=g.active,target=at(x,y);clear();g=null;if(active){if(e.cancelable)e.preventDefault();ignoreUntil.current=Date.now()+700;getOptions().onEnd(target);}}
  function ts(e:TouchEvent){if(e.touches.length!==1){cancel();return}const p=e.touches[0];start(p.clientX,p.clientY,true,p.identifier);}
  function tm(e:TouchEvent){if(!g?.touch)return;const p=[...e.touches].find(p=>p.identifier===g!.id);if(p)move(p.clientX,p.clientY,e);}
  function te(e:TouchEvent){if(!g?.touch)return;const p=[...e.changedTouches].find(p=>p.identifier===g!.id);if(p)end(p.clientX,p.clientY,e);}
  function pd(e:PointerEvent){if(e.pointerType==='touch'||e.button!==0)return;start(e.clientX,e.clientY,false,e.pointerId);}
  function pm(e:PointerEvent){if(g&&!g.touch&&e.pointerId===g.id)move(e.clientX,e.clientY,e);}
  function pu(e:PointerEvent){if(g&&!g.touch&&e.pointerId===g.id)end(e.clientX,e.clientY,e);}
  function menu(e:Event){if(g||getOptions().enabled)e.preventDefault();}
  root.addEventListener('touchstart',ts,{passive:true});root.addEventListener('touchmove',tm,{passive:false});root.addEventListener('touchend',te,{passive:false});root.addEventListener('touchcancel',cancel);
  root.addEventListener('pointerdown',pd);root.addEventListener('contextmenu',menu);document.addEventListener('pointermove',pm,{passive:false});document.addEventListener('pointerup',pu);document.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
  return()=>{clear();root.removeEventListener('touchstart',ts);root.removeEventListener('touchmove',tm);root.removeEventListener('touchend',te);root.removeEventListener('touchcancel',cancel);root.removeEventListener('pointerdown',pd);root.removeEventListener('contextmenu',menu);document.removeEventListener('pointermove',pm);document.removeEventListener('pointerup',pu);document.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel)};
}
