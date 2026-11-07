'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeftRight} from 'lucide-react';
import {toast} from 'sonner';
import {shortDate} from '@/lib/date-format';
import {userMessage} from '@/lib/messages';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {EditorDialog} from '@/components/rota/editor-dialog';
import {KindChoice,ReviewStep} from '@/components/rota/published-duty-editor';
import {DayCard,DayCards,DayHeading,KeepChoice,SplitJoinRow,WeekendLayoutSwitch,useWeekendLayout,type Half} from '@/components/rota/weekend-cards';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {editStale,halfPoints,swapPartners,validExtra,weekendChanges,weekendConflicts,weekendEditSummary,type EditKind,type PublishedWeekend,type WeekendEdit} from '@/lib/supabase/published-edit';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';

type DayPick={primary:string;points:string};

/** An admin's edit of one published weekend (decision 2026-11-07), in the draft editor's
 * "One weekend | Two days" layout: one card, or a card per day with its own person and points
 * (each starts at its date's own points, half the weekend's). Different people split it; the
 * same person joins it back. Temporary/Permanent and the copyable summary as in Edit duty. */
export function PublishedWeekendEditor({remote,weekend:opened,focusDay,lang,onClose,onSwap}:{remote:TeamWorkspace;weekend:PublishedWeekend;focusDay:string;lang:'en'|'he';onClose:()=>void;onSwap?:()=>void}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 // The version reviewed here: a newer publication makes the save fail instead of applying to it.
 const [w]=useState(opened),raw=remote.snapshot!;
 const layout=useWeekendLayout(w.joined?'one':'half'),{mode,choosing}=layout;
 const focus:Half=focusDay===w.sat.day?'sat':'fri';
 const [fri,setFri]=useState<DayPick>({primary:w.fri.primary,points:String(halfPoints(w.fri.extra))}),[sat,setSat]=useState<DayPick>({primary:w.sat.primary,points:String(halfPoints(w.sat.extra))});
 const [kind,setKind]=useState<EditKind>('temporary'),[override,setOverride]=useState(false),[reason,setReason]=useState(''),[approveWeekend,setApproveWeekend]=useState(false),[step,setStep]=useState<'edit'|'review'>('edit');
 const lock=useRef(false),[pending,setPending]=useState(false),busy=remote.saving||pending;
 // Who a Permanent edit would give each date back to, undoing a Temporary change (H1): the server decides.
 const [returns,setReturns]=useState<Record<string,string[]>|'error'|null>(null);
 useEffect(()=>{
  let live=true;const publication=w.fri.row.publication_id!;
  Promise.all([w.fri.day,w.sat.day].map(day=>remote.editReturns(publication,day))).then(([a,b])=>{if(live)setReturns({[w.fri.day]:a,[w.sat.day]:b})},()=>{if(live)setReturns('error')});
  return ()=>{live=false};
  // The opened version is fixed for this dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[w]);
 const name=(id:string)=>raw.members.find(m=>m.id===id)?.name??t('Former member','חבר צוות קודם');
 const pts=(n:number)=>lang==='en'?`${n} ${n===1?'point':'points'}`:`${n} ${n===1?'נקודה':'נקודות'}`;
 const fmt=(day:string)=>shortDate(day,lang);
 const get=(h:Half)=>h==='fri'?fri:sat;
 const extraOf=(p:DayPick)=>Number(p.points)-.5,validPoints=(p:DayPick)=>p.points.trim()!==''&&validExtra(extraOf(p));
 const valid=validPoints(fri)&&validPoints(sat);
 const draft:WeekendEdit={fridayPrimary:fri.primary,fridayExtra:extraOf(fri),saturdayPrimary:sat.primary,saturdayExtra:extraOf(sat),kind,overrideReason:''};
 const joined=fri.primary===sat.primary;
 const changes=weekendChanges(w,draft),conflicts=weekendConflicts(raw,w,draft);
 const edit:WeekendEdit={...draft,overrideReason:conflicts.length?reason:''};
 const unchanged=joined===w.joined&&!changes.length&&edit.fridayExtra===w.fri.extra&&edit.saturdayExtra===w.sat.extra;
 // A No weekends member newly placed on a date needs the manager's approval, like unavailability.
 const skipped=changes.filter(c=>raw.members.find(m=>m.id===c.to)?.no_weekends);
 const permanent=kind==='permanent'&&!!changes.length,known=returns!==null&&returns!=='error';
 const returning=new Set(permanent&&known?changes.filter(c=>returns[c.day]?.includes(c.to)).map(c=>c.day):[]);
 // A newer version or a reopened draft (another tab or admin) makes this copy stale.
 const stale=editStale(raw,w.fri.row),partners=[...new Set([w.fri.row,w.sat.row].flatMap(r=>swapPartners(raw,r)))].map(name).join(', ');
 const ready=!stale&&valid&&!unchanged&&!choosing&&(!conflicts.length||(override&&!!reason.trim()))&&(!skipped.length||approveWeekend)&&(!permanent||known);
 const summary=ready?weekendEditSummary(w,edit,name,lang,returning):'';
 // Any change of person or points asks again for approvals.
 function update(h:Half|'both',f:(p:DayPick)=>DayPick){setOverride(false);setReason('');setApproveWeekend(false);if(h!=='sat')setFri(f);if(h!=='fri')setSat(f)}
 function join(){layout.join(fri.primary===sat.primary)}
 function keep(h:Half){const kept=get(h).primary;update('both',p=>({...p,primary:kept}));layout.kept()}
 function setLayout(next:'one'|'two'){if(next==='two')layout.split();else join()}
 async function save(){
  const publication=w.fri.row.publication_id;
  if(lock.current||busy||!ready||!publication)return;
  lock.current=true;setPending(true);
  try{const result=await remote.editPublishedWeekend(publication,w.friday,edit);toast.success(t(`Published version ${result.version}.`,`פורסמה גרסה ${result.version}.`));onClose()}
  catch(e){toast.error(userMessage((e as Error).message,t))}
  finally{lock.current=false;setPending(false)}
 }
 const covers=(h:Half|'both')=>h==='both'?[w.fri.row.secondary_id,w.sat.row.secondary_id]:[(h==='fri'?w.fri:w.sat).row.secondary_id];
 const days=(h:Half|'both')=>h==='both'?[w.fri.day,w.sat.day]:[h==='fri'?w.fri.day:w.sat.day];
 function picker(h:Half|'both',aria:string){
  const current=get(h==='sat'?'sat':'fri').primary,holders=[w.fri.primary,w.sat.primary];
  const members=raw.members.filter(m=>m.status==='approved'&&(m.active||holders.includes(m.id))&&!covers(h).includes(m.id));
  return <label className="field-label">{t('Primary engineer','מהנדס ראשי')}<Select disabled={busy} value={current} onValueChange={v=>update(h,p=>({...p,primary:v}))}>
   <SelectTrigger className="picker" aria-label={aria}><SelectValue/></SelectTrigger>
   <SelectContent>{members.map(m=><SelectItem key={m.id} value={m.id}>{m.name}{raw.constraints.some(c=>c.member_id===m.id&&c.kind==='no'&&days(h).includes(c.day))&&!holders.includes(m.id)?t(' · unavailable',' · לא זמין'):''}{m.no_weekends&&!holders.includes(m.id)?t(' · no weekends',' · ללא סופי שבוע'):''}</SelectItem>)}</SelectContent>
  </Select></label>;
 }
 function pointsField(h:Half,label:string){
  const p=get(h);
  return <label className="field-label">{label}<input type="number" inputMode="decimal" min={0.5} max={20.5} step={0.5} disabled={busy} value={p.points} onChange={e=>{const v=e.target.value;update(h,x=>({...x,points:v}))}}/></label>;
 }
 const dayName=(h:Half)=>h==='fri'?t('Friday','שישי'):t('Saturday','שבת');
 function card(h:Half|'both'){
  const own=h!=='both'&&mode==='two';
  const heading=own?<DayHeading points={pts(Number(get(h).points)||0)}>{fmt(h==='fri'?w.fri.day:w.sat.day)}</DayHeading>:<DayHeading>{t('On duty','בתורנות')}</DayHeading>;
  return <DayCard half={h} heading={heading}>
   {h==='both'&&choosing?<KeepChoice lang={lang} disabled={busy} onKeep={keep} options={(['fri','sat'] as const).map(k=>{const kept=get(k).primary,other=get(k==='fri'?'sat':'fri').primary,p=raw.members.find(x=>x.id===kept);
    return {half:k,person:p&&{name:p.name,color:p.color},title:t(`Keep ${name(kept)}`,`להשאיר את ${name(kept)}`),detail:`${name(other)} −${Number(get(k==='fri'?'sat':'fri').points)||0}`}})}/>
   :h==='both'?<>
    {picker('both',t('Primary engineer','מהנדס ראשי'))}
    <div className="form-pair">{pointsField('fri',t('Friday points','נקודות ביום שישי'))}{pointsField('sat',t('Saturday points','נקודות ביום שבת'))}</div>
   </>:<>
    {picker(h,own?t(`${dayName(h)} primary engineer`,`מהנדס ראשי ביום ${dayName(h)}`):t('Primary engineer','מהנדס ראשי'))}
    {pointsField(h,own?t(`${dayName(h)} points`,`נקודות ביום ${dayName(h)}`):t('Points','נקודות'))}
   </>}
  </DayCard>;
 }
 const total=(Number(fri.points)||0)+(Number(sat.points)||0);
 const temporaryText=changes.map(c=>t(`${name(c.from)} owes ${name(c.to)} ${pts(c.owed)} (${fmt(c.day)})`,`${name(c.from)} חייב/ת ל־${name(c.to)} ${pts(c.owed)} (${fmt(c.day)})`)).join(' · ');
 return <EditorDialog onClose={onClose} saving={busy} lang={lang} className="duty-dialog published-edit-dialog"
  title={step==='edit'?(mode==='half'?t('Edit duty','עריכת תורנות'):t('Weekend','סוף שבוע')):t('Review and copy','בדיקה והעתקה')}
  description={mode==='half'&&step==='edit'?`${fmt(focusDay)} · ${t('Published','פורסם')} · ${pts(Number(get(focus).points)||0)}`:`${fmt(w.fri.day)} – ${fmt(w.sat.day)} · ${t('Published','פורסם')} · ${pts(total)}`}
  onCloseAutoFocus={event=>{event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-gesture-key="${focusDay}"]`)?.focus()}}>
  {stale&&<p className="warning-note" role="alert">{t('This month changed after you opened this duty: a newer version was published or a draft was reopened. Close and open the duty again.','החודש השתנה אחרי שפתחת את התורנות: פורסמה גרסה חדשה או נפתחה טיוטה. יש לסגור ולפתוח את התורנות מחדש.')}</p>}
  {!stale&&!!partners&&<p className="warning-note" role="note">{t(`Pending swap with ${partners}. Saving cancels it.`,`החלפה ממתינה עם ${partners}. השמירה תבטל אותה.`)}</p>}
  {step==='edit'?<>
   {mode!=='half'&&<WeekendLayoutSwitch lang={lang} layout={layout} disabled={busy} onChange={setLayout}/>}
   {mode==='half'&&<SplitJoinRow lang={lang} disabled={busy} onJoin={join}/>}
   <DayCards layout={layout} weekend focus={focus} card={card}/>
   {!valid&&<p className="warning-note" role="alert">{t('Use 0.5 to 20.5 points a day in steps of 0.5.','יש להזין 0.5 עד 20.5 נקודות ליום בקפיצות של 0.5.')}</p>}
   {!!changes.length&&!choosing&&<div className="published-edit-kind">
    <KindChoice lang={lang} kind={kind} busy={busy} onChange={setKind}/>
    <p className="muted-copy">{kind==='temporary'?t(`${temporaryText}, repaid in later months.`,`${temporaryText}, שיוחזרו בחודשים הבאים.`)
     :returns===null?t('Checking this weekend’s earlier changes…','בודקים את השינויים הקודמים בסוף השבוע…')
     :returns==='error'?t('Could not read this weekend’s earlier changes. Close and open it again.','לא ניתן לקרוא את השינויים הקודמים בסוף השבוע. יש לסגור ולפתוח אותו מחדש.')
     :returning.size?t('Giving a day back undoes its Temporary change, so that debt cancels. Otherwise no debt.','החזרת יום מבטלת את השינוי הזמני שלו, וגם את החוב. מעבר לכך ללא חוב.')
     :t('No debt. Each day goes to its new person for good.','ללא חוב. כל יום עובר לאדם החדש לצמיתות.')}</p>
   </div>}
   {!!conflicts.length&&<div className="warning-note" role="alert">
    {conflicts.map(c=><p key={c.day}>{t(`${name(c.member)} is unavailable on ${fmt(c.day)}`,`${name(c.member)} לא זמין/ה ב־${fmt(c.day)}`)}{c.note?` · ${c.note}`:''}</p>)}
    <label className="check-label"><Checkbox disabled={busy} checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Override availability as admin','חריגה מאילוץ כמנהל')}</label>
    {override&&<label className="field-label">{t('Required audit reason','נימוק חובה לתיעוד')}<textarea rows={2} maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
   </div>}
   {!!skipped.length&&<div className="warning-note" role="alert">
    {skipped.map(c=><p key={c.day}>{t(`${name(c.to)} doesn’t take weekends · ${fmt(c.day)}`,`${name(c.to)} לא עושה סופי שבוע · ${fmt(c.day)}`)}</p>)}
    <label className="check-label"><Checkbox disabled={busy} checked={approveWeekend} onCheckedChange={v=>setApproveWeekend(!!v)}/>{t('Approve this exception as manager','אישור החריגה כמנהל')}</label>
   </div>}
   {unchanged&&valid&&!stale&&!choosing&&<p className="muted-copy" role="note">{t('Choose another engineer, split the weekend or change the points to review a change.','יש לבחור מהנדס אחר, לפצל את סוף השבוע או לשנות את הנקודות כדי לבדוק שינוי.')}</p>}
   <div className="editor-actions"><Button disabled={!ready||busy} onClick={()=>setStep('review')}>{t('Review change','בדיקת השינוי')}</Button></div>
   {onSwap&&<Button variant="ghost" disabled={busy} onClick={onSwap}><ArrowLeftRight/>{t('Swap with another duty…','החלפה עם תורנות אחרת…')}</Button>}
  </>:<ReviewStep lang={lang} summary={summary} busy={busy} canPublish={!remote.readOnly&&ready} onBack={()=>setStep('edit')} onPublish={save}/>}
 </EditorDialog>;
}
