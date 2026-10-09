import {addDays,dayOf} from '../rota/engine.ts';
import type {Snapshot} from './snapshot.ts';

export function publishedSwapDuties(raw:Snapshot,month:string,today:string){
 const publication=raw.months.find(m=>m.month===month)?.current_publication_id;
 return raw.assignments.filter(a=>publication&&a.publication_id===publication&&a.day>today&&
  (dayOf(a.day)===6?addDays(a.day,-1):a.day).slice(0,7)===month&&
  raw.members.some(m=>m.id===a.primary_id&&m.active&&m.status==='approved')).sort((a,b)=>a.day.localeCompare(b.day));
}
