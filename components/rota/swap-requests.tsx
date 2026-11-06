'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {ArrowLeftRight,Copy} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Sheet} from '@/components/ui/sheet';
import {Chip,type ChipTone} from '@/components/ui/chip';
import {Avatar} from '@/components/ui/avatar';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {SwapRequest} from '@/lib/supabase/snapshot';
import {todayIsrael} from '@/lib/supabase/snapshot';
import {publishedSwapDuties,eligibleSwapTarget,visibleSwapRequests,swapStarter,swapWaitingOn,swapAnswerFor,swapSummary,swapDuties,swapProblem,type SwapConflict,type SwapProblem} from '@/lib/supabase/swaps';
import {addDays} from '@/lib/rota/engine';
import {toast} from 'sonner';
import {userMessage} from '@/lib/messages';

type Translate=(en:string,he:string)=>string;

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

const fmtDay=(day:string,lang:'en'|'he')=>new Date(day+'T12:00:00Z').toLocaleDateString(lang==='he'?'he-IL':'en-GB',{day:'numeric',month:'short',timeZone:'Asia/Jerusalem'});
const spanOf=(start:string,end:string,lang:'en'|'he')=>fmtDay(start,lang)+(end!==addDays(start,1)?` – ${fmtDay(addDays(end,-1),lang)}`:'');

function conflictAlert(conflicts:SwapConflict[]|null,footer:string,name:(id:string)=>string,t:Translate,lang:'en'|'he'){
 return !!conflicts?.length&&<div className="note-line" data-tone="danger" role="alert" style={{display:'block'}}>
  <strong>{t('Availability conflict','התנגשות זמינות')}</strong>
  <ul className="swap-conflicts">{conflicts.map(c=><li key={`${c.member}${c.day}`}>{c.member
   ?t(`${name(c.member)} is unavailable on ${fmtDay(c.day,lang)}`,`ל־${name(c.member)} יש אילוץ אי־זמינות ב־${fmtDay(c.day,lang)}`)
   :t(`Emergency cover is unavailable on ${fmtDay(c.day,lang)}`,`לכונן החירום יש אילוץ אי־זמינות ב־${fmtDay(c.day,lang)}`)}</li>)}</ul>
  <p>{footer}</p>
 </div>;
}

/** Accept, decline, approve, reject and cancel, with their consent and approval sheets. The
 * sheets render through `dialogs` once, at the workspace root; cards anywhere call the actions. */
export function useSwapActions(remote:TeamWorkspace,lang:'en'|'he'){
 const t:Translate=(en,he)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const [review,setReview]=useState<SwapRequest|null>(null),[override,setOverride]=useState(false),[reason,setReason]=useState('');
 const [consent,setConsent]=useState<{request:SwapRequest;conflicts:SwapConflict[]}|null>(null);
 const temporary=new Set(raw.members.filter(m=>m.is_temporary).map(m=>m.id));
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const explain=(p:SwapProblem,step:'request'|'accept'|'approve')=>(p.person===me?t('This swap would give you a second weekend this month.','ההחלפה הזו תיתן לך סוף שבוע שני החודש.'):t(`This swap would give ${name(p.person)} a second weekend this month.`,`ההחלפה הזו תיתן ל${name(p.person)} סוף שבוע שני החודש.`))+' '+
  ({request:t('Choose another duty.','יש לבחור תורנות אחרת.'),accept:t('Decline it instead.','אפשר לסרב לה במקום.'),approve:t('Reject it instead.','אפשר לדחות אותה במקום.')}[step]);
 // Dialogs read the latest copy: a refresh (another tab, a republish) can reassign, invalidate or resolve the request while it is open.
 const latest=(r:SwapRequest|undefined)=>r&&(raw.swapRequests??[]).find(x=>x.id===r.id);
 const current=latest(review??undefined),reviewable=current?.status==='awaiting_admin';
 const consenting=latest(consent?.request),answerable=!!consenting&&swapAnswerFor(consenting,me,remote.isAdmin,temporary)!==null;
 const reviewed=current?swapDuties(raw,current):null;
 const reviewConflicts=useSwapConflicts(remote,reviewed?.source?.id,reviewed?.target?.id);
 const reviewProblem=current&&reviewed?.source&&reviewed.target?swapProblem(raw,current.month,reviewed.source,reviewed.target,false):null;
 const summary=current&&reviewed?.source&&reviewed.target?swapSummary({requester:name(current.requester_id),other:name(current.other_id),lang,
  from:{label:spanOf(current.from_day,current.from_end_day,lang),points:reviewed.source.points},to:{label:spanOf(current.to_day,current.to_end_day,lang),points:reviewed.target.points}}):'';
 const changedAlert=<p className="note-line" role="alert">{t('This request changed and no longer needs this answer. Close and check the list.','הבקשה השתנתה ואינה ממתינה עוד לתשובה זו. סגרו ובדקו את הרשימה.')}</p>;
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error(userMessage((e as Error).message,t));return false}}
 function accept(r:SwapRequest){
  const last=swapWaitingOn(r).length===1;
  return act(()=>remote.resolveSwap(r.id,'accept'),last?t('Accepted · waiting for an admin','התקבל · ממתין למנהל'):t('Accepted · waiting for the other engineer','התקבל · ממתין למהנדס השני'));
 }
 // Availability is rechecked at consent; a conflict can be accepted, then needs an admin override.
 async function startAccept(r:SwapRequest){
  const {source:from,target:to}=swapDuties(raw,r),conflicts=from&&to?await remote.swapAvailability(from.id,to.id).catch(()=>[]):[];
  if(conflicts.length)setConsent({request:r,conflicts});else await accept(r);
 }
 async function copySummary(){
  try{await navigator.clipboard.writeText(summary);toast.success(t('Copied','הועתק'))}
  catch{toast.error(t('Could not copy. Select the text instead.','ההעתקה נכשלה. סמנו את הטקסט במקום.'))}
 }
 const dialogs:ReactNode=<>
  <Sheet open={!!consent} onOpenChange={v=>!v&&setConsent(null)} lang={lang} kind="alert" title={t('Accept despite a conflict?','לאשר למרות התנגשות?')}
   description={consenting&&`${name(consenting.requester_id)} · ${spanOf(consenting.from_day,consenting.from_end_day,lang)} ↔ ${name(consenting.other_id)} · ${spanOf(consenting.to_day,consenting.to_end_day,lang)}`}
   footer={<div className="sheet-actions"><Button variant="secondary" onClick={()=>setConsent(null)}>{t('Cancel','ביטול')}</Button><Button disabled={remote.readOnly||remote.saving||!answerable} onClick={async()=>{if(consenting&&await accept(consenting))setConsent(null)}}>{t('Accept anyway','אישור בכל זאת')}</Button></div>}>
   {consent&&!answerable&&changedAlert}
   {consent&&answerable&&conflictAlert(consent.conflicts,t('You can still accept. An admin must then approve an exception with a reason.','אפשר עדיין לאשר. לאחר מכן מנהל יצטרך לאשר חריגה עם נימוק.'),name,t,lang)}
  </Sheet>
  <Sheet open={!!review} onOpenChange={v=>!v&&setReview(null)} lang={lang} title={t('Approve swap','אישור החלפה')} description={t('Record it in the external system first. Approval publishes a new version.','יש לרשום במערכת החיצונית תחילה. האישור מפרסם גרסה חדשה.')}
   footer={<div className="sheet-actions"><Button disabled={remote.readOnly||remote.saving||!reviewable||(override&&!reason.trim())||(!!reviewConflicts?.length&&!override)||!!reviewProblem} onClick={async()=>{if(current&&await act(()=>remote.resolveSwap(current.id,'approve',override?reason:''),t('Swap approved and published','ההחלפה אושרה ופורסמה')))setReview(null)}}>{t('Approve & publish','אישור ופרסום')}</Button></div>}>
   {summary?<div className="swap-summary"><pre aria-label={t('Swap summary','סיכום ההחלפה')}>{summary}</pre><Button size="sm" variant="secondary" onClick={copySummary}><Copy/>{t('Copy summary','העתקת סיכום')}</Button></div>
    :current&&<p>{name(current.requester_id)} · {spanOf(current.from_day,current.from_end_day,lang)} ↔ {name(current.other_id)} · {spanOf(current.to_day,current.to_end_day,lang)}</p>}
   {review&&!reviewable&&changedAlert}
   {conflictAlert(reviewConflicts,t('Approving requires an explicit override with a reason.','האישור מחייב חריגה מפורשת עם נימוק.'),name,t,lang)}
   <label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Explicitly override availability conflicts','אישור חריגה מפורשת מאילוצי זמינות')}</label>
   {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   {reviewProblem&&<p className="note-line" role="note">{explain(reviewProblem,'approve')}</p>}
  </Sheet>
 </>;
 return {
  dialogs,name,temporary,explain,
  requests:visibleSwapRequests(raw.swapRequests??[],me,remote.isAdmin,temporary),
  startAccept,
  decline:(r:SwapRequest)=>act(()=>remote.resolveSwap(r.id,'decline'),t('Declined','סורב')),
  openApprove:(r:SwapRequest)=>{setReview(r);setOverride(false);setReason('')},
  reject:(r:SwapRequest)=>act(()=>remote.resolveSwap(r.id,'reject'),t('Rejected','נדחה')),
  cancel:(r:SwapRequest)=>act(()=>remote.resolveSwap(r.id,'cancel'),t('Request cancelled','הבקשה בוטלה')),
 };
}
export type SwapActions=ReturnType<typeof useSwapActions>;

/** One request as a card: who, which dates, its state, and the answer it waits for from the viewer. */
export function SwapCard({r,swaps,remote,lang}:{r:SwapRequest;swaps:SwapActions;remote:TeamWorkspace;lang:'en'|'he'}){
 const t:Translate=(en,he)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id,{name,temporary}=swaps;
 const member=(id:string)=>raw.members.find(m=>m.id===id);
 const waiting=swapWaitingOn(r),answerFor=swapAnswerFor(r,me,remote.isAdmin,temporary),incoming=answerFor!==null,admin=remote.isAdmin&&r.status==='awaiting_admin',pending=['awaiting_engineer','awaiting_admin'].includes(r.status);
 // Consent may precede an availability override, never a second weekend.
 const duties=incoming?swapDuties(raw,r):null,refused=duties?.source&&duties.target?swapProblem(raw,r.month,duties.source,duties.target,false):null;
 const status:[string,ChipTone]={awaiting_engineer:[t('Waiting for an answer','ממתינה לתשובה'),'info'],awaiting_admin:[t('Waiting for an admin','ממתינה למנהל'),'warn'],approved:[t('Approved','אושרה'),'ok'],declined:[t('Declined','סורבה'),'danger'],rejected:[t('Rejected','נדחתה'),'danger'],cancelled:[t('Cancelled','בוטלה'),'neutral'],invalidated:[t('No longer applies','כבר לא תקפה'),'neutral']}[r.status] as [string,ChipTone];
 const you=(id:string)=>id===me?t('You','את/ה'):name(id).split(' ')[0];
 return <article className={'swap-card '+(incoming?'incoming':admin?'admin-review':'outgoing')} data-swap-card={r.id}>
  <div className="swap-card-head">
   <span className="swap-card-icon" data-tone={incoming?'info':admin?'warn':'neutral'}><ArrowLeftRight/></span>
   <div className="swap-card-text">
    <strong>{incoming?answerFor===me?t(`${name(r.requester_id===me?r.other_id:r.requester_id)} asks to swap`,`${name(r.requester_id===me?r.other_id:r.requester_id)} מבקש/ת להחליף`):t(`Answer for ${name(answerFor!)} (temporary)`,`מענה עבור ${name(answerFor!)} (זמני)`):admin?t('Swap to approve','החלפה לאישור'):r.proposed_by===me?t('Your proposal','ההצעה שלך'):t('Your request','הבקשה שלך')}</strong>
    <span className="swap-card-pair">
     <Avatar name={name(r.requester_id)} color={member(r.requester_id)?.color} size={22}/>{you(r.requester_id)} · {spanOf(r.from_day,r.from_end_day,lang)}
     <span className="swap-arrow">↔</span>
     <Avatar name={name(r.other_id)} color={member(r.other_id)?.color} size={22}/>{you(r.other_id)} · {spanOf(r.to_day,r.to_end_day,lang)}
    </span>
    {r.proposed_by&&r.proposed_by!==me&&<small>{t('Proposed by','הוצעה על ידי')} {name(r.proposed_by)}</small>}
    {waiting.length>0&&(r.proposed_by||waiting.some(id=>temporary.has(id)))&&!incoming&&<small>{t('Waiting for','ממתינה ל')}: {waiting.map(id=>temporary.has(id)?t(`${name(id)} (temporary, an admin answers)`,`${name(id)} (זמני, מנהל עונה)`):name(id)).join(', ')}</small>}
    {r.explanation&&<p className="swap-explanation">{r.explanation}</p>}{r.override_reason&&<small>{t('Admin override','חריגת מנהל')}: {r.override_reason}</small>}
    {refused&&<small className="swap-refused" role="note">{swaps.explain(refused,'accept')}</small>}
   </div>
   <Chip tone={status[1]} size="sm" className="swap-status">{status[0]}</Chip>
  </div>
  {pending&&<div className="swap-card-actions">
   {incoming&&<><Button size="sm" disabled={!!refused||remote.readOnly} onClick={()=>swaps.startAccept(r)}>{t('Accept','קבלה')}</Button><Button size="sm" variant="secondary" disabled={remote.readOnly} onClick={()=>swaps.decline(r)}>{t('Decline','סירוב')}</Button></>}
   {admin&&<><Button size="sm" disabled={remote.readOnly} onClick={()=>swaps.openApprove(r)}>{t('Approve','אישור')}</Button><Button size="sm" variant="secondary" disabled={remote.readOnly} onClick={()=>swaps.reject(r)}>{t('Reject','דחייה')}</Button></>}
   {swapStarter(r)===me&&<Button size="sm" variant="ghost" disabled={remote.readOnly} onClick={()=>swaps.cancel(r)}>{t('Cancel request','ביטול הבקשה')}</Button>}
  </div>}
 </article>;
}

/** The confirmation of a swap chosen in the calendar (two duties), for members and admins. */
export function SwapRequestDialog({remote,month,lang,selection,onSelection}:{remote:TeamWorkspace;month:string;lang:'en'|'he';selection:{from:string;to:string}|null;onSelection:(value:{from:string;to:string}|null)=>void}){
 const [explanation,setExplanation]=useState('');
 const t:Translate=(en,he)=>lang==='he'?he:en,raw=remote.snapshot!,me=remote.user!.id;
 const duties=publishedSwapDuties(raw,month,todayIsrael()),pick=(day?:string)=>duties.find(d=>d.day===day);
 // Engineers offer their own duty. An admin may pick any two; as a party, their side is the request's side.
 let source=pick(selection?.from),target=pick(selection?.to);
 if(!remote.isAdmin&&source?.primary_id!==me)source=undefined;
 if(remote.isAdmin&&target?.primary_id===me)[source,target]=[target,source];
 const eligible=eligibleSwapTarget(source,target),proposing=eligible&&source!.primary_id!==me;
 // Availability comes from the server's alert; the weekend limit is checked here.
 const problem=eligible?swapProblem(raw,month,source!,target!,false):null;
 const requestConflicts=useSwapConflicts(remote,eligible?source!.id:undefined,eligible?target!.id:undefined);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const member=(id:string)=>raw.members.find(m=>m.id===id);
 const explain=(p:SwapProblem)=>(p.person===me?t('This swap would give you a second weekend this month.','ההחלפה הזו תיתן לך סוף שבוע שני החודש.'):t(`This swap would give ${name(p.person)} a second weekend this month.`,`ההחלפה הזו תיתן ל${name(p.person)} סוף שבוע שני החודש.`))+' '+t('Choose another duty.','יש לבחור תורנות אחרת.');
 async function act(operation:()=>Promise<void>,success:string){try{await operation();toast.success(success);return true}catch(e){toast.error(userMessage((e as Error).message,t));return false}}
 function close(){onSelection(null);setExplanation('')}
 return <Sheet open={!!selection} onOpenChange={v=>!v&&close()} lang={lang} title={proposing?t('Propose swap','הצעת החלפה'):t('Ask to swap','בקשת החלפה')}
  description={proposing?t('Both engineers accept, then an admin approves.','שני המהנדסים מאשרים, ואז מנהל מאשר.'):t('The other engineer accepts, then an admin approves.','המהנדס האחר מאשר, ואז מנהל מאשר.')}
  footer={<div className="sheet-actions"><Button variant="secondary" onClick={close}>{t('Cancel','ביטול')}</Button><Button disabled={remote.readOnly||!eligible||remote.saving||!!problem||!requestConflicts||requestConflicts.length>0} onClick={async()=>{if(source&&target&&await act(()=>remote.requestSwap(source.id,target.id,explanation),proposing?t('Proposed to both engineers','הוצע לשני המהנדסים'):t('Request sent','הבקשה נשלחה')))close()}}>{proposing?t('Send to both','שליחה לשניהם'):t('Confirm Request','אישור בקשה')}</Button></div>}>
  <div className="swap-review">{[source,target].map((d,i)=>d&&<div key={d.id} className="card card-inset"><div className="row">
   <span className="row-lead"><Avatar name={name(d.primary_id!)} color={member(d.primary_id!)?.color} size={36}/></span>
   <span className="row-body"><span className="row-title">{spanOf(d.day,d.end_day,lang)}</span><span className="row-subtitle">{name(d.primary_id!)}{!proposing&&` · ${i===0?t('your duty','התורנות שלך'):t('requested duty','התורנות המבוקשת')}`}</span></span>
   <span className="row-trail"><Chip tone="neutral" size="sm">{d.points} {t('pt','נק׳')}</Chip></span>
  </div></div>)}</div>
  {problem&&<p className="note-line" role="note">{explain(problem)}</p>}
  {!eligible&&<p className="note-line" data-tone="danger" role="alert">{t('These duties changed or are no longer eligible. Cancel and choose again.','התורנויות השתנו או אינן מתאימות עוד. בטלו ובחרו שוב.')}</p>}
  {conflictAlert(requestConflicts,t('This swap can’t be sent until the availability changes. Choose other duties instead.','אי אפשר לשלוח את ההחלפה עד שהזמינות תשתנה. בחרו תורנויות אחרות במקום.'),name,t,lang)}
  <label className="field-label">{t('Explanation (optional)','הסבר (אופציונלי)')}<textarea rows={2} maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>
 </Sheet>;
}
