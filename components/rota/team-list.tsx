'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {useOptimisticTeam} from '@/hooks/use-optimistic-team';
import {GripVertical} from 'lucide-react';
import type {Role} from '@/lib/supabase/snapshot';
import {Checkbox} from '@/components/ui/checkbox';
import {useHoldDrag} from '@/hooks/use-hold-drag';
import {ink,type Engineer} from '@/lib/rota/engine';
import {NetBalance} from '@/components/rota/net-balance';
import type {Balance} from '@/lib/supabase/balance';
export function TeamList({balance=null,name=id=>id,team,revision,monthTotals,historyTotals,lang,onReorder,onActive,readOnly=false,saving=false,selfId='e0',roles=[],onRole,temporaryIds=[],onRename,noWeekendIds=[],onNoWeekends}:{noWeekendIds?:string[];onNoWeekends?:(id:string,noWeekends:boolean)=>void;balance?:Balance|null;name?:(id:string)=>string;temporaryIds?:string[];onRename?:(id:string)=>void;roles?:Role[];onRole?:(id:string,role:string)=>void;readOnly?:boolean;saving?:boolean;selfId?:string;team:Engineer[];revision:number;monthTotals:Record<string,number>;historyTotals:Record<string,number>;lang:'en'|'he';onReorder:(team:Engineer[])=>boolean|void|Promise<boolean|void>;onActive:(id:string,active:boolean)=>void}){
 const t=(a:string,b:string)=>lang==='en'?a:b,source=useRef<string|null>(null);
 const focusAfterMove=useRef<string|null>(null);
 const failureMessage=t('Could not reorder. Try again.','\u05dc\u05d0 \u05e0\u05d9\u05ea\u05df \u05dc\u05e9\u05e0\u05d5\u05ea \u05d0\u05ea \u05d4\u05e1\u05d3\u05e8. \u05e0\u05e1\u05d5 \u05e9\u05d5\u05d1.');
 const {displayed,moving,reorder}=useOptimisticTeam(team,revision,readOnly,onReorder,failureMessage);
 const [dragging,setDragging]=useState<string|null>(null),[announcement,setAnnouncement]=useState('');
 async function move(from:string,to:string,keyboard=false){
  if(moving||saving||readOnly)return;
  const a=displayed.findIndex(p=>p.id===from),b=displayed.findIndex(p=>p.id===to);
  if(a<0||b<0||a===b)return;
  const next=[...displayed];next.splice(b,0,next.splice(a,1)[0]);
  if(keyboard)focusAfterMove.current=from;
  const saved=await reorder(next);
  if(saved!==undefined)setAnnouncement(saved===false?failureMessage:`${next[b].name} \u00b7 ${b+1}`);
 }
 function clear(){source.current=null;setDragging(null)}
 // The native settle callback removes the ghost/transforms. Commit the keyed
 // rows in that same callback, before the browser can paint the original stack.
 const {container,bindContainer}=useHoldDrag({enabled:!readOnly&&!moving&&!saving,handleSelector:'.team-grip',onStart:id=>{source.current=id;setDragging(id)},onMove:()=>{},onEnd:id=>{flushSync(()=>{if(id&&source.current)void move(source.current,id);clear()})},onCancel:clear});
 const positions=useRef(new Map<string,number>()),lastOrder=useRef('');
 useLayoutEffect(()=>{
  const rows=[...container.current?.querySelectorAll<HTMLElement>('[data-gesture-key]')??[]];
  const order=displayed.map(p=>p.id).join(',');
  const next=new Map(rows.map(row=>[row.dataset.gestureKey!,row.getBoundingClientRect().top]));
  if(lastOrder.current!==order&&!moving&&!dragging&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
   rows.forEach(row=>{
    const before=positions.current.get(row.dataset.gestureKey!),after=next.get(row.dataset.gestureKey!)!;
    if(before!==undefined&&before!==after)row.animate([{transform:`translateY(${before-after}px)`},{transform:'translateY(0)'}],{duration:240,easing:'cubic-bezier(.2,.85,.25,1)'});
   });
  }
  positions.current=next;lastOrder.current=order;
 },[displayed,moving,dragging,container]);
 useLayoutEffect(()=>{
  if(moving||saving||!focusAfterMove.current)return;
  const handle=container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${focusAfterMove.current}"] .team-grip`);
  if(!readOnly&&(document.activeElement===document.body||document.activeElement===handle))handle?.focus({preventScroll:true});
  // A subsequent allocation-context reconciliation disables the parent fieldset
  // again. Retain the keyboard origin until focus moves to another control.
  else focusAfterMove.current=null;
 },[moving,saving,readOnly,container]);
 return <><p style={{display:readOnly?'none':undefined}} className="gesture-hint">{t('Hold & drag to reorder · Senior → newest','לחיצה ארוכה וגרירה לשינוי הסדר · ותיק ← חדש')}</p><span className="sr-only" aria-live="polite">{announcement}</span><div ref={bindContainer} className="team-list gesture-grid" aria-busy={moving||saving}>{displayed.map((p,i)=><div data-gesture-key={p.id} key={p.id} className={['team-row',!p.active?'inactive':'',dragging===p.id?'drag-source':''].join(' ')}><button disabled={readOnly||moving||saving} className="team-grip" aria-label={`${t('Drag to reorder','גרירה לשינוי הסדר')} ${p.name}`} aria-describedby="team-keyboard-hint" onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const target=displayed[i+(e.key==='ArrowUp'?-1:1)];if(target)move(p.id,target.id,true)}}}><GripVertical size={18}/><span>{i+1}</span></button><span className="avatar" style={{background:p.color,color:ink(p.color)}}>{p.name.split(' ').map(n=>n[0]).join('').slice(0,2)}</span><div className="team-name"><strong>{p.name}</strong><small>{temporaryIds.includes(p.id)?t('Temporary','\u05d6\u05de\u05e0\u05d9'):roles.find(r=>r.code===p.role)?.can_manage?t('Admin + engineer','מנהל ומהנדס'):p.id===selfId?t('You','אני'):i===team.length-1?t('Newest teammate','חבר הצוות החדש ביותר'):t('Engineer','מהנדס')}{noWeekendIds.includes(p.id)&&` · ${t('No weekends','ללא סופי שבוע')}`}</small>{temporaryIds.includes(p.id)&&!readOnly&&<button type="button" disabled={saving||moving} aria-label={`${t('Edit name','\u05e2\u05e8\u05d9\u05db\u05ea \u05e9\u05dd')} ${p.name}`} onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()} onClick={()=>onRename?.(p.id)}>{t('Edit name','\u05e2\u05e8\u05d9\u05db\u05ea \u05e9\u05dd')}</button>}</div><div className="team-points"><strong>{monthTotals[p.id]??0}</strong><span>{t('this month','החודש')}</span></div><div className="team-points total-points"><strong>{historyTotals[p.id]??0}</strong><span>{t('all months','כל החודשים')}</span></div>{balance&&<NetBalance memberId={p.id} memberName={p.name} balance={balance} name={name} lang={lang}/>}<label className="team-role" style={{display:readOnly?'none':undefined}} onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}><span className="sr-only">{t('Role','תפקיד')} {p.name}</span><select disabled={temporaryIds.includes(p.id)} aria-label={`${t('Role','תפקיד')} ${p.name}`} value={p.role??'engineer'} onChange={e=>onRole?.(p.id,e.target.value)}>{roles.map(r=><option key={r.code} value={r.code}>{lang==='he'?(r.can_manage?'מנהל':'מהנדס'):r.label}</option>)}</select></label><label style={{display:readOnly?'none':undefined}} className="weekend-checkbox" onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}><Checkbox disabled={saving||moving} aria-label={`${t('No weekends','ללא סופי שבוע')} ${p.name}`} checked={noWeekendIds.includes(p.id)} onCheckedChange={v=>onNoWeekends?.(p.id,!!v)}/>{t('No weekends','ללא סופי שבוע')}</label><label style={{display:readOnly?'none':undefined}} className="active-checkbox" onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}><Checkbox disabled={p.id===selfId} checked={p.active} onCheckedChange={v=>onActive(p.id,!!v)}/>{t('Active','פעיל')}</label></div>)}</div><span id="team-keyboard-hint" className="sr-only">{t('Use up and down keys to reorder.','אפשר להשתמש במקשי למעלה ולמטה לשינוי הסדר.')}</span></>
}
