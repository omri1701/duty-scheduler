'use client';
import {useRef,useState} from 'react';
import {LockKeyhole,LockKeyholeOpen,Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {EditorDialog} from '@/components/rota/editor-dialog';
import {DayCard,DayCards,DayHeading,KeepChoice,SplitJoinRow,WeekendLayoutSwitch,useWeekendLayout,type Half} from '@/components/rota/weekend-cards';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {addDays,blocks,noWeekendPlacements,ownerMonth,unavailable,weekendAssignments,setWeekendAssignments,weekendCounts,type State,type Duty,type Assignment} from '@/lib/rota/engine';

/** Edits one duty. A weekend opens as one card with a "One weekend | Two days" switch; two days
 * edits each date like a regular day. Saving identical halves joins them (normalizeWeekends). */
export function DutyEditor({state,duty,month,lang,onClose,onMonth,onSave,onRemoveSpecial,saving=false}:{state:State;duty:Duty;month:string;lang:'en'|'he';onClose:()=>void;onMonth:(month:string)=>void;onSave:(change:(s:State)=>State,reviewedLocks?:string[])=>void|Promise<void>;onRemoveSpecial:()=>void|Promise<void>;saving?:boolean}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 const lock=useRef(false),[pending,setPending]=useState(false),busy=saving||pending;
 const close=()=>{if(!lock.current&&!saving)onClose()};
 async function submit(action:()=>void|Promise<void>){if(lock.current||saving)return;lock.current=true;setPending(true);try{await action()}finally{lock.current=false;setPending(false)}}
 const weekend=!!duty.weekendId,friday=duty.weekendId??duty.start,saturday=addDays(friday,1);
 const splitHalf=weekend&&duty.end===addDays(duty.start,1),focus:Half=duty.start===saturday?'sat':'fri';
 // Each date's own points, as the halves of a split weekend carry them (0.5, or a holiday date's).
 const halves=weekend?blocks(ownerMonth(duty),state.specials,[...(state.splitWeekends??[]),friday]):[];
 const halfPoints=(h:Half)=>halves.find(b=>b.id===(h==='fri'?friday:saturday))?.points??0.5;
 const [initialFri,initialSat]=weekend?weekendAssignments(state,friday):[state.assignments[duty.id]??{primary:''},{primary:''}];
 const [fri,setFri]=useState<Assignment>(initialFri),[sat,setSat]=useState<Assignment>(initialSat);
 const layout=useWeekendLayout(splitHalf?'half':'one'),{mode,choosing}=layout,[override,setOverride]=useState(false);
 const carry=ownerMonth(duty)!==month;
 const day=(start:string):Duty=>({...duty,id:start,start,end:addDays(start,1)});
 const edits=weekend?[{block:day(friday),assignment:fri},{block:day(saturday),assignment:sat}]:[{block:duty,assignment:fri}];
 const name=(id:string)=>state.team.find(p=>p.id===id)?.name??id;
 const dateLabel=(d:string)=>new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
 const fmt=(d:string)=>new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{day:'numeric',month:'short',timeZone:'UTC'});
 const range=lang==='en'&&friday.slice(0,7)===saturday.slice(0,7)?`${dateLabel(friday).replace(/ \S+$/,'')} – ${dateLabel(saturday)}`:`${dateLabel(friday)} – ${dateLabel(saturday)}`;
 const pts=(n:number)=>`${n} ${t('pt','נק׳')}`;
 const conflicts=edits.flatMap(({block,assignment})=>[assignment.primary,assignment.secondary].filter((id):id is string=>!!id).flatMap(id=>unavailable(block,id,state.constraints).map(date=>`${name(id)} · ${fmt(date)}${state.constraintNotes?.[id]?.[date]?' · '+state.constraintNotes[id][date]:''}`)));
 // A No weekends member newly placed on either day needs approval, like unavailability.
 const skipped=weekend?noWeekendPlacements(state,[{duty:day(friday),assignment:fri,before:initialFri},{duty:day(saturday),assignment:sat,before:initialSat}]).map(c=>t(`${name(c.person)} doesn’t take weekends · ${fmt(c.date)}`,`${name(c.person)} לא עושה סופי שבוע · ${fmt(c.date)}`)):[];
 const skips=(id:string)=>weekend&&!!state.team.find(p=>p.id===id)?.noWeekends;
 const duplicate=edits.some(({assignment:a})=>a.primary&&a.primary===a.secondary);
 function change(s:State,approved=false){const clean=(a:Assignment,initial:Assignment):Assignment=>({primary:a.primary,secondary:a.secondary,locked:a.primary?a.locked:undefined,override:approved||(a.primary===initial.primary&&a.secondary===initial.secondary&&initial.override)||undefined});return weekend?setWeekendAssignments(s,friday,clean(fri,initialFri),clean(sat,initialSat)):{...s,assignments:{...s.assignments,[duty.id]:clean(fri,initialFri)}}}
 const before=weekendCounts(state,month),after=weekendCounts(change(state),month);
 const extraWeekends=Object.keys(after).filter(id=>after[id]>1&&after[id]>(before[id]??0));
 const needsOverride=!!(conflicts.length||extraWeekends.length||skipped.length);
 const get=(h:Half)=>h==='fri'?fri:sat;
 // One card writes both dates; a day card writes its own.
 function update(h:Half|'both',f:(a:Assignment)=>Assignment){setOverride(false);if(h!=='sat')setFri(f);if(h!=='fri')setSat(f)}
 /** Back to one weekend: the same person just joins; different people choose who keeps it. */
 function join(){
  if(fri.primary===sat.primary){const one={...fri,secondary:fri.secondary??sat.secondary,locked:fri.locked||sat.locked};update('both',()=>({...one}))}
  layout.join(fri.primary===sat.primary);
 }
 function keep(h:Half){const kept=get(h);update('both',()=>({...kept}));layout.kept()}
 function setLayout(next:'one'|'two'){if(next==='two')layout.split();else join()}
 function picker(label:string,aria:string,h:Half|'both',emergency=false){
  const a=get(h==='sat'?'sat':'fri'),current=emergency?a.secondary:a.primary,block=weekend?h==='both'?duty:day(h==='fri'?friday:saturday):duty;
  return <label className="field-label">{label}<Select disabled={busy} value={current||'none'} onValueChange={v=>{const id=v==='none'?undefined:v;update(h,x=>emergency?{...x,secondary:id}:{...x,primary:id??''})}}><SelectTrigger className="picker" aria-label={aria}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="none">{emergency?t('Not needed','לא נדרש'):t('Leave unassigned','ללא שיבוץ')}</SelectItem>{state.team.filter(p=>p.active||p.id===current).map(p=><SelectItem key={p.id} value={p.id}>{p.name}{unavailable(block,p.id,state.constraints).length?t(' · unavailable',' · לא זמין'):''}{skips(p.id)?t(' · no weekends',' · ללא סופי שבוע'):''}</SelectItem>)}</SelectContent></Select></label>
 }
 function lockButton(h:Half|'both',aria:{lock:string;unlock:string}){
  const a=get(h==='sat'?'sat':'fri'),locked=!!a.locked;
  return <Button className="duty-lock-toggle" variant={locked?'secondary':'ghost'} size="icon-sm" disabled={busy||!a.primary} aria-pressed={locked} aria-label={locked?aria.unlock:aria.lock} title={locked?aria.unlock:aria.lock} onClick={()=>update(h,x=>({...x,locked:!locked}))}>{locked?<LockKeyhole size={16}/>:<LockKeyholeOpen size={16}/>}</Button>
 }
 const dutyLock={lock:t('Lock duty','נעילת כוננות'),unlock:t('Unlock duty','ביטול נעילת כוננות')};
 /** A regular day's card: its date and points, the person, its lock and its emergency cover. */
 function card(h:Half|'both'){
  const a=get(h==='sat'?'sat':'fri'),own=h!=='both'&&mode==='two';
  const dayName=h==='fri'?t('Friday','שישי'):t('Saturday','שבת');
  const aria=(en:string,he:string)=>own?t(`${dayName} ${en}`,`${he} ביום ${dayName}`):t(en.charAt(0).toUpperCase()+en.slice(1),he);
  const heading=mode==='two'&&h!=='both'?dayHeading(h==='fri'?friday:saturday,halfPoints(h)):onCard;
  return <DayCard half={h} heading={heading} action={!carry&&!(h==='both'&&choosing)&&lockButton(h,own?{lock:t(`Lock ${dayName}`,`נעילת יום ${dayName}`),unlock:t(`Unlock ${dayName}`,`ביטול נעילת יום ${dayName}`)}:dutyLock)}>
   {h==='both'&&choosing?<KeepChoice lang={lang} disabled={busy} onKeep={keep} options={(['fri','sat'] as const).map(k=>{const kept=get(k).primary,other=get(k==='fri'?'sat':'fri').primary,p=state.team.find(x=>x.id===kept),gives=halfPoints(k==='fri'?'sat':'fri');
    return {half:k,person:p&&{name:p.name,color:p.color},title:kept?t(`Keep ${name(kept)}`,`להשאיר את ${name(kept)}`):t('Leave open','להשאיר פנוי'),detail:other?`${name(other)} −${gives}`:`${name(kept)} +${gives}`}})}/>:<>
    {picker(t('Primary engineer','מהנדס ראשי'),aria('primary engineer','מהנדס ראשי'),h)}
    <details className="emergency-editor" open={!!a.secondary}><summary>{t('Emergency cover (optional)','כיסוי חירום (לא חובה)')}</summary><div>{picker(t('Second engineer','מהנדס נוסף'),aria('second engineer','מהנדס נוסף'),h,true)}</div></details>
   </>}
  </DayCard>
 }
 const showWeekend=weekend&&mode!=='half';
 const onCard=<DayHeading>{t('On duty','בכוננות')}</DayHeading>;
 function dayHeading(d:string,p:number){return <DayHeading points={pts(p)}>{dateLabel(d)}</DayHeading>}
 return <EditorDialog onClose={close} saving={busy} lang={lang} className="duty-dialog" title={showWeekend?t('Weekend','סוף שבוע'):duty.title||t('Edit duty','עריכת כוננות')} description={showWeekend?`${range} · ${pts(halfPoints('fri')+halfPoints('sat'))}`:`${dateLabel(duty.start)} · ${pts(duty.points)}`} onCloseAutoFocus={event=>{event.preventDefault();document.querySelector<HTMLButtonElement>(`[data-gesture-key="${duty.id}"]`)?.focus()}}>
 {carry?<div className="inline-note">{t('Edit this weekend in the month containing Friday.','יש לערוך את סוף השבוע בחודש שבו חל יום שישי.')}<Button onClick={()=>onMonth(ownerMonth(duty))}>{t('Open month','פתיחת החודש')}</Button></div>:<>
 {showWeekend&&<WeekendLayoutSwitch lang={lang} layout={layout} disabled={busy} onChange={setLayout}/>}
 {mode==='half'&&<SplitJoinRow lang={lang} disabled={busy} onJoin={join}/>}
 <DayCards layout={layout} weekend={weekend} focus={focus} card={card}/>
 {duplicate&&<div className="warning-note">{t('Primary and emergency engineers must be different on each day.','המהנדס הראשי ומהנדס החירום חייבים להיות שונים בכל יום.')}</div>}
 {needsOverride&&<div className="warning-note">{!!conflicts.length&&<p>{conflicts.join(' / ')}</p>}{!!extraWeekends.length&&<p>{extraWeekends.map(name).join(', ')} · {t('This adds another weekend this month.','השיבוץ מוסיף סוף שבוע נוסף בחודש.')}</p>}{skipped.map(text=><p key={text}>{text}</p>)}<label className="check-label duty-override manager-override"><Checkbox disabled={busy} checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Approve these exceptions as manager','אישור החריגות כמנהל')}</label></div>}
 <div className="editor-actions"><Button disabled={duplicate||choosing||(needsOverride&&!override)||busy} onClick={()=>submit(()=>onSave(s=>change(s,needsOverride&&override),weekend?[friday,saturday]:[duty.id]))}>{t('Save assignment','שמירת השיבוץ')}</Button></div>
 {duty.kind==='special'&&<Button variant="ghost" disabled={busy} onClick={()=>submit(onRemoveSpecial)}><Trash2/>{t('Remove extra points from this duty','הסרת הנקודות הנוספות מכוננות זו')}</Button>}
 </>}
 </EditorDialog>
}
