import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot,SwapRequest,DutyRow} from './snapshot.ts';

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

/** A swap's duties in the month's current publication, as resolve_swap finds them. */
export function swapDuties(raw:Snapshot,r:SwapRequest){
 const publication=raw.months.find(m=>m.month===r.month)?.current_publication_id;
 const find=(day:string,end:string)=>raw.assignments.find(a=>publication&&a.publication_id===publication&&a.day===day&&a.end_day===end);
 return {source:find(r.from_day,r.from_end_day),target:find(r.to_day,r.to_end_day)};
}

export type SwapProblem={kind:'weekend';person:string}|{kind:'availability';person:string;day:string};
/** What duty_private.validate_swap would refuse, checked before the click (decision 2026-11-01): a
 * second weekend for either engineer (either half or emergency cover counts), or an availability
 * conflict among the constraints this viewer may read: members their own, admins everyone's. */
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

export function swapNeedsAction(r:SwapRequest,me:string,admin:boolean){
 return (r.status==='awaiting_engineer'&&r.other_id===me)||(admin&&r.status==='awaiting_admin');
}

export function visibleSwapRequests(requests:SwapRequest[],me:string,admin:boolean){
 return requests.filter(r=>r.requester_id===me||
  (r.other_id===me&&r.status==='awaiting_engineer')||(admin&&r.status==='awaiting_admin'))
  .sort((a,b)=>Number(swapNeedsAction(b,me,admin))-Number(swapNeedsAction(a,me,admin))||b.created_at.localeCompare(a.created_at));
}
