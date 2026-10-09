'use client';
import {useCallback,useEffect,useLayoutEffect,useRef} from 'react';
import {attachHoldDrag,type HoldDragOptions} from '@/lib/rota/gesture';
export function useHoldDrag(options:HoldDragOptions){
 const container=useRef<HTMLDivElement>(null),latest=useRef(options),ignoreUntil=useRef(0);
 useLayoutEffect(()=>{latest.current=options});
 const bindContainer=useCallback((node:HTMLDivElement|null)=>{container.current=node},[]);
 useEffect(()=>{const root=container.current;if(!root)return;return attachHoldDrag(root,()=>latest.current,ignoreUntil)},[]);
 return{container,bindContainer,ignoreClick:()=>Date.now()<ignoreUntil.current};
}
