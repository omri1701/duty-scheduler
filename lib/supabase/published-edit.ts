import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot,DutyRow} from './snapshot.ts';

/** Temporary: the old engineer owes the new one. Permanent: no debt. */
export type EditKind='temporary'|'permanent';
export type PublishedEdit={primary:string;extra:number;saturdayExtra:number;kind:EditKind;overrideReason:string};

const owner=(row:DutyRow)=>(dayOf(row.day)===6?addDays(row.day,-1):row.day).slice(0,7);
export const combinedWeekend=(row:Pick<DutyRow,'day'|'end_day'>)=>row.end_day===addDays(row.day,2);

/** The month's current publication row an admin may edit: owned by the month, today or later, with a primary. */
export function editablePublishedDuty(raw:Snapshot,month:string,today:string,day:string){
 const publication=raw.months.find(m=>m.month===month)?.current_publication_id;
 return raw.assignments.find(a=>!!publication&&a.publication_id===publication&&a.day===day&&a.day>=today&&owner(a)===month&&!!a.primary_id);
}

/** The opened row is no longer the live version: a newer version was published or a draft reopened. */
export function editStale(raw:Snapshot,row:DutyRow){
 const m=raw.months.find(m=>m.month===owner(row));
 return !m||m.status!=='published'||m.current_publication_id!==row.publication_id;
}

/** Pending swap requests that include this duty: publishing an edit invalidates them or asks the new engineer again. */
export const pendingSwaps=(raw:Snapshot,row:DutyRow)=>(raw.swapRequests??[]).filter(r=>
 (r.status==='awaiting_engineer'||r.status==='awaiting_admin')&&(r.from_day===row.day||r.to_day===row.day));

/** Half points only, 0 to 20: the database's own bounds. */
export const validExtra=(value:number)=>Number.isFinite(value)&&value>=0&&value<=20&&Number.isInteger(value*2);

/** Mirrors the stored points column: a combined weekend is 1 + each date's extra. */
export function dutyPoints(row:Pick<DutyRow,'day'|'end_day'>,extra:number,saturdayExtra=0){
 return combinedWeekend(row)?1+extra+saturdayExtra:([5,6].includes(dayOf(row.day))?.5:1)+extra;
}

/** Half-point units a Temporary edit moves: each date's points shared by the old and new
 * versions, as the ledger derives them. Extra added now counts for whoever does the duty. */
export function owedUnits(row:DutyRow,extra:number,saturdayExtra=0){
 if(!combinedWeekend(row))return Math.min(dutyPoints(row,row.extra_points),dutyPoints(row,extra))*2;
 const oldSaturday=row.saturday_extra_points??0;
 return Math.min(1+2*row.extra_points,1+2*extra)+Math.min(1+2*oldSaturday,1+2*saturdayExtra);
}

/** Dates in the duty the member marked unavailable, with the admin-visible note. */
export function editConflicts(raw:Snapshot,member:string,row:DutyRow){
 return raw.constraints.filter(c=>c.member_id===member&&c.kind==='no'&&c.day>=row.day&&c.day<row.end_day)
  .sort((a,b)=>a.day.localeCompare(b.day)).map(c=>({day:c.day,note:c.note}));
}

/** Plain text for the admin's external record, written before the change is saved.
 * Never includes availability notes; the override reason is the admin's own text. */
export function editSummary(row:DutyRow,edit:PublishedEdit,name:(id:string)=>string,lang:'en'|'he'){
 const he=lang==='he',t=(en:string,hebrew:string)=>he?hebrew:en;
 // Fixed day/month/year text, independent of the browser's date formatting.
 const date=(day:string)=>`${(he?['יום א׳','יום ב׳','יום ג׳','יום ד׳','יום ה׳','יום ו׳','שבת']:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[dayOf(day)]} ${day.slice(8)}/${day.slice(5,7)}/${day.slice(0,4)}`;
 const last=addDays(row.end_day,-1),changed=edit.primary!==row.primary_id;
 const before=dutyPoints(row,row.extra_points,row.saturday_extra_points??0),after=dutyPoints(row,edit.extra,edit.saturdayExtra);
 const extraBefore=row.extra_points+(row.saturday_extra_points??0),extraAfter=edit.extra+edit.saturdayExtra;
 const points=(n:number)=>he?`${n} ${n===1?'נקודה':'נקודות'}`:`${n} ${n===1?'point':'points'}`;
 const from=name(row.primary_id!),to=name(edit.primary),owed=owedUnits(row,edit.extra,edit.saturdayExtra)/2;
 // Hebrew joins values with words: an arrow between two Latin names would reorder in RTL.
 const change=(a:string,b:string)=>he?`${b} במקום ${a}`:`${a} → ${b}`;
 const extraText=(n:number)=>n?points(n):t('none','אין');
 const lines=[
  t('Duty change (published schedule)','שינוי תורנות (לוח שפורסם)'),
  `${t('Date','תאריך')}: ${date(row.day)}${last!==row.day?` – ${date(last)}`:''}`,
  `${t('Engineer','מהנדס')}: ${changed?change(from,to):`${from} ${t('(unchanged)','(ללא שינוי)')}`}`,
  `${t('Points','נקודות')}: ${before===after?points(after):change(points(before),points(after))}`,
  `${t('Extra','תוספת')}: ${extraBefore===extraAfter?extraText(extraAfter):change(extraText(extraBefore),extraText(extraAfter))}`,
 ];
 if(changed){
  lines.push(`${t('Type','סוג')}: ${edit.kind==='temporary'?t('Temporary','זמני'):t('Permanent','קבוע')}`);
  lines.push(`${t('Balance','מאזן')}: ${edit.kind==='temporary'?t(`${from} owes ${to} ${points(owed)}`,`${from} חייב/ת ל־${to} ${points(owed)}`):t('No debt','ללא חוב')}`);
  if(edit.overrideReason.trim())lines.push(`${t('Availability override','חריגה מאילוץ')}: ${edit.overrideReason.trim()}`);
 }
 else lines.push(`${t('Balance','מאזן')}: ${t(`No debt; the extra counts for ${from}`,`ללא חוב; התוספת נזקפת ל־${from}`)}`);
 return lines.join('\n');
}
