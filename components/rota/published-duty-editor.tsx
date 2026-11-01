'use client';
import {useRef,useState} from 'react';
import {Copy,ArrowLeftRight} from 'lucide-react';
import {toast} from 'sonner';
import {shortDate} from '@/lib/date-format';
import {userMessage} from '@/lib/messages';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {EditorDialog} from '@/components/rota/editor-dialog';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {addDays} from '@/lib/rota/engine';
import {combinedWeekend,dutyPoints,editConflicts,editStale,editSummary,owedUnits,pendingSwaps,validExtra,type EditKind,type PublishedEdit} from '@/lib/supabase/published-edit';
import type {DutyRow} from '@/lib/supabase/snapshot';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';

/** An admin's edit of one published duty: engineer, extra points and Temporary/Permanent,
 * then a copyable summary for the external record before a new version is published. */
export function PublishedDutyEditor({remote,row:opened,lang,onClose,onSwap}:{remote:TeamWorkspace;row:DutyRow;lang:'en'|'he';onClose:()=>void;onSwap?:()=>void}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 // The version reviewed here: a newer publication makes the save fail instead of applying to it.
 const [row]=useState(opened),raw=remote.snapshot!,weekend=combinedWeekend(row);
 const points=(n:number)=>lang==='en'?`${n} ${n===1?'point':'points'}`:`${n} ${n===1?'נקודה':'נקודות'}`;
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const [primary,setPrimary]=useState(row.primary_id!),[extra,setExtra]=useState(String(row.extra_points)),[saturday,setSaturday]=useState(String(row.saturday_extra_points??0));
 const [kind,setKind]=useState<EditKind>('temporary'),[override,setOverride]=useState(false),[reason,setReason]=useState(''),[step,setStep]=useState<'edit'|'review'>('edit');
 const lock=useRef(false),[pending,setPending]=useState(false),busy=remote.saving||pending;
 const extraValue=Number(extra),saturdayValue=weekend?Number(saturday):0;
 const validExtras=extra.trim()!==''&&validExtra(extraValue)&&(!weekend||(saturday.trim()!==''&&validExtra(saturdayValue)));
 const changed=primary!==row.primary_id,conflicts=changed?editConflicts(raw,primary,row):[];
 const unchanged=!changed&&extraValue===row.extra_points&&saturdayValue===(row.saturday_extra_points??0);
 const edit:PublishedEdit={primary,extra:extraValue,saturdayExtra:saturdayValue,kind,overrideReason:conflicts.length?reason:''};
 // A newer version or a reopened draft (another tab or admin) makes this copy stale; reopening the duty starts from the live one.
 const stale=editStale(raw,row),swaps=pendingSwaps(raw,row).length;
 const ready=!stale&&validExtras&&!unchanged&&(!conflicts.length||(override&&!!reason.trim()));
 const fmt=(day:string)=>shortDate(day,lang),last=addDays(row.end_day,-1);
 const members=raw.members.filter(m=>m.status==='approved'&&(m.active||m.id===row.primary_id)&&m.id!==row.secondary_id);
 const summary=ready?editSummary(row,edit,name,lang):'';
 async function copy(){
  try{
   if(navigator.clipboard)await navigator.clipboard.writeText(summary);
   // Without the async clipboard (an insecure origin), copy the selected summary.
   else{const box=document.querySelector<HTMLTextAreaElement>('.published-edit-summary');box?.select();if(!document.execCommand('copy'))throw Error('copy')}
   toast.success(t('Summary copied.','הסיכום הועתק.'))
  }
  catch{toast.error(t('Could not copy. Select the summary and copy it manually.','ההעתקה נכשלה. סמנו את הסיכום והעתיקו ידנית.'))}
 }
 async function save(){
  const publication=row.publication_id;
  if(lock.current||busy||!ready||!publication)return;
  lock.current=true;setPending(true);
  try{const result=await remote.editPublishedDuty(publication,row.day,edit);toast.success(t(`Published version ${result.version}.`,`פורסמה גרסה ${result.version}.`));onClose()}
  catch(e){toast.error(userMessage((e as Error).message,t))}
  finally{lock.current=false;setPending(false)}
 }
 function extraField(label:string,value:string,set:(v:string)=>void){
  return <label className="field-label">{label}<input type="number" inputMode="decimal" min={0} max={20} step={0.5} disabled={busy} value={value} onChange={e=>set(e.target.value)}/></label>;
 }
 return <EditorDialog onClose={onClose} saving={busy} lang={lang} className="duty-dialog published-edit-dialog"
  title={step==='edit'?t('Edit duty','עריכת תורנות'):t('Review and copy','בדיקה והעתקה')}
  description={`${fmt(row.day)}${last!==row.day?` – ${fmt(last)}`:''} · ${t('Published','פורסם')} · ${points(dutyPoints(row,row.extra_points,row.saturday_extra_points??0))}`}
  onCloseAutoFocus={event=>{event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-gesture-key="${row.day}"]`)?.focus()}}>
  {stale&&<p className="warning-note" role="alert">{t('This month changed after you opened this duty: a newer version was published or a draft was reopened. Close and open the duty again.','החודש השתנה אחרי שפתחת את התורנות: פורסמה גרסה חדשה או נפתחה טיוטה. יש לסגור ולפתוח את התורנות מחדש.')}</p>}
  {!stale&&!!swaps&&<p className="muted-copy" role="note">{t('A pending swap request includes this duty. Publishing cancels it, or asks the new engineer to accept again.','בקשת החלפה ממתינה כוללת את התורנות. הפרסום יבטל אותה, או יבקש מהמהנדס החדש לאשר שוב.')}</p>}
  {step==='edit'?<>
   <label className="field-label">{t('Engineer','מהנדס')}<Select disabled={busy} value={primary} onValueChange={v=>{setPrimary(v);setOverride(false);setReason('')}}>
    <SelectTrigger className="picker" aria-label={t('Engineer','מהנדס')}><SelectValue/></SelectTrigger>
    <SelectContent>{members.map(m=><SelectItem key={m.id} value={m.id}>{m.name}{m.id!==row.primary_id&&editConflicts(raw,m.id,row).length?t(' · unavailable',' · לא זמין'):''}</SelectItem>)}</SelectContent>
   </Select></label>
   {weekend?<div className="form-pair">{extraField(t('Friday extra points','תוספת ביום שישי'),extra,setExtra)}{extraField(t('Saturday extra points','תוספת ביום שבת'),saturday,setSaturday)}</div>
    :extraField(t('Extra points','נקודות נוספות'),extra,setExtra)}
   {!validExtras&&<p className="warning-note" role="alert">{t('Use 0 to 20 points in steps of 0.5.','יש להזין 0 עד 20 נקודות בקפיצות של 0.5.')}</p>}
   {changed&&<div className="published-edit-kind">
    <div className="segmented" role="group" aria-label={t('Compensation','פיצוי')}>
     {(['temporary','permanent'] as const).map(k=><button key={k} type="button" disabled={busy} aria-pressed={kind===k} className={kind===k?'selected':''} onClick={()=>setKind(k)}>{k==='temporary'?t('Temporary','זמני'):t('Permanent','קבוע')}</button>)}
    </div>
    <p className="muted-copy">{kind==='temporary'
     ?t(`${name(row.primary_id!)} owes ${name(primary)} ${points(owedUnits(row,extraValue||0,saturdayValue||0)/2)}, repaid in later months.`,`${name(row.primary_id!)} חייב/ת ל־${name(primary)} ${points(owedUnits(row,extraValue||0,saturdayValue||0)/2)}, שיוחזרו בחודשים הבאים.`)
     :t(`No debt. ${name(primary)} takes this duty for good.`,`ללא חוב. ${name(primary)} לוקח/ת את התורנות לצמיתות.`)}</p>
   </div>}
   {!!conflicts.length&&<div className="warning-note" role="alert">
    {conflicts.map(c=><p key={c.day}>{t(`${name(primary)} is unavailable on ${fmt(c.day)}`,`${name(primary)} לא זמין/ה ב־${fmt(c.day)}`)}{c.note?` · ${c.note}`:''}</p>)}
    <label className="check-label"><Checkbox disabled={busy} checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Override availability as admin','חריגה מאילוץ כמנהל')}</label>
    {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={2} maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   </div>}
   <div className="editor-actions"><Button disabled={!ready||busy} onClick={()=>setStep('review')}>{t('Review change','בדיקת השינוי')}</Button></div>
   {onSwap&&<Button variant="ghost" disabled={busy} onClick={onSwap}><ArrowLeftRight/>{t('Request a swap instead','בקשת החלפה במקום')}</Button>}
  </>:<>
   <p className="muted-copy">{t('Record this change in your external system first, then publish. Publishing creates a new version of the month.','רשמו את השינוי במערכת החיצונית תחילה, ואז פרסמו. הפרסום יוצר גרסה חדשה של החודש.')}</p>
   <label className="field-label">{t('Summary','סיכום')}<textarea className="published-edit-summary" readOnly value={summary} dir={lang==='he'?'rtl':'ltr'} style={{height:`calc(${summary.split('\n').length} * 1.55em + 24px)`}}/></label>
   <Button variant="outline" disabled={busy} onClick={copy}><Copy/>{t('Copy summary','העתקת הסיכום')}</Button>
   <div className="editor-actions">
    <Button variant="outline" disabled={busy} onClick={()=>setStep('edit')}>{t('Back','חזרה')}</Button>
    <Button disabled={busy||remote.readOnly||!ready} onClick={save}>{t('Publish change','פרסום השינוי')}</Button>
   </div>
  </>}
 </EditorDialog>;
}
