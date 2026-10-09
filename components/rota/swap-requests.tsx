'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {todayIsrael} from '@/lib/supabase/snapshot';
import {publishedSwapDuties,eligibleSwapTarget,visibleSwapRequests} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';

export function SwapRequests({remote,month,lang,selection,onSelection}:{remote:TeamWorkspace;month:string;lang:'en'|'he';selection:{from:string;to:string}|null;onSelection:(value:{from:string;to:string}|null)=>void}){
 const [explanation,setExplanation]=useState(''),[review,setReview]=useState<SwapRequest|null>(null),[override,setOverride]=useState(false),[reason,setReason]=useState('');
 const t=(en:string,he:string)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const duties=publishedSwapDuties(raw,month,todayIsrael()),source=duties.find(d=>d.day===selection?.from&&d.primary_id===me),target=duties.find(d=>d.day===selection?.to);
 const eligible=eligibleSwapTarget(source,target);
 const requests=visibleSwapRequests(raw.swapRequests??[],me,remote.isAdmin);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const fmt=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Jerusalem'});
 const span=(start:string,end:string)=>fmt(start)+(end!==addDays(start,1)?` – ${fmt(addDays(end,-1))}`:'');
 const status=(s:SwapRequest['status'])=>({awaiting_engineer:t('Awaiting Engineer','ממתינה למהנדס'),awaiting_admin:t('Awaiting Admin','ממתינה למנהל'),approved:t('Approved','אושרה'),declined:t('Declined','סורבה'),rejected:t('Rejected','נדחתה'),cancelled:t('Cancelled','בוטלה'),invalidated:t('Invalidated','אינה תקפה')}[s]);
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error((e as Error).message);return false}}
 function close(){onSelection(null);setExplanation('')}
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
      {admin&&<><Button size="sm" onClick={()=>{setReview(r);setOverride(false);setReason('')}}>{t('Approve','אישור')}</Button><Button size="sm" variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'reject'),t('Request rejected.','הבקשה נדחתה.'))}>{t('Reject','דחייה')}</Button></>}
      {r.requester_id===me&&<Button size="sm" variant="ghost" onClick={()=>act(()=>remote.resolveSwap(r.id,'cancel'),t('Request cancelled.','הבקשה בוטלה.'))}>{t('Cancel request','ביטול בקשה')}</Button>}
     </div>}
    </article>;
   })}</div>
  </section>}
  <Dialog open={!!selection} onOpenChange={v=>!v&&close()}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Confirm swap request','אישור בקשת החלפה')}</DialogTitle><DialogDescription>{t('The other engineer accepts first, then an admin approves. Assignments stay unchanged until final approval.','המהנדס האחר מאשר תחילה, ואז מנהל מאשר. השיבוצים נשארים ללא שינוי עד לאישור הסופי.')}</DialogDescription></DialogHeader>
   <div className="swap-review">{[source,target].map((d,i)=>d&&<div key={d.id}><strong>{span(d.day,d.end_day)}</strong><span>{name(d.primary_id!)}</span><small>{i===0?t('Your duty','התורנות שלך'):t('Requested duty','התורנות המבוקשת')}</small></div>)}</div>
   {!eligible&&<p role="alert">{t('These duties changed or are no longer eligible. Cancel and choose again.','התורנויות השתנו או אינן מתאימות עוד. בטלו ובחרו שוב.')}</p>}
   <label className="field-label">{t('Explanation (optional)','הסבר (אופציונלי)')}<textarea rows={2} maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>
   <div className="swap-request-actions"><Button disabled={!eligible||remote.saving} onClick={async()=>{if(source&&target&&await act(()=>remote.requestSwap(source.id,target.id,explanation),t('Swap request submitted.','בקשת ההחלפה נשלחה.')))close()}}>{t('Confirm Request','אישור בקשה')}</Button><Button variant="outline" onClick={close}>{t('Cancel','ביטול')}</Button></div>
  </DialogContent></Dialog>
  <Dialog open={!!review} onOpenChange={v=>!v&&setReview(null)}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Approve published swap','אישור החלפה בלוח שפורסם')}</DialogTitle><DialogDescription>{t('Creates a new published version from the current publication. Availability and weekend limits are checked again.','יוצר גרסה חדשה מהפרסום הנוכחי. אילוצים ומגבלת סופי שבוע נבדקים שוב.')}</DialogDescription></DialogHeader>
   {review&&<p>{name(review.requester_id)} · {span(review.from_day,review.from_end_day)} ↔ {name(review.other_id)} · {span(review.to_day,review.to_end_day)}</p>}
   <label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Explicitly override availability conflicts','אישור חריגה מפורשת מאילוצי זמינות')}</label>
   {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   <Button disabled={remote.saving||(override&&!reason.trim())} onClick={async()=>{if(review&&await act(()=>remote.resolveSwap(review.id,'approve',override?reason:''),t('Swap approved and new version published.','ההחלפה אושרה ופורסמה גרסה חדשה.')))setReview(null)}}>{t('Approve & publish swap','אישור ופרסום ההחלפה')}</Button>
  </DialogContent></Dialog>
 </>;
}
