'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {todayIsrael} from '@/lib/supabase/snapshot';
import {publishedSwapDuties} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';

export function SwapRequests({remote,month,lang,sourceDay,onSourceDay}:{remote:TeamWorkspace;month:string;lang:'en'|'he';sourceDay:string|null;onSourceDay:(day:string|null)=>void}){
 const [target,setTarget]=useState(''),[explanation,setExplanation]=useState(''),[review,setReview]=useState<SwapRequest|null>(null),[override,setOverride]=useState(false),[reason,setReason]=useState('');
 const t=(en:string,he:string)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const duties=publishedSwapDuties(raw,month,todayIsrael()),own=duties.filter(d=>d.primary_id===me),source=own.find(d=>d.day===sourceDay);
 const targets=source?duties.filter(d=>d.primary_id!==me&&d.secondary_id!==me&&source.secondary_id!==d.primary_id):[];
 const requests=raw.swapRequests??[],pending=requests.filter(r=>r.status==='pending').length;
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const fmt=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Jerusalem'});
 const span=(start:string,end:string)=>fmt(start)+(end!==addDays(start,1)?` – ${fmt(addDays(end,-1))}`:'');
 const label=(d:typeof duties[number])=>`${span(d.day,d.end_day)} · ${name(d.primary_id!)} · ${d.points} ${t('points','נקודות')}`;
 const status=(s:SwapRequest['status'])=>({pending:t('Pending','ממתינה'),approved:t('Approved','אושרה'),rejected:t('Rejected','נדחתה'),cancelled:t('Cancelled','בוטלה')}[s]);
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error((e as Error).message);return false}}
 function open(){setTarget('');setExplanation('');onSourceDay(own[0]?.day??null)}
 return <section className="calendar-panel swap-requests" aria-labelledby="swap-requests-heading">
  <div className="section-heading"><h3 id="swap-requests-heading">{t('Swap Requests','בקשות החלפה')} <span className="tiny-badge" role="status">{pending} {t('pending','ממתינות')}</span></h3><Button variant="outline" disabled={!own.length||remote.saving} onClick={open}>{t('Request swap','בקשת החלפה')}</Button></div>
  <p className="muted-copy">{t('Swap future primary duties in the current publication. Only admin approval is needed. Draft edits and emergency cover stay unchanged.','החלפת תורנויות ראשיות עתידיות בפרסום הנוכחי. נדרש רק אישור מנהל. עריכות טיוטה וכיסוי חירום נשארים ללא שינוי.')}</p>
  {!requests.length&&<p>{t('No swap requests yet.','אין עדיין בקשות החלפה.')}</p>}
  <div className="swap-request-list">{requests.map(r=><article key={r.id} className="swap-request-row">
   <div><strong>{name(r.requester_id)} ↔ {name(r.other_id)}</strong><p>{span(r.from_day,r.from_end_day)} ↔ {span(r.to_day,r.to_end_day)}</p>{r.explanation&&<p className="swap-explanation">{r.explanation}</p>}<small>{status(r.status)} · {t('Requested','נשלחה')} {fmt(r.created_at.slice(0,10))}{r.resolved_by&&` · ${name(r.resolved_by)}`}</small>{r.override_reason&&<p>{t('Admin override:','חריגת מנהל:')} {r.override_reason}</p>}</div>
   {r.status==='pending'&&<div className="swap-request-actions">{remote.isAdmin&&<><Button onClick={()=>{setReview(r);setOverride(false);setReason('')}}>{t('Approve','אישור')}</Button><Button variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'reject'),t('Request rejected.','הבקשה נדחתה.'))}>{t('Reject','דחייה')}</Button></>}{r.requester_id===me&&<Button variant="ghost" onClick={()=>act(()=>remote.resolveSwap(r.id,'cancel'),t('Request cancelled.','הבקשה בוטלה.'))}>{t('Cancel','ביטול')}</Button>}</div>}
  </article>)}</div>
  <Dialog open={sourceDay!==null} onOpenChange={v=>{if(!v){onSourceDay(null);setTarget('');setExplanation('')}}}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Request swap','בקשת החלפה')}</DialogTitle><DialogDescription>{t('The published schedule changes only after admin approval. Choose whole duties; intact weekends stay together.','הלוח שפורסם משתנה רק לאחר אישור מנהל. בחרו תורנויות שלמות; סוף שבוע מאוחד נשאר יחד.')}</DialogDescription></DialogHeader>
   <label className="field-label">{t('Your published duty','התורנות שלך שפורסמה')}<select value={source?.day??''} onChange={e=>{onSourceDay(e.target.value);setTarget('')}}><option value="" disabled>{t('Choose your duty','בחירת תורנות שלך')}</option>{own.map(d=><option key={d.id} value={d.day}>{label(d)}</option>)}</select></label>
   <label className="field-label">{t('Exchange with','החלפה עם')}<select value={targets.some(d=>d.id===target)?target:''} onChange={e=>setTarget(e.target.value)}><option value="">{t('Choose another engineer’s duty','בחירת תורנות של מהנדס אחר')}</option>{targets.map(d=><option key={d.id} value={d.id}>{label(d)}</option>)}</select></label>
   {!targets.length&&<p role="status">{t('No other eligible duties in this published month.','אין תורנויות מתאימות אחרות בחודש שפורסם.')}</p>}
   <label className="field-label">{t('Explanation (optional)','הסבר (אופציונלי)')}<textarea rows={3} maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>
   <Button disabled={!source||!targets.some(d=>d.id===target)||remote.saving} onClick={async()=>{if(source&&await act(()=>remote.requestSwap(source.id,target,explanation),t('Swap request submitted.','בקשת ההחלפה נשלחה.'))){onSourceDay(null);setTarget('');setExplanation('')}}}>{t('Submit request','שליחת בקשה')}</Button>
  </DialogContent></Dialog>
  <Dialog open={!!review} onOpenChange={v=>!v&&setReview(null)}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Approve published swap','אישור החלפה בלוח שפורסם')}</DialogTitle><DialogDescription>{t('Creates a new published version from the current publication. Availability and weekend limits are checked again.','יוצר גרסה חדשה מהפרסום הנוכחי. אילוצים ומגבלת סופי שבוע נבדקים שוב.')}</DialogDescription></DialogHeader>
   {review&&<p>{name(review.requester_id)} · {span(review.from_day,review.from_end_day)} ↔ {name(review.other_id)} · {span(review.to_day,review.to_end_day)}</p>}
   <label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Explicitly override availability conflicts','אישור חריגה מפורשת מאילוצי זמינות')}</label>
   {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   <Button disabled={remote.saving||(override&&!reason.trim())} onClick={async()=>{if(review&&await act(()=>remote.resolveSwap(review.id,'approve',override?reason:''),t('Swap approved and new version published.','ההחלפה אושרה ופורסמה גרסה חדשה.')))setReview(null)}}>{t('Approve & publish swap','אישור ופרסום ההחלפה')}</Button>
  </DialogContent></Dialog>
 </section>;
}
