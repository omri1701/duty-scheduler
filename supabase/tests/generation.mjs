// Checked RPCs, real PostgreSQL authorization/rollback, and core accounting parity.
// Only synthetic fixtures in an empty disposable LOCAL container; every case rolls back.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {canonicalDuties, handover} from '../../lib/scheduling/calendar.ts';
import {replay} from '../../lib/compensation/index.ts';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const ids=Array.from({length:13},(_,i)=>`73000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
const manager=ids[0],month='2027-12',duties=canonicalDuties(month,{}),zero=()=>Object.fromEntries(ids.map(id=>[id,0]));
let weekend=0,weekday=0;
const assignments=Object.fromEntries(duties.map(d=>[d.id,{primary:ids[d.weekendId?weekend++:5+weekday++%7]}]));
const totals=zero();for(const d of duties)totals[assignments[d.id].primary]+=d.units;
const draft={baselineUnits:{...totals},offeredUnits:{...totals},targetsUnits:{...totals},repayments:[],transfers:[],pending:[],sourceKey:'reviewed-server-fixture'};
// Baseline is a minimum-cost partition of the actual canonical weights. Explicit
// permanent counterparts express deliberate differences in these test targets.
const fair=Object.fromEntries(ids.map(id=>[id,4]));fair[manager]+=duties.reduce((n,d)=>n+d.units,0)-ids.length*4;
function classify(d,repayments=[]) {
 const offered={...fair};for(const r of repayments){offered[r.debtor]+=r.units;offered[r.creditor]-=r.units}
 const current={...offered},prefix=[];
 for(const fromId of ids)for(const toId of ids){const n=Math.min(current[fromId]-d.offeredUnits[fromId],d.offeredUnits[toId]-current[toId]);if(n>0){prefix.push({id:'baseline/'+prefix.length,fromId,toId,units:n,kind:'permanent'});current[fromId]-=n;current[toId]+=n}}
 return {...structuredClone(d),baselineUnits:{...fair},offeredUnits:offered,transfers:[...prefix,...d.transfers]};
}
const confirmedDraft=classify(draft);
const ordered=v=>{v=structuredClone(v);for(const k of ['members','lots','contributions','settlements','publications'])v[k]?.sort((a,b)=>a.id.localeCompare(b.id));return v};
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const sql=(query)=>{const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').filter(x=>x.startsWith('{')).map(JSON.parse)};
const rev='(select revision from public.duty_workspace where id)';
const setup=`begin;
do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select 1822478400000::bigint$$;
insert into auth.users(id,email) values ${ids.map((id,i)=>`('${id}','generation-${i}@example.invalid')`).join(',')};
insert into public.duty_members(id,email,name,role,status,active,seniority) values ${ids.map((id,i)=>`('${id}','generation-${i}@example.invalid','Fixture ${i}','${i<2?'admin':'engineer'}','approved',true,${i+1})`).join(',')};
insert into public.duty_months(month,deadline) values('${month}','2027-11-24');
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command;exception when others then if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;end;
 raise exception 'Unexpected acceptance: %',pattern;
end$$;
set local request.jwt.claim.sub='${manager}';set local role authenticated;
create temp table context(v jsonb);insert into context select public.duty_generation_context('${month}',${rev});
`;
const refresh=`update context set v=public.duty_generation_context('${month}',${rev});`;
const confirm=(d=confirmedDraft,locks=[],approvals=[])=>`update context set v=public.duty_confirm_allocation('${month}',${quote(d)},${quote(locks)},${quote(approvals)},(v->>'revision')::bigint,v->>'fingerprint');`;
const save=(a=assignments)=>`update context set v=public.duty_save_generation('${month}',${quote(a)},(v->>'revision')::bigint,v->>'fingerprint',123);`;
const publish=`select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${month}',jsonb_build_object('status','draft','deadline','2027-11-24','generated',true)),
 'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null and duty_private.duty_owner(day)='${month}')),${rev},'${month}');`;
// Public caller cannot invoke private fact helpers to bypass the manager gate.
const failure=(command,pattern)=>`select pg_temp.must_fail($command$${command}$command$,'${pattern}');`;
const metricsCheck=`do $$begin if not exists(select 1 from public.duty_allocations where publication_id is null and allocation->'targetsUnits'=${quote(totals)}) then raise exception 'Targets mutated';end if;end$$;`;
const partial=Object.fromEntries(duties.map(d=>[d.id,{primary:null}]));
let test=setup;
test+=failure(`select duty_private.generation_facts('${month}')`,'permission denied');
test+=`set local request.jwt.claim.sub='${ids[2]}';`;
test+=failure(`select public.duty_generation_context('${month}',${rev})`,'Admin access required');
test+=failure(`select public.duty_confirm_allocation('${month}',${quote(draft)},'[]','[]',${rev},'fake')`,'Admin access required');
test+=`do $$begin if exists(select 1 from public.duty_allocations) then raise exception 'Allocation RLS';end if;end$$;
set local request.jwt.claim.sub='${manager}';`;
test+=failure(`select public.duty_save_generation('${month}','{}',${rev},'fake',1)`,'Generation inputs changed');
const invalid=structuredClone(confirmedDraft);invalid.targetsUnits[manager]+=1;
test+=failure(confirm(invalid),'target-total-mismatch');
test+=failure(confirm(draft),'invalid-ordinary-baseline');
test+=confirm()+save(partial)+metricsCheck;
test+=`set local request.jwt.claim.sub='${ids[2]}';do $$begin if exists(select 1 from public.duty_allocations) then raise exception 'Engineer read private confirmed allocation';end if;end$$;set local request.jwt.claim.sub='${manager}';`;
test+=failure(`delete from public.duty_allocations where month='${month}'`,'permission denied');
test+=failure(publish,'active engineer');
const exceeded=structuredClone(partial);
// Explicitly use a zero-target eligible engineer for a forged extra assignment.
exceeded[duties[0].id]={primary:ids[12]};
test+=failure(save(exceeded),'target-exceeded');
const adjacent=structuredClone(partial);adjacent[duties[0].id]={primary:ids[5]};adjacent[duties[1].id]={primary:ids[5]};
test+=failure(save(adjacent),'consecutive-primary');
const weekends=structuredClone(partial);for(const d of duties.filter(d=>d.weekendId).slice(0,2))weekends[d.id]={primary:ids[5]};
test+=failure(save(weekends),'weekend-cap');
test+=save()+metricsCheck;
test+=`reset role;create function pg_temp.fail_ledger() returns trigger language plpgsql as $$begin if new.operation->>'kind'='publication' then raise exception 'Injected publication failure';end if;return new;end$$;
create trigger generation_failure before insert on public.duty_compensation_events for each row execute function pg_temp.fail_ledger();set local role authenticated;`;
test+=failure(publish,'Injected publication failure');
test+=`do $$begin if exists(select 1 from public.duty_publications) or exists(select 1 from public.duty_allocations where publication_id is not null) then raise exception 'Failed publication left partial state';end if;end$$;
reset role;drop trigger generation_failure on public.duty_compensation_events;set local role authenticated;`;
test+=failure(`select public.duty_save_generation('${month}',${quote(assignments)},0,(select v->>'fingerprint' from context),123)`,'team data changed');
// Wall clock alone invalidates an in-flight result at equality with opening.
test+=`reset role;create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${handover(duties[0].startDate)*60000}::bigint$$;set local role authenticated;`;
test+=failure(save(),'generation-window-closed');
test+=`reset role;create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select 1822478400000::bigint$$;set local role authenticated;`;
test+=publish;
test+=`create temp table original as select to_jsonb(a) a from public.duty_allocations a where publication_id is not null;
select public.duty_restore_publication((select current_publication_id from public.duty_months where month='${month}'),${rev});`+refresh+save()+publish;
test+=`do $$begin if (select count(*) from public.duty_allocations where publication_id is not null)<>2 then raise exception 'Missing snapshots';end if;
 if not exists(select 1 from public.duty_allocations a join original o on to_jsonb(a)=o.a) then raise exception 'History changed';end if;end$$;
select public.duty_restore_publication((select current_publication_id from public.duty_months where month='${month}'),${rev});
select public.duty_cancel_draft('${month}',${rev});
do $$begin if exists(select 1 from public.duty_allocations where publication_id is null) then raise exception 'Cancelled draft metadata retained';end if;end$$;
select duty_private.compensation_view(duty_private.compensation_state());
rollback;`;
// Private helper select at end runs as postgres only, never grant the helper.
test=test.replace('select duty_private.compensation_view(duty_private.compensation_state());','reset role;select duty_private.compensation_view(duty_private.compensation_state());');
// The legacy publish helper builds payload server-side only in this test.
test=test.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
const views=sql(test);for(const view of views)assert.deepEqual(ordered(view),ordered(replay(view.events)));
console.log('PASS: generation authorization, independent schedule validation, partial saves, stale revisions, cutoff, publication copies and cancellation');

// Real first-publication routed accounting, including the Astra mixed chain.
const mixed=structuredClone(draft);
mixed.baselineUnits[ids[5]]+=2;mixed.baselineUnits[ids[6]]-=2;mixed.offeredUnits={...mixed.baselineUnits};
mixed.transfers=[{id:'temporary',fromId:ids[5],toId:ids[12],units:2,kind:'temporary'},
 {id:'permanent',fromId:ids[12],toId:ids[6],units:2,kind:'permanent'}];
let routed=setup+confirm(classify(mixed))+save()+publish.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
routed+=`reset role;select duty_private.compensation_view(duty_private.compensation_state());
set local role authenticated;select public.duty_restore_publication((select current_publication_id from public.duty_months where month='${month}'),${rev});`;
routed+=publish.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
routed+=`reset role;select duty_private.compensation_view(duty_private.compensation_state());rollback;`;
const routedViews=sql(routed);
for(const view of routedViews)assert.deepEqual(ordered(view),ordered(replay(view.events)));
assert.equal(routedViews[0].net[ids[5]],-2);assert.equal(routedViews[0].net[ids[12]],2);assert.equal(routedViews[0].net[ids[6]],0);
assert.equal(routedViews[0].lots.length,routedViews[1].lots.length);
console.log('PASS: server-compiled mixed temporary/permanent route retains the original creditor, earns no duplicate origin on copying, and replays exactly in TypeScript');

// The authoritative context is directly consumable by the typed adapter.
const contextValue=sql(setup+`select v from context;rollback;`)[0];
const converted=readGenerationContext(contextValue);
assert.equal(converted.input.schedule.month,month);assert.equal(converted.generationAllowed,true);
assert.deepEqual(canonicalDuties(month,converted.input.schedule.calendar),duties);
console.log('PASS: actual SQL generation context round-trips through the typed adapter');

// Explicit locks and exact approvals survive generation, publication, restoration
// and cancellation. A generic legacy flag alone cannot approve solver work.
const lockedDuty=duties.find(d=>!d.weekendId),lockedEngineer=assignments[lockedDuty.id].primary;
const lock=[{dutyId:lockedDuty.id,engineer:lockedEngineer}];
const approval=[{rule:'availability',dutyId:lockedDuty.id,engineer:lockedEngineer,dates:[lockedDuty.startDate],reason:'Reviewed exact duty'}];
let locked;
// Materialize the assigned duty without granting a generic override.
locked=setup+`reset role;insert into public.duty_assignments(day,end_day,primary_id) values('${lockedDuty.startDate}','${lockedDuty.endDate}','${lockedEngineer}');
insert into public.duty_constraints(member_id,day,kind,note) values('${lockedEngineer}','${lockedDuty.startDate}','no','Private lock note');set local role authenticated;`+refresh;
locked+=failure(confirm(confirmedDraft,lock,[]),'unavailable-primary');
locked+=failure(confirm(confirmedDraft,lock,[{...approval[0],dates:[duties[1].startDate]}]),'invalid-availability-approval');
locked+=confirm(confirmedDraft,lock,approval);
const dropped=structuredClone(assignments);dropped[lockedDuty.id].primary=null;
locked+=failure(save(dropped),'lock-changed')+save();
locked+=`select v from context;`;
locked+=publish.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
const swapDays=[ids[6],ids[7]].map(id=>duties.find(d=>!d.weekendId&&assignments[d.id].primary===id).id);
locked+=`set local request.jwt.claim.sub='${ids[6]}';select public.duty_request_swap(
 (select id from public.duty_assignments where publication_id=(select current_publication_id from public.duty_months where month='${month}') and day='${swapDays[0]}'),
 (select id from public.duty_assignments where publication_id=(select current_publication_id from public.duty_months where month='${month}') and day='${swapDays[1]}'),'Reviewed swap',${rev});
set local request.jwt.claim.sub='${ids[7]}';select public.duty_resolve_swap((select id from public.duty_swap_requests),'accept',${rev});
set local request.jwt.claim.sub='${manager}';select public.duty_resolve_swap((select id from public.duty_swap_requests),'approve',${rev});
do $$begin if not exists(select 1 from public.duty_allocations where publication_id=(select current_publication_id from public.duty_months where month='${month}') and origin='swap' and approvals=${quote(approval)}) then raise exception 'Swap lost unrelated scoped approval';end if;end$$;`;
locked+=`select public.duty_restore_publication((select current_publication_id from public.duty_months where month='${month}'),${rev});`+refresh+`select v from context;rollback;`;
const lockViews=sql(locked);assert.deepEqual(lockViews[0].facts.locks,lockViews[1].facts.locks);assert.deepEqual(lockViews[0].facts.approvals,lockViews[1].facts.approvals);
assert.deepEqual(readGenerationContext(lockViews[0]).generationInput.targets,Object.fromEntries(Object.entries(totals).map(([id,units])=>[id,units/2])));
assert.ok(!JSON.stringify(lockViews).includes('Private lock note'));
console.log('PASS: exact availability approval publishes without a generic override; locks/approvals round-trip and private notes stay excluded');

// Server debt validation, deferred repayment mixed route, post-normalization
// source suffix and actual duty reservations. Nothing is earned on publication.
const deferred={...structuredClone(draft),baselineUnits:{...fair},offeredUnits:{...fair},targetsUnits:{...fair}},debtor=ids[5],creditor=ids[6],carrier=ids[7];
deferred.offeredUnits[debtor]+=4;deferred.offeredUnits[creditor]-=4;deferred.targetsUnits={...deferred.offeredUnits};
deferred.targetsUnits[ids[12]]-=4;deferred.targetsUnits[ids[8]]+=4;
deferred.targetsUnits[debtor]-=2;deferred.targetsUnits[carrier]+=2;
deferred.transfers=[{id:'bridge-relief',fromId:ids[12],toId:ids[8],units:4,kind:'permanent'},
 {id:'defer',fromId:debtor,toId:ids[12],units:2,kind:'temporary'},
 {id:'volunteer',fromId:ids[12],toId:carrier,units:2,kind:'permanent'}];
// Small deterministic constructive fixture; no solver proofs cross the RPC.
function arrangement(targets) {
 const remaining={...targets},chosen={},seen=new Map(ids.map(id=>[id,new Set()]));
 function place(i){if(i===duties.length)return Object.values(remaining).every(n=>n===0);const d=duties[i];
  for(const id of [...ids].sort((a,b)=>remaining[b]-remaining[a]||a.localeCompare(b))){if(remaining[id]<d.units||i&&chosen[duties[i-1].id]?.primary===id||d.weekendId&&seen.get(id).size&&!seen.get(id).has(d.weekendId))continue;
   remaining[id]-=d.units;chosen[d.id]={primary:id};if(d.weekendId)seen.get(id).add(d.weekendId);if(place(i+1))return true;if(d.weekendId)seen.get(id).delete(d.weekendId);remaining[id]+=d.units;
  }return false;
 }assert.ok(place(0),'constructive allocation fixture');return chosen;
}
const reassign=arrangement(deferred.targetsUnits);
let repayment=setup+`create temp table debt(v jsonb);insert into debt select public.duty_compensation(${quote({kind:'claim',debtorId:debtor,creditorId:creditor,units:4})},'debt','Reviewed source',${rev});`+refresh;
repayment+=`create temp table proposed(v jsonb);insert into proposed select jsonb_set(${quote(deferred)},'{repayments}',jsonb_build_array(jsonb_build_object('claim',v->'actual'->'claims'->0,'units',4))) from debt;
`;
repayment+=failure(`update context set v=public.duty_confirm_allocation('${month}',(select jsonb_set(v,'{repayments}',(v->'repayments')||(v->'repayments')) from proposed),'[]','[]',(v->>'revision')::bigint,v->>'fingerprint')`,'duplicate-repayment-source');
repayment+=`update context set v=public.duty_confirm_allocation('${month}',(select v from proposed),'[]','[]',(v->>'revision')::bigint,v->>'fingerprint');`;
repayment+=save(reassign)+publish.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
repayment+=`reset role;select duty_private.compensation_view(duty_private.compensation_state());
set local role authenticated;select public.duty_delete_publication((select current_publication_id from public.duty_months where month='${month}'),${rev});`;
repayment+=publish.replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");
repayment+=`reset role;select duty_private.compensation_view(duty_private.compensation_state());
do $$declare s jsonb:=duty_private.compensation_state();ancestor uuid;p jsonb;metadata jsonb;allocation_id uuid;completed jsonb;released jsonb;
begin
 select (x->'operation'->'after'->>'id')::uuid into ancestor from jsonb_array_elements(s->'events') with ordinality e(x,i) where x->'operation'->>'kind'='publication' and x->'operation'->'after'<>'null' order by i limit 1;
 p:=s->'publications'->'${month}';select a.allocation_id into allocation_id from public.duty_allocations a where a.publication_id=(p->>'id')::uuid;
 metadata:=duty_private.allocation_rebind(s,p||jsonb_build_object('id',gen_random_uuid()),ancestor,allocation_id,1822478400000);
 if metadata->'reservations'<>p->'reservations' then raise exception 'Ancestor replay duplicated pending descendants';end if;
 completed:=duty_private.compensation_reconcile(s,${handover('2028-01-03')*60000},false);
 metadata:=duty_private.allocation_rebind(completed,p||jsonb_build_object('id',gen_random_uuid()),ancestor,allocation_id,${handover('2028-01-03')*60000});
 if metadata->'reservations'<>p->'reservations' then raise exception 'Ancestor replay duplicated settled descendants';end if;
 released:=duty_private.compensation_apply(s,jsonb_build_object('sequence',(s->'events'->-1->>'sequence')::bigint+1,'sourceKey','manual/release-fixture','actor','${manager}','reason','Reviewed release','at',1822478400000,
  'operation',jsonb_build_object('kind','release','contributionId',p->'reservations'->0->'id')));
 begin
  perform duty_private.allocation_rebind(released,p||jsonb_build_object('id',gen_random_uuid()),ancestor,allocation_id,1822478400000);
  raise exception 'Ancestor replay undid explicit release';
 exception when serialization_failure then null;end;
end$$;rollback;`;
const repaymentViews=sql(repayment),repaymentView=repaymentViews[0];for(const view of repaymentViews)assert.deepEqual(ordered(view),ordered(replay(view.events)));
assert.equal(repaymentView.net[debtor],-4);assert.equal(repaymentView.net[ids[12]],2);assert.equal(repaymentView.net[creditor],2);
assert.equal(repaymentView.settlements.length,0);assert.equal(repaymentView.contributions.reduce((n,c)=>n+c.capacity.units,0),2);
assert.deepEqual(repaymentView.contributions.flatMap(c=>Array.from({length:c.capacity.units},(_,i)=>c.claim.path[0].offset+i)).sort(),[2,3]);
console.log('PASS: deferred mixed route retains the original debtor and reserves only the unreserved normalized suffix; no unearned settlement');
assert.equal(repaymentViews[1].lots.length,repaymentView.lots.length);
const rebound=repaymentViews[1].contributions.filter(c=>c.status==='pending');assert.equal(rebound.reduce((n,c)=>n+c.capacity.units,0),2);
assert.ok(rebound.every(c=>!repaymentView.contributions.some(old=>old.id===c.id)),'cancelled contribution IDs are never resurrected');
console.log('PASS: deleting the final publication and republishing rebinds outstanding repayment with new exclusive IDs without replaying origins');

// Strict route shape checks on the legacy public publication boundary too.
const intent={id:'reviewed-route',fromId:ids[5],toId:ids[6],kind:'temporary',capacity:[{date:duties.find(d=>assignments[d.id].primary===ids[6]).startDate,offset:0,units:2}],
 route:[{fromId:ids[5],toId:ids[6],kind:'temporary',transferIds:['counterpart'],counterparts:[{id:'counterpart',fromId:ids[5],toId:ids[6],kind:'temporary',units:2}]}]};
const malformed=[];
for(const change of [t=>delete t.route[0].counterparts[0].kind,t=>t.route[0].counterparts[0].kind=null,
 t=>{t.route[0].transferIds=[1];t.route[0].counterparts[0].id=1},t=>t.route[0].deferredClaim={debtorId:ids[5]},t=>t.route[0].deferredClaim=null]){const bad=structuredClone(intent);change(bad);malformed.push(bad)}
let poison=setup+`reset role;insert into public.duty_assignments(day,end_day,primary_id) values ${duties.map(d=>`('${d.startDate}','${d.endDate}','${assignments[d.id].primary}')`).join(',')};set local role authenticated;`+refresh;
for(const bad of malformed){const command=publish.replace("'duties',(",`'compensation',jsonb_build_object('fingerprint',(select v->>'accountingFingerprint' from context),'intents',${quote([bad])},'reservations','[]'::jsonb),'duties',(`)
 .replaceAll("and duty_private.duty_owner(day)='2027-12'","and day>='2027-12-01' and day<'2028-01-01'");poison+=failure(command,'invalid-intent-route|invalid-path')}
poison+=`do $$begin if exists(select 1 from public.duty_publications) then raise exception 'Malformed route committed';end if;end$$;rollback;`;sql(poison);
console.log('PASS: malformed/null/numeric routed fields are refused atomically through the legacy publication RPC');

// Independent baseline search is checked against an exhaustive small oracle.
let baseline=`begin;create function pg_temp.accept_baseline(f jsonb,b jsonb) returns boolean language plpgsql as $$begin perform duty_private.allocation_baseline(f,b);return true;exception when raise_exception then if sqlerrm<>'invalid-ordinary-baseline' then raise;end if;return false;end$$;`;
const expected=[];
for(const weights of [[2,2,2],[1,4,5],[2,2,7,7],[1,2,3,4]]){
 const possible=new Set(),n=3,total=weights.reduce((a,b)=>a+b,0),bins=[0,0,0];
 const enumerate=i=>{if(i===weights.length){possible.add(bins.join(','));return}for(let k=0;k<n;k++){bins[k]+=weights[i];enumerate(i+1);bins[k]-=weights[i]}};enumerate(0);
 const cost=b=>b.reduce((s,v)=>s+(n*v-total)**2,0),best=Math.min(...[...possible].map(v=>cost(v.split(',').map(Number))));
 for(let a=0;a<=total;a++)for(let b=0;b<=total-a;b++){const v=[a,b,total-a-b],ok=possible.has(v.join(','))&&cost(v)===best;expected.push(ok);
  baseline+=`select jsonb_build_object('accepted',pg_temp.accept_baseline(${quote({duties:weights.map(units=>({units}))})},${quote(Object.fromEntries(v.map((units,i)=>[String(i),units])))}));`}
}baseline+='rollback;';assert.deepEqual(sql(baseline).map(v=>v.accepted),expected);
console.log(`PASS: exact ordinary-baseline validation matches ${expected.length} exhaustive weighted-partition cases; inflated baselines are rejected`);

// A reopened neighbor must not hide its live boundary commitment. Only the
// selected owner is writable, and Saturday belongs to the preceding Friday.
let boundary=setup+confirm()+save(partial)+`reset role;
insert into public.duty_months(month,deadline,status,publication_sequence) values('2027-11','2027-10-24','draft',1);
insert into public.duty_publications(month,version,published_by) values('2027-11',1,'${manager}');
insert into public.duty_assignments(publication_id,day,end_day,primary_id) select id,'2027-11-30','2027-12-01','${ids[5]}' from public.duty_publications;
update public.duty_months set current_publication_id=(select id from public.duty_publications) where month='2027-11';
insert into public.duty_assignments(day,end_day,primary_id) values('2027-11-30','2027-12-01','${ids[6]}');set local role authenticated;`+refresh+confirm();
boundary+=`select v from context;`+failure(save(),'neighbor-conflict');
const draftConflict=structuredClone(partial);draftConflict[duties[0].id]={primary:ids[6]};boundary+=failure(save(draftConflict),'neighbor-conflict');
boundary+=`reset role;create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${handover('2028-01-01')*60000}::bigint$$;set local role authenticated;
select public.duty_generation_context('2028-01',${rev});rollback;`;
const boundaryViews=sql(boundary);assert.deepEqual(new Set(boundaryViews[0].facts.neighbors.map(n=>n.source)),new Set(['published','working']));
assert.equal(boundaryViews[1].coverageStartMs,handover('2028-01-02')*60000);assert.equal(boundaryViews[1].generationAllowed,true);
console.log('PASS: both neighboring live/draft commitments bind, and the Saturday-start owner opens on its Sunday handover');
