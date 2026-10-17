'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {visibleSwapRequests} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';

import {DeferredFeature,deferred} from './deferred-feature';
const SwapRequestDialogs=deferred(()=>import('./swap-request-dialogs').then(m=>m.SwapRequestDialogs));

export function SwapRequests({remote,month,lang,selection,onSelection}:{remote:TeamWorkspace;month:string;lang:'en'|'he';selection:{from:string;to:string}|null;onSelection:(value:{from:string;to:string}|null)=>void}){
 const [review,setReview]=useState<SwapRequest|null>(null);
 const t=(en:string,he:string)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const requests=visibleSwapRequests(raw.swapRequests??[],me,remote.isAdmin);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const fmt=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Jerusalem'});
 const span=(start:string,end:string)=>fmt(start)+(end!==addDays(start,1)?` – ${fmt(addDays(end,-1))}`:'');
 const status=(s:SwapRequest['status'])=>({awaiting_engineer:t('Awaiting Engineer','ממתינה למהנדס'),awaiting_admin:t('Awaiting Admin','ממתינה למנהל'),approved:t('Approved','אושרה'),declined:t('Declined','סורבה'),rejected:t('Rejected','נדחתה'),cancelled:t('Cancelled','בוטלה'),invalidated:t('Invalidated','אינה תקפה')}[s]);
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error((e as Error).message);return false}}
 return <>
  {requests.length>0&&<section className="calendar-panel swap-requests" aria-labelledby="swap-requests-heading">
   <div className="section-heading"><h3 id="swap-requests-heading">{t('Swap Requests','בקשות החלפה')}</h3></div>
   <div className="swap-request-list">{requests.map(r=>{
    const incoming=r.other_id===me&&r.status==='awaiting_engineer',admin=remote.isAdmin&&r.status==='awaiting_admin',pending=['awaiting_engineer','awaiting_admin'].includes(r.status);
    return <article key={r.id} className={'swap-request-row '+(incoming?'incoming':admin?'admin-review':'outgoing')}>
     <div className="swap-request-details"><div className="swap-request-meta"><small>{incoming?t('Incoming · your consent','נכנסת · לאישורך'):admin?t('Admin approval','אישור מנהל'):t('Outgoing','יוצאת')}</small><span className={'swap-status '+r.status}>{status(r.status)}</span></div>
      <strong>{name(r.requester_id)} ↔ {name(r.other_id)}</strong><p>{span(r.from_day,r.from_end_day)} ↔ {span(r.to_day,r.to_end_day)}</p>
      {r.explanation&&<p className="swap-explanation">{r.explanation}</p>}{r.override_reason&&<small>{t('Admin override:','חריגת מנהל:')} {r.override_reason}</small>}
     </div>
     {pending&&<div className="swap-request-actions">{incoming&&<><Button size="sm" onClick={()=>act(()=>remote.resolveSwap(r.id,'accept'),t('Accepted. Awaiting admin approval.','אושרה. ממתינה לאישור מנהל.'))}>{t('Accept','קבלה')}</Button><Button size="sm" variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'decline'),t('Request declined.','הבקשה סורבה.'))}>{t('Decline','סירוב')}</Button></>}
      {admin&&<><Button size="sm" onClick={()=>{setReview(r)}}>{t('Approve','אישור')}</Button><Button size="sm" variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'reject'),t('Request rejected.','הבקשה נדחתה.'))}>{t('Reject','דחייה')}</Button></>}
      {r.requester_id===me&&<Button size="sm" variant="ghost" onClick={()=>act(()=>remote.resolveSwap(r.id,'cancel'),t('Request cancelled.','הבקשה בוטלה.'))}>{t('Cancel request','ביטול בקשה')}</Button>}
     </div>}
    </article>;
   })}</div>
  </section>}
  {(selection||review)&&<DeferredFeature lang={lang} onClose={()=>{onSelection(null);setReview(null)}}><SwapRequestDialogs remote={remote} month={month} lang={lang} selection={selection} onSelection={onSelection} review={review} setReview={setReview}/></DeferredFeature>}
 </>;
}
