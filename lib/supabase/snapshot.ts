import {addDays,dayOf,blocks,ownerMonth,type State,type Special} from '../rota/engine.ts';
export type Member={id:string;email:string;name:string;role:string;status:string;active:boolean;seniority:number;color:string};
export type Lookup={code:string;label:string};
export type Role=Lookup&{can_manage:boolean};
export type DutyRow={id:string;publication_id:string|null;day:string;end_day:string;primary_id:string|null;secondary_id:string|null;manager_override:boolean;title:string;extra_points:number;points:number};
export type Publication={id:string;month:string;version:number;published_at:string;published_by:string};
export type Snapshot={revision:number|null;members:Member[];months:{month:string;deadline:string;status:'draft'|'published';generated:boolean;current_publication_id:string|null;publication_sequence:number}[];constraints:{member_id:string;day:string;kind:'no'|'prefer';note:string}[];assignments:DutyRow[];publications:Publication[];roles:Role[];memberStatuses:Lookup[];monthStatuses:Lookup[];constraintTypes:Lookup[]};
export function canManage(raw:Snapshot,userId:string){const me=raw.members.find(m=>m.id===userId);return !!raw.roles.find(r=>r.code===me?.role)?.can_manage}
function rowOwner(row:DutyRow){return (dayOf(row.day)===6?addDays(row.day,-1):row.day).slice(0,7)}
function applyRows(state:State,rows:DutyRow[]){
 const specials:Special[]=[],splits=new Set<string>();
 for(const row of rows){
  state.assignments[row.day]={primary:row.primary_id??'',secondary:row.secondary_id??undefined,override:row.manager_override||undefined};
  if(row.title||Number(row.extra_points)>0)specials.push({id:row.id,title:row.title,start:row.day,end:row.end_day,extra:Number(row.extra_points)});
  if(row.end_day===addDays(row.day,1)&&[5,6].includes(dayOf(row.day)))splits.add(dayOf(row.day)===5?row.day:addDays(row.day,-1));
 }
 state.specials=specials;state.splitWeekends=[...splits];return state;
}
export function fromSnapshot(raw:Snapshot,userId:string,previewPublication?:string):State{
 const admin=canManage(raw,userId);
 const state:State={version:3,team:raw.members.filter(m=>m.status==='approved').map(m=>({id:m.id,name:m.name,color:m.color,active:m.active,role:m.role})),constraints:{},constraintNotes:{},assignments:{},specials:[],splitWeekends:[],months:{}};
 for(const m of raw.months)state.months[m.month]={deadline:m.deadline,status:admin&&!previewPublication?m.status:m.current_publication_id?'published':'draft',generated:m.generated};
 for(const c of raw.constraints){(state.constraints[c.member_id]??={})[c.day]=c.kind;if(c.note)(state.constraintNotes![c.member_id]??={})[c.day]=c.note}
 if(previewPublication)return applyRows(state,raw.assignments.filter(r=>r.publication_id===previewPublication));
 if(admin)return applyRows(state,raw.assignments.filter(r=>r.publication_id===null));
 const current=new Set(raw.months.map(m=>m.current_publication_id)),publicationMonths=new Map(raw.publications.map(p=>[p.id,p.month]));
 // The owning Friday's publication wins over a copied weekend in the next month.
 const rows=raw.assignments.filter(r=>r.publication_id&&current.has(r.publication_id)).sort((a,b)=>Number(publicationMonths.get(a.publication_id!)===rowOwner(a))-Number(publicationMonths.get(b.publication_id!)===rowOwner(b)));
 const byDay=new Map<string,DutyRow>();
 for(const row of rows){for(const [key,existing] of byDay)if(existing.day<row.end_day&&existing.end_day>row.day)byDay.delete(key);byDay.set(row.day,row)}
 return applyRows(state,[...byDay.values()]);
}
export function schedulePayload(s:State){
 const months=new Set([...Object.keys(s.months),...Object.keys(s.assignments).map(d=>d.slice(0,7)),...s.specials.flatMap(x=>[x.start.slice(0,7),addDays(x.end,-1).slice(0,7)])]);
 const duties=new Map<string,ReturnType<typeof blocks>[number]>();
 for(const month of months)for(const duty of blocks(month,s.specials,s.splitWeekends)){
  // Include only explicit data or duties belonging to an existing month; never invent a carried assignment.
  if(s.months[ownerMonth(duty)]||s.assignments[duty.id]||duty.specialId)duties.set(duty.id,duty);
 }
 return {team:s.team.map(({id,color,active})=>({id,color,active})),months:s.months,duties:[...duties.values()].map(d=>({day:d.start,end_day:d.end,primary_id:s.assignments[d.id]?.primary||null,secondary_id:s.assignments[d.id]?.secondary||null,manager_override:!!s.assignments[d.id]?.override,title:d.title??'',extra_points:d.points-(d.weekendId?(d.end===addDays(d.start,2)?1:0.5):1)}))};
}
export function todayIsrael(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
