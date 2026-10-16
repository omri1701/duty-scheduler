'use client';
import {useRef,type ReactNode} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';

// Both editors share Special Duty's centered Radix shell and dismissal rules.
export function EditorDialog({open=true,onClose,saving=false,lang,title,description,children,className='',onCloseAutoFocus,role='dialog'}:{
 open?:boolean;onClose:()=>void;saving?:boolean;lang:'en'|'he';title:ReactNode;description:ReactNode;children:ReactNode;className?:string;
 onCloseAutoFocus?:(event:Event)=>void;role?:'dialog'|'alertdialog';
}){
 const returnFocus=useRef<HTMLElement|null>(null);
 return <Dialog open={open} onOpenChange={value=>{if(!value&&!saving)onClose()}}>
  <DialogContent className={`editor-dialog ${className}`} role={role} dir={lang==='he'?'rtl':'ltr'} aria-busy={saving} closeDisabled={saving}
   onEscapeKeyDown={event=>{if(saving)event.preventDefault()}}
   onPointerDownOutside={event=>{if(saving)event.preventDefault()}}
   onOpenAutoFocus={()=>{returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null}}
   onCloseAutoFocus={event=>{
    if(onCloseAutoFocus){onCloseAutoFocus(event);return}
    event.preventDefault();
    if(returnFocus.current?.isConnected)returnFocus.current.focus({preventScroll:true});
   }}>
   <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
   {children}
  </DialogContent>
 </Dialog>;
}
