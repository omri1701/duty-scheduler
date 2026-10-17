'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {todayIsrael} from '@/lib/supabase/snapshot';
import {publishedSwapDuties,eligibleSwapTarget} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';

export function SwapRequestDialogs({remote,month,lang,selection,onSelection,review,setReview}:{remote:TeamWorkspace;month:string;lang:'en'|'he';selection:{from:string;to:string}|null;onSelection:(value:{from:string;to:string}|null)=>void;review:SwapRequest|null;setReview:(value:SwapRequest|null)=>void}){
 const [explanation,setExplanation]=useState(''),[override,setOverride]=useState(false),[reason,setReason]=useState('');
 const t=(en:string,he:string)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const duties=publishedSwapDuties(raw,month,todayIsrael()),source=duties.find(d=>d.day===selection?.from&&d.primary_id===me),target=duties.find(d=>d.day===selection?.to);
 const eligible=eligibleSwapTarget(source,target);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const fmt=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Jerusalem'});
 const span=(start:string,end:string)=>fmt(start)+(end!==addDays(start,1)?` – ${fmt(addDays(end,-1))}`:'');
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error((e as Error).message);return false}}
 function close(){onSelection(null);setExplanation('')}
 return <>
  <Dialog open={!!selection} onOpenChange={v=>!v&&close()}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Confirm swap request','אישור בקשת החלפה')}</DialogTitle><DialogDescription>{t('The other engineer accepts first, then an admin approves. Assignments stay unchanged until final approval.','המהנדס האחר מאשר תחילה, ואז מנהל מאשר. השיבוצים נשארים ללא שינוי עד לאישור הסופי.')}</DialogDescription></DialogHeader>
   <div className="swap-review">{[source,target].map((d,i)=>d&&<div key={d.id}><strong>{span(d.day,d.end_day)}</strong><span>{name(d.primary_id!)}</span><small>{i===0?t('Your duty','התורנות שלך'):t('Requested duty','התורנות המבוקשת')}</small></div>)}</div>
   {!eligible&&<p role="alert">{t('These duties changed or are no longer eligible. Cancel and choose again.','התורנויות השתנו או אינן מתאימות עוד. בטלו ובחרו שוב.')}</p>}
   <label className="field-label">{t('Explanation (optional)','הסבר (אופציונלי)')}<textarea rows={2} maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>
   <div className="swap-request-actions"><Button disabled={remote.readOnly||!eligible||remote.saving} onClick={async()=>{if(source&&target&&await act(()=>remote.requestSwap(source.id,target.id,explanation),t('Swap request submitted.','בקשת ההחלפה נשלחה.')))close()}}>{t('Confirm Request','אישור בקשה')}</Button><Button variant="outline" onClick={close}>{t('Cancel','ביטול')}</Button></div>
  </DialogContent></Dialog>
  <Dialog open={!!review} onOpenChange={v=>!v&&setReview(null)}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Approve published swap','אישור החלפה בלוח שפורסם')}</DialogTitle><DialogDescription>{t('Creates a new published version from the current publication. Availability and weekend limits are checked again.','יוצר גרסה חדשה מהפרסום הנוכחי. אילוצים ומגבלת סופי שבוע נבדקים שוב.')}</DialogDescription></DialogHeader>
   {review&&<p>{name(review.requester_id)} · {span(review.from_day,review.from_end_day)} ↔ {name(review.other_id)} · {span(review.to_day,review.to_end_day)}</p>}
   <label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Explicitly override availability conflicts','אישור חריגה מפורשת מאילוצי זמינות')}</label>
   {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   <Button disabled={remote.readOnly||remote.saving||(override&&!reason.trim())} onClick={async()=>{if(review&&await act(()=>remote.resolveSwap(review.id,'approve',override?reason:''),t('Swap approved and new version published.','ההחלפה אושרה ופורסמה גרסה חדשה.')))setReview(null)}}>{t('Approve & publish swap','אישור ופרסום ההחלפה')}</Button>
  </DialogContent></Dialog>
 </>;
}
