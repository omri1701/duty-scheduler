'use client';
import {useEffect,useState} from 'react';
import {Copy} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {todayIsrael} from '@/lib/supabase/snapshot';
import {publishedSwapDuties,eligibleSwapTarget,visibleSwapRequests,swapStarter,swapWaitingOn,swapSummary,swapDuties,swapProblem,type SwapConflict,type SwapProblem} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';
import {userMessage} from '@/lib/messages';

// Whose unavailability blocks a swap; null while checking. The revision changes
// with every constraint edit, so it is the refresh trigger.
function useSwapConflicts(remote:TeamWorkspace,from?:string,to?:string){
 const key=from&&to?`${from}|${to}|${remote.snapshot?.revision}`:'',check=remote.swapAvailability;
 const [result,setResult]=useState<{key:string;conflicts:SwapConflict[]}|null>(null);
 useEffect(()=>{
  if(!from||!to)return;
  let alive=true;
  // The server rechecks every write; an unavailable check only hides the warning.
  check(from,to).then(conflicts=>{if(alive)setResult({key,conflicts})},()=>{if(alive)setResult({key,conflicts:[]})});
  return()=>{alive=false};
  // eslint-disable-next-line react-hooks/exhaustive-deps -- check is recreated each render; key is the trigger.
 },[key]);
 return key&&result?.key===key?result.conflicts:null;
}

export function SwapRequests({remote,month,lang,selection,onSelection}:{remote:TeamWorkspace;month:string;lang:'en'|'he';selection:{from:string;to:string}|null;onSelection:(value:{from:string;to:string}|null)=>void}){
 const [explanation,setExplanation]=useState(''),[review,setReview]=useState<SwapRequest|null>(null),[override,setOverride]=useState(false),[reason,setReason]=useState('');
 const [consent,setConsent]=useState<{request:SwapRequest;conflicts:SwapConflict[]}|null>(null);
 const t=(en:string,he:string)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const duties=publishedSwapDuties(raw,month,todayIsrael()),pick=(day?:string)=>duties.find(d=>d.day===day);
 // Engineers offer their own duty. An admin may pick any two; as a party, their side is the request's side.
 let source=pick(selection?.from),target=pick(selection?.to);
 if(!remote.isAdmin&&source?.primary_id!==me)source=undefined;
 if(remote.isAdmin&&target?.primary_id===me)[source,target]=[target,source];
 const eligible=eligibleSwapTarget(source,target),proposing=eligible&&source!.primary_id!==me;
 // Availability comes from the server's alert; the weekend limit is checked here.
 const problem=eligible?swapProblem(raw,month,source!,target!,false):null;
 const requestConflicts=useSwapConflicts(remote,eligible?source!.id:undefined,eligible?target!.id:undefined);
 const requests=visibleSwapRequests(raw.swapRequests??[],me,remote.isAdmin);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const fmt=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Jerusalem'});
 const span=(start:string,end:string)=>fmt(start)+(end!==addDays(start,1)?` – ${fmt(addDays(end,-1))}`:'');
 const status=(s:SwapRequest['status'])=>({awaiting_engineer:t('Awaiting Engineer','ממתינה למהנדס'),awaiting_admin:t('Awaiting Admin','ממתינה למנהל'),approved:t('Approved','אושרה'),declined:t('Declined','סורבה'),rejected:t('Rejected','נדחתה'),cancelled:t('Cancelled','בוטלה'),invalidated:t('Invalidated','אינה תקפה')}[s]);
 // What the server would refuse is said before the click (decision 2026-11-01).
 const explain=(p:SwapProblem,step:'request'|'accept'|'approve')=>(p.person===me?t('This swap would give you a second weekend this month.','ההחלפה הזו תיתן לך סוף שבוע שני החודש.'):t(`This swap would give ${name(p.person)} a second weekend this month.`,`ההחלפה הזו תיתן ל${name(p.person)} סוף שבוע שני החודש.`))+' '+
  ({request:t('Choose another duty.','יש לבחור תורנות אחרת.'),accept:t('Decline it instead.','אפשר לסרב לה במקום.'),approve:t('Reject it instead.','אפשר לדחות אותה במקום.')}[step]);
 // Dialogs read the latest copy: a refresh (another tab, a republish) can reassign,
 // invalidate or resolve the request while it is open.
 const latest=(r:SwapRequest|undefined)=>r&&(raw.swapRequests??[]).find(x=>x.id===r.id);
 const current=latest(review??undefined),reviewable=current?.status==='awaiting_admin';
 const consenting=latest(consent?.request),answerable=!!consenting&&swapWaitingOn(consenting).includes(me);
 const reviewed=current?swapDuties(raw,current):null;
 const reviewConflicts=useSwapConflicts(remote,reviewed?.source?.id,reviewed?.target?.id);
 const reviewProblem=current&&reviewed?.source&&reviewed.target?swapProblem(raw,current.month,reviewed.source,reviewed.target,false):null;
 const summary=current&&reviewed?.source&&reviewed.target?swapSummary({requester:name(current.requester_id),other:name(current.other_id),lang,
  from:{label:span(current.from_day,current.from_end_day),points:reviewed.source.points},to:{label:span(current.to_day,current.to_end_day),points:reviewed.target.points}}):'';
 const changedAlert=<p role="alert">{t('This request changed and no longer needs this answer. Close and check the list.','הבקשה השתנתה ואינה ממתינה עוד לתשובה זו. סגרו ובדקו את הרשימה.')}</p>;
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error(userMessage((e as Error).message,t));return false}}
 function close(){onSelection(null);setExplanation('')}
 function accept(r:SwapRequest){
  const last=swapWaitingOn(r).length===1;
  return act(()=>remote.resolveSwap(r.id,'accept'),last?t('Accepted. Awaiting admin approval.','אושרה. ממתינה לאישור מנהל.'):t('Accepted. Waiting for the other engineer.','אושרה. ממתינה למהנדס השני.'));
 }
 // Availability is rechecked at consent; a conflict can be accepted, then needs an admin override.
 async function startAccept(r:SwapRequest){
  const {source:from,target:to}=swapDuties(raw,r),conflicts=from&&to?await remote.swapAvailability(from.id,to.id).catch(()=>[]):[];
  if(conflicts.length)setConsent({request:r,conflicts});else await accept(r);
 }
 async function copySummary(){
  try{await navigator.clipboard.writeText(summary);toast.success(t('Summary copied.','הסיכום הועתק.'))}
  catch{toast.error(t('Could not copy. Select the text instead.','ההעתקה נכשלה. סמנו את הטקסט במקום.'))}
 }
 const conflictAlert=(conflicts:SwapConflict[]|null,footer:string)=>!!conflicts?.length&&<div className="warning-note swap-conflicts" role="alert">
  <strong>{t('Availability conflict','התנגשות זמינות')}</strong>
  <ul>{conflicts.map(c=><li key={`${c.member}${c.day}`}>{c.member
   ?t(`${name(c.member)} is unavailable on ${fmt(c.day)}`,`ל־${name(c.member)} יש אילוץ אי־זמינות ב־${fmt(c.day)}`)
   :t(`Emergency cover is unavailable on ${fmt(c.day)}`,`לכונן החירום יש אילוץ אי־זמינות ב־${fmt(c.day)}`)}</li>)}</ul>
  <p>{footer}</p>
 </div>;
 return <>
  {requests.length>0&&<section className="calendar-panel swap-requests" aria-labelledby="swap-requests-heading">
   <div className="section-heading"><h3 id="swap-requests-heading">{t('Swap Requests','בקשות החלפה')}</h3></div>
   <div className="swap-request-list">{requests.map(r=>{
    const waiting=swapWaitingOn(r),incoming=waiting.includes(me),admin=remote.isAdmin&&r.status==='awaiting_admin',pending=['awaiting_engineer','awaiting_admin'].includes(r.status);
    // Consent may precede an availability override, never a second weekend.
    const duties=incoming?swapDuties(raw,r):null,refused=duties?.source&&duties.target?swapProblem(raw,r.month,duties.source,duties.target,false):null;
    return <article key={r.id} className={'swap-request-row '+(incoming?'incoming':admin?'admin-review':'outgoing')}>
     <div className="swap-request-details"><div className="swap-request-meta"><small>{incoming?t('Incoming · your consent','נכנסת · לאישורך'):admin?t('Admin approval','אישור מנהל'):r.proposed_by===me?t('Proposed by you','הצעה שלך'):t('Outgoing','יוצאת')}</small><span className={'swap-status '+r.status}>{status(r.status)}</span></div>
      <strong>{name(r.requester_id)} ↔ {name(r.other_id)}</strong><p>{span(r.from_day,r.from_end_day)} ↔ {span(r.to_day,r.to_end_day)}</p>
      {r.proposed_by&&r.proposed_by!==me&&<small className="swap-proposer">{t('Proposed by','הוצעה על ידי')} {name(r.proposed_by)}</small>}
      {waiting.length>0&&r.proposed_by&&<p className="swap-waiting">{t('Waiting for:','ממתינה ל:')} {waiting.map(name).join(', ')}</p>}
      {r.explanation&&<p className="swap-explanation">{r.explanation}</p>}{r.override_reason&&<small>{t('Admin override:','חריגת מנהל:')} {r.override_reason}</small>}
     </div>
     {pending&&<div className="swap-request-actions">{incoming&&<><Button size="sm" disabled={!!refused} onClick={()=>startAccept(r)}>{t('Accept','קבלה')}</Button><Button size="sm" variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'decline'),t('Request declined.','הבקשה סורבה.'))}>{t('Decline','סירוב')}</Button>{refused&&<p className="swap-explanation" role="note">{explain(refused,'accept')}</p>}</>}
      {admin&&<><Button size="sm" onClick={()=>{setReview(r);setOverride(false);setReason('')}}>{t('Approve','אישור')}</Button><Button size="sm" variant="outline" onClick={()=>act(()=>remote.resolveSwap(r.id,'reject'),t('Request rejected.','הבקשה נדחתה.'))}>{t('Reject','דחייה')}</Button></>}
      {swapStarter(r)===me&&<Button size="sm" variant="ghost" onClick={()=>act(()=>remote.resolveSwap(r.id,'cancel'),t('Request cancelled.','הבקשה בוטלה.'))}>{t('Cancel request','ביטול בקשה')}</Button>}
     </div>}
    </article>;
   })}</div>
  </section>}
  <Dialog open={!!selection} onOpenChange={v=>!v&&close()}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{proposing?t('Propose swap','הצעת החלפה'):t('Confirm swap request','אישור בקשת החלפה')}</DialogTitle><DialogDescription>{proposing
    ?t('Both engineers accept first, then an admin approves. Assignments stay unchanged until final approval.','שני המהנדסים מאשרים תחילה, ואז מנהל מאשר. השיבוצים נשארים ללא שינוי עד לאישור הסופי.')
    :t('The other engineer accepts first, then an admin approves. Assignments stay unchanged until final approval.','המהנדס האחר מאשר תחילה, ואז מנהל מאשר. השיבוצים נשארים ללא שינוי עד לאישור הסופי.')}</DialogDescription></DialogHeader>
   <div className="swap-review">{[source,target].map((d,i)=>d&&<div key={d.id}><strong>{span(d.day,d.end_day)}</strong><span>{name(d.primary_id!)}</span>{!proposing&&<small>{i===0?t('Your duty','התורנות שלך'):t('Requested duty','התורנות המבוקשת')}</small>}</div>)}</div>
   {problem&&<p role="note">{explain(problem,'request')}</p>}
   {!eligible&&<p role="alert">{t('These duties changed or are no longer eligible. Cancel and choose again.','התורנויות השתנו או אינן מתאימות עוד. בטלו ובחרו שוב.')}</p>}
   {conflictAlert(requestConflicts,t('This swap can’t be sent until the availability changes. Choose other duties instead.','אי אפשר לשלוח את ההחלפה עד שהזמינות תשתנה. בחרו תורנויות אחרות במקום.'))}
   <label className="field-label">{t('Explanation (optional)','הסבר (אופציונלי)')}<textarea rows={2} maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>
   <div className="swap-request-actions"><Button disabled={remote.readOnly||!eligible||remote.saving||!!problem||!requestConflicts||requestConflicts.length>0} onClick={async()=>{if(source&&target&&await act(()=>remote.requestSwap(source.id,target.id,explanation),proposing?t('Swap proposed to both engineers.','ההחלפה הוצעה לשני המהנדסים.'):t('Swap request submitted.','בקשת ההחלפה נשלחה.')))close()}}>{proposing?t('Send to both','שליחה לשניהם'):t('Confirm Request','אישור בקשה')}</Button><Button variant="outline" onClick={close}>{t('Cancel','ביטול')}</Button></div>
  </DialogContent></Dialog>
  <Dialog open={!!consent} onOpenChange={v=>!v&&setConsent(null)}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Accept despite a conflict?','לאשר למרות התנגשות?')}</DialogTitle><DialogDescription>{consenting&&`${name(consenting.requester_id)} · ${span(consenting.from_day,consenting.from_end_day)} ↔ ${name(consenting.other_id)} · ${span(consenting.to_day,consenting.to_end_day)}`}</DialogDescription></DialogHeader>
   {consent&&!answerable&&changedAlert}
   {consent&&answerable&&conflictAlert(consent.conflicts,t('You can still accept. An admin must then approve an exception with a reason.','אפשר עדיין לאשר. לאחר מכן מנהל יצטרך לאשר חריגה עם נימוק.'))}
   <div className="swap-request-actions"><Button disabled={remote.readOnly||remote.saving||!answerable} onClick={async()=>{if(consenting&&await accept(consenting))setConsent(null)}}>{t('Accept anyway','אישור בכל זאת')}</Button><Button variant="outline" onClick={()=>setConsent(null)}>{t('Cancel','ביטול')}</Button></div>
  </DialogContent></Dialog>
  <Dialog open={!!review} onOpenChange={v=>!v&&setReview(null)}><DialogContent className="swap-request-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('Approve published swap','אישור החלפה בלוח שפורסם')}</DialogTitle><DialogDescription>{t('Record this swap in the external system first, then approve. Approval creates a new published version from the current publication; availability and weekend limits are checked again.','יש לרשום את ההחלפה במערכת החיצונית ורק אז לאשר. האישור יוצר גרסה חדשה מהפרסום הנוכחי; אילוצים ומגבלת סופי שבוע נבדקים שוב.')}</DialogDescription></DialogHeader>
   {summary?<div className="swap-summary"><pre aria-label={t('Swap summary','סיכום ההחלפה')}>{summary}</pre><Button size="sm" variant="outline" onClick={copySummary}><Copy size={15}/>{t('Copy summary','העתקת סיכום')}</Button></div>
    :current&&<p>{name(current.requester_id)} · {span(current.from_day,current.from_end_day)} ↔ {name(current.other_id)} · {span(current.to_day,current.to_end_day)}</p>}
   {review&&!reviewable&&changedAlert}
   {conflictAlert(reviewConflicts,t('Approving requires an explicit override with a reason.','האישור מחייב חריגה מפורשת עם נימוק.'))}
   <label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Explicitly override availability conflicts','אישור חריגה מפורשת מאילוצי זמינות')}</label>
   {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   {reviewProblem&&<p role="note">{explain(reviewProblem,'approve')}</p>}
   <Button disabled={remote.readOnly||remote.saving||!reviewable||(override&&!reason.trim())||(!!reviewConflicts?.length&&!override)||!!reviewProblem} onClick={async()=>{if(current&&await act(()=>remote.resolveSwap(current.id,'approve',override?reason:''),t('Swap approved and new version published.','ההחלפה אושרה ופורסמה גרסה חדשה.')))setReview(null)}}>{t('Approve & publish swap','אישור ופרסום ההחלפה')}</Button>
  </DialogContent></Dialog>
 </>;
}
