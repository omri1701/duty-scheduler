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

export function swapNeedsAction(r:SwapRequest,me:string,admin:boolean){
 return swapWaitingOn(r).includes(me)||(admin&&r.status==='awaiting_admin');
}

export function visibleSwapRequests(requests:SwapRequest[],me:string,admin:boolean){
 return requests.filter(r=>r.requester_id===me||r.proposed_by===me||
  (r.other_id===me&&r.status==='awaiting_engineer')||(admin&&r.status==='awaiting_admin'))
  .sort((a,b)=>Number(swapNeedsAction(b,me,admin))-Number(swapNeedsAction(a,me,admin))||b.created_at.localeCompare(a.created_at));
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
