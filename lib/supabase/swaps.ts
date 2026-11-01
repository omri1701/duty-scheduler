import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot,SwapRequest,DutyRow} from './snapshot.ts';
import type {DutyClient} from './rpc.ts';

export function publishedSwapDuties(raw:Snapshot,month:string,today:string){
 const publication=raw.months.find(m=>m.month===month)?.current_publication_id;
 return raw.assignments.filter(a=>publication&&a.publication_id===publication&&a.day>=today&&
  (dayOf(a.day)===6?addDays(a.day,-1):a.day).slice(0,7)===month&&
  raw.members.some(m=>m.id===a.primary_id&&m.active&&m.status==='approved')).sort((a,b)=>a.day.localeCompare(b.day));
}

export function eligibleSwapTarget(source:DutyRow|undefined,target:DutyRow|undefined){
 return !!source&&!!target&&source.id!==target.id&&source.publication_id===target.publication_id&&
  source.primary_id!==target.primary_id&&target.secondary_id!==source.primary_id&&source.secondary_id!==target.primary_id;
}

/** Who started the request: the admin who proposed it, or the requester. */
export const swapStarter=(r:SwapRequest)=>r.proposed_by??r.requester_id;

/** Members whose answer is still missing. A requester who asked consented by sending it. */
export function swapWaitingOn(r:SwapRequest){
 if(r.status!=='awaiting_engineer')return [];
 return [...(r.proposed_by&&!r.requester_accepted_at?[r.requester_id]:[]),...(r.accepted_by?[]:[r.other_id])];
}

/** A swap's duties in the month's current publication, as resolve_swap finds them. */
export function swapDuties(raw:Snapshot,r:SwapRequest){
 const publication=raw.months.find(m=>m.month===r.month)?.current_publication_id;
 const find=(day:string,end:string)=>raw.assignments.find(a=>publication&&a.publication_id===publication&&a.day===day&&a.end_day===end);
 return {source:find(r.from_day,r.from_end_day),target:find(r.to_day,r.to_end_day)};
}

export type SwapProblem={kind:'weekend';person:string}|{kind:'availability';person:string;day:string};
/** What duty_private.validate_swap would refuse, checked before the click (decision 2026-11-01): a
 * second weekend for either engineer (either half or emergency cover counts), or an availability
 * conflict among the constraints in raw. Swaps checks only the weekend here: its availability
 * alert comes from duty_swap_availability, which also covers the counterpart and cover. */
export function swapProblem(raw:Snapshot,month:string,source:DutyRow,target:DutyRow,availability=true):SwapProblem|null{
 const no=(people:(string|null)[],duty:DutyRow)=>raw.constraints.find(c=>c.kind==='no'&&people.includes(c.member_id)&&c.day>=duty.day&&c.day<duty.end_day);
 const conflict=availability?no([target.primary_id,source.secondary_id],source)??no([source.primary_id,target.secondary_id],target):undefined;
 if(conflict)return {kind:'availability',person:conflict.member_id,day:conflict.day};
 const weekends=raw.assignments.filter(a=>a.publication_id===source.publication_id&&[5,6].includes(dayOf(a.day))&&(dayOf(a.day)===6?addDays(a.day,-1):a.day).slice(0,7)===month);
 const primary=(a:DutyRow)=>a.id===source.id?target.primary_id:a.id===target.id?source.primary_id:a.primary_id;
 const count=(who:string,owner:(a:DutyRow)=>string|null)=>new Set(weekends.filter(a=>owner(a)===who||a.secondary_id===who).map(a=>dayOf(a.day)===6?addDays(a.day,-1):a.day)).size;
 for(const who of [source.primary_id,target.primary_id]){
  if(!who)continue;
  const after=count(who,primary);
  if(after>1&&after>count(who,a=>a.primary_id))return {kind:'weekend',person:who};
 }
 return null;
}

/** Whose answer Accept or Decline records for this viewer, as resolve_swap decides: their own
 * open side first; an admin also answers for a temporary member, who has no account
 * (decision 2026-11-01), the requester's side before the other's. */
export function swapAnswerFor(r:SwapRequest,me:string,admin:boolean,temporary:ReadonlySet<string>=new Set()){
 const waiting=swapWaitingOn(r);
 return waiting.includes(me)?me:admin?waiting.find(id=>temporary.has(id))??null:null;
}

export function swapNeedsAction(r:SwapRequest,me:string,admin:boolean,temporary?:ReadonlySet<string>){
 return swapAnswerFor(r,me,admin,temporary)!==null||(admin&&r.status==='awaiting_admin');
}

export function visibleSwapRequests(requests:SwapRequest[],me:string,admin:boolean,temporary?:ReadonlySet<string>){
 return requests.filter(r=>r.requester_id===me||r.proposed_by===me||
  (r.other_id===me&&r.status==='awaiting_engineer')||(admin&&r.status==='awaiting_admin')||swapAnswerFor(r,me,admin,temporary)!==null)
  .sort((a,b)=>Number(swapNeedsAction(b,me,admin,temporary))-Number(swapNeedsAction(a,me,admin,temporary))||b.created_at.localeCompare(a.created_at));
}

/** A member's unavailability that blocks a swap: who and which date, never the note.
 * Members see emergency cover's conflicts without a name (member null). */
export type SwapConflict={member:string|null;day:string};
export function readSwapConflicts(value:unknown):SwapConflict[]{
 if(!Array.isArray(value)||value.some(c=>typeof c!=='object'||c===null||(c.member!==null&&typeof c.member!=='string')||typeof c.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(c.day)))
  throw Error('Invalid availability check');
 return value.map(c=>({member:c.member,day:c.day}));
}
export async function swapAvailability(client:DutyClient,from:string,to:string){
 const {data,error}=await client.rpc('duty_swap_availability',{p_from:from,p_to:to});
 if(error)throw error;
 return readSwapConflicts(data);
}

const pointsText=(n:number,lang:'en'|'he')=>lang==='he'?`${n} נק׳`:`${n} ${n===1?'pt':'pts'}`;
const signed=(n:number,lang:'en'|'he')=>(n>0?'+':n<0?'−':'')+pointsText(Math.abs(n),lang);
/** Plain text an admin copies into the external system before approving. */
export function swapSummary({requester,other,from,to,lang}:{requester:string;other:string;from:{label:string;points:number};to:{label:string;points:number};lang:'en'|'he'}){
 const he=lang==='he',change=to.points-from.points;
 const side=(name:string,gives:typeof from,takes:typeof from,delta:number)=>he
  ?`${name} — מסירה: ${gives.label} (${pointsText(gives.points,lang)}) · קבלה: ${takes.label} (${pointsText(takes.points,lang)}) · שינוי: ${signed(delta,lang)}`
  :`${name} — gives: ${gives.label} (${pointsText(gives.points,lang)}) · takes: ${takes.label} (${pointsText(takes.points,lang)}) · change: ${signed(delta,lang)}`;
 return [`${he?'החלפת תורנויות':'Duty swap'}: ${requester} ⇄ ${other}`,side(requester,from,to,change),side(other,to,from,-change)].join('\n');
}
