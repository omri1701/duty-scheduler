import {addDays,dayOf,blocks,ownerMonth,type State,type Special} from '../rota/engine.ts';
export type Member={id:string;email:string;name:string;role:string;status:string;active:boolean;seniority:number;color:string};
export type Lookup={code:string;label:string};
export type Role=Lookup&{can_manage:boolean};
export type DutyRow={id:string;publication_id:string|null;day:string;end_day:string;primary_id:string|null;secondary_id:string|null;manager_override:boolean;title:string;extra_points:number;points:number};
export type Publication={id:string;month:string;version:number;published_at:string;published_by:string};
export type SwapRequest={id:string;month:string;source_publication_id:string|null;requester_id:string;other_id:string;from_day:string;from_end_day:string;to_day:string;to_end_day:string;explanation:string;status:'awaiting_engineer'|'awaiting_admin'|'approved'|'declined'|'rejected'|'cancelled'|'invalidated';accepted_by:string|null;accepted_at:string|null;created_at:string;resolved_at:string|null;resolved_by:string|null;result_publication_id:string|null;override_reason:string};
export type Snapshot={swapRequests?:SwapRequest[];revision:number|null;members:Member[];months:{month:string;deadline:string;status:'draft'|'published';generated:boolean;current_publication_id:string|null;publication_sequence:number}[];constraints:{member_id:string;day:string;kind:'no'|'prefer';note:string}[];assignments:DutyRow[];publications:Publication[];roles:Role[];memberStatuses:Lookup[];monthStatuses:Lookup[];constraintTypes:Lookup[]};
type Check = (value: unknown) => boolean;
const text: Check = value => typeof value === 'string';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const boolean: Check = value => typeof value === 'boolean';
const nullableText: Check = value => value === null || text(value);
const revision: Check = value => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const oneOf = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value);
const record = (shape: Record<string, Check>): Check => value => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.entries(shape).every(([key, check]) => check((value as Record<string, unknown>)[key]));
const rows = (shape: Record<string, Check>): Check => value => Array.isArray(value) && value.every(record(shape));
const lookup = {code: text, label: text};
const snapshotChecks = {
 revision,
 members: rows({id:text,email:text,name:text,role:text,status:text,active:boolean,seniority:number,color:text}),
 months: rows({month:text,deadline:text,status:oneOf('draft','published'),generated:boolean,current_publication_id:nullableText,publication_sequence:number}),
 constraints: rows({member_id:text,day:text,kind:oneOf('no','prefer'),note:text}),
 assignments: rows({id:text,publication_id:nullableText,day:text,end_day:text,primary_id:nullableText,secondary_id:nullableText,manager_override:boolean,title:text,extra_points:number,points:number}),
 publications: rows({id:text,month:text,version:number,published_at:text,published_by:text}),
 roles: rows({...lookup,can_manage:boolean}),
 memberStatuses: rows(lookup), monthStatuses: rows(lookup), constraintTypes: rows(lookup),
 swapRequests: value => value === undefined || rows({id:text,month:text,source_publication_id:nullableText,requester_id:text,other_id:text,from_day:text,from_end_day:text,to_day:text,to_end_day:text,explanation:text,status:oneOf('awaiting_engineer','awaiting_admin','approved','declined','rejected','cancelled','invalidated'),accepted_by:nullableText,accepted_at:nullableText,created_at:text,resolved_at:nullableText,resolved_by:nullableText,result_publication_id:nullableText,override_reason:text})(value),
} satisfies Record<keyof Snapshot, Check>;
// Validate the JSON boundary without changing it, logging it, or involving storage.
export function readSnapshot(value: unknown): Snapshot {
 if (!record(snapshotChecks)(value)) throw Error('Invalid team data. Please refresh and try again.');
 return value as Snapshot;
}
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
