'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {useOptimisticTeam} from '@/hooks/use-optimistic-team';
import {ChevronDown,GripVertical,UserRoundCheck,UserRoundX} from 'lucide-react';
import type {Role} from '@/lib/supabase/snapshot';
import {useHoldDrag} from '@/hooks/use-hold-drag';
import type {Engineer} from '@/lib/rota/engine';
import {Avatar} from '@/components/ui/avatar';
import {Chip} from '@/components/ui/chip';
import {SwipeRow} from '@/components/ui/swipe-row';
import {NetBalance} from '@/components/rota/net-balance';
import type {Balance} from '@/lib/supabase/balance';
import {userMessage} from '@/lib/messages';

/** The team (decision 2026-11-06): active members in seniority order (hold the grip to reorder,
 * Up/Down on the keyboard), a collapsed Inactive group, a swipe on a row to deactivate or
 * activate, and a tap to open the member. Moves between groups slide into place. */
export function TeamList({balance=null,name=id=>id,team,revision,monthTotals,historyTotals,lang,onReorder,onActive,onSelect,readOnly=false,saving=false,selfId='e0',roles=[],temporaryIds=[],noWeekendIds=[]}:{
 noWeekendIds?:string[];balance?:Balance|null;name?:(id:string)=>string;temporaryIds?:string[];roles?:Role[];readOnly?:boolean;saving?:boolean;selfId?:string;team:Engineer[];revision:number;
 monthTotals:Record<string,number>;historyTotals:Record<string,number>;lang:'en'|'he';onReorder:(team:Engineer[])=>boolean|void|Promise<boolean|void>;onActive:(id:string,active:boolean)=>void;onSelect:(id:string)=>void;
}){
 const t=(a:string,b:string)=>lang==='en'?a:b,source=useRef<string|null>(null),rtl=lang==='he';
 const focusAfterMove=useRef<string|null>(null);
 const failureMessage=t('Could not reorder. Try again.','לא ניתן לשנות את הסדר. נסו שוב.');
 const {displayed,moving,reorder}=useOptimisticTeam(team,revision,readOnly,onReorder,failureMessage,e=>userMessage(e instanceof Error?e.message:'',t));
 const [dragging,setDragging]=useState<string|null>(null),[announcement,setAnnouncement]=useState(''),[openSwipe,setOpenSwipe]=useState<string|null>(null);
 const [showInactive,setShowInactive]=useState(false);
 const active=displayed.filter(p=>p.active),inactive=displayed.filter(p=>!p.active);
 async function move(from:string,to:string,keyboard=false){
  if(moving||saving||readOnly)return;
  const a=displayed.findIndex(p=>p.id===from),b=displayed.findIndex(p=>p.id===to);
  if(a<0||b<0||a===b||displayed[a].active!==displayed[b].active)return;
  const next=[...displayed];next.splice(b,0,next.splice(a,1)[0]);
  if(keyboard)focusAfterMove.current=from;
  const saved=await reorder(next);
  if(saved!==undefined)setAnnouncement(saved===false?failureMessage:`${next[b].name} · ${next.filter(p=>p.active).findIndex(p=>p.id===from)+1}`);
 }
 function clear(){source.current=null;setDragging(null)}
 // The native settle callback removes the ghost/transforms. Commit the keyed
 // rows in that same callback, before the browser can paint the original stack.
 const {container,bindContainer}=useHoldDrag({enabled:!readOnly&&!moving&&!saving,handleSelector:'.team-grip',onStart:id=>{source.current=id;setDragging(id);setOpenSwipe(null)},onMove:()=>{},onEnd:id=>{flushSync(()=>{if(id&&source.current)void move(source.current,id);clear()})},onCancel:clear});
 // FLIP: rows keep their keys, so a reorder or a move between groups slides each row from where it was.
 const positions=useRef(new Map<string,number>()),lastOrder=useRef('');
 useLayoutEffect(()=>{
  const rows=[...container.current?.querySelectorAll<HTMLElement>('[data-gesture-key]')??[]];
  const order=displayed.map(p=>`${p.id}:${p.active?1:0}`).join(',')+(showInactive?'+':'-');
  const next=new Map(rows.map(row=>[row.dataset.gestureKey!,row.getBoundingClientRect().top]));
  if(lastOrder.current!==order&&!moving&&!dragging&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
   rows.forEach(row=>{
    const before=positions.current.get(row.dataset.gestureKey!),after=next.get(row.dataset.gestureKey!)!;
    if(before!==undefined&&before!==after)row.animate([{transform:`translateY(${before-after}px)`},{transform:'translateY(0)'}],{duration:300,easing:'cubic-bezier(.2,.85,.25,1)'});
    else if(before===undefined&&lastOrder.current)row.animate([{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'ease-out'});
   });
  }
  positions.current=next;lastOrder.current=order;
 },[displayed,moving,dragging,container,showInactive]);
 useLayoutEffect(()=>{
  if(moving||saving||!focusAfterMove.current)return;
  const handle=container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${focusAfterMove.current}"] .team-grip`);
  if(!readOnly&&(document.activeElement===document.body||document.activeElement===handle))handle?.focus({preventScroll:true});
  // A subsequent allocation-context reconciliation disables the parent fieldset again. Retain the keyboard origin until focus moves to another control.
  else focusAfterMove.current=null;
 },[moving,saving,readOnly,container]);
 // Deactivating opens the Inactive group so the row is seen sliding into it.
 function setActive(id:string,value:boolean){if(!value)setShowInactive(true);onActive(id,value)}
 const roleLabel=(p:Engineer)=>temporaryIds.includes(p.id)?t('Temporary','זמני'):roles.find(r=>r.code===p.role)?.can_manage?t('Admin','מנהל'):null;
 const row=(p:Engineer,i:number,group:Engineer[])=>{
  const canSwipe=!readOnly&&p.id!==selfId&&!saving&&!moving;
  return <SwipeRow key={p.id} id={p.id} rtl={rtl} openId={openSwipe} onOpen={setOpenSwipe} disabled={!canSwipe} className={['team-row',!readOnly?'editable':'',!p.active?'inactive':'',dragging===p.id?'drag-source':''].join(' ')}
   attrs={{'data-gesture-key':p.id,'data-member':p.id}} onClick={()=>onSelect(p.id)}
   action={canSwipe?p.active?{label:t('Deactivate','השבתה'),icon:<UserRoundX/>,tone:'danger',onSelect:()=>setActive(p.id,false)}:{label:t('Activate','הפעלה'),icon:<UserRoundCheck/>,tone:'brand',onSelect:()=>setActive(p.id,true)}:undefined}>
   <div className="team-row-inner">
    {!readOnly&&p.active?<button type="button" data-no-swipe disabled={readOnly||moving||saving} className="team-grip" aria-label={`${t('Drag to reorder','גרירה לשינוי הסדר')} ${p.name}`} aria-describedby="team-keyboard-hint"
     onClick={e=>e.stopPropagation()}
     onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();const target=group[i+(e.key==='ArrowUp'?-1:1)];if(target)move(p.id,target.id,true)}}}><GripVertical size={18}/><span>{i+1}</span></button>
     :<span className="team-rank" aria-hidden="true">{p.active?i+1:''}</span>}
    <Avatar name={p.name} color={p.color} size={40}/>
    <div className="team-name">
     <strong>{p.name}{p.id===selfId&&<span className="muted"> · {t('you','אני')}</span>}</strong>
     <span className="team-tags">
      {roleLabel(p)&&<Chip size="sm" tone={temporaryIds.includes(p.id)?'neutral':'brand'}>{roleLabel(p)}</Chip>}
      {noWeekendIds.includes(p.id)&&<Chip size="sm" tone="neutral">{t('No weekends','ללא סופ״ש')}</Chip>}
      {i===group.length-1&&p.active&&group.length>1&&<span className="team-newest">{t('Newest','החדש ביותר')}</span>}
     </span>
    </div>
    <div className="team-points"><strong>{monthTotals[p.id]??0}</strong><span>{t('this month','החודש')}</span></div>
    <div className="team-points total-points"><strong>{historyTotals[p.id]??0}</strong><span>{t('all months','כל החודשים')}</span></div>
    {balance&&<NetBalance memberId={p.id} memberName={p.name} balance={balance} name={name} lang={lang}/>}
   </div>
  </SwipeRow>;
 };
 return <><span className="sr-only" aria-live="polite">{announcement}</span>
  <div ref={bindContainer} className="team-list gesture-grid" aria-busy={moving||saving}>
   {active.map((p,i)=>row(p,i,active))}
   {inactive.length>0&&<button type="button" className="team-group" aria-expanded={showInactive} onClick={()=>setShowInactive(v=>!v)}>
    <span>{t('Inactive','לא פעילים')} · {inactive.length}</span><ChevronDown className={showInactive?'open':''} aria-hidden="true"/>
   </button>}
   {showInactive&&inactive.map((p,i)=>row(p,i,inactive))}
  </div>
  <span id="team-keyboard-hint" className="sr-only">{t('Use up and down keys to reorder.','אפשר להשתמש במקשי למעלה ולמטה לשינוי הסדר.')}</span></>;
}
