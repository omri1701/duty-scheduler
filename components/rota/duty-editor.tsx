'use client';
import {useState} from 'react';
import {Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {addDays,ownerMonth,unavailable,weekendAssignments,setWeekendAssignments,weekendCounts,type State,type Duty,type Assignment} from '@/lib/rota/engine';
export function DutyEditor({state,duty,month,lang,onClose,onMonth,onSave,onRemoveSpecial}:{state:State;duty:Duty;month:string;lang:'en'|'he';onClose:()=>void;onMonth:(month:string)=>void;onSave:(change:(s:State)=>State)=>void;onRemoveSpecial:()=>void}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 const weekend=!!duty.weekendId,friday=duty.weekendId??duty.start;
 const [initialFri,initialSat]=weekend?weekendAssignments(state,friday):[state.assignments[duty.id]??{primary:''},{primary:''}];
 const [fri,setFri]=useState<Assignment>(initialFri),[sat,setSat]=useState<Assignment>(initialSat);
 const [followFriday,setFollowFriday]=useState(initialFri.primary===initialSat.primary),[override,setOverride]=useState(false);
 const carry=ownerMonth(duty)!==month;
 const day=(start:string):Duty=>({...duty,id:start,start,end:addDays(start,1)});
 const edits=weekend?[{block:day(friday),assignment:fri},{block:day(addDays(friday,1)),assignment:sat}]:[{block:duty,assignment:fri}];
 const name=(id:string)=>state.team.find(p=>p.id===id)?.name??id;
 const fmt=(d:string)=>new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{day:'numeric',month:'short'});
 const conflicts=edits.flatMap(({block,assignment})=>[assignment.primary,assignment.secondary].filter((id):id is string=>!!id).flatMap(id=>unavailable(block,id,state.constraints).map(date=>`${name(id)} · ${fmt(date)}${state.constraintNotes?.[id]?.[date]?' · '+state.constraintNotes[id][date]:''}`)));
 const duplicate=edits.some(({assignment:a})=>a.primary&&a.primary===a.secondary);
 function change(s:State,approved=false){const clean=(a:Assignment):Assignment=>({primary:a.primary,secondary:a.secondary,override:approved||undefined});return weekend?setWeekendAssignments(s,friday,clean(fri),clean(sat)):{...s,assignments:{...s.assignments,[duty.id]:clean(fri)}}}
 const before=weekendCounts(state,month),after=weekendCounts(change(state),month);
 const extraWeekends=Object.keys(after).filter(id=>after[id]>1&&after[id]>(before[id]??0));
 const needsOverride=!!(conflicts.length||extraWeekends.length);
 function setPrimary(value:string,which:'fri'|'sat'){
  setOverride(false);const primary=value==='none'?'':value;
  if(which==='sat'){setSat(a=>({...a,primary}));setFollowFriday(primary===fri.primary)}
  else{setFri(a=>({...a,primary}));if(weekend&&followFriday)setSat(a=>({...a,primary}))}
 }
 function picker(label:string,a:Assignment,which:'fri'|'sat',emergency=false){
  const current=emergency?a.secondary:a.primary,block=weekend?day(which==='fri'?friday:addDays(friday,1)):duty;
  return <label className="field-label">{label}<Select value={current||'none'} onValueChange={v=>{if(!emergency)setPrimary(v,which);else{setOverride(false);const secondary=v==='none'?undefined:v;(which==='fri'?setFri:setSat)(x=>({...x,secondary}))}}}><SelectTrigger className="picker" aria-label={label}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="none">{emergency?t('Not needed','לא נדרש'):t('Leave unassigned','ללא שיבוץ')}</SelectItem>{state.team.filter(p=>p.active||p.id===current).map(p=><SelectItem key={p.id} value={p.id}>{p.name}{unavailable(block,p.id,state.constraints).length?t(' · unavailable',' · לא זמין'):''}</SelectItem>)}</SelectContent></Select></label>
 }
 return <Dialog open onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="duty-dialog" dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{weekend?t('Edit weekend','עריכת סוף שבוע'):duty.title||t('Edit duty','עריכת תורנות')}</DialogTitle><DialogDescription>{weekend?`${fmt(friday)} – ${fmt(addDays(friday,2))} · ${t('Friday–Sunday','שישי–ראשון')}`:`${fmt(duty.start)} · ${duty.points} ${t('points','נקודות')}`}</DialogDescription></DialogHeader>
 {carry?<div className="inline-note">{t('Edit this weekend in the month containing Friday.','יש לערוך את סוף השבוע בחודש שבו חל יום שישי.')}<Button onClick={()=>onMonth(ownerMonth(duty))}>{t('Open month','פתיחת החודש')}</Button></div>:<>
 {picker(weekend?t('Friday primary engineer','מהנדס ראשי ביום שישי'):t('Primary engineer','מהנדס ראשי'),fri,'fri')}
 {weekend&&<>{picker(t('Saturday engineer','מהנדס ביום שבת'),sat,'sat')}<p className="muted-copy">{t('Saturday follows Friday until you choose someone else.','שבת תואמת לשישי עד שתבחרו מהנדס אחר.')}</p></>}
 <details className="emergency-editor" open={!!(fri.secondary||sat.secondary)}><summary>{t('Emergency cover (optional)','כיסוי חירום (לא חובה)')}</summary><div>{picker(weekend?t('Friday second engineer','מהנדס נוסף ביום שישי'):t('Second engineer','מהנדס נוסף'),fri,'fri',true)}{weekend&&picker(t('Saturday second engineer','מהנדס נוסף ביום שבת'),sat,'sat',true)}</div></details>
 {duplicate&&<div className="warning-note">{t('Primary and emergency engineers must be different on each day.','המהנדס הראשי ומהנדס החירום חייבים להיות שונים בכל יום.')}</div>}
 {needsOverride&&<div className="warning-note">{!!conflicts.length&&<p>{conflicts.join(' / ')}</p>}{!!extraWeekends.length&&<p>{extraWeekends.map(name).join(', ')} · {t('This adds another weekend this month.','השיבוץ מוסיף סוף שבוע נוסף בחודש.')}</p>}<label className="check-label"><Checkbox checked={override} onCheckedChange={v=>setOverride(!!v)}/>{t('Approve these exceptions as manager','אישור החריגות כמנהל')}</label></div>}
 <Button disabled={duplicate||(needsOverride&&!override)} onClick={()=>onSave(s=>change(s,needsOverride&&override))}>{t('Save assignment','שמירת השיבוץ')}</Button>
 {duty.kind==='special'&&<Button variant="ghost" onClick={onRemoveSpecial}><Trash2/>{t('Remove extra points from this day','הסרת הנקודות הנוספות ביום זה')}</Button>}
 </>}
 </DialogContent></Dialog>
}
