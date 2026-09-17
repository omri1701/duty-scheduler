import type {State,Assignment,Special} from '../rota/engine';
export type Member={id:string;email:string;name:string;role:'manager'|'engineer';status:'pending'|'approved'|'rejected';active:boolean;seniority:number;color:string};
export type Snapshot={revision:number|null;members:Member[];months:{month:string;deadline:string;status:'draft'|'published';generated:boolean}[];constraints:{member_id:string;day:string;kind:'no'|'prefer';note:string}[];specials:{id:string;title:string;start_day:string;end_day:string;extra:number}[];splits:string[];assignments:{day:string;primary_id:string|null;secondary_id:string|null;manager_override:boolean}[];publications:{month:string;payload:{assignments:Record<string,Assignment>;specials:Special[];splitWeekends:string[]};published_at:string}[]};
export function fromSnapshot(raw:Snapshot,userId:string):State{
 const manager=raw.members.find(m=>m.id===userId)?.role==='manager';
 const state:State={version:3,team:raw.members.filter(m=>m.status==='approved').map(m=>({id:m.id,name:m.name,color:m.color,active:m.active})),constraints:{},constraintNotes:{},assignments:{},specials:[],splitWeekends:[],months:{}};
 for(const m of raw.months)state.months[m.month]={deadline:m.deadline,status:manager?m.status:raw.publications.some(p=>p.month===m.month)?'published':'draft',generated:m.generated};
 for(const c of raw.constraints){(state.constraints[c.member_id]??={})[c.day]=c.kind;if(c.note)(state.constraintNotes![c.member_id]??={})[c.day]=c.note}
 if(manager){state.assignments=Object.fromEntries(raw.assignments.map(a=>[a.day,{primary:a.primary_id??'',secondary:a.secondary_id??undefined,override:a.manager_override||undefined}]));state.specials=raw.specials.map(s=>({id:s.id,title:s.title,start:s.start_day,end:s.end_day,extra:Number(s.extra)}));state.splitWeekends=raw.splits}
 else{const specials=new Map<string,Special>(),splits=new Set<string>();for(const p of raw.publications){Object.assign(state.assignments,p.payload.assignments);p.payload.specials.forEach(s=>specials.set(s.id,s));p.payload.splitWeekends.forEach(s=>splits.add(s))}state.specials=[...specials.values()];state.splitWeekends=[...splits]}
 return state;
}
export function schedulePayload(s:State){return {team:s.team,months:s.months,specials:s.specials,assignments:s.assignments,splitWeekends:s.splitWeekends??[]}}
export function todayIsrael(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
