import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot,DutyRow} from './snapshot.ts';
import type {DutyClient} from './rpc.ts';

/** Temporary: the old engineer owes the new one. Permanent: no debt, except that giving the duty
 * back to someone who held it before a Temporary change still in effect undoes that change (H1). */
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

/** Pending swap requests the admin can see that include this duty: saving an edit cancels them. */
export const pendingSwaps=(raw:Snapshot,row:DutyRow)=>(raw.swapRequests??[]).filter(r=>
 (r.status==='awaiting_engineer'||r.status==='awaiting_admin')&&(r.from_day===row.day||r.to_day===row.day));

/** The other member in each pending swap of this duty, once each. */
export const swapPartners=(raw:Snapshot,row:DutyRow)=>[...new Set(pendingSwaps(raw,row).map(r=>r.from_day===row.day?r.other_id:r.requester_id))];

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

/** Who a Permanent edit of this duty would give it back to, undoing a Temporary change (H1,
 * decision 2026-11-06), most recent first: duty_private.edit_returns decides, as the edit does. */
export async function editReturns(client:DutyClient,publication:string,day:string){
 const {data,error}=await client.rpc('duty_edit_returns',{p_publication:publication,p_day:day});
 if(error)throw error;
 if(!Array.isArray(data)||data.some(id=>typeof id!=='string'))throw Error('Invalid edit returns');
 return data as string[];
}

/** Dates in the duty the member marked unavailable, with the admin-visible note. */
export function editConflicts(raw:Snapshot,member:string,row:DutyRow){
 return raw.constraints.filter(c=>c.member_id===member&&c.kind==='no'&&c.day>=row.day&&c.day<row.end_day)
  .sort((a,b)=>a.day.localeCompare(b.day)).map(c=>({day:c.day,note:c.note}));
}

/** Plain text for the admin's external record, written before the change is saved.
 * Never includes availability notes; the override reason is the admin's own text. */
export function editSummary(row:DutyRow,edit:PublishedEdit,name:(id:string)=>string,lang:'en'|'he',returning=false){
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
  t('Duty change (published schedule)','שינוי כוננות (לוח שפורסם)'),
  `${t('Date','תאריך')}: ${date(row.day)}${last!==row.day?` – ${date(last)}`:''}`,
  `${t('Engineer','מהנדס')}: ${changed?change(from,to):`${from} ${t('(unchanged)','(ללא שינוי)')}`}`,
  `${t('Points','נקודות')}: ${before===after?points(after):change(points(before),points(after))}`,
  `${t('Extra','תוספת')}: ${extraBefore===extraAfter?extraText(extraAfter):change(extraText(extraBefore),extraText(extraAfter))}`,
 ];
 if(changed){
  lines.push(`${t('Type','סוג')}: ${edit.kind==='temporary'?t('Temporary','זמני'):t('Permanent','קבוע')}`);
  lines.push(`${t('Balance','מאזן')}: ${edit.kind==='temporary'?t(`${from} owes ${to} ${points(owed)}`,`${from} חייב/ת ל־${to} ${points(owed)}`)
   :returning?t(`${to} gets the duty back: the earlier Temporary change is undone and its debt cancels`,`${to} מקבל/ת את הכוננות בחזרה: השינוי הזמני הקודם מתבטל וגם החוב שלו`):t('No debt','ללא חוב')}`);
  if(edit.overrideReason.trim())lines.push(`${t('Availability override','חריגה מאילוץ')}: ${edit.overrideReason.trim()}`);
 }
 else lines.push(`${t('Balance','מאזן')}: ${t(`No debt; the extra counts for ${from}`,`ללא חוב; התוספת נזקפת ל־${from}`)}`);
 return lines.join('\n');
}

/** One date of a published weekend: the row covering it, its holder and its own points. */
export type WeekendHalf={day:string;row:DutyRow;primary:string;extra:number};
/** A published weekend as its two dates (decision 2026-11-07): one Friday–Sunday row or two day rows. */
export type PublishedWeekend={friday:string;joined:boolean;fri:WeekendHalf;sat:WeekendHalf};
export type WeekendEdit={fridayPrimary:string;fridayExtra:number;saturdayPrimary:string;saturdayExtra:number;kind:EditKind;overrideReason:string};
/** A weekend date's points: 0.5 plus its extra. */
export const halfPoints=(extra:number)=>.5+extra;

/** The published weekend the row belongs to, while it can still be split or joined: both dates
 * have a person and Friday is today or later (a started weekend's Saturday is a normal day). */
export function publishedWeekend(raw:Snapshot,row:DutyRow,today:string):PublishedWeekend|null{
 if(![5,6].includes(dayOf(row.day))||!row.publication_id)return null;
 const friday=dayOf(row.day)===6?addDays(row.day,-1):row.day,saturday=addDays(friday,1);
 if(friday<today)return null;
 const covering=(day:string)=>raw.assignments.find(a=>a.publication_id===row.publication_id&&a.day<=day&&a.end_day>day);
 const f=covering(friday),s=covering(saturday);
 if(!f||!s||f.day!==friday||!f.primary_id||!s.primary_id)return null;
 const joined=f.id===s.id;
 return {friday,joined,fri:{day:friday,row:f,primary:f.primary_id,extra:Number(f.extra_points)},
  sat:{day:saturday,row:s,primary:s.primary_id,extra:Number(joined?f.saturday_extra_points??0:s.extra_points)}};
}

/** Each date whose person changes: who gives it, who takes it, and the shared points a
 * Temporary edit makes the giver owe (the ledger's per-date units; extra added now counts
 * for whoever does it). */
export function weekendChanges(w:PublishedWeekend,edit:WeekendEdit){
 return ([[w.fri,edit.fridayPrimary,edit.fridayExtra],[w.sat,edit.saturdayPrimary,edit.saturdayExtra]] as const)
  .filter(([h,to])=>to!==h.primary).map(([h,to,extra])=>({day:h.day,from:h.primary,to,owed:Math.min(halfPoints(h.extra),halfPoints(extra))}));
}

/** The emergency cover of the weekend saved as one duty, as edit_published_weekend picks it:
 * the cover of a date that kept its engineer (Friday first), else Friday's, else Saturday's. */
export function joinedCover(w:PublishedWeekend,edit:WeekendEdit){
 const f=w.fri.row.secondary_id,s=w.sat.row.secondary_id;
 return [edit.fridayPrimary===w.fri.primary?f:null,edit.saturdayPrimary===w.sat.primary?s:null,f,s].find(Boolean)??null;
}

/** Dates a member marked unavailable among the dates they newly take: a new engineer, or a cover
 * that joining moves onto a date it didn't cover. */
export function weekendConflicts(raw:Snapshot,w:PublishedWeekend,edit:WeekendEdit){
 const taken=weekendChanges(w,edit).map(c=>({day:c.day,member:c.to}));
 const cover=edit.fridayPrimary===edit.saturdayPrimary?joinedCover(w,edit):null;
 if(cover)for(const h of [w.fri,w.sat])if(h.row.secondary_id!==cover)taken.push({day:h.day,member:cover});
 return taken.flatMap(t=>raw.constraints.filter(x=>x.member_id===t.member&&x.kind==='no'&&x.day===t.day).map(x=>({day:x.day,member:t.member,note:x.note})));
}

/** Plain text for the admin's external record of a weekend edit, written before saving. Never
 * includes availability notes; the override reason is the admin's own text. returning: dates a
 * Permanent edit gives back to who held them before a Temporary change (H1). */
export function weekendEditSummary(w:PublishedWeekend,edit:WeekendEdit,name:(id:string)=>string,lang:'en'|'he',returning:ReadonlySet<string>=new Set()){
 const he=lang==='he',t=(en:string,hebrew:string)=>he?hebrew:en;
 const date=(day:string)=>`${(he?['יום א׳','יום ב׳','יום ג׳','יום ד׳','יום ה׳','יום ו׳','שבת']:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[dayOf(day)]} ${day.slice(8)}/${day.slice(5,7)}/${day.slice(0,4)}`;
 const points=(n:number)=>he?`${n} ${n===1?'נקודה':'נקודות'}`:`${n} ${n===1?'point':'points'}`;
 const change=(a:string,b:string)=>he?`${b} במקום ${a}`:`${a} → ${b}`;
 const joined=edit.fridayPrimary===edit.saturdayPrimary,layout=(one:boolean)=>one?t('One weekend','סוף שבוע אחד'):t('Two days','שני ימים');
 const changes=weekendChanges(w,edit);
 const lines=[
  t('Duty change (published schedule)','שינוי כוננות (לוח שפורסם)'),
  `${t('Date','תאריך')}: ${date(w.fri.day)} – ${date(w.sat.day)}`,
  `${t('Weekend','סוף שבוע')}: ${joined===w.joined?layout(joined):change(layout(w.joined),layout(joined))}`,
 ];
 for(const [h,to,extra] of [[w.fri,edit.fridayPrimary,edit.fridayExtra],[w.sat,edit.saturdayPrimary,edit.saturdayExtra]] as const){
  const before=halfPoints(h.extra),after=halfPoints(extra);
  lines.push(`${date(h.day)}: ${to===h.primary?`${name(to)} ${t('(unchanged)','(ללא שינוי)')}`:change(name(h.primary),name(to))} · ${before===after?points(after):change(points(before),points(after))}`);
 }
 if(changes.length){
  lines.push(`${t('Type','סוג')}: ${edit.kind==='temporary'?t('Temporary','זמני'):t('Permanent','קבוע')}`);
  for(const c of changes)lines.push(`${t('Balance','מאזן')} ${date(c.day)}: ${edit.kind==='temporary'?t(`${name(c.from)} owes ${name(c.to)} ${points(c.owed)}`,`${name(c.from)} חייב/ת ל־${name(c.to)} ${points(c.owed)}`)
   :returning.has(c.day)?t(`${name(c.to)} gets the day back: the earlier Temporary change is undone and its debt cancels`,`${name(c.to)} מקבל/ת את היום בחזרה: השינוי הזמני הקודם מתבטל וגם החוב שלו`):t('No debt','ללא חוב')}`);
  if(edit.overrideReason.trim())lines.push(`${t('Availability override','חריגה מאילוץ')}: ${edit.overrideReason.trim()}`);
 }
 else lines.push(`${t('Balance','מאזן')}: ${t('No debt; the points count for whoever does each day','ללא חוב; הנקודות נזקפות למי שעושה כל יום')}`);
 return lines.join('\n');
}
