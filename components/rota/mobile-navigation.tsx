'use client';
import {useLayoutEffect,useRef} from 'react';
import {TabsList,TabsTrigger} from '@/components/ui/tabs';
import {tactileTick} from '@/lib/tactile';
import {NavigationPill,NavigationLabel,navigationItems,navigationValues} from './navigation-presentation';
import type {Translate} from './workspace-types';

export function MobileNavigation({value,onChange,t,rtl,disabled}:{
  value:string;onChange:(value:string)=>void;t:Translate;rtl:boolean;disabled:boolean;
}) {
  const root=useRef<HTMLDivElement>(null);
  const ignoreClickUntil=useRef(0);
  useLayoutEffect(()=>{
    const node=root.current;
    if(!node||disabled)return;
    let gesture:{id:number;x:number;y:number;start:number;max:number;positions:number[];sliding:boolean;canceled:boolean;target:number;next:number}|null=null;
    let frame=0;
    const paint=()=>{frame=0;if(gesture?.sliding)node.style.setProperty('--selection-drag-x',`${gesture.next}px`)};
    const cancel=()=>{
      const active=gesture;gesture=null;
      cancelAnimationFrame(frame);frame=0;
      node.removeAttribute('data-sliding');node.style.removeProperty('--selection-drag-x');
      if(active&&node.hasPointerCapture(active.id))node.releasePointerCapture(active.id);
    };
    const move=(x:number,y:number)=>{
      const g=gesture;if(!g||g.canceled)return;
      const dx=x-g.x,dy=y-g.y;
      if(!g.sliding){
        if(Math.abs(dy)>8&&Math.abs(dy)>=Math.abs(dx)){g.canceled=true;return}
        if(Math.abs(dx)<8||Math.abs(dx)<=Math.abs(dy))return;
        g.sliding=true;node.setPointerCapture(g.id);node.setAttribute('data-sliding','true');
      }
      g.next=Math.max(0,Math.min(g.max,g.start+dx));
      const target=g.positions.reduce((best,position,i)=>Math.abs(position-g.next)<Math.abs(g.positions[best]-g.next)?i:best,0);
      if(target!==g.target)tactileTick();g.target=target;
      if(!frame)frame=requestAnimationFrame(paint);
    };
    const down=(event:PointerEvent)=>{
      if(gesture){cancel();return}
      if(!event.isPrimary||event.button!==0)return;
      ignoreClickUntil.current=0;
      const boxes=[...node.querySelectorAll<HTMLElement>('[role=tab]')].map(button=>button.getBoundingClientRect());
      const min=Math.min(...boxes.map(box=>box.left));
      const positions=boxes.map(box=>box.left-min);
      const target=Math.max(0,navigationValues.findIndex(tab=>tab===value));
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY,start:positions[target],max:Math.max(...positions),positions,sliding:false,canceled:false,target,next:positions[target]};
    };
    const pointerMove=(event:PointerEvent)=>{if(gesture?.id===event.pointerId)move(event.clientX,event.clientY)};
    const up=(event:PointerEvent)=>{
      const g=gesture;if(!g||g.id!==event.pointerId)return;
      if(g.sliding){
        move(event.clientX,event.clientY);cancelAnimationFrame(frame);paint();
        // Flush once on release so settling starts at the last finger position.
        node.querySelector('.mobile-nav-selection')?.getBoundingClientRect();
        ignoreClickUntil.current=performance.now()+400;
        onChange(navigationValues[g.target]);
        node.style.setProperty('--selection-index',String(rtl?navigationValues.length-1-g.target:g.target));
        node.querySelectorAll<HTMLButtonElement>('[role=tab]')[g.target]?.focus({preventScroll:true});
      }else if(g.canceled)ignoreClickUntil.current=performance.now()+400;
      cancel();
    };
    // iOS can cancel captured pointers for native panning. React's touchmove
    // listener is passive; prevent native scrolling only after horizontal intent.
    const touchMove=(event:TouchEvent)=>{
      if(event.touches.length!==1){cancel();return}
      if(!gesture)return;
      move(event.touches[0].clientX,event.touches[0].clientY);
      if(gesture?.sliding&&event.cancelable)event.preventDefault();
    };
    const pointerCancel=(event:PointerEvent)=>{if(gesture?.id===event.pointerId)cancel()};
    // Touch initially captures on the tab. Its bubbled lost-capture event is
    // expected when capture transfers to the pill; only pill capture loss ends it.
    const lost=(event:PointerEvent)=>{if(event.target===node)pointerCancel(event)};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel()};
    const visibility=()=>{if(document.visibilityState==='hidden')cancel()};
    node.addEventListener('pointerdown',down);node.addEventListener('pointermove',pointerMove);node.addEventListener('pointerup',up);
    node.addEventListener('pointercancel',pointerCancel);node.addEventListener('lostpointercapture',lost);
    node.addEventListener('touchmove',touchMove,{passive:false});
    window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);
    window.addEventListener('keydown',key);document.addEventListener('visibilitychange',visibility);
    return ()=>{
      cancel();node.removeEventListener('pointerdown',down);node.removeEventListener('pointermove',pointerMove);node.removeEventListener('pointerup',up);
      node.removeEventListener('pointercancel',pointerCancel);node.removeEventListener('lostpointercapture',lost);node.removeEventListener('touchmove',touchMove);
      window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);
      window.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',visibility);
    };
  },[value,onChange,rtl,disabled]);
  return <NavigationPill ref={root} value={value} rtl={rtl}
    onMouseDownCapture={event=>{if(performance.now()<ignoreClickUntil.current){event.preventDefault();event.stopPropagation()}}}
    onClickCapture={event=>{if(event.detail>0&&performance.now()<ignoreClickUntil.current){event.preventDefault();event.stopPropagation()}}}>
    <TabsList variant="line" aria-label={t('Main navigation','ניווט ראשי')}>
      {navigationItems(t).map(item=><TabsTrigger key={item.value} value={item.value} disabled={disabled} aria-label={item.label}><NavigationLabel item={item}/></TabsTrigger>)}
    </TabsList>
  </NavigationPill>;
}
