// Real RPC -> allocation planner -> HiGHS -> checked save/reload, inside one rolled-back transaction.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import loadHighs from 'highs';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
import {readSnapshot,fromSnapshot,schedulePayload} from '../../lib/supabase/snapshot.ts';
import {proposeAllocation} from '../../lib/allocation/index.ts';
import {createHighsAdapter,createGenerationRequest,solveGeneration,validateGeneration,canonicalDuties} from '../../lib/scheduling/index.ts';
import {replay} from '../../lib/compensation/index.ts';

const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/,'Disposable LOCAL container required');
const db=spawn('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
let buffer='',errors='',pending,sequence=0;
db.stderr.on('data',data=>{errors+=data});
db.stdout.on('data',data=>{buffer+=data;const marker=`__temporary_${sequence}__`;if(pending&&buffer.includes(marker)){const result=buffer.slice(0,buffer.indexOf(marker));buffer=buffer.slice(buffer.indexOf(marker)+marker.length);const {resolve}=pending;pending=null;resolve(result.trim())}});
db.on('close',code=>{if(pending){pending.reject(Error(`psql exited ${code}: ${errors}`));pending=null}});
function sql(query){assert.ok(pending==null);sequence++;return new Promise((resolve,reject)=>{pending={resolve,reject};db.stdin.write(query+`\n\\echo __temporary_${sequence}__\n`)})}
const json=async query=>JSON.parse(await sql(query));
const q=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb";
const rev='(select revision from public.duty_workspace where id)';
const manager='75000000-0000-0000-0000-000000000001',testMember='75000000-0000-0000-0000-000000000002';
const month='2026-11',now=Date.parse('2026-10-26T10:00:00Z');
try {
 await sql(await readFile(new URL('./temporary-members.sql',import.meta.url),'utf8'));
 console.log('PASS: temporary member RPC grants, admin authorization, stale/invalid writes, private notes, no self access and unchanged registration');
 await sql(`begin;
 do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
 create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${now}::bigint$$;
 insert into auth.users(id,email) values('${manager}','manager@example.invalid'),('${testMember}','old-test@example.invalid');
 insert into public.duty_members(id,email,name,role,status,active,seniority) values('${manager}','manager@example.invalid','Manager','admin','approved',true,1),('${testMember}','old-test@example.invalid','Old test','engineer','approved',true,2);
 insert into public.duty_months(month,deadline,status) values('2026-10','2026-09-24','published');
 insert into public.duty_publications(month,version,published_by) values('2026-10',1,'${manager}');
 insert into public.duty_assignments(publication_id,day,end_day,primary_id) select id,'2026-10-01','2026-10-02','${testMember}' from public.duty_publications;
 update public.duty_months set current_publication_id=(select id from public.duty_publications) where month='2026-10';
 set local request.jwt.claim.sub='${manager}';set local role authenticated;
 create temp table created(id uuid);
 do $$begin for i in 1..12 loop insert into created select public.duty_add_temporary_member('Engineer '||i,${rev});end loop;end$$;`);
 const ids=(await json('select jsonb_agg(id order by seniority) from public.duty_members where is_temporary;'));
 assert.equal(ids.length,12);
 await sql(`select public.duty_rename_temporary_member('${ids[0]}','Renamed Engineer',${rev});
 do $$declare member uuid;begin for member in select id from created loop
 perform public.duty_set_constraints(member,array['2026-11-05'::date],'no','Private absence',${rev});end loop;end$$;
 select public.duty_set_constraints('${ids[0]}',array['2026-11-05'::date],'clear','',${rev});
 -- Keep the administrator active; explicitly deactivate only the synthetic old test member.
 select public.duty_save_schedule(${q({team:[{id:testMember,color:'#adc9ee',active:false}],months:{[month]:{status:'draft',deadline:'2026-10-25',generated:false}},duties:[]})},${rev},null);`);
 let context=readGenerationContext(await json(`select public.duty_generation_context('${month}',${rev});`));
 assert.equal(context.input.schedule.members.find(m=>m.id===testMember).eligible,false);
 assert.equal(context.input.schedule.members.filter(m=>m.eligible).length,13);
 for(const id of ids)assert.equal(context.input.schedule.members.find(m=>m.id===id).eligible,true);
 const solver=await createHighsAdapter(loadHighs),proposal=proposeAllocation(context.input);
 assert.equal(proposal.draft.targetsUnits[testMember]??0,0);
 context=readGenerationContext(await json(`select public.duty_confirm_allocation('${month}',${q(proposal.draft)},'[]','[]',${context.revision},'${context.fingerprint}');`));
 const result=solveGeneration(solver,createGenerationRequest(context.generationInput,{now,seed:17,seconds:10}));
 assert.equal(result.complete,true);
 assert.ok(validateGeneration(context.generationInput,result.assignments).deficits.every(v=>v===0));
 assert.ok(ids.every(id=>Object.values(result.assignments).some(a=>a.primary===id)),'All 12 temporary engineers receive work');
 assert.ok(Object.values(result.assignments).every(a=>a.primary!==testMember));
 context=readGenerationContext(await json(`select public.duty_save_generation('${month}',${q(result.assignments)},${context.revision},'${context.fingerprint}',17);`));
 let snapshot=readSnapshot(await json('select public.duty_load();'));
 const stableIds=snapshot.members.filter(m=>m.is_temporary).map(m=>m.id).sort();
 const state=fromSnapshot(snapshot,manager);
 for(const duty of canonicalDuties(month,{}))assert.equal(state.assignments[duty.id].primary,result.assignments[duty.id].primary);
 assert.equal(snapshot.constraints.length,11);
 assert.equal(snapshot.members.find(m=>m.id===ids[0]).name,'Renamed Engineer');
 // Publication exercises existing member FKs and compensation binding with temporary endpoints.
 await sql(`select public.duty_save_schedule(${q(schedulePayload(state,month,true))},${rev},'${month}');`);
 snapshot=readSnapshot(await json('select public.duty_load();'));
 assert.deepEqual(snapshot.members.filter(m=>m.is_temporary).map(m=>m.id).sort(),stableIds);
 assert.ok(snapshot.assignments.some(a=>a.primary_id===testMember&&a.day==='2026-10-01'),'Inactive history retained');
 assert.equal(snapshot.months.find(m=>m.month===month).status,'published');
 await sql('reset role;');
 const ledger=await json('select duty_private.compensation_view(duty_private.compensation_state());');
 const stateLedger=replay(ledger.events);
 for(const id of ids)assert.equal(stateLedger.members.find(m=>m.id===id).active,true);
 assert.equal(stateLedger.members.find(m=>m.id===testMember).active,false);
 await sql(`set local role authenticated;
 select public.duty_compensation(${q({kind:'claim',debtorId:ids[0],creditorId:ids[1],units:2})},'temporary-claim','Reviewed temporary obligation',${rev},null,null);`);
 await sql('reset role;');
 const balances=await json('select duty_private.compensation_view(duty_private.compensation_state());');
 assert.equal(balances.net[ids[0]],-2);assert.equal(balances.net[ids[1]],2);
 const originalLots=balances.lots;
 for(const active of [false,true]){
  await sql(`set local role authenticated;select public.duty_save_schedule(${q({team:[{id:ids[0],color:'#adc9ee',active}],months:{},duties:[]})},${rev},null);reset role;`);
  const changed=await json('select duty_private.compensation_view(duty_private.compensation_state());');
  assert.deepEqual(changed.lots,originalLots,'Participation changes retain exact compensation units and age');
  assert.equal(changed.claims.find(c=>c.debtorId===ids[0]).frozen,!active);
  const retained=await json(`select to_jsonb(m) from public.duty_members m where id='${ids[0]}';`);
  assert.equal(retained.id,ids[0]);assert.equal(retained.name,'Renamed Engineer');assert.equal(retained.active,active);
 }
 assert.equal(await json('select to_jsonb(count(*)) from auth.users;'),2);
 console.log('PASS: create 12, rename/edit constraints, deactivate old test member, real November allocation/HiGHS, validate/save/reload/publish, stable IDs/history and compensation');
 await sql('rollback;');
} finally {db.stdin.end();}
