export type Engineer = { id: string; name: string; color: string; active: boolean };
export type Special = { id: string; title: string; start: string; end: string; extra: number };
export type Duty = { id: string; start: string; end: string; points: number; kind: 'day'|'weekend'|'special'; title?: string };
export type Assignment = { primary: string; secondary?: string; locked?: boolean; override?: boolean };
export type Constraints = Record<string, Record<string, 'no'|'prefer'>>;
export type State = { team: Engineer[]; specials: Special[]; constraints: Constraints; constraintNotes?: Record<string, Record<string,string>>; assignments: Record<string, Assignment>; months: Record<string, { deadline: string; status: 'draft'|'published'; generated?: boolean }>; version: number };
export const addDays = (s:string,n:number) => {const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
export const dayOf = (s:string) => new Date(s+'T12:00:00Z').getUTCDay();
export const monthNext = (m:string,n=1) => {const d=new Date(m+'-15T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,7)};
export function dates(start:string,end:string){const result:string[]=[];for(let d=start;d<end;d=addDays(d,1))result.push(d);return result;}
export const overlap=(a:{start:string;end:string},b:{start:string;end:string})=>a.start<b.end&&b.start<a.end;
export function blocks(month:string,specials:Special[]):Duty[]{
 const begin=month+'-01',end=monthNext(month)+'-01';
 const all:Duty[]=[];let d=addDays(begin,-7);const stop=addDays(end,7);
 while(d<stop){
  const sp=specials.find(s=>s.start<=d&&d<s.end);
  if(sp){if(!all.some(b=>b.id===sp.start))all.push({id:sp.start,start:sp.start,end:sp.end,points:1+sp.extra,kind:'special',title:sp.title});d=sp.end;continue;}
  let next=addDays(d,1),kind:Duty['kind']='day';
  if(dayOf(d)===5&&!specials.some(s=>s.start<=next&&next<s.end)){next=addDays(d,2);kind='weekend';}
  all.push({id:d,start:d,end:next,points:1,kind});d=next;
 }
 return all.filter(b=>b.start<end&&b.end>begin);
}
export const unavailable=(b:Duty,id:string,c:Constraints)=>dates(b.start,b.end).filter(d=>c[id]?.[d]==='no');
export const preferred=(b:Duty,id:string,c:Constraints)=>dates(b.start,b.end).some(d=>c[id]?.[d]==='prefer');
export function allKnownBlocks(s:State):Duty[]{const map=new Map<string,Duty>();for(const m of Object.keys(s.months))for(const b of blocks(m,s.specials))map.set(b.id,b);return [...map.values()].sort((a,b)=>a.start.localeCompare(b.start));}
export function totals(s:State,bs:Duty[]){return Object.fromEntries(s.team.map(p=>[p.id,bs.reduce((v,b)=>{const a=s.assignments[b.id];return v+(a?.primary===p.id||a?.secondary===p.id?b.points:0)},0)]));}
const distance=(a:string,b:string)=>Math.abs((Date.parse(a)-Date.parse(b))/86400000);
export function generate(s:State,month:string,seed=1):{assignments:State['assignments'];warnings:string[]}{
 const team=s.team.filter(p=>p.active);if(!team.length)return{assignments:s.assignments,warnings:['no-team']};
 const bs=blocks(month,s.specials),ids=new Set(bs.map(b=>b.id));
 const fixed=bs.filter(b=>s.assignments[b.id]?.locked||b.start.slice(0,7)!==month);
 const free=bs.filter(b=>!fixed.includes(b));
 const historical=allKnownBlocks(s).filter(b=>!ids.has(b.id));
 const previous=historical.filter(b=>b.start<month+'-01');
 const weights=Object.fromEntries(team.map((p,i)=>[p.id,1+0.12*i/Math.max(1,team.length-1)]));
 // Carry fairness as deviation, so joining does not create a debt for old months.
 const credit=Object.fromEntries(team.map(p=>[p.id,0]));
 for(const m of Object.keys(s.months).filter(m=>m<month&&s.months[m].generated)){
  const own=previous.filter(b=>b.start.slice(0,7)===m),t=totals(s,own);
  const participating=team.filter(p=>t[p.id]>0);const sum=participating.reduce((v,p)=>v+t[p.id],0),w=participating.reduce((v,p)=>v+weights[p.id],0);
  for(const p of participating)credit[p.id]+=t[p.id]-sum*weights[p.id]/w;
 }
 let monthSeed=seed>>>0;for(const char of month)monthSeed=(Math.imul(monthSeed,31)+char.charCodeAt(0))>>>0;
 const solutions:{assignments:State['assignments'];score:number}[]=[];
 let bestScore=Infinity;
 for(let attempt=0;attempt<90;attempt++){
  let random=(Math.imul(monthSeed+1,7919)+attempt*104729)>>>0;const rand=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/4294967296};
  const result={...s.assignments};for(const b of free)delete result[b.id];
  const load=Object.fromEntries(team.map(p=>[p.id,credit[p.id]]));
  for(const b of fixed){const a=result[b.id];if(a?.primary&&load[a.primary]!==undefined)load[a.primary]+=b.points;if(a?.secondary&&load[a.secondary]!==undefined)load[a.secondary]+=b.points;}
  for(const b of free){const second=s.assignments[b.id]?.secondary;if(second&&load[second]!==undefined)load[second]+=b.points;}
  const priority=Object.fromEntries(free.map(b=>[b.id,rand()]));
  const ordered=[...free].sort((a,b)=>{
   const ca=team.filter(p=>!unavailable(a,p.id,s.constraints).length).length,cb=team.filter(p=>!unavailable(b,p.id,s.constraints).length).length;
   return ca-cb||b.points-a.points||priority[a.id]-priority[b.id];
  });
  for(const b of ordered){
   const second=s.assignments[b.id]?.secondary;
   const candidates=team.filter(p=>p.id!==second&&!unavailable(b,p.id,s.constraints).length);
   if(!candidates.length){result[b.id]={primary:'',secondary:second};continue;}
   const score=(p:Engineer)=>{
    const others=[...historical,...bs].filter(x=>x.id!==b.id&&(result[x.id]?.primary===p.id||result[x.id]?.secondary===p.id));
    const gap=others.reduce((v,x)=>Math.min(v,x.end<=b.start?distance(x.end,b.start):b.end<=x.start?distance(b.end,x.start):0),30);
    return (load[p.id]+b.points/2)/weights[p.id]*12+Math.max(0,5-gap)*1.3-(preferred(b,p.id,s.constraints)?1.3:0)+rand()*4;
   };
   const rated=candidates.map(p=>({p,v:score(p)})).sort((a,b)=>a.v-b.v||team.indexOf(b.p)-team.indexOf(a.p));const chosen=rated[0].p;
   result[b.id]={primary:chosen.id,secondary:second};load[chosen.id]+=b.points;
  }
  const avg=team.reduce((v,p)=>v+load[p.id],0)/team.reduce((v,p)=>v+weights[p.id],0);
  let total=team.reduce((v,p)=>v+(load[p.id]/weights[p.id]-avg)**2*15,0);
  for(const p of team){const mine=[...historical,...bs].filter(b=>result[b.id]?.primary===p.id||result[b.id]?.secondary===p.id).sort((a,b)=>a.start.localeCompare(b.start));
   for(let i=1;i<mine.length;i++){if(!ids.has(mine[i].id)&&!ids.has(mine[i-1].id))continue;const gap=distance(mine[i-1].end,mine[i].start);total+=Math.max(0,5-gap)*2;}
  }
  // Prefer fresh arrangements among similarly fair, well-spaced solutions.
  total+=free.filter(b=>s.assignments[b.id]?.primary===result[b.id]?.primary).length*0.7;
  bestScore=Math.min(bestScore,total);solutions.push({assignments:result,score:total});
 }
 const finalists=solutions.filter(x=>x.score<=bestScore+3);
 const best=finalists[(Math.imul(monthSeed,2654435761)>>>0)%finalists.length].assignments;
 return {assignments:best,warnings:bs.filter(b=>!best[b.id]?.primary).map(b=>b.id)};
}
export function demo():State{
 const names=['Alex Morgan','Noa Levin','Daniel Cohen','Maya Shalev','Ethan Katz','Tamar Bar','Amit Halevi','Yael Sela','Omer Tal','Lior Ben-Ami','Roni Shaham','Yuval Or'];
 const colors=['#17605d','#315daa','#7844a2','#a34865','#856023','#306f90','#426539','#974527','#5256a0','#98570a','#2b7180','#685443'];
 const team=names.map((name,i)=>({id:'e'+i,name,color:colors[i],active:true}));
 const constraints:Constraints={};team.forEach((p,i)=>{constraints[p.id]={[`2026-10-${String(2+i).padStart(2,'0')}`]:'no',[`2026-10-${String(18+i%8).padStart(2,'0')}`]:'prefer'};});
 return {version:1,team,specials:[],constraints,assignments:{},months:{'2026-10':{deadline:'2026-09-25',status:'draft'}}};
}

export function applyConstraints(s:State,person:string,selected:string[],kind:'no'|'prefer'|'clear',note=''):State{
 if(!s.team.some(p=>p.id===person))throw Error('unknown-person');
 if(!['no','prefer','clear'].includes(kind)||!selected.length||selected.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))))throw Error('invalid-constraints');
 if(selected.some(d=>s.months[d.slice(0,7)]?.status==='published'))throw Error('published');
 const c={...s.constraints[person]},notes={...s.constraintNotes?.[person]};
 for(const d of selected){if(kind==='clear'){delete c[d];delete notes[d];}else{c[d]=kind;if(note.trim())notes[d]=note.trim().slice(0,300);else delete notes[d];}}
 return {...s,constraints:{...s.constraints,[person]:c},constraintNotes:{...s.constraintNotes,[person]:notes}};
}
export type SwapResult = {ok:true;assignments:State['assignments'];conflicts:{person:string;date:string}[]}|{ok:false;reason:string;conflicts?:{person:string;date:string}[]};
export function swapDraft(s:State,month:string,from:string,to:string,allowOverride=false):SwapResult{
 if(s.months[month]?.status==='published')return{ok:false,reason:'published'};
 if(from===to)return{ok:false,reason:'same-duty'};
 const bs=blocks(month,s.specials),a=bs.find(b=>b.id===from),b=bs.find(b=>b.id===to);
 if(!a||!b||a.start.slice(0,7)!==month||b.start.slice(0,7)!==month)return{ok:false,reason:'other-month'};
 const x=s.assignments[from],y=s.assignments[to];
 if(!x?.primary||!y?.primary)return{ok:false,reason:'unassigned'};
 if(x.locked||y.locked)return{ok:false,reason:'locked'};
 if(x.primary===y.primary)return{ok:false,reason:'same-person'};
 if(y.primary===x.secondary||x.primary===y.secondary)return{ok:false,reason:'duplicate'};
 if([x.primary,y.primary].some(id=>!s.team.some(p=>p.id===id&&p.active)))return{ok:false,reason:'inactive'};
 const changed=[{duty:a,assignment:{...x,primary:y.primary,override:undefined}},{duty:b,assignment:{...y,primary:x.primary,override:undefined}}];
 const conflicts=changed.flatMap(({duty,assignment})=>[assignment.primary,assignment.secondary].filter((id):id is string=>!!id).flatMap(id=>unavailable(duty,id,s.constraints).map(date=>({person:id,date}))));
 if(conflicts.length&&!allowOverride)return{ok:false,reason:'availability',conflicts};
 const assignments={...s.assignments};for(const {duty,assignment} of changed)assignments[duty.id]={...assignment,override:conflicts.some(c=>duty.start<=c.date&&c.date<duty.end)?true:undefined};
 return{ok:true,assignments,conflicts};
}
