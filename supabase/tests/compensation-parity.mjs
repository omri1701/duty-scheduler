// Real SQL replay vs PR #33. LOCAL-only, no persistent fixture writes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {record,replay,reconcile,normalize,sliceClaim,project} from '../../lib/compensation/index.ts';
import {handover} from '../../lib/scheduling/calendar.ts';
const container=process.argv[2];
assert.match(container??'',/^supabase_db_[\w-]+$/);
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const cases=[];
const send=(h,operation,key,at=(h.at(-1)?.at??0)+1)=>record(h,{sourceKey:key,at,actor:'manager',reason:'Reviewed',operation}).events;
const setup=()=>send([],{kind:'members',members:['a','b','c','d'].map(id=>({id,active:true}))},'members');
const owe=(h,a,b,n,key)=>send(h,{kind:'claim',debtorId:a,creditorId:b,units:n},key);
const keep=h=>{cases.push(replay(h));return h};
let h=owe(setup(),'a','b',6,'ab');h=owe(h,'b','c',4,'bc');keep(h);
const ref=replay(h).claims.find(c=>c.creditorId==='c');
h=send(h,{kind:'adjust',mode:'settle',claim:ref,units:2},'settle');keep(h);
h=send(h,{kind:'reverse-settlement',settlementId:'settle'},'reverse');keep(h);
h=send(h,{kind:'correct',lotId:'bc',deltaUnits:-2},'correct');keep(h);
h=send(h,{kind:'members',members:[{id:'b',active:false}]},'freeze');keep(h);
h=owe(h,'d','b',2,'db');h=send(h,{kind:'members',members:[{id:'b',active:true}]},'reactivate');keep(h);
const duty=(date,primaryId,units=2,endDate='2026-11-03')=>({startDate:date,endDate,primaryId,units});
const publication=(id,duties,reservations=[],intents=[],month='2026-11')=>({id,month,duties,reservations,intents});
const publish=(h,after,beforeId=null)=>send(h,{kind:'publication',month:after.month,beforeId,after},'publish/'+after.id);
const plan=(h,id,units=2)=>({id,capacity:{date:'2026-11-02',offset:0,units},claim:sliceClaim(replay(h).claims[0],units)});
const completion=handover('2026-11-03')*60000;
for(const replacement of ['a','b','c']) {
 h=owe(setup(),'a','b',4,'debt');
 const p=publication('v1',[duty('2026-11-02','a',6)],[plan(h,'r',4)]);h=keep(publish(h,p));
 h=keep(publish(h,{...p,id:'v2'},'v1'));
 h=keep(publish(h,publication('v3',[duty('2026-11-02',replacement,6)],replacement==='a'?p.reservations:[]),'v2'));
 h=keep(reconcile(h,completion).events);
 h=keep(send(h,{kind:'publication',month:'2026-11',beforeId:'v3',after:p,mode:'delete'},'delete-old',completion+1));
 keep(send(h,{kind:'publication',month:'2026-11',beforeId:'v1',after:null,mode:'delete'},'delete-last',completion+2));
}
for(const at of [completion-1,completion+1]) {
 h=owe(setup(),'a','b',4,'debt');h=publish(h,publication('v1',[duty('2026-11-02','a')],[plan(h,'r')]));
 h=keep(send(h,{kind:'members',members:[{id:'a',active:false}]},'off',at));
 h=keep(send(h,{kind:'members',members:[{id:'a',active:true}]},'on',completion+2));
 if(replay(h).contributions[0].status==='held') keep(send(h,{kind:'release',contributionId:'r'},'release',completion+3));
}
// Split weekend comparison, temporary/permanent exemptions and weighted swaps.
h=publish(setup(),publication('weekend',[duty('2026-11-06','a',2,'2026-11-08')]));
keep(publish(h,publication('split',[duty('2026-11-06','a',1,'2026-11-07'),duty('2026-11-07','b',1,'2026-11-08')]),'weekend'));
// Holiday weekends: each date keeps its own units; a combined duty names Saturday's (saturdayUnits).
h=publish(setup(),publication('holiday',[{...duty('2026-11-06','a',10,'2026-11-08'),saturdayUnits:5}]));
keep(publish(h,publication('holiday-split',[duty('2026-11-06','a',5,'2026-11-07'),duty('2026-11-07','b',5,'2026-11-08')]),'holiday'));
h=publish(setup(),publication('friday',[duty('2026-11-06','a',3,'2026-11-08')]));
keep(publish(h,publication('friday-split',[duty('2026-11-06','b',2,'2026-11-07'),duty('2026-11-07','a',1,'2026-11-08')]),'friday'));
h=publish(setup(),publication('saturday',[{...duty('2026-11-06','a',4,'2026-11-08'),saturdayUnits:3}]));
keep(publish(h,publication('saturday-split',[duty('2026-11-06','a',1,'2026-11-07'),duty('2026-11-07','b',3,'2026-11-08')]),'saturday'));
for(const kind of ['temporary','permanent']) {
 h=publish(setup(),publication('v1',[duty('2026-11-02','a')]));
 keep(publish(h,publication('v2',[duty('2026-11-02','b')],[],[{id:'intent',kind,fromId:'a',toId:'b',capacity:[{date:'2026-11-02',offset:0,units:2}]}]),'v1'));
}
h=publish(setup(),publication('v1',[duty('2026-11-02','a',2),duty('2026-11-04','b',6,'2026-11-05')]));
keep(publish(h,publication('v2',[duty('2026-11-02','b',2),duty('2026-11-04','a',6,'2026-11-05')]),'v1'));
// Incremental graph parity also checks frozen endpoint/provenance decisions.
for(let seed=1;seed<=30;seed++) {
 let random=seed;const rand=()=>random=(Math.imul(random,1664525)+1013904223)>>>0;
 h=setup();
 for(let i=0;i<9;i++){const a=rand()%4,b=(a+1+rand()%3)%4;h=owe(h,['a','b','c','d'][a],['a','b','c','d'][b],1+rand()%5,'s'+i)}
 keep(h);
}
const graphs=[];
// Routed legs share one actual carrier budget, including permanent bridges.
for(const kinds of [['temporary','permanent'],['permanent','temporary'],['temporary','temporary'],['permanent','permanent']]) {
 h=setup();
 const route=[{fromId:'a',toId:'b',kind:kinds[0],transferIds:['ab'],counterparts:[{id:'ab',fromId:'a',toId:'b',kind:kinds[0],units:2}]},
  {fromId:'b',toId:'c',kind:kinds[1],transferIds:['bc'],counterparts:[{id:'bc',fromId:'b',toId:'c',kind:kinds[1],units:2}]}];
 h=keep(publish(h,publication('route-v1',[duty('2026-11-02','c')],[],[{id:'route',kind:kinds[0],fromId:'a',toId:'c',capacity:[{date:'2026-11-02',offset:0,units:2}],route}])));
 keep(publish(h,{...replay(h).publications[0],id:'route-copy'},'route-v1'));
}
for(let seed=1;seed<=20;seed++) {
 let random=seed;const rand=()=>random=(Math.imul(random,1664525)+1013904223)>>>0;
 const edges=Array.from({length:9},(_,i)=>{const a=rand()%4,b=(a+1+rand()%3)%4;return {debtorId:String(a),creditorId:String(b),path:[{lotId:'s'+i,offset:0,units:1+rand()%5}],priority:{at:1,sequence:i+1,lotId:'s'+i}}});
 graphs.push({edges,expected:normalize(edges,new Set(['0','1','2','3']))});
}
const sql=`begin;
create function pg_temp.compensation_replay(events jsonb) returns jsonb language plpgsql as $$
declare s jsonb:='{"events":[],"members":{},"lots":{},"claims":[],"contributions":{},"settlements":{},"publications":{},"intents":{},"normalizations":[]}';e jsonb;
begin for e in select value from jsonb_array_elements(events) loop s:=duty_private.compensation_apply(s,e);end loop;return duty_private.compensation_view(s);end $$;
${cases.map(v=>`select pg_temp.compensation_replay(${quote(v.events)});`).join('\n')}
${graphs.map(({edges})=>`select duty_private.compensation_normalize(${quote(edges)},'{"0":{"active":true},"1":{"active":true},"2":{"active":true},"3":{"active":true}}');`).join('\n')}
rollback;`;
const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(r.status,0,r.stderr);
const rows=r.stdout.trim().split('\n').map(JSON.parse);
function sorted(v) {v=structuredClone(v);for(const k of ['members','lots','contributions','settlements','publications'])v[k]?.sort((a,b)=>a.id.localeCompare(b.id));return v}
for(let i=0;i<cases.length;i++)assert.deepEqual(sorted(rows[i]),sorted(cases[i]),'SQL/core replay case '+i);
for(let i=0;i<graphs.length;i++)assert.deepEqual(rows[cases.length+i],graphs[i].expected,'SQL/core graph '+i);
// Projection uses the same pure core after the SQL event suffix is persisted.
assert.equal(project(cases[7].events,100,completion).actual.events.length,cases[7].events.length);
console.log(`PASS: ${cases.length} SQL/core histories and ${graphs.length} graph normalizations match exactly (claims, lots, provenance, holds, settlements, publications and events)`);
// Validate histories produced by real RPCs/hooks too, including malformed-input
// refusals and the mid-weekend completed-fact adapter, not only pure operations.
for(const file of ['compensation.sql','compensation-settlement.sql']) {
 const input=readFileSync('supabase/tests/'+file,'utf8').replace(/rollback;\s*$/i,'select duty_private.compensation_view(duty_private.compensation_state());\nrollback;');
 const result=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16*1024*1024});
 assert.equal(result.status,0,result.stderr);
 const view=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('{')));
 assert.deepEqual(sorted(view),sorted(replay(view.events)),file+' committed RPC history must replay in PR #33');
 console.log('PASS: real '+file+' RPC/hook history exactly matches pure core replay');
}
