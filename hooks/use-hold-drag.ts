'use client';
import {useEffect,useRef} from 'react';
import {attachHoldDrag,type HoldDragOptions} from '@/lib/rota/gesture';
export function useHoldDrag(options:HoldDragOptions){
 const container=useRef<HTMLDivElement>(null),latest=useRef(options),ignoreUntil=useRef(0);latest.current=options;
 useEffect(()=>{const root=container.current;if(!root)return;return attachHoldDrag(root,()=>latest.current,ignoreUntil)},[]);
 return{container,ignoreClick:()=>Date.now()<ignoreUntil.current};
}
