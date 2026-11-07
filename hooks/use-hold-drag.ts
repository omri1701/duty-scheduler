'use client';
import {useCallback,useLayoutEffect,useRef} from 'react';
import {attachHoldDrag,type HoldDragOptions} from '@/lib/rota/gesture';
export function useHoldDrag(options:HoldDragOptions){
 const container=useRef<HTMLDivElement>(null),latest=useRef(options),ignoreUntil=useRef(0);
 useLayoutEffect(()=>{latest.current=options});
 // The grid may be re-mounted (a month slide keys it), so the listeners follow the bound node.
 const bindContainer=useCallback((node:HTMLDivElement|null)=>{
  container.current=node;
  if(!node)return;
  const detach=attachHoldDrag(node,()=>latest.current,ignoreUntil);
  return()=>{detach();if(container.current===node)container.current=null};
 },[]);
 return{container,bindContainer,ignoreClick:()=>Date.now()<ignoreUntil.current};
}
