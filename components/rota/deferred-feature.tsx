'use client';
import dynamic from 'next/dynamic';
import {Component, Suspense, createContext, useContext, useLayoutEffect, useState, useRef, useId, type ComponentType, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@/components/ui/button';

type Feedback = {lang: 'en'|'he'; onClose?: () => void; active?: boolean};
const FeedbackContext = createContext<Feedback>({lang:'en'});

// The boundary owns only code loading. Private data stays in the identity-keyed
// workspace, and the real feature retains its existing save/dismissal rules.
export function DeferredFeature({lang,onClose,active=true,children}: Feedback & {children:ReactNode}) {
 const [visited,setVisited]=useState(active),modal=!!onClose;
 const [focus,setFocus]=useState(()=>({active,trigger:active&&modal?document.activeElement:null}));
 if(active&&!visited)setVisited(true);
 if(focus.active!==active)setFocus({active,trigger:active&&modal?document.activeElement:null});
 useLayoutEffect(()=>{
  if(!modal||!active)return;
  const trigger=focus.trigger;
  return()=>{queueMicrotask(()=>{if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true})})};
 },[modal,active,focus.trigger]);
 return visited||active?<FeedbackContext.Provider value={{lang,onClose,active}}>{children}</FeedbackContext.Provider>:null;
}

function FeatureFeedback({retry}:{retry?:()=>void}) {
 const {lang,onClose,active}=useContext(FeedbackContext),he=lang==='he';
 if(active===false)return null;
 const title=retry?(he?'לא ניתן לטעון כרגע':'Could not load this feature'):(he?'טוען…':'Loading…');
 const content=<div role={retry?'alert':'status'} aria-busy={!retry}>
  {title}{retry&&<Button variant="outline" onClick={retry}>{he?'ניסיון נוסף':'Retry'}</Button>}
 </div>;
 return onClose?<LoadingDialog lang={lang} onClose={onClose} title={title}>{content}</LoadingDialog>
  :<section className="team-panel" dir={he?'rtl':'ltr'}>{content}</section>;
}

// Native modal semantics keep focus/inertness/Escape without downloading Radix
// before any feature needs it. This shell exists only during loading or retry.
function LoadingDialog({lang,onClose,title,children}:Feedback & {onClose:()=>void;title:string;children:ReactNode}) {
 const ref=useRef<HTMLDialogElement>(null),titleId=useId();
 useLayoutEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close()},[]);
 return createPortal(<dialog ref={ref} className="deferred-dialog" dir={lang==='he'?'rtl':'ltr'} aria-labelledby={titleId}
  onCancel={event=>{event.preventDefault();onClose()}}
  onClick={event=>{if(event.target!==event.currentTarget)return;const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose()}}>
  <h2 id={titleId}>{title}</h2>{children}<Button variant="ghost" onClick={onClose} aria-label="Close">{lang==='he'?'סגירה':'Close'}</Button>
 </dialog>,document.body);
}

// React.lazy caches rejected imports. Recreate the Next dynamic component on an
// explicit retry so a recovered connection can fetch the failed chunk again.
export function deferred<P extends object>(loader:()=>Promise<ComponentType<P>>) {
 let View=dynamic(loader);
 return class Deferred extends Component<P,{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true}}
  retry=()=>{View=dynamic(loader);this.setState({failed:false})};
  render(){return this.state.failed?<FeatureFeedback retry={this.retry}/>:<Suspense fallback={<FeatureFeedback/>}><View {...this.props}/></Suspense>}
 };
}
