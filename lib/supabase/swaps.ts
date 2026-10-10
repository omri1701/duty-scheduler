import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot,SwapRequest,DutyRow} from './snapshot.ts';

export function publishedSwapDuties(raw:Snapshot,month:string,today:string){
 const publication=raw.months.find(m=>m.month===month)?.current_publication_id;
 return raw.assignments.filter(a=>publication&&a.publication_id===publication&&a.day>today&&
  (dayOf(a.day)===6?addDays(a.day,-1):a.day).slice(0,7)===month&&
  raw.members.some(m=>m.id===a.primary_id&&m.active&&m.status==='approved')).sort((a,b)=>a.day.localeCompare(b.day));
}

export function eligibleSwapTarget(source:DutyRow|undefined,target:DutyRow|undefined){
 return !!source&&!!target&&source.id!==target.id&&source.publication_id===target.publication_id&&
  source.primary_id!==target.primary_id&&target.secondary_id!==source.primary_id&&source.secondary_id!==target.primary_id;
}

export function swapNeedsAction(r:SwapRequest,me:string,admin:boolean){
 return (r.status==='awaiting_engineer'&&r.other_id===me)||(admin&&r.status==='awaiting_admin');
}

export function visibleSwapRequests(requests:SwapRequest[],me:string,admin:boolean){
 return requests.filter(r=>r.requester_id===me||
  (r.other_id===me&&r.status==='awaiting_engineer')||(admin&&r.status==='awaiting_admin'))
  .sort((a,b)=>Number(swapNeedsAction(b,me,admin))-Number(swapNeedsAction(a,me,admin))||b.created_at.localeCompare(a.created_at));
}
